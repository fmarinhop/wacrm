// ============================================================
// Unofficial-channel session orchestration.
//
// High-level operations the `/api/openwa/config` route exposes to the
// settings UI. Each one composes gateway calls (openwa-api.ts) with
// the per-account `openwa_config` row that mirrors the session state
// into our DB (and, via Supabase Realtime, into the UI).
//
// The happy connect path:
//   connectChannel()
//     → create session `wacrm-<account_id>` (idempotent on 409)
//     → register the webhook subscription (session.qr, message.*, …)
//     → start the session
//     → upsert openwa_config { status: 'connecting' }
//   … the gateway then pushes `session.qr` → webhook route stores the
//   QR string → UI renders it → user scans → `session.authenticated`
//   → webhook route flips status to 'connected'.
//
// `db` is the caller's RLS-scoped client (settings routes) — RLS is
// what enforces that only admin+ can mutate the channel. The webhook
// route uses the service-role client and its own handlers instead.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import {
  createSession,
  listSessions,
  getSession,
  startSession,
  stopSession,
  deleteSession,
  registerWebhook,
  deleteWebhook,
  updateWebhook,
  OpenWAApiError,
  type OpenWASessionStatus,
} from '@/lib/openwa/openwa-api'

/** openwa_config.status values (DB CHECK constraint, migration 037). */
export type OpenWAChannelStatus =
  | 'disconnected'
  | 'connecting'
  | 'qr_ready'
  | 'authenticating'
  | 'connected'
  | 'failed'

/** Gateway session status → our channel status. */
export function mapSessionStatus(
  status: OpenWASessionStatus,
): OpenWAChannelStatus {
  switch (status) {
    case 'created':
    case 'initializing':
      return 'connecting'
    case 'qr_ready':
      return 'qr_ready'
    case 'authenticating':
      return 'authenticating'
    case 'ready':
      return 'connected'
    case 'failed':
      return 'failed'
    case 'disconnected':
    default:
      return 'disconnected'
  }
}

/** Events the wacrm webhook consumes — everything else stays unsubscribed. */
const WEBHOOK_EVENTS = [
  'session.qr',
  'session.authenticated',
  'session.disconnected',
  'session.status',
  'message.received',
  // Emitted for messages sent FROM the linked phone as well as via the
  // API. The webhook route dedupes by message_id, so API sends (already
  // persisted by the send core) are skipped and only phone-side sends
  // get mirrored into the thread.
  'message.sent',
  'message.ack',
  'message.failed',
  // Emoji reactions on a message (👍 etc.) — stored in message_reactions.
  'message.reaction',
]

export class OpenWAChannelError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'OpenWAChannelError'
    this.status = status
  }
}

/**
 * The public URL of THIS wacrm instance, used as the webhook target the
 * gateway will POST events to. Server-to-server: the OpenWA deployment
 * must allow this host in its SSRF_ALLOWED_HOSTS.
 */
function webhookUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    throw new OpenWAChannelError(
      'NEXT_PUBLIC_APP_URL is not set — it is required to register the OpenWA webhook (the gateway must know where to deliver events).',
      500,
    )
  }
  return `${appUrl.replace(/\/+$/, '')}/api/openwa/webhook`
}

function webhookSecret(): string {
  const secret = process.env.OPENWA_WEBHOOK_SECRET
  if (!secret) {
    throw new OpenWAChannelError(
      'OPENWA_WEBHOOK_SECRET is not set — it is required to sign gateway webhook deliveries.',
      500,
    )
  }
  return secret
}

export function sessionNameForAccount(accountId: string): string {
  // OpenWA session names allow [a-zA-Z0-9-], 3–50 chars. "wacrm-" + a
  // 36-char UUID = 42 chars, comfortably inside the limit.
  return `wacrm-${accountId}`
}

interface OpenWAConfigRow {
  id: string
  account_id: string
  user_id: string
  session_id: string | null
  session_name: string
  status: OpenWAChannelStatus
  qr_code: string | null
  phone: string | null
  push_name: string | null
  webhook_id: string | null
  last_error: string | null
}

