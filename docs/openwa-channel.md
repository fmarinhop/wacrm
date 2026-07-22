# Unofficial WhatsApp channel (OpenWA)

wacrm can drive a second WhatsApp channel per account, authenticated by
**QR code** instead of Meta Business credentials, through a self-hosted
[OpenWA](https://github.com/rmyndharis/OpenWA) gateway. The official
Meta Cloud API channel is unchanged; an account may hold **one of
each**, and every conversation belongs to exactly one channel.

> **Risk notice** — OpenWA drives WhatsApp Web (whatsapp-web.js /
> Baileys). This is not approved by Meta and carries a non-zero risk of
> the number being restricted or banned. Use a dedicated number, warm it
> up, and never bulk-send through it (broadcasts stay official-only).

## Architecture

```
customer phone ⇄ WhatsApp ⇄ OpenWA gateway (one shared instance)
                                 │  session per account: wacrm-<account_id>
                     webhooks    │  REST (X-API-Key)
                                 ▼
                    wacrm  /api/openwa/webhook   (inbound events, HMAC-signed)
                    wacrm  src/lib/openwa/*      (outbound sends, session mgmt)
```

- **`openwa_config`** (migration 037) — one row per account: session
  ids, live status, the current QR string, connected phone. The
  settings UI subscribes to it via Supabase Realtime, so QR rotation
  and status flips render live without polling.
- **`conversations.channel`** — `'official' | 'openwa'`. Replies always
  route through the conversation's own channel
  (`src/lib/whatsapp/send-message.ts` and the flows/automations engine
  senders all dispatch on it). The migration-036 dedup index widens to
  `(account_id, contact_id, channel)`, so the same customer can hold
  one thread per channel.
- **Inbound** — the gateway POSTs signed events to
  `/api/openwa/webhook`: `session.qr` / `session.authenticated` /
  `session.disconnected` mirror channel state; `message.received`
  creates contact + conversation + message exactly like the Meta
  webhook and fires the same automations / flows / AI auto-reply;
  `message.sent` mirrors phone-side sends into the thread (API sends
  are deduped by `message_id`); `message.ack` advances delivery status
  along the same forward-only ladder as the official channel.
- **Media** — inbound media arrives base64-inline and is persisted to
  the public `chat-media` bucket; outbound media is sent by public URL
  from that same bucket.

## Feature matrix

| Capability | Official (Meta) | Unofficial (OpenWA) |
| --- | --- | --- |
| Text, image, video, audio, document | ✅ | ✅ |
| Location, reactions (inbound) | ✅ | partial |
| Message templates | ✅ | ❌ (rejected with a clear error) |
| Interactive buttons / lists | ✅ | ❌ (rejected with a clear error) |
| Broadcasts | ✅ | ❌ (deliberately not wired) |
| 24h customer-service window | applies | does not apply |

## Setup

1. **Gateway** — run OpenWA (Docker) reachable from the wacrm server.
   Create an API key with the `OPERATOR` role, and add the wacrm
   public hostname to the gateway's `SSRF_ALLOWED_HOSTS` (otherwise its
   SSRF guard blocks webhook deliveries to wacrm).
2. **Env** — in `.env.local` (see `.env.local.example`):
   `OPENWA_BASE_URL` (including `/api`), `OPENWA_API_KEY`,
   `OPENWA_WEBHOOK_SECRET` (`openssl rand -hex 32`), and
   `NEXT_PUBLIC_APP_URL` (this deployment's public URL).
3. **Migration** — apply `supabase/migrations/037_openwa_channel.sql`.
4. **Connect** — Settings → WhatsApp → "WhatsApp via QR code" →
   Connect. Scan the QR with the phone (Settings → Linked devices →
   Link a device). On `session.authenticated` the card flips to
   Connected with the number and profile name.

## Operational notes

- **Session persistence lives on the gateway's disk**
  (`SESSION_DATA_PATH`). Losing that volume logs every account out
  (fresh QR scans required) — back it up. wacrm holds no session
  credentials, only pointers.
- **Disconnect vs Remove** — Disconnect stops the gateway session but
  keeps its auth on disk (reconnect resumes without a new scan).
  Remove deletes the gateway session and its auth entirely.
- **Local development** — the gateway must be able to reach your
  machine to deliver webhooks: expose the dev server with a tunnel
  (cloudflared/ngrok), point `NEXT_PUBLIC_APP_URL` at the tunnel URL,
  and allow that host in the gateway's `SSRF_ALLOWED_HOSTS`. Without
  webhooks the settings card still works in degraded mode (it polls
  `/api/openwa/qr` and live-refreshes status on page load), but inbound
  messages will not arrive.
