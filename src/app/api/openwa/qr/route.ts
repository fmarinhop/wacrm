import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

import { getQRCode, OpenWAApiError } from '@/lib/openwa/openwa-api'

// ============================================================
// GET /api/openwa/qr — current QR string for the connect flow.
//
// The primary QR delivery path is push: gateway `session.qr` webhook →
// openwa_config.qr_code → Supabase Realtime → settings UI. This
// endpoint is the pull fallback for when that chain is degraded (a
// missed webhook delivery, Realtime disconnected): it serves the
// stored QR when fresh, and otherwise asks the gateway directly and
// re-stores the answer.
//
// QR strings rotate roughly every 30s; anything older is stale and
// worth re-fetching rather than rendering a code the phone will reject.
// ============================================================

const QR_STALE_MS = 45_000

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!profile?.account_id) {
    return NextResponse.json(
      { error: 'Your profile is not linked to an account.' },
      { status: 400 },
    )
  }

  const { data: config, error } = await supabase
    .from('openwa_config')
    .select('session_id, status, qr_code, qr_updated_at')
    .eq('account_id', profile.account_id)
    .maybeSingle()

  if (error) {
    console.error('[openwa/qr] config fetch failed:', error)
    return NextResponse.json({ error: 'Failed to fetch configuration' }, { status: 500 })
  }
  if (!config) {
    return NextResponse.json(
      { error: 'Unofficial channel is not configured' },
      { status: 404 },
    )
  }

  const fresh =
    config.qr_code &&
    config.qr_updated_at &&
    Date.now() - new Date(config.qr_updated_at).getTime() < QR_STALE_MS

  if (fresh) {
    return NextResponse.json({ qrCode: config.qr_code, status: config.status })
  }

  if (!config.session_id) {
    return NextResponse.json({ qrCode: null, status: config.status })
  }

  try {
    const live = await getQRCode({ sessionId: config.session_id })
    await supabase
      .from('openwa_config')
      .update({
        qr_code: live.qrCode,
        qr_updated_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('account_id', profile.account_id)
    return NextResponse.json({ qrCode: live.qrCode, status: config.status })
  } catch (err) {
    // The gateway 400s when no QR is available (still initializing, or
    // already authenticated) — that's a state, not a failure.
    if (err instanceof OpenWAApiError && err.status === 400) {
      return NextResponse.json({ qrCode: null, status: config.status })
    }
    console.error('[openwa/qr] gateway fetch failed:', err)
    return NextResponse.json(
      { error: 'Failed to fetch QR code from the gateway' },
      { status: 502 },
    )
  }
}
