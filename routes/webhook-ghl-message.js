'use strict';
/**
 * routes/webhook-ghl-message.js — POST /webhook/ghl/message/:secret
 *
 * Called by a GoHighLevel WORKFLOW "Webhook" action placed immediately after
 * a "Send SMS" action, so the inbox learns about a message GHL just sent the
 * moment it goes out.
 *
 * This endpoint NEVER SENDS. GHL has already sent the message through its
 * Telnyx Bridge app by the time this fires; all this does is record it so the
 * app's thread matches GHL's. Sending here would double-text the customer,
 * which is why it is a separate route from /webhook/send rather than a flag
 * on it.
 *
 * Like the new-contact webhook, a workflow webhook carries no signature, so
 * the shared secret rides in the URL path and is compared timing-safely.
 *
 * The background sync in sync-ghl.js still runs and still reconciles. This is
 * the fast path; that is the safety net for messages no workflow announced —
 * a workflow someone forgot to wire, or a reply Dominic typed by hand in GHL.
 * Both write through the same dedup, so a message announced here and later
 * seen by the sync is stored exactly once.
 */

const crypto = require('crypto');
const { storeGhlMessage } = require('../lib/ghl-message-store');
const { upsertGhlContact } = require('../lib/ghl-contact-store');
const { normalisePhone } = require('../lib/phone');

function timingSafeMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Same defensive picker as the contact webhook: workflow payload key casing
// is not documented and varies with how the action is built in the UI.
function pick(body, keys) {
  const containers = [body, body?.contact, body?.customData, body?.custom_data];
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of keys) {
      const value = container[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }
  }
  return null;
}

let loggedUnrecognisedShape = false;

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/ghl/message/:secret', async (req, res) => {
    const expected = process.env.GHL_WEBHOOK_SECRET;
    if (!expected) {
      console.error('[GHL-MSG] GHL_WEBHOOK_SECRET is not configured — rejecting');
      return res.status(503).json({ error: 'Webhook not configured', code: 503 });
    }
    if (!timingSafeMatch(req.params.secret, expected)) {
      return res.status(401).json({ error: 'Unauthorised', code: 401 });
    }

    // Answer before doing the work: GHL retries a non-200, and a retry here
    // would only ever be a duplicate.
    res.status(200).json({ received: true });

    try {
      const body = req.body || {};

      const rawPhone = pick(body, ['phone', 'Phone', 'to', 'phone_number', 'phoneNumber']);
      const message  = pick(body, ['message', 'Message', 'body', 'text', 'sms', 'messageBody']);
      const phone    = normalisePhone(rawPhone);

      if (!phone || !message) {
        if (!loggedUnrecognisedShape) {
          loggedUnrecognisedShape = true;
          console.warn('[GHL-MSG] Unrecognised payload shape. Raw body follows so the picker can be tightened:');
          console.warn(JSON.stringify(body).slice(0, 5000));
        }
        console.warn(`[GHL-MSG] Ignored — ${!phone ? 'no usable phone' : 'no message body'}`);
        return;
      }

      // Direction is assumed outbound: this fires from a Send SMS action.
      // Honoured if the workflow states it, so the same endpoint can record a
      // manual reply if that is ever wired up.
      const direction = (pick(body, ['direction']) || 'outbound').toLowerCase() === 'inbound'
        ? 'inbound' : 'outbound';

      const contactId = pick(body, ['contact_id', 'contactId', 'id', 'Contact ID']);
      const firstName = pick(body, ['firstName', 'first_name', 'First Name', 'firstname']);
      const lastName  = pick(body, ['lastName', 'last_name', 'Last Name', 'lastname']);

      // Keep the contact current, but never let a contact problem lose the
      // message — the thread matters more than the name on it.
      if (contactId || firstName || lastName) {
        try {
          await upsertGhlContact({
            ghlId: contactId, firstName, lastName,
            email: pick(body, ['email', 'Email']),
            phone,
            tags: [], dateAdded: null, country: null, source: null
          }, 'ghl-message-webhook');
        } catch (contactErr) {
          console.error('[GHL-MSG] Contact upsert failed:', contactErr.message);
        }
      }

      const result = await storeGhlMessage({
        id:          pick(body, ['messageId', 'message_id', 'ghlMessageId']),
        body:        message,
        direction,
        dateAdded:   new Date().toISOString(),
        to:          phone,
        messageType: 'TYPE_SMS'
      }, phone);

      if (result === 'inserted') {
        broadcastSSE({ type: 'new_message', phone, body: message.slice(0, 500), direction });
        console.log(`[GHL-MSG] Recorded ${direction} | ...${phone.slice(-4)} | ${message.slice(0, 50)}`);
      } else {
        // Usually means the background sync got there first. Not a problem.
        console.log(`[GHL-MSG] ${result} | ...${phone.slice(-4)}`);
      }
    } catch (err) {
      console.error('[GHL-MSG] Processing error:', err.message);
    }
  });

  return router;
};
