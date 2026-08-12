'use strict';
/**
 * sync-ghl.js — keeps the app in step with GoHighLevel.
 *
 * The Shore Academy runs every automation in GHL, and GHL sends its SMS
 * through the "Telnyx Bridge" marketplace app, which never touches this app.
 * So GHL knows things the inbox does not: new leads the moment they opt in,
 * and every automated message it has sent them.
 *
 * This job pulls both across on a timer. It is a mirror, never a sender —
 * nothing here puts a message on the wire.
 *
 * Why polling and not webhooks alone: a GHL workflow webhook has to be wired
 * by hand for each workflow, and one that is forgotten fails silently. The
 * poll is the safety net that makes the inbox correct regardless of how GHL
 * is configured. The new-contact webhook still runs, and still delivers the
 * push instantly; this job then finds nothing new to do.
 *
 * Idempotent by construction: contacts upsert on ghl_contact_id and messages
 * on a UNIQUE ghl_message_id, so overlapping runs and concurrent instances
 * are safe.
 */

// Before ./db, which builds its Supabase client at require time. server.js has
// already loaded this; the repeat is a no-op and makes a direct CLI run work.
require('dotenv').config();

const { supabase } = require('./db');
const { searchConversations, getConversationMessages, sleep, PAGE_PAUSE_MS } = require('./lib/ghl-client');
const { upsertGhlContact } = require('./lib/ghl-contact-store');
const { storeGhlMessage } = require('./lib/ghl-message-store');
const { sendNativeMessagePush } = require('./lib/apns-notify');
const { broadcast } = require('./lib/broadcaster');

const WATERMARK_KEY = 'ghl_messages_synced_through';

/**
 * Re-examine a window before the watermark on every run. GHL's list is
 * ordered by last_message_date, and a message can be written a moment after
 * the timestamp it carries, so a strict ">" would eventually skip one.
 * Dedup makes the repeated work free.
 */
const OVERLAP_MS = 10 * 60 * 1000;

/** How far back a first run reaches when there is no watermark yet. */
const FIRST_RUN_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

let migrationWarningLogged = false;

/**
 * The mirror needs columns added by scripts/ghl-mirror-migration.sql. Two
 * migrations have already been forgotten on these projects, so rather than
 * failing obscurely on every tick this reports the cause once and stands down.
 */
async function mirrorColumnsExist() {
  const { error } = await supabase.from('sms_messages').select('ghl_message_id').limit(1);
  if (!error) return true;
  if (!migrationWarningLogged) {
    migrationWarningLogged = true;
    console.error('[GHL-SYNC] sms_messages.ghl_message_id is missing — run scripts/ghl-mirror-migration.sql in the Supabase SQL editor. Sync is standing down until then.');
    console.error('[GHL-SYNC] Reported by PostgREST as:', error.message);
  }
  return false;
}

async function readWatermark() {
  const { data, error } = await supabase
    .from('sms_sync_state')
    .select('value')
    .eq('key', WATERMARK_KEY)
    .maybeSingle();
  if (error) {
    console.warn('[GHL-SYNC] Could not read watermark:', error.message);
    return null;
  }
  const ms = data?.value ? Number(data.value) : null;
  return Number.isFinite(ms) ? ms : null;
}

async function writeWatermark(ms) {
  const { error } = await supabase
    .from('sms_sync_state')
    .upsert({ key: WATERMARK_KEY, value: String(ms), updated_at: new Date().toISOString() },
            { onConflict: 'key' });
  if (error) console.warn('[GHL-SYNC] Could not save watermark:', error.message);
}

/** Shape a GHL conversation into the contact record the store expects. */
function contactFromConversation(conv) {
  const full = (conv.contactName || conv.fullName || '').trim();
  const space = full.indexOf(' ');
  return {
    ghlId:     conv.contactId,
    firstName: space > 0 ? full.slice(0, space) : (full || null),
    lastName:  space > 0 ? full.slice(space + 1) : null,
    email:     conv.email || null,
    phone:     conv.phone || null,
    tags:      Array.isArray(conv.tags) ? conv.tags : [],
    dateAdded: conv.dateAdded ? new Date(conv.dateAdded).toISOString() : null,
    country:   null,
    source:    null
  };
}

/**
 * Run one sync pass.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.full] ignore the watermark and walk every conversation
 * @param {boolean} [opts.quiet] only log when something changed
 * @returns {object} counts
 */
