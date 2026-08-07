const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: ws } }
);

/**
 * Reports whether the database is reachable. Deliberately does NOT exit the
 * process on failure: killing the server here means the platform only ever
 * reports a failed health check, with the actual Supabase error lost along
 * with the process. Staying up keeps /health and the logs reachable so the
 * cause is visible.
 */
async function verifyConnection() {
  try {
    const { error } = await supabase.from('sms_contacts').select('id').limit(1);
    if (error) {
      console.error('[STARTUP] Database unreachable:', error.message);
      console.error('[STARTUP] Serving in a degraded state — check SUPABASE_URL and SUPABASE_SERVICE_KEY.');
      return false;
    }
    console.log('[STARTUP] Database connected.');
    return true;
  } catch (err) {
    console.error('[STARTUP] Database check threw:', err.message);
    return false;
  }
}

// Insert into sms_messages, tolerating a not-yet-migrated schema: if the DB
// doesn't have the MMS/reply columns yet (PGRST204 unknown column), retry
// without them so plain text messages never break on deploy ordering.
const MIGRATION_COLUMNS = ['media_urls', 'reply_to_message_id', 'reactions'];

async function insertSmsMessage(row) {
  let { data, error } = await supabase
    .from('sms_messages')
    .insert(row)
    .select('id')
    .maybeSingle();

  if (error && error.code === 'PGRST204') {
    const fallback = { ...row };
    for (const col of MIGRATION_COLUMNS) delete fallback[col];
    console.warn('[DB] sms_messages missing MMS columns — run scripts/mms-reply-migration.sql. Inserting without them.');
    ({ data, error } = await supabase
      .from('sms_messages')
      .insert(fallback)
      .select('id')
      .maybeSingle());
  }

  if (error) throw new Error(error.message);
  return data;
}

module.exports = { supabase, verifyConnection, insertSmsMessage };
