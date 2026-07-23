import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import { verifyOpenWAWebhookSignature } from '@/lib/openwa/webhook-signature'
import { mapSessionStatus } from '@/lib/openwa/session-manager'
import {
  chatIdToPhone,
  getSession,
  getContact,
  contactDisplayName,
} from '@/lib/openwa/openwa-api'
import type { OpenWASessionStatus } from '@/lib/openwa/openwa-api'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'

// ============================================================
// POST /api/openwa/webhook — event receiver for the unofficial channel.
//
// The OpenWA gateway POSTs one JSON envelope per event:
//   { event, timestamp, sessionId, idempotencyKey, deliveryId, data }
// signed with `X-OpenWA-Signature: sha256=<HMAC-SHA256(body)>` using
// the secret we registered the subscription with (session-manager.ts).
//
// This is the unofficial-channel counterpart of
// `src/app/api/whatsapp/webhook/route.ts` and deliberately mirrors its
// structure: verify raw-body signature → ack fast → process in
// `after()`. Inbound messages land in the SAME contacts/conversations/
// messages tables, on a conversation with `channel = 'openwa'`, and
// fire the same automations / flows / AI auto-reply dispatches.
//
// Idempotency: the gateway retries failed deliveries, and `message.sent`
// echoes API sends we already persisted — every message handler first
// checks `messages.message_id` within the conversation and skips
// duplicates.
// ============================================================

export const maxDuration = 60

// Lazy-initialized to avoid build-time crash when env vars are missing
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

interface OpenWAWebhookEnvelope {
  event: string
  timestamp?: number | string
  sessionId: string
  idempotencyKey?: string
  deliveryId?: string
  data?: unknown
}

/** Subset of the gateway's IncomingMessage we consume. */
interface OpenWAIncomingMessage {
  id: string
  from: string
  to?: string
  chatId?: string
  body?: string
  type?: string
  timestamp?: number
  fromMe?: boolean
  isGroup?: boolean
  isStatusBroadcast?: boolean
  isLidSender?: boolean
  senderPhone?: string | null
  contact?: { pushName?: string; name?: string; verifiedName?: string }
  media?: {
    mimetype: string
    filename?: string
    data?: string
    omitted?: boolean
    sizeBytes?: number
  }
  quotedMessage?: { id: string; body?: string }
  location?: { latitude: number; longitude: number; description?: string }
}

interface OpenWAAckPayload {
  id?: string
  messageId?: string
  status?: string
}

interface OpenWAReactionPayload {
  /** Gateway message id of the message being reacted to. */
  messageId: string
  chatId?: string
  /** The emoji; '' (empty) means the reaction was removed. */
  reaction?: string
  senderId?: string
}

