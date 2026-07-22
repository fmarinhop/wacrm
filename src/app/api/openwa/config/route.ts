import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

import {
  connectChannel,
  disconnectChannel,
  removeChannel,
  refreshStatus,
  OpenWAChannelError,
} from '@/lib/openwa/session-manager'
import { OpenWAApiError } from '@/lib/openwa/openwa-api'

// ============================================================
// /api/openwa/config — unofficial (QR) channel management.
//
// The settings UI drives the whole lifecycle through here:
//   GET               → current channel state (optionally live-refreshed
//                       from the gateway with ?refresh=1)
//   POST              → connect: create/adopt + start the gateway
//                       session; the QR then arrives via webhook →
//                       openwa_config.qr_code → Realtime → UI
//   POST {action:'disconnect'} → stop the session, keep the WhatsApp link
//   DELETE            → remove the channel entirely (purges gateway
//                       session auth — reconnecting needs a new scan)
//
// Auth mirrors /api/whatsapp/config: any signed-in member may read;
// writes go through the caller's RLS-scoped client, so the
// admin+-only policies on openwa_config (migration 037) are the
// enforcement point — no duplicated role checks here.
// ============================================================

async function resolveAccount(): Promise<
  | { supabase: Awaited<ReturnType<typeof createClient>>; userId: string; accountId: string }
  | { errorResponse: NextResponse }
> {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return {
      errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    }
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (profileError || !profile?.account_id) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 400 },
      ),
    }
  }

  return { supabase, userId: user.id, accountId: profile.account_id as string }
}

function toErrorResponse(err: unknown): NextResponse {
  if (err instanceof OpenWAChannelError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  if (err instanceof OpenWAApiError) {
    // Gateway-side failure — surface the message but normalize the
    // status to 502 (the gateway's own 4xx codes aren't meaningful to
    // our caller, except config errors which keep their 500).
    return NextResponse.json(
      { error: `OpenWA gateway error: ${err.message}` },
      { status: err.status === 500 ? 500 : 502 },
    )
  }
  console.error('[openwa/config] unexpected error:', err)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}

export async function GET(request: Request) {
  const ctx = await resolveAccount()
  if ('errorResponse' in ctx) return ctx.errorResponse
  const { supabase, accountId } = ctx

  try {
    const { searchParams } = new URL(request.url)

    // Live-refresh mirrors the gateway state onto the row first (missed
    // webhook fallback). Not configured yet is a normal state, not an
    // error — swallow the 404.
    if (searchParams.get('refresh') === '1') {
      try {
        await refreshStatus(supabase, accountId)
      } catch (err) {
        if (!(err instanceof OpenWAChannelError && err.status === 404)) {
          console.warn(
            '[openwa/config] refresh failed (returning stored state):',
            err instanceof Error ? err.message : err,
          )
        }
      }
    }

    const { data: config, error } = await supabase
      .from('openwa_config')
      .select(
        'status, phone, push_name, qr_code, qr_updated_at, last_error, connected_at',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[openwa/config] fetch failed:', error)
      return NextResponse.json(
        { error: 'Failed to fetch configuration' },
        { status: 500 },
      )
    }

    if (!config) {
      return NextResponse.json({ configured: false, status: 'disconnected' })
    }

    return NextResponse.json({ configured: true, ...config })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  const ctx = await resolveAccount()
  if ('errorResponse' in ctx) return ctx.errorResponse
  const { supabase, userId, accountId } = ctx

  let action = 'connect'
  try {
    const body = await request.json().catch(() => ({}))
    if (body && typeof body.action === 'string') action = body.action
  } catch {
    // No/invalid body → default connect.
  }

  try {
    if (action === 'disconnect') {
      await disconnectChannel(supabase, accountId)
      return NextResponse.json({ status: 'disconnected' })
    }
    if (action !== 'connect') {
      return NextResponse.json(
        { error: `Unknown action "${action}"` },
        { status: 400 },
      )
    }
    const result = await connectChannel(supabase, { accountId, userId })
    return NextResponse.json(result)
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  const ctx = await resolveAccount()
  if ('errorResponse' in ctx) return ctx.errorResponse
  const { supabase, accountId } = ctx

  try {
    await removeChannel(supabase, accountId)
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
