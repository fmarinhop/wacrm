// ============================================================
// OpenWA gateway client — the unofficial-channel counterpart of
// `src/lib/whatsapp/meta-api.ts`.
//
// OpenWA (github.com/rmyndharis/OpenWA) is a self-hosted NestJS
// gateway that drives WhatsApp Web sessions (whatsapp-web.js /
// Baileys engines) behind a REST API. wacrm talks to ONE shared
// gateway instance, configured at deployment level:
//
//   OPENWA_BASE_URL  — e.g. http://openwa.example.com/api
//                      (must include the gateway's global /api prefix)
//   OPENWA_API_KEY   — an OPERATOR-or-above key, sent as X-API-Key
//
// Every account on this wacrm instance owns one named session on that
// gateway (`wacrm-<account_id>`); the session lifecycle + QR flow is
// orchestrated by `session-manager.ts`, and inbound traffic arrives on
// `/api/openwa/webhook`.
//
// Named-params convention mirrors meta-api.ts: multiple positional
// strings (sessionId, chatId, text, …) are trivially swappable at a
// call site and TypeScript can't catch it — an object literal makes
// every argument self-labeling.
// ============================================================

/** Gateway session lifecycle states (OpenWA `SessionStatus` enum). */
export type OpenWASessionStatus =
  | 'created'
  | 'initializing'
  | 'qr_ready'
  | 'authenticating'
  | 'ready'
  | 'disconnected'
  | 'failed'

export interface OpenWASession {
  id: string
  name: string
  status: OpenWASessionStatus
  phone?: string | null
  pushName?: string | null
  connectedAt?: string | null
  lastActive?: string | null
}

export interface OpenWAWebhookSubscription {
  id: string
  url: string
  events: string[]
}

export interface OpenWASendResult {
  /** Gateway message id (e.g. "true_628..@c.us_3EB0.."), stored in messages.message_id. */
  messageId: string
  /** Unix seconds at which the gateway accepted the message. */
  timestamp: number
}

/** Media kinds the gateway exposes as distinct send endpoints. */
export type OpenWAMediaKind = 'image' | 'video' | 'audio' | 'document'

export class OpenWAApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'OpenWAApiError'
    this.status = status
  }
}

function baseUrl(): string {
  const url = process.env.OPENWA_BASE_URL
  if (!url) {
    throw new OpenWAApiError(
      'OPENWA_BASE_URL is not set. Configure the OpenWA gateway URL (including its /api prefix) to enable the unofficial channel.',
      500,
    )
  }
  return url.replace(/\/+$/, '')
}

function apiKey(): string {
  const key = process.env.OPENWA_API_KEY
  if (!key) {
    throw new OpenWAApiError(
      'OPENWA_API_KEY is not set. Create an OPERATOR API key on the OpenWA gateway and configure it to enable the unofficial channel.',
      500,
    )
  }
  return key
}

async function openwaFetch<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        'X-API-Key': apiKey(),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch (err) {
    throw new OpenWAApiError(
      `OpenWA gateway unreachable: ${err instanceof Error ? err.message : String(err)}`,
      502,
    )
  }

  const text = await response.text()
  let json: unknown = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      // Non-JSON error body (proxy page, HTML) — fall through with null.
    }
  }

  if (!response.ok) {
    // Nest error shape: { statusCode, message: string | string[], error }
    const raw = (json as { message?: string | string[] } | null)?.message
    const message = Array.isArray(raw) ? raw.join('; ') : raw
    throw new OpenWAApiError(
      message || `OpenWA request failed with HTTP ${response.status}`,
      response.status,
    )
  }

  return json as T
}

// ------------------------------------------------------------
// chatId helpers. The gateway addresses 1:1 chats as
// `<msisdn-digits>@c.us`; wacrm stores phones as E.164 (+digits).
// ------------------------------------------------------------

/** `+55119...` → `55119...@c.us` */
export function phoneToChatId(phone: string): string {
  return `${phone.replace(/\D/g, '')}@c.us`
}