export async function POST(request: Request) {
  // Raw body first — HMAC covers the exact bytes the gateway signed.
  const rawBody = await request.text()
  const signature = request.headers.get('x-openwa-signature')

  if (!verifyOpenWAWebhookSignature(rawBody, signature)) {
    // 401 so the gateway's delivery-failure log surfaces a
    // misconfiguration loudly instead of silently eating events.
    console.warn('[openwa-webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let envelope: OpenWAWebhookEnvelope
  try {
    envelope = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!envelope?.event || !envelope?.sessionId) {
    return NextResponse.json({ error: 'Malformed envelope' }, { status: 400 })
  }

  // Ack fast, process after the response — same rationale as the Meta
  // webhook (see that route's comment): `after()` keeps the function
  // alive on serverless, a detached promise does not.
  after(async () => {
    try {
      await processEvent(envelope)
    } catch (error) {
      console.error('[openwa-webhook] error processing event:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OpenWAConfigRow = any

/**
 * Resolve the tenant from the gateway's session identifier. Depending
 * on gateway version the envelope's sessionId may be the session UUID
 * or its name — match either.
 *
 * Self-heal for UUID drift: the gateway assigns a NEW session UUID when
 * it restarts (auto-starting a persisted session), but the session NAME
 * (`wacrm-<account_id>`) is stable. When the incoming sessionId matches
 * no stored row, we ask the gateway for that session's name, derive the
 * account from it, and reconcile `openwa_config.session_id` — so the
 * account's inbound traffic keeps flowing across gateway restarts
 * instead of silently dropping as "no config for session".
 */
async function resolveConfig(sessionId: string): Promise<OpenWAConfigRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('openwa_config')
    .select('*')
    .or(`session_id.eq.${sessionId},session_name.eq.${sessionId}`)
    .maybeSingle()
  if (error) {
    console.error('[openwa-webhook] config lookup failed:', error)
    return null
  }
  if (data) return data

  try {
    const session = await getSession({ sessionId })
    const name = session?.name ?? ''
    if (name.startsWith('wacrm-')) {
      const accountId = name.slice('wacrm-'.length)
      const { data: byName } = await supabaseAdmin()
        .from('openwa_config')
        .select('*')
        .eq('account_id', accountId)
        .maybeSingle()
      if (byName) {
        await supabaseAdmin()
          .from('openwa_config')
          .update({
            session_id: sessionId,
            updated_at: new Date().toISOString(),
          })
          .eq('account_id', accountId)
        console.log(
          `[openwa-webhook] reconciled session_id for account ${accountId} → ${sessionId}`,
        )
        return { ...byName, session_id: sessionId }
      }
    }
  } catch (err) {
    console.error(
      '[openwa-webhook] session reconcile failed:',
      err instanceof Error ? err.message : err,
    )
  }

  console.warn('[openwa-webhook] no config for session:', sessionId)
  return null
}

async function processEvent(envelope: OpenWAWebhookEnvelope) {
  const config = await resolveConfig(envelope.sessionId)
  if (!config) return

  switch (envelope.event) {
    case 'session.qr': {
      const qr = (envelope.data as { qr?: string } | undefined)?.qr
      if (!qr) return
      await supabaseAdmin()
        .from('openwa_config')
        .update({
          status: 'qr_ready',
          qr_code: qr,
          qr_updated_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', config.id)
      return
    }

    case 'session.authenticated': {
      const data = envelope.data as
        | { phone?: string; pushName?: string }
        | undefined
      await supabaseAdmin()
        .from('openwa_config')
        .update({
          status: 'connected',
          phone: data?.phone ? normalizePhone(data.phone) : config.phone,
          push_name: data?.pushName ?? config.push_name,
          qr_code: null,
          qr_updated_at: null,
          last_error: null,
          connected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', config.id)
      return
    }

    case 'session.disconnected': {
      const reason = (envelope.data as { reason?: string } | undefined)?.reason
      await supabaseAdmin()
        .from('openwa_config')
        .update({
          status: 'disconnected',
          qr_code: null,
          qr_updated_at: null,
          last_error: reason ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', config.id)
      return
    }

    case 'session.status': {
      const raw = (envelope.data as { status?: string } | undefined)?.status
      if (!raw) return
      const status = mapSessionStatus(raw as OpenWASessionStatus)
      // qr/authenticated/disconnected carry richer payloads and own
      // their transitions — session.status only fills the gaps so an
      // out-of-order generic status can't clobber a specific one.
      if (status === 'qr_ready' || status === 'connected') return
      await supabaseAdmin()
        .from('openwa_config')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', config.id)
      return
    }

    case 'message.received':
    case 'message.sent': {
      const message = envelope.data as OpenWAIncomingMessage | undefined
      if (!message?.id) return
      await processInboundMessage(config, message, envelope.event)
      return
    }

    case 'message.ack':
    case 'message.failed': {
      const ack = envelope.data as OpenWAAckPayload | undefined
      if (!ack) return
      await handleAck(ack, envelope.event === 'message.failed')
      return
    }

    case 'message.reaction': {
      const data = envelope.data as OpenWAReactionPayload | undefined
      if (!data?.messageId) return
      await handleReaction(config, data)
      return
    }

    default:
      // Unsubscribed/unknown event — ignore quietly.
      return
  }
}

// ------------------------------------------------------------
// Delivery-status updates (message.ack / message.failed)
// ------------------------------------------------------------

/**
 * Same forward-only ladder the Meta webhook enforces: a replayed or
 * out-of-order ack can only ADVANCE a message's status. The guard is
 * expressed as an `.in('status', priors)` filter so it's race-safe at
 * the DB level (no read-then-write window).
 */
const PRIOR_STATUSES: Record<string, string[]> = {
  sent: ['sending', 'pending'],
  delivered: ['sending', 'pending', 'sent'],
  read: ['sending', 'pending', 'sent', 'delivered'],
  failed: ['sending', 'pending', 'sent'],
}

async function handleAck(ack: OpenWAAckPayload, forceFailed: boolean) {
  const messageId = ack.messageId ?? ack.id
  if (!messageId) return

  const status = forceFailed ? 'failed' : (ack.status ?? '')
  const priors = PRIOR_STATUSES[status]
  if (!priors) return // played / unknown → nothing to mirror

  const { error } = await supabaseAdmin()
    .from('messages')
    .update({ status })
    .eq('message_id', messageId)
    .in('status', priors)
  if (error) {
    console.error('[openwa-webhook] ack update failed:', error)
  }
}

// ------------------------------------------------------------
// Reactions (emoji on a message)
//
// WhatsApp reactions are per-(target message, actor) state, not new
// messages — mirror them into message_reactions like the Meta webhook
// does. We attribute an inbound reaction to the conversation's contact
// (the customer); an empty emoji is a removal.
// ------------------------------------------------------------

async function handleReaction(
  config: OpenWAConfigRow,
  data: OpenWAReactionPayload
) {
  // Resolve the target message (by gateway message_id) within this
  // account's openwa conversations, and the contact who owns the thread.
  const { data: rows, error } = await supabaseAdmin()
    .from('messages')
    .select('id, conversation_id, conversation:conversations!inner(account_id, contact_id, channel)')
    .eq('message_id', data.messageId)
    .eq('conversation.account_id', config.account_id)
    .eq('conversation.channel', 'openwa')
    .limit(1)

  if (error) {
    console.error('[openwa-webhook] reaction lookup failed:', error)
    return
  }
  const target = rows?.[0]
  if (!target) {
    // We never stored the reacted-to message (e.g. it predates the CRM).
    return
  }
  const conversation = target.conversation as { contact_id: string }
  const actorId = conversation.contact_id
  const emoji = data.reaction ?? ''

  if (!emoji) {
    const { error: delErr } = await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', target.id)
      .eq('actor_type', 'customer')
      .eq('actor_id', actorId)
    if (delErr) console.error('[openwa-webhook] reaction delete failed:', delErr)
    return
  }

  const { error: upErr } = await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: target.id,
        conversation_id: target.conversation_id,
        actor_type: 'customer',
        actor_id: actorId,
        emoji,
      },
      { onConflict: 'message_id,actor_type,actor_id' }
    )
  if (upErr) console.error('[openwa-webhook] reaction upsert failed:', upErr)
}

// ------------------------------------------------------------
// Inbound messages
// ------------------------------------------------------------

async function processInboundMessage(
  config: OpenWAConfigRow,
  message: OpenWAIncomingMessage,
  event: 'message.received' | 'message.sent'
) {
  // Threads the CRM doesn't model: groups and status/story broadcasts.
  if (message.isGroup || message.isStatusBroadcast) return

  // The customer's phone. For an inbound message that's the sender
  // (`from`); for a phone-side send it's the recipient (`to`/chatId).
  const isEcho = event === 'message.sent' || message.fromMe === true
  const counterpartJid = isEcho
    ? (message.to ?? message.chatId ?? '')
    : (message.senderPhone
        ? `${message.senderPhone}@c.us`
        : (message.from ?? ''))
  const rawPhone = chatIdToPhone(counterpartJid)
  if (!rawPhone) {
    // Privacy-id (@lid) sender the gateway couldn't resolve, or some
    // other non-phone JID — nothing to key a contact on.
    console.warn('[openwa-webhook] skipping message with unresolvable JID:', counterpartJid)
    return
  }
  const phone = normalizePhone(rawPhone)

  const accountId: string = config.account_id
  const ownerUserId: string = config.user_id

  // Prefer the push name carried on the message. When it's absent (common
  // for @lid senders), enrich from the gateway's contact cache so the
  // inbox shows a real name instead of a bare number. Best-effort and
  // only when we don't already have a name — bounded, cheap (cache read).
  let resolvedName: string | null = isEcho
    ? null
    : (message.contact?.pushName ??
       message.contact?.name ??
       message.contact?.verifiedName ??
       null)

  if (!isEcho && !resolvedName && config.session_id) {
    try {
      const c = await getContact({
        sessionId: config.session_id,
        contactId: `${phone.replace(/\D/g, '')}@c.us`,
      })
      resolvedName = contactDisplayName(c)
    } catch (err) {
      console.warn(
        '[openwa-webhook] contact enrichment failed:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  const contactName = resolvedName || phone

  const contactOutcome = await findOrCreateContact(
    accountId,
    ownerUserId,
    phone,
    contactName
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const convResult = await findOrCreateConversation(
    accountId,
    ownerUserId,
    contactRecord.id
  )
  if (!convResult) return
  const conversation = convResult.conversation

  // Idempotency: gateway retries and message.sent echoes of API sends
  // both re-present a message_id we already stored.
  const { data: existing } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', message.id)
    .maybeSingle()
  if (existing) return

  if (convResult.created) {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, 'conversation.created', {
      conversation_id: conversation.id,
      contact_id: contactRecord.id,
    })
  }

  const { contentText, mediaUrl, contentType } = await parseContent(
    accountId,
    message
  )

  // Swipe-reply context → internal parent id, when we have the parent.
  let replyToInternalId: string | null = null
  if (message.quotedMessage?.id) {
    const { data: parent } = await supabaseAdmin()
      .from('messages')
      .select('id')
      .eq('message_id', message.quotedMessage.id)
      .eq('conversation_id', conversation.id)
      .maybeSingle()
    replyToInternalId = parent?.id ?? null
  }

  // First-ever inbound from this contact? (echoes don't count — they're
  // agent-side). Checked BEFORE the insert so the count is accurate.
  let isFirstInboundMessage = false
  if (!isEcho) {
    const { count } = await supabaseAdmin()
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('conversation_id', conversation.id)
      .eq('sender_type', 'customer')
    isFirstInboundMessage = (count ?? 0) === 0
  }

  const createdAt = message.timestamp
    ? new Date(message.timestamp * 1000).toISOString()
    : new Date().toISOString()

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: isEcho ? 'agent' : 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.id,
    status: isEcho ? 'sent' : 'delivered',
    created_at: createdAt,
    reply_to_message_id: replyToInternalId,
  })
  if (msgError) {
    // A unique-violation here is a concurrent duplicate delivery — fine.
    if (!isUniqueViolation(msgError)) {
      console.error('[openwa-webhook] error inserting message:', msgError)
    }
    return
  }

  const { error: convError } = await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || `[${contentType}]`,
      last_message_at: new Date().toISOString(),
      ...(isEcho
        ? {}
        : { unread_count: (conversation.unread_count || 0) + 1 }),
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
  if (convError) {
    console.error('[openwa-webhook] error updating conversation:', convError)
  }

  // Phone-side sends mirror into the thread but trigger nothing — the
  // human already answered from their device.
  if (isEcho) return

  // ---- Same post-processing pipeline as the official webhook ----
  // Flows (deterministic bots) get first claim on the message; their
  // replies route back through this channel via the channel-aware
  // engine sender.
  const inboundText = contentText ?? message.body ?? ''
  const flowResult = await dispatchInboundToFlows({
    accountId,
    userId: ownerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: {
      kind: 'text',
      text: inboundText,
      meta_message_id: message.id,
    },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: inboundText,
        conversation_id: conversation.id,
      },
    }).catch((err) =>
      console.error('[openwa-webhook] automations dispatch failed:', err)
    )
  }

  if (!flowConsumed && inboundText.trim()) {
    await dispatchInboundToAiReply({
      accountId,
      conversationId: conversation.id,
      contactId: contactRecord.id,
      configOwnerUserId: ownerUserId,
    })
  }

  await dispatchWebhookEvent(supabaseAdmin(), accountId, 'message.received', {
    conversation_id: conversation.id,
    contact_id: contactRecord.id,
    whatsapp_message_id: message.id,
    content_type: contentType,
    text: contentText,
    channel: 'openwa',
  })
}

// ------------------------------------------------------------
// Content parsing + media persistence
// ------------------------------------------------------------

/** messages.content_type CHECK allows: text, image, document, audio,
 *  video, location, template, interactive. Map gateway types onto it. */
function mapContentType(type: string | undefined, hasMedia: boolean): string {
  switch (type) {
    case 'image':
    case 'video':
    case 'audio':
    case 'document':
    case 'location':
      return type
    case 'sticker':
      return 'image'
    case 'ptt': // voice note
    case 'voice':
      return 'audio'
    default:
      // chat / text / unknown. A media blob with an unknown label still
      // needs a media content_type for the bubble to render it.
      return hasMedia ? 'document' : 'text'
  }
}

const MEDIA_MAX_BYTES = 16 * 1024 * 1024 // chat-media bucket cap (migration 023)

function extensionFor(mimetype: string, filename?: string): string {
  if (filename && /\.[^.]+$/.test(filename)) {
    return filename.split('.').pop()!.toLowerCase()
  }
  const subtype = mimetype.split('/')[1]?.split(';')[0]?.trim() ?? 'bin'
  const known: Record<string, string> = {
    jpeg: 'jpg',
    'x-matroska': 'mkv',
    mpeg: 'mp3',
    ogg: 'ogg',
    'vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  }
  return known[subtype] ?? (/^[a-z0-9]{1,5}$/.test(subtype) ? subtype : 'bin')
}

/**
 * Unlike Meta (media by id, fetched through our proxy route), the
 * gateway inlines media as base64 in the webhook payload. Persist it to
 * the existing public `chat-media` bucket (same one the composer uses)
 * and store its public URL — the inbox then renders it exactly like
 * official-channel media.
 */
async function parseContent(
  accountId: string,
  message: OpenWAIncomingMessage
): Promise<{
  contentText: string | null
  mediaUrl: string | null
  contentType: string
}> {
  const hasMedia = Boolean(message.media)
  const contentType = mapContentType(message.type, hasMedia)

  if (message.location) {
    const loc = message.location
    const locationText = [loc.description, `${loc.latitude},${loc.longitude}`]
      .filter(Boolean)
      .join(' - ')
    return { contentText: locationText, mediaUrl: null, contentType: 'location' }
  }

  let mediaUrl: string | null = null
  if (message.media?.data && !message.media.omitted) {
    try {
      const buffer = Buffer.from(message.media.data, 'base64')
      if (buffer.byteLength > 0 && buffer.byteLength <= MEDIA_MAX_BYTES) {
        const mimetype = message.media.mimetype.split(';')[0].trim()
        const ext = extensionFor(mimetype, message.media.filename)
        const path = `account-${accountId}/${Date.now()}-openwa.${ext}`
        const { error: uploadError } = await supabaseAdmin()
          .storage.from('chat-media')
          .upload(path, buffer, { contentType: mimetype, upsert: false })
        if (uploadError) {
          console.error('[openwa-webhook] media upload failed:', uploadError)
        } else {
          const {
            data: { publicUrl },
          } = supabaseAdmin().storage.from('chat-media').getPublicUrl(path)
          mediaUrl = publicUrl
        }
      } else if (buffer.byteLength > MEDIA_MAX_BYTES) {
        console.warn(
          `[openwa-webhook] media exceeds ${MEDIA_MAX_BYTES} bytes — storing message without blob`
        )
      }
    } catch (err) {
      console.error('[openwa-webhook] media decode failed:', err)
    }
  }

  // A human-readable label per media kind, used when the media couldn't
  // be downloaded (mediaUrl null) so the bubble shows "[imagem]" instead
  // of a blank row. whatsapp-web.js fails to fetch some inbound media
  // ("Getter was called with undefined data"), most often for history-
  // sync messages — the label keeps those visible in the thread.
  const MEDIA_LABEL: Record<string, string> = {
    image: '[imagem]',
    video: '[vídeo]',
    audio: '[áudio]',
    document: '[documento]',
  }

  // For media, `body` carries the caption. For documents fall back to
  // the filename so the bubble has a label even without a caption.
  const contentText =
    message.body?.trim() ||
    (contentType === 'document' ? (message.media?.filename ?? null) : null) ||
    (contentType in MEDIA_LABEL && !mediaUrl ? MEDIA_LABEL[contentType] : null)

  return {
    contentText: contentType === 'text' ? (message.body ?? null) : contentText,
    mediaUrl,
    contentType,
  }
}

// ------------------------------------------------------------
// Contact / conversation find-or-create (channel-aware)
//
// Mirrors the official webhook's helpers; the conversation lookup adds
// `channel = 'openwa'` so the same customer can hold one thread per
// channel (unique index widened in migration 037).
// ------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

async function findOrCreateContact(
  accountId: string,
  ownerUserId: string,
  phone: string,
  name: string
): Promise<{ contact: ContactRow; wasCreated: boolean } | null> {
  const existingContact = await findExistingContact(
    supabaseAdmin(),
    accountId,
    phone
  )
  if (existingContact) {
    if (name && name !== phone && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[openwa-webhook] error creating contact:', createError)
    return null
  }
  return { contact: newContact, wasCreated: true }
}

async function findOrCreateConversation(
  accountId: string,
  ownerUserId: string,
  contactId: string
) {
  const { data: existingRows, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .eq('channel', 'openwa')
    .order('created_at', { ascending: true })
    .limit(1)

  if (findError) {
    console.error('[openwa-webhook] error finding conversation:', findError)
    return null
  }
  if (existingRows && existingRows.length > 0) {
    return { conversation: existingRows[0], created: false }
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      channel: 'openwa',
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const { data: raced } = await supabaseAdmin()
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .eq('channel', 'openwa')
        .order('created_at', { ascending: true })
        .limit(1)
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false }
      }
    }
    console.error('[openwa-webhook] error creating conversation:', createError)
    return null
  }
  return { conversation: newConv, created: true }
}
