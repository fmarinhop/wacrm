import crypto from 'node:crypto'

/**
 * Verify the HMAC-SHA256 signature the OpenWA gateway attaches to
 * webhook POSTs.
 *
 * When a webhook subscription is registered with a `secret`, the
 * gateway signs the raw JSON body and sends the result in the
 * `X-OpenWA-Signature: sha256=<hex>` header — the same scheme Meta
 * uses for its webhooks (`src/lib/whatsapp/webhook-signature.ts`),
 * which is why this mirrors that module's contract exactly.
 *
 * Contract:
 *   `OPENWA_WEBHOOK_SECRET` is **required**. If it's missing we fail
 *   closed — every request is rejected until the operator configures
 *   the secret. Without verification, anyone who discovers the webhook
 *   URL could inject fabricated inbound messages or flip a channel's
 *   connection status.
 */
export function verifyOpenWAWebhookSignature(
  rawBody: string,
  signatureHeader: string | null,
): boolean {
  const secret = process.env.OPENWA_WEBHOOK_SECRET
  if (!secret) {
    console.error(
      '[openwa-webhook] OPENWA_WEBHOOK_SECRET is not set — rejecting request. ' +
        'Configure the env var (the same secret passed when registering the ' +
        'session webhook) to enable signature verification.',
    )
    return false
  }

  if (!signatureHeader) return false
  if (!signatureHeader.startsWith('sha256=')) return false

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', secret).update(rawBody).digest('hex')

  const a = Buffer.from(signatureHeader)
  const b = Buffer.from(expected)
  // Bail if lengths differ — timingSafeEqual throws otherwise.
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}
