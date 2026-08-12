'use strict';
/**
 * lib/ghl-writeback.js — pushes the app's side of a conversation into GoHighLevel.
 *
 * GHL is The Shore Academy's brain: 15 published workflows drive every
 * sequence. But GHL sends through its "Telnyx Bridge" app and never receives —
 * a scan of all 29 conversations found 5 outbound SMS and ZERO inbound. So
 * every workflow branch that asks "did they reply?" is permanently false, and
 * an opt-out recorded here is invisible to the thing actually sending.
 *
 * This closes that loop. It does NOT need to know what any workflow contains:
 * if GHL sees the same conversation it would have seen had it owned the
 * channel, all 15 behave correctly on their own.
 *
 * ENDPOINT SAFETY — the important detail. GHL has three:
 *   POST /conversations/messages            ACTUALLY SENDS. Never use it here;
 *                                           the customer has already been
 *                                           texted via Telnyx, so this would
 *                                           deliver the message a second time.
 *   POST /conversations/messages/inbound    records only.
 *   POST /conversations/messages/outbound   records only.
 * Only the latter two appear below, deliberately.
 *
 * Everything here is advisory: a GHL failure must never break sending or
 * receiving a text. Errors are logged and swallowed.
 */

const { supabase } = require('../db');
const { ghlRequest, findContactByPhone } = require('./ghl-client');
const { upsertGhlContact } = require('./ghl-contact-store');

function configured() {
  return !!(process.env.GHL_PIT && process.env.GHL_LOCATION_ID);
}

/**
 * The GHL contact id for a phone number.
 *
 * Checks our own row first — that is the common case and costs no API call.
 * Falls back to asking GHL, and stores what it learns so the next message on
 * this thread is free.
 */
async function resolveContactId(phone) {
  if (!phone) return null;

  const { data: row } = await supabase
    .from('sms_contacts')
    .select('ghl_contact_id')
    .eq('phone', phone)
    .maybeSingle();
  if (row?.ghl_contact_id) return row.ghl_contact_id;

  const contact = await findContactByPhone(process.env.GHL_LOCATION_ID, phone);
  if (!contact?.id) return null;

  // Link it locally so this lookup happens once per contact, not once per message.
  try {
    await upsertGhlContact({
      ghlId: contact.id,
      firstName: contact.firstName || null,
      lastName: contact.lastName || null,
      email: contact.email || null,
      phone: contact.phone || phone,
      tags: Array.isArray(contact.tags) ? contact.tags : [],
      dateAdded: contact.dateAdded || null,
      country: contact.country || null,
      source: contact.source || null
    }, 'ghl-writeback');
  } catch (err) {
    console.warn('[GHL-WB] Could not link contact locally:', err.message);
  }
  return contact.id;
}

/**
 * Record a message in GHL without sending it.
 * @param {'inbound'|'outbound'} direction
 */
async function recordMessage(direction, phone, body) {
  if (!configured()) return { skipped: 'not configured' };
  const text = (body || '').trim();
  if (!text) return { skipped: 'empty' };

  const contactId = await resolveContactId(phone);
  if (!contactId) {
    // Not in GHL at all. Not an error: someone can text the number without
    // ever having been a GHL contact. The contact sync will catch up.
    console.log(`[GHL-WB] No GHL contact for ...${String(phone).slice(-4)} — nothing to record against`);
    return { skipped: 'no contact' };
  }

  const path = direction === 'inbound'
    ? '/conversations/messages/inbound'
    : '/conversations/messages/outbound';

  const res = await ghlRequest('POST', path, {
    contactId,
    type: 'SMS',
    message: text
  });

  console.log(`[GHL-WB] ${direction} recorded in GHL | ...${String(phone).slice(-4)} | ${text.slice(0, 40)}`);
  return { ok: true, messageId: res?.messageId, conversationId: res?.conversationId };
}

/**
 * Mirror a customer's reply into GHL so reply-dependent workflow branches fire.
 */
async function recordInboundInGhl(phone, body) {
  try {
    return await recordMessage('inbound', phone, body);
  } catch (err) {
    console.error('[GHL-WB] Inbound write-back failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Mirror an outbound sent from this app so GHL's thread is complete and any
 * "has been contacted / has engaged" logic sees it.
 */
async function recordOutboundInGhl(phone, body) {
  try {
    return await recordMessage('outbound', phone, body);
  } catch (err) {
    console.error('[GHL-WB] Outbound write-back failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Set Do Not Disturb on the GHL contact after a STOP.
 *
 * This is the compliance link and the most important function in the file.
 * Recording an opt-out only in our own database protects sends that go through
 * this app — but GHL sends through the Telnyx Bridge and never asks us. Without
 * this, a customer who texts STOP keeps receiving workflow messages.
 */
async function setGhlDnd(phone) {
  if (!configured()) return { skipped: 'not configured' };
  try {
    const contactId = await resolveContactId(phone);
    if (!contactId) {
      console.warn(`[GHL-WB] OPT-OUT: no GHL contact for ...${String(phone).slice(-4)} — cannot set DND`);
      return { skipped: 'no contact' };
    }
    await ghlRequest('PUT', `/contacts/${contactId}`, { dnd: true });
    console.log(`[GHL-WB] OPT-OUT: DND set in GHL for ...${String(phone).slice(-4)} — workflows will stop`);
    return { ok: true };
  } catch (err) {
    // Loud: this failing means GHL may keep texting someone who opted out.
    console.error(`[GHL-WB] OPT-OUT: FAILED to set DND for ...${String(phone).slice(-4)}: ${err.message}`);
    return { error: err.message };
  }
}

module.exports = { recordInboundInGhl, recordOutboundInGhl, setGhlDnd, resolveContactId };
