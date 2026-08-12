-- scripts/ghl-mirror-migration.sql
-- Run once in the Supabase SQL editor for The Shore Academy project.
--
-- Purpose: let the app mirror everything GoHighLevel has.
--
-- All marketing automation stays in GHL, and GHL keeps sending SMS through
-- its "Telnyx Bridge" marketplace app. Those outbound messages never touch
-- this app, so the inbox only ever saw the customer's replies — half a
-- conversation. These columns let a background job pull GHL's side in and
-- interleave it into the same thread.
--
-- Safe to re-run. Nothing is dropped or rewritten.

-- The GHL message id. Unique so the sync can run repeatedly, overlap its own
-- time window, and race a second instance without ever duplicating a message.
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS ghl_message_id text;

-- Where the row came from: NULL/'app' for messages this app sent or received
-- directly through Telnyx, 'ghl-mirror' for messages pulled from GHL.
ALTER TABLE sms_messages ADD COLUMN IF NOT EXISTS source text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_messages_ghl_message_id
  ON sms_messages(ghl_message_id)
  WHERE ghl_message_id IS NOT NULL;

-- Supports the near-duplicate lookup the mirror does before inserting, so a
-- message that somehow arrives down both paths is stamped rather than doubled.
CREATE INDEX IF NOT EXISTS idx_sms_messages_phone_created
  ON sms_messages(contact_phone, created_at DESC);

-- Watermark storage for the incremental sync. A table rather than an env var
-- so the position survives a redeploy.
CREATE TABLE IF NOT EXISTS sms_sync_state (
  key        text PRIMARY KEY,
  value      text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sms_sync_state DISABLE ROW LEVEL SECURITY;
