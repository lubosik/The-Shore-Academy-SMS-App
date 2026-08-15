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
 *   POST /conversations/messages            ACTUALLY SENDS. This is used only
 *                                           by sendOutboundViaGhl as the sole
 *                                           logical send for an app message.
 *   POST /conversations/messages/inbound    records only.
 *   POST /conversations/messages/outbound   records only.
 * The record-only endpoints are used only after the message has already
 * travelled through Telnyx. A request must never call a real-send endpoint
 * and direct Telnyx for the same logical message.
 *
 * Everything here is advisory: a GHL failure must never break sending or
 * receiving a text. Errors are logged and swallowed.
 */

const { supabase } = require('../db');
const {
  ghlRequest,
  findContactByPhone,
  findConversationByContactId,
  upsertContactByPhone
} = require('./ghl-client');
const { upsertGhlContact } = require('./ghl-contact-store');

function configured() {
  return !!(process.env.GHL_PIT && process.env.GHL_LOCATION_ID);
}

/** Say the outbound-provider thing once, not once per message sent. */
let warnedNoProvider = false;

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

async function resolveConversationContext(phone) {
  const contactId = await resolveContactId(phone);
  if (!contactId) return { contactId: null, conversationId: null };
  try {
    const conversation = await findConversationByContactId(process.env.GHL_LOCATION_ID, contactId);
    return { contactId, conversationId: conversation?.id || null };
  } catch (err) {
    // `contactId` is sufficient for GHL to select/create the canonical thread.
    console.warn('[GHL-WB] Conversation lookup failed; falling back to contact id:', err.message);
    return { contactId, conversationId: null };
  }
}

function safeAttachments(mediaUrls) {
  if (!Array.isArray(mediaUrls)) return [];
  return [...new Set(mediaUrls
    .map(item => typeof item === 'string' ? item : item?.url)
    .filter(url => typeof url === 'string' && url.startsWith('https://')))]
    .slice(0, 10);
}

/**
 * Record a message in GHL without sending it.
 * @param {'inbound'|'outbound'} direction
 */
async function recordMessage(direction, phone, body, mediaUrls = []) {
  if (!configured()) return { skipped: 'not configured' };
  const text = (body || '').trim();
  const attachments = safeAttachments(mediaUrls);
  if (!text && attachments.length === 0) return { skipped: 'empty' };

  const { contactId, conversationId } = await resolveConversationContext(phone);
  if (!contactId) {
    // Not in GHL at all. Not an error: someone can text the number without
    // ever having been a GHL contact. The contact sync will catch up.
    console.log(`[GHL-WB] No GHL contact for ...${String(phone).slice(-4)} — nothing to record against`);
    return { skipped: 'no contact' };
  }

  // Recording an OUTBOUND message requires a conversationProviderId, which only
  // a GHL marketplace app can create — a Private Integration Token cannot, and
  // the Telnyx Bridge's appId is rejected ("No conversationProvider found").
  // Verified against the live API. So without one, skip rather than fail a
  // request per sent message. Inbound has no such requirement, which is why it
  // works and matters more: replies are what workflow branches actually test.
  if (direction === 'outbound' && !process.env.GHL_CONVERSATION_PROVIDER_ID) {
    if (!warnedNoProvider) {
      warnedNoProvider = true;
      console.log('[GHL-WB] GHL_CONVERSATION_PROVIDER_ID is not set — outbound messages will not be mirrored into GHL. Inbound and opt-outs are unaffected.');
    }
    return { skipped: 'no conversationProviderId' };
  }

  const path = direction === 'inbound'
    ? '/conversations/messages/inbound'
    : '/conversations/messages/outbound';

  const payload = { contactId, type: 'SMS', message: text };
  if (conversationId) payload.conversationId = conversationId;
  if (attachments.length) payload.attachments = attachments;
  if (direction === 'outbound') {
    payload.conversationProviderId = process.env.GHL_CONVERSATION_PROVIDER_ID;
  }

  const res = await ghlRequest('POST', path, payload);

  console.log(`[GHL-WB] ${direction} recorded in GHL | ...${String(phone).slice(-4)} | ${text.slice(0, 40)}`);
  return { ok: true, messageId: res?.messageId, conversationId: res?.conversationId };
}

/**
 * Mirror a customer's reply into GHL so reply-dependent workflow branches fire.
 */
async function recordInboundInGhl(phone, body, mediaUrls = []) {
  try {
    return await recordMessage('inbound', phone, body, mediaUrls);
  } catch (err) {
    console.error('[GHL-WB] Inbound write-back failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Mirror an outbound sent from this app so GHL's thread is complete and any
 * "has been contacted / has engaged" logic sees it.
 */
async function recordOutboundInGhl(phone, body, mediaUrls = []) {
  try {
    return await recordMessage('outbound', phone, body, mediaUrls);
  } catch (err) {
    console.error('[GHL-WB] Outbound write-back failed:', err.message);
    return { error: err.message };
  }
}

/**
 * Send exactly once through GHL's configured SMS provider. Unlike the
 * `/outbound` record-only endpoint, this is a real send. It is intentionally
 * used instead of (never in addition to) a direct Telnyx request, so GHL owns
 * the canonical message and thread while its Telnyx Bridge handles delivery.
 */
async function sendOutboundViaGhl(phone, body, mediaUrls = []) {
  if (!configured()) return { skipped: 'not configured' };
  const message = (body || '').trim();
  const attachments = safeAttachments(mediaUrls);
  if (!message && attachments.length === 0) return { skipped: 'empty' };

  let { contactId } = await resolveConversationContext(phone);
  if (!contactId) {
    const created = await upsertContactByPhone(process.env.GHL_LOCATION_ID, phone);
    contactId = created?.id || null;
    if (contactId) {
      try {
        await upsertGhlContact({
          ghlId: contactId,
          firstName: created?.firstName || null,
          lastName: created?.lastName || null,
          email: created?.email || null,
          phone: created?.phone || phone,
          tags: Array.isArray(created?.tags) ? created.tags : [],
          dateAdded: created?.dateAdded || null,
          country: created?.country || null,
          source: created?.source || 'Shore Inbox'
        }, 'shore-inbox');
      } catch (err) {
        console.warn('[GHL-WB] Created GHL contact but could not link it locally:', err.message);
      }
    }
  }
  if (!contactId) throw new Error('GHL could not resolve or create the contact');

  const payload = {
    type: 'SMS',
    contactId,
    message,
    status: 'pending'
  };
  if (attachments.length) payload.attachments = attachments;

  const result = await ghlRequest('POST', '/conversations/messages', payload);
  return {
    ok: true,
    messageId: result?.messageId || null,
    conversationId: result?.conversationId || null,
    status: 'queued'
  };
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

module.exports = {
  recordInboundInGhl,
  recordOutboundInGhl,
  sendOutboundViaGhl,
  setGhlDnd,
  resolveContactId,
  resolveConversationContext,
  safeAttachments
};
