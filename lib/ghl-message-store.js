'use strict';
/**
 * lib/ghl-message-store.js — writes GoHighLevel messages into sms_messages.
 *
 * GHL sends The Shore Academy's automated SMS through its "Telnyx Bridge"
 * marketplace app, which bypasses this app entirely. Replies come back to our
 * Telnyx number and land here. The result before this module existed: GHL held
 * every outbound message, the app held every reply, and neither had a whole
 * conversation.
 *
 * This mirrors GHL's side in. GHL remains the sender and the system of record;
 * the app becomes the place you can actually read the thread.
 *
 * Dedup is deliberately belt-and-braces:
 *   1. ghl_message_id carries a UNIQUE index, so re-running the sync, letting
 *      its time window overlap, or racing a second Railway instance can never
 *      duplicate a row.
 *   2. Before inserting, a near-identical row (same phone, direction and body
 *      within a few minutes) is stamped with the GHL id instead. Today the two
 *      paths are disjoint, but if GHL is ever wired to see inbound as well,
 *      this stops the same message appearing twice.
 */

const { supabase } = require('../db');
const { normalisePhone } = require('./phone');

/** Window for treating an existing row as the same message arriving twice. */
const NEAR_DUPLICATE_WINDOW_MS = 3 * 60 * 1000;

/**
 * GHL carries email, calls and internal notes on the same conversation object.
 * This is an SMS inbox and the thread UI renders SMS bubbles, so only text
 * messages are mirrored. Emails stay in GHL where they render properly.
 */
function isTextMessage(m) {
  if (m?.messageType && m.messageType !== 'TYPE_SMS') return false;
  // Numeric fallback for payloads that omit messageType: 2 = SMS, 3 = email.
  if (!m?.messageType && m?.type !== undefined && m.type !== 2) return false;
  return true;
}

/**
 * True when this app already sent or received the message itself, so the GHL
 * copy is a mirror of our own row rather than new information.
 */
async function findNearDuplicate({ phone, direction, body, sentAt }) {
  if (!body) return null;
  const from = new Date(sentAt.getTime() - NEAR_DUPLICATE_WINDOW_MS).toISOString();
  const to   = new Date(sentAt.getTime() + NEAR_DUPLICATE_WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from('sms_messages')
    .select('id, body, ghl_message_id')
    .eq('contact_phone', phone)
    .eq('direction', direction)
    .gte('created_at', from)
    .lte('created_at', to)
    .limit(20);

  if (error) throw new Error(error.message);
  return (data || []).find(row => (row.body || '').trim() === body.trim()) || null;
}

/**
 * Store one GHL message.
 *
 * @param {object} m raw GHL message
 * @param {string} fallbackPhone conversation phone, used when the message omits one
 * @returns {'inserted'|'linked'|'skipped-duplicate'|'skipped-not-sms'|'skipped-no-phone'|'skipped-empty'}
 */
async function storeGhlMessage(m, fallbackPhone) {
  if (!isTextMessage(m)) return 'skipped-not-sms';

  const body = (m?.body || '').trim();
  if (!body) return 'skipped-empty';

  // For outbound the customer is `to`; for inbound they are `from`. Either can
  // be a display name ("The Shore Academy") rather than a number, and
  // normalisePhone returns null for those, so the conversation phone wins.
  const raw = m.direction === 'inbound' ? (m.from || fallbackPhone) : (m.to || fallbackPhone);
  const phone = normalisePhone(raw ? String(raw) : null)
             || normalisePhone(fallbackPhone ? String(fallbackPhone) : null);
  if (!phone) return 'skipped-no-phone';

  const ghlId = m.id;
  if (ghlId) {
    const { data: existing, error } = await supabase
      .from('sms_messages')
      .select('id')
      .eq('ghl_message_id', ghlId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (existing) return 'skipped-duplicate';
  }

  const sentAt = m.dateAdded ? new Date(m.dateAdded) : new Date();
  const direction = m.direction === 'inbound' ? 'inbound' : 'outbound';

  // Same message already here from the Telnyx side — link, do not duplicate.
  const twin = await findNearDuplicate({ phone, direction, body, sentAt });
  if (twin) {
    if (!twin.ghl_message_id && ghlId) {
      await supabase.from('sms_messages').update({ ghl_message_id: ghlId }).eq('id', twin.id);
      return 'linked';
    }
    return 'skipped-duplicate';
  }

  const row = {
    ghl_message_id: ghlId || null,
    contact_phone:  phone,
    direction,
    body,
    // GHL reports delivery for outbound; a mirrored row is never pending.
    status:         m.status === 'failed' ? 'failed' : 'delivered',
    source:         'ghl-mirror',
    created_at:     sentAt.toISOString()
  };

  const { error } = await supabase.from('sms_messages').insert(row);
  if (error) {
    // 23505 = the unique index caught a concurrent insert of the same message.
    if (error.code === '23505') return 'skipped-duplicate';
    throw new Error(error.message);
  }
  return 'inserted';
}

module.exports = { storeGhlMessage, isTextMessage, NEAR_DUPLICATE_WINDOW_MS };