/**
 * `55119...@c.us` → `+55119...`. Returns null for anything that isn't
 * a plain 1:1 phone JID (groups `@g.us`, privacy ids `@lid`,
 * broadcasts) — callers must skip those.
 */
export function chatIdToPhone(chatId: string): string | null {
  const match = /^(\d{5,15})@c\.us$/.exec(chatId)
  return match ? `+${match[1]}` : null
}

// ------------------------------------------------------------
// Sessions
// ------------------------------------------------------------

export async function createSession(args: {
  name: string
  config?: Record<string, unknown>
}): Promise<OpenWASession> {
  return openwaFetch<OpenWASession>('POST', '/sessions', {
    name: args.name,
    ...(args.config ? { config: args.config } : {}),
  })
}

export async function listSessions(): Promise<OpenWASession[]> {
  return openwaFetch<OpenWASession[]>('GET', '/sessions')
}

export async function getSession(args: {
  sessionId: string
}): Promise<OpenWASession> {
  return openwaFetch<OpenWASession>('GET', `/sessions/${args.sessionId}`)
}

export async function startSession(args: {
  sessionId: string
}): Promise<OpenWASession> {
  return openwaFetch<OpenWASession>('POST', `/sessions/${args.sessionId}/start`)
}

export async function stopSession(args: { sessionId: string }): Promise<void> {
  await openwaFetch<unknown>('POST', `/sessions/${args.sessionId}/stop`)
}

export async function deleteSession(args: {
  sessionId: string
}): Promise<void> {
  await openwaFetch<unknown>('DELETE', `/sessions/${args.sessionId}`)
}

/**
 * Current QR string for a session awaiting scan. The gateway 400s when
 * the QR isn't ready (still initializing, or already authenticated) —
 * callers should treat that as "no QR right now", not a hard failure.
 */
export async function getQRCode(args: {
  sessionId: string
}): Promise<{ qrCode: string; status: OpenWASessionStatus }> {
  return openwaFetch<{ qrCode: string; status: OpenWASessionStatus }>(
    'GET',
    `/sessions/${args.sessionId}/qr`,
  )
}

// ------------------------------------------------------------
// Webhook subscriptions (per session)
// ------------------------------------------------------------

export async function registerWebhook(args: {
  sessionId: string
  url: string
  events: string[]
  secret: string
  retryCount?: number
}): Promise<OpenWAWebhookSubscription> {
  return openwaFetch<OpenWAWebhookSubscription>(
    'POST',
    `/sessions/${args.sessionId}/webhooks`,
    {
      url: args.url,
      events: args.events,
      secret: args.secret,
      ...(args.retryCount !== undefined ? { retryCount: args.retryCount } : {}),
    },
  )
}

export async function deleteWebhook(args: {
  sessionId: string
  webhookId: string
}): Promise<void> {
  await openwaFetch<unknown>(
    'DELETE',
    `/sessions/${args.sessionId}/webhooks/${args.webhookId}`,
  )
}

// ------------------------------------------------------------
// Messages
// ------------------------------------------------------------

export async function sendText(args: {
  sessionId: string
  chatId: string
  text: string
}): Promise<OpenWASendResult> {
  return openwaFetch<OpenWASendResult>(
    'POST',
    `/sessions/${args.sessionId}/messages/send-text`,
    { chatId: args.chatId, text: args.text },
  )
}

export async function sendMedia(args: {
  sessionId: string
  chatId: string
  kind: OpenWAMediaKind
  /** Publicly fetchable media URL (the chat-media bucket is public). */
  url: string
  caption?: string
  filename?: string
}): Promise<OpenWASendResult> {
  return openwaFetch<OpenWASendResult>(
    'POST',
    `/sessions/${args.sessionId}/messages/send-${args.kind}`,
    {
      chatId: args.chatId,
      url: args.url,
      ...(args.caption ? { caption: args.caption } : {}),
      ...(args.filename ? { filename: args.filename } : {}),
    },
  )
}
