-- ============================================================
-- 037_openwa_channel.sql — Unofficial WhatsApp channel via OpenWA
--
-- Adds a second, QR-code-authenticated WhatsApp channel per account,
-- backed by a self-hosted OpenWA gateway (github.com/rmyndharis/OpenWA).
-- The official Meta Cloud API channel (`whatsapp_config`) is untouched;
-- an account may now have up to one of each.
--
-- Design notes
--   - `openwa_config` mirrors the role of `whatsapp_config`: one row
--     per account (UNIQUE), settings-class RLS (members read, admin+
--     write). The OpenWA *instance* credentials (base URL + API key)
--     are deployment-level env vars, NOT per-tenant columns — every
--     account on this wacrm instance shares one OpenWA gateway, each
--     with its own named session.
--   - `qr_code` holds the raw QR string pushed by the gateway's
--     `session.qr` webhook. The settings UI subscribes to this table
--     via Supabase Realtime, so a re-emitted QR (they expire every
--     ~30s) re-renders without polling.
--   - `conversations.channel` discriminates which transport a thread
--     belongs to ('official' = Meta Cloud API, 'openwa' = unofficial).
--     Replies are routed by this column, so a thread can never be
--     answered through the wrong number. Messages need no column of
--     their own — they inherit the channel from their conversation;
--     `messages.message_id` stores the OpenWA message id instead of a
--     Meta wamid on openwa threads.
--   - The (account, contact) conversation-dedup index from migration
--     036 widens to (account, contact, channel): the same customer may
--     legitimately hold one official AND one unofficial thread.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ============================================================
-- 1. openwa_config — per-account unofficial channel state
-- ============================================================
CREATE TABLE IF NOT EXISTS openwa_config (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- Audit / sender-of-record for rows the inbound webhook creates
  -- (contacts, conversations need a NOT NULL user_id FK). Same
  -- convention as whatsapp_config.user_id: the admin who connected.
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- OpenWA session identifiers. `session_id` is the gateway's UUID;
  -- `session_name` is the human-readable unique name we create it
  -- under (wacrm-<account_id>) and the key of its auth dir on disk.
  session_id     TEXT,
  session_name   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'disconnected'
                 CHECK (status IN ('disconnected', 'connecting', 'qr_ready',
                                   'authenticating', 'connected', 'failed')),
  qr_code        TEXT,
  qr_updated_at  TIMESTAMPTZ,
  -- Filled from the gateway's `session.authenticated` event.
  phone          TEXT,
  push_name      TEXT,
  -- The webhook subscription we registered on the session, so
  -- disconnect/remove can clean it up.
  webhook_id     TEXT,
  last_error     TEXT,
  connected_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The inbound webhook resolves the tenant from the gateway's session
-- identifier (it has no auth context of its own).
CREATE INDEX IF NOT EXISTS idx_openwa_config_session_id
  ON openwa_config (session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_openwa_config_session_name
  ON openwa_config (session_name);

ALTER TABLE openwa_config ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see channel status.
DROP POLICY IF EXISTS openwa_config_select ON openwa_config;
CREATE POLICY openwa_config_select ON openwa_config FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only (settings-class, mirroring
-- webhook_endpoints / api_keys).
DROP POLICY IF EXISTS openwa_config_insert ON openwa_config;
CREATE POLICY openwa_config_insert ON openwa_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS openwa_config_update ON openwa_config;
CREATE POLICY openwa_config_update ON openwa_config FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS openwa_config_delete ON openwa_config;
CREATE POLICY openwa_config_delete ON openwa_config FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ============================================================
-- 2. conversations.channel — which transport owns the thread
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'official';

-- CHECK constraints can't use IF NOT EXISTS — guard with a catalog probe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'conversations_channel_check'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_channel_check
      CHECK (channel IN ('official', 'openwa'));
  END IF;
END $$;

-- Widen the migration-036 dedup guarantee to one conversation per
-- (account, contact, *channel*). Order matters: create the wider
-- unique index BEFORE dropping the narrower one so there is no window
-- where concurrent inbound webhooks could insert duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact_channel
  ON conversations (account_id, contact_id, channel);
DROP INDEX IF EXISTS idx_conversations_account_contact;

-- Inbox filters and channel-scoped lookups.
CREATE INDEX IF NOT EXISTS idx_conversations_account_channel
  ON conversations (account_id, channel);

-- ============================================================
-- 3. Realtime — the settings UI subscribes to openwa_config changes
--    (QR refresh, status transitions) instead of polling.
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'openwa_config'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE openwa_config;
  END IF;
END $$;