async function loadConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<OpenWAConfigRow | null> {
  const { data, error } = await db
    .from('openwa_config')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    throw new OpenWAChannelError(
      `Failed to load channel config: ${error.message}`,
      500,
    )
  }
  return (data as OpenWAConfigRow | null) ?? null
}

/**
 * Connect (or resume connecting) the account's unofficial channel.
 *
 * Idempotent by design — clicking "Connect" twice, or reconnecting
 * after the phone was unlinked, converges on the same session:
 *   - a 409 on create means the session already exists (an earlier
 *     attempt, or a previous connect) → adopt it by name;
 *   - a 400 on start means it's already started → fine;
 *   - the webhook subscription is only created once (tracked via
 *     openwa_config.webhook_id).
 */
export async function connectChannel(
  db: SupabaseClient,
  args: { accountId: string; userId: string },
): Promise<{ status: OpenWAChannelStatus }> {
  const { accountId, userId } = args
  const name = sessionNameForAccount(accountId)
  const existing = await loadConfig(db, accountId)

  if (existing?.status === 'connected') {
    return { status: 'connected' }
  }

  // ---- 1. Find or create the gateway session -------------------
  let sessionId = existing?.session_id ?? null
  if (sessionId) {
    // Confirm it still exists on the gateway (an operator may have
    // purged it). A 404 falls through to re-create.
    try {
      await getSession({ sessionId })
    } catch (err) {
      if (err instanceof OpenWAApiError && err.status === 404) {
        sessionId = null
      } else {
        throw err
      }
    }
  }

  let webhookId = existing?.webhook_id ?? null
  if (!sessionId) {
    try {
      const session = await createSession({ name })
      sessionId = session.id
    } catch (err) {
      if (err instanceof OpenWAApiError && err.status === 409) {
        // Session name already exists on the gateway (orphan from a
        // wiped DB or an interrupted connect) — adopt it.
        const sessions = await listSessions()
        const match = sessions.find((s) => s.name === name)
        if (!match) throw err
        sessionId = match.id
      } else {
        throw err
      }
    }
    // New/adopted session → any webhook_id we stored belonged to a
    // previous session and is gone with it.
    webhookId = existing?.session_id === sessionId ? webhookId : null
  }

  // Persist the session_id BEFORE registering the webhook + starting, so
  // the row exists when the very first `session.qr` event arrives — the
  // gateway starts emitting QRs within milliseconds of start(), which
  // could otherwise race ahead of the final upsert below and get dropped
  // by the webhook handler as "no config for session".
  await db.from('openwa_config').upsert(
    {
      account_id: accountId,
      user_id: userId,
      session_id: sessionId,
      session_name: name,
      status: 'connecting',
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'account_id' },
  )

  // ---- 2. Ensure our webhook subscription exists ---------------
  if (!webhookId) {
    const webhook = await registerWebhook({
      sessionId,
      url: webhookUrl(),
      events: WEBHOOK_EVENTS,
      secret: webhookSecret(),
      retryCount: 3,
    })
    webhookId = webhook.id
  } else {
    // Re-assert the event list on an already-registered webhook so a
    // reconnect picks up newly-added events (e.g. message.reaction)
    // without the operator having to remove + recreate the channel.
    // Best-effort — a failure here shouldn't block reconnect.
    try {
      await updateWebhook({ sessionId, webhookId, events: WEBHOOK_EVENTS })
    } catch (err) {
      console.warn(
        '[openwa] webhook event re-assert failed (continuing):',
        err instanceof Error ? err.message : err,
      )
    }
  }

  // ---- 3. Start the session (tolerate "already started") -------
  try {
    await startSession({ sessionId })
  } catch (err) {
    if (!(err instanceof OpenWAApiError && err.status === 400)) {
      throw err
    }
  }

  // ---- 4. Mirror into openwa_config ----------------------------
  const now = new Date().toISOString()
  const { error: upsertError } = await db.from('openwa_config').upsert(
    {
      account_id: accountId,
      user_id: userId,
      session_id: sessionId,
      session_name: name,
      webhook_id: webhookId,
      status: 'connecting',
      qr_code: null,
      qr_updated_at: null,
      last_error: null,
      updated_at: now,
    },
    { onConflict: 'account_id' },
  )
  if (upsertError) {
    throw new OpenWAChannelError(
      `Session started but saving channel config failed: ${upsertError.message}`,
      500,
    )
  }

  return { status: 'connecting' }
}