async function syncFromGhl({ full = false, quiet = false } = {}) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId || !process.env.GHL_PIT) {
    return { skipped: 'GHL not configured' };
  }
  if (!(await mirrorColumnsExist())) {
    return { skipped: 'migration not run' };
  }

  const stats = {
    conversations: 0, scanned: 0, contactsAdded: 0, contactsUpdated: 0,
    messagesAdded: 0, messagesLinked: 0, errors: 0
  };

  const watermark = full ? null : await readWatermark();
  const since = watermark !== null
    ? watermark - OVERLAP_MS
    : Date.now() - FIRST_RUN_LOOKBACK_MS;

  let highWater = watermark || 0;

  const { conversations } = await searchConversations({ locationId });
  stats.conversations = conversations.length;

  for (const conv of conversations) {
    const lastMessageMs = Number(conv.lastMessageDate) || 0;
    if (lastMessageMs > highWater) highWater = lastMessageMs;

    // Contacts are reconciled for every conversation, not just active ones —
    // a lead can exist in GHL with no message yet, and should still show up.
    if (conv.phone) {
      try {
        const { action, phone } = await upsertGhlContact(contactFromConversation(conv), 'ghl-sync');
        if (action === 'inserted') {
          stats.contactsAdded++;
          const name = (conv.contactName || conv.fullName || '').trim() || phone;
          broadcast({ type: 'contact_added', phone, name, source: 'ghl-sync' });
          // Same push the new-contact webhook sends. Only fires on a genuine
          // insert, so a webhook that already handled this lead wins the race
          // and nobody is notified twice.
          try {
            await sendNativeMessagePush({
              title: 'New Shore Academy contact 👋',
              body: `${name} just came in — go say hi.`,
              phone
            });
          } catch (pushErr) {
            console.error('[GHL-SYNC] Push failed:', pushErr.message);
          }
        } else if (action === 'updated') {
          stats.contactsUpdated++;
        }
      } catch (err) {
        stats.errors++;
        console.error(`[GHL-SYNC] Contact ${conv.contactId} failed:`, err.message);
      }
    }

    // Only pull messages for threads that have moved since we last looked.
    if (!full && lastMessageMs && lastMessageMs < since) continue;

    stats.scanned++;
    try {
      const messages = await getConversationMessages(conv.id);
      for (const m of messages) {
        try {
          const result = await storeGhlMessage(m, conv.phone);
          if (result === 'inserted') {
            stats.messagesAdded++;
            broadcast({
              type: 'new_message',
              phone: conv.phone,
              body: (m.body || '').slice(0, 500),
              direction: m.direction === 'inbound' ? 'inbound' : 'outbound'
            });
          } else if (result === 'linked') {
            stats.messagesLinked++;
          }
        } catch (err) {
          stats.errors++;
          console.error(`[GHL-SYNC] Message ${m?.id} failed:`, err.message);
        }
      }
    } catch (err) {
      stats.errors++;
      console.error(`[GHL-SYNC] Conversation ${conv.id} failed:`, err.message);
    }

    await sleep(PAGE_PAUSE_MS);
  }

  // Only advance on a clean pass. Moving the watermark past a conversation
  // that errored would skip it permanently on the next run.
  if (highWater && stats.errors === 0) await writeWatermark(highWater);

  const changed = stats.contactsAdded || stats.messagesAdded || stats.contactsUpdated || stats.errors;
  if (!quiet || changed) {
    console.log(
      `[GHL-SYNC] ${stats.conversations} conversations, ${stats.scanned} scanned | ` +
      `contacts +${stats.contactsAdded}/~${stats.contactsUpdated} | ` +
      `messages +${stats.messagesAdded}/linked ${stats.messagesLinked} | errors ${stats.errors}`
    );
  }
  return stats;
}

/**
 * Start the background reconciliation pass.
 *
 * The two GHL workflow webhooks are the fast path and deliver in real time.
 * This exists to catch what they cannot: a workflow nobody wired a webhook
 * onto, a webhook that failed while the app was redeploying, or a reply typed
 * by hand inside GHL, which fires no workflow at all.
 *
 * Fifteen minutes because it is a backstop, not the primary path. That is
 * ~100 GHL calls a day against a published ceiling of 200,000, so the cost is
 * immaterial either way — the reason not to poll faster is that the webhooks
 * already did the job, not the quota.
 */
function startGhlSync(intervalMs = 15 * 60 * 1000) {
  if (!process.env.GHL_PIT || !process.env.GHL_LOCATION_ID) {
    console.log('[GHL-SYNC] Disabled — GHL_PIT / GHL_LOCATION_ID not set.');
    return;
  }

  // An in-process guard, not a distributed lock. Two Railway instances during
  // an overlapping deploy will both run this; that is safe because every write
  // is idempotent, and a lock table would be more machinery than a read-only
  // mirror at this size warrants.
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncFromGhl({ quiet: true });
    } catch (err) {
      console.error('[GHL-SYNC] Pass failed:', err.message);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, 20 * 1000);   // let the app finish booting first
  setInterval(tick, intervalMs);
  console.log(`[GHL-SYNC] Mirroring GoHighLevel every ${Math.round(intervalMs / 1000)}s.`);
}

module.exports = { syncFromGhl, startGhlSync, WATERMARK_KEY };

// Run directly for a one-off backfill:
//   node sync-ghl.js --full
if (require.main === module) {
  syncFromGhl({ full: process.argv.includes('--full') })
    .then(stats => { console.log('[GHL-SYNC] Done:', stats); process.exit(0); })
    .catch(err => { console.error('[GHL-SYNC] Failed:', err.message); process.exit(1); });
}