/**
 * Stop the session (keeps the WhatsApp link on the gateway's disk, so
 * a later connect resumes without re-scanning) and mark the channel
 * disconnected.
 */
export async function disconnectChannel(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  const config = await loadConfig(db, accountId)
  if (!config) {
    throw new OpenWAChannelError('Unofficial channel is not configured', 404)
  }

  if (config.session_id) {
    try {
      await stopSession({ sessionId: config.session_id })
    } catch (err) {
      // A session the gateway no longer knows is already "stopped".
      if (!(err instanceof OpenWAApiError && (err.status === 404 || err.status === 400))) {
        throw err
      }
    }
  }

  const { error } = await db
    .from('openwa_config')
    .update({
      status: 'disconnected',
      qr_code: null,
      qr_updated_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
  if (error) {
    throw new OpenWAChannelError(
      `Failed to update channel config: ${error.message}`,
      500,
    )
  }
}

/**
 * Tear the channel down completely: webhook subscription, gateway
 * session (which purges its auth data — the phone must re-scan to ever
 * reconnect), and our config row. Existing conversations/messages are
 * kept — they're history, not channel state.
 */
export async function removeChannel(
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  const config = await loadConfig(db, accountId)
  if (!config) {
    throw new OpenWAChannelError('Unofficial channel is not configured', 404)
  }

  if (config.session_id) {
    if (config.webhook_id) {
      try {
        await deleteWebhook({
          sessionId: config.session_id,
          webhookId: config.webhook_id,
        })
      } catch (err) {
        // Best-effort — deleting the session below drops its webhooks too.
        console.warn(
          '[openwa] webhook cleanup failed (continuing):',
          err instanceof Error ? err.message : err,
        )
      }
    }
    try {
      await deleteSession({ sessionId: config.session_id })
    } catch (err) {
      if (!(err instanceof OpenWAApiError && err.status === 404)) {
        throw err
      }
    }
  }

  const { error } = await db
    .from('openwa_config')
    .delete()
    .eq('account_id', accountId)
  if (error) {
    throw new OpenWAChannelError(
      `Failed to delete channel config: ${error.message}`,
      500,
    )
  }
}

/**
 * Pull the session's live status from the gateway and mirror it onto
 * the config row. Fallback for when a webhook delivery was missed
 * (e.g. the wacrm host was unreachable) — the UI calls this on load.
 */
export async function refreshStatus(
  db: SupabaseClient,
  accountId: string,
): Promise<{ status: OpenWAChannelStatus }> {
  const config = await loadConfig(db, accountId)
  if (!config) {
    throw new OpenWAChannelError('Unofficial channel is not configured', 404)
  }
  if (!config.session_id) {
    return { status: config.status }
  }

  let session
  try {
    session = await getSession({ sessionId: config.session_id })
  } catch (err) {
    if (err instanceof OpenWAApiError && err.status === 404) {
      // Session vanished on the gateway — reflect reality.
      await db
        .from('openwa_config')
        .update({
          status: 'disconnected',
          session_id: null,
          webhook_id: null,
          qr_code: null,
          updated_at: new Date().toISOString(),
        })
        .eq('account_id', accountId)
      return { status: 'disconnected' }
    }
    throw err
  }

  const status = mapSessionStatus(session.status)
  const { error } = await db
    .from('openwa_config')
    .update({
      status,
      phone: session.phone ?? config.phone,
      push_name: session.pushName ?? config.push_name,
      ...(status === 'connected' ? { qr_code: null, qr_updated_at: null } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq('account_id', accountId)
  if (error) {
    throw new OpenWAChannelError(
      `Failed to update channel config: ${error.message}`,
      500,
    )
  }

  return { status }
}
