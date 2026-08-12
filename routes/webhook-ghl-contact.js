'use strict';
/**
 * routes/webhook-ghl-contact.js — POST /webhook/ghl/contact/:secret
 *
 * Called by a GoHighLevel WORKFLOW "Webhook" action (configured by hand in
 * the GHL UI) whenever a new contact opts in. This is NOT a native
 * Marketplace webhook: a Private Integration Token cannot create webhook
 * subscriptions via API, and workflow webhooks carry no signature — which is
 * why the shared secret rides in the URL and is compared timing-safely.
 *
 * The exact JSON key casing of a workflow webhook payload is not documented,
 * so fields are picked defensively from several likely shapes. The first
 * time an unrecognised shape arrives, the full raw body is logged once so
 * the picker can be tightened after the first real payload.
 *
 * Always answers 200 quickly — GHL retries error responses, and a retried
 * webhook could duplicate work. Failures are logged, never surfaced.
 */

const crypto = require('crypto');
const { upsertGhlContact, buildFullName } = require('../lib/ghl-contact-store');
const { sendNativeMessagePush } = require('../lib/apns-notify');

function timingSafeMatch(provided, expected) {
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(String(provided)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Pick the first non-empty value across the key spellings a GHL workflow
// webhook might use, checking the top level and a nested `contact` object.
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

function pickTags(body) {
  const raw = body?.tags ?? body?.contact?.tags ?? body?.Tags;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return raw.split(',').map(t => t.trim()).filter(Boolean);
  return [];
}

let loggedUnrecognisedShape = false;

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/ghl/contact/:secret', async (req, res) => {
    const expected = process.env.GHL_WEBHOOK_SECRET;
    if (!expected) {
      console.error('[GHL-WEBHOOK] GHL_WEBHOOK_SECRET is not configured — rejecting');
      return res.status(503).json({ error: 'Webhook not configured', code: 503 });
    }
    if (!timingSafeMatch(req.params.secret, expected)) {
      return res.status(401).json({ error: 'Unauthorised', code: 401 });
    }

    // Acknowledge immediately: GHL retries non-200s, which could duplicate
    // contacts. Everything below runs after the response.
    res.status(200).json({ received: true });

    try {
      const body = req.body || {};

      const contact = {
        ghlId:     pick(body, ['contact_id', 'contactId', 'id', 'Contact ID']),
        firstName: pick(body, ['firstName', 'first_name', 'First Name', 'firstname']),
        lastName:  pick(body, ['lastName', 'last_name', 'Last Name', 'lastname']),
        email:     pick(body, ['email', 'Email', 'email_address']),
        phone:     pick(body, ['phone', 'Phone', 'phone_number', 'phoneNumber']),
        tags:      pickTags(body),
        dateAdded: pick(body, ['dateAdded', 'date_added', 'Date Added', 'date_created', 'dateCreated']),
        country:   pick(body, ['country', 'Country']),
        source:    pick(body, ['contact_source', 'source', 'Source']) || 'ghl-webhook'
      };

      if (!contact.phone && !loggedUnrecognisedShape) {
        // First unrecognised payload shape — log it whole so the field
        // picker can be tightened after the first real delivery.
        loggedUnrecognisedShape = true;
        console.warn('[GHL-WEBHOOK] Unrecognised payload shape (no phone found). Raw body follows:');
        console.warn(JSON.stringify(body).slice(0, 5000));
      }

      const { action, phone } = await upsertGhlContact(contact, 'ghl-webhook');
      if (action === 'skipped-no-phone') {
        console.warn(`[GHL-WEBHOOK] New contact had no usable phone — not stored | ghl=${contact.ghlId || 'unknown'}`);
        return;
      }
      console.log(`[GHL-WEBHOOK] Contact ${action} | phone=...${phone.slice(-4)}`);

      const name = buildFullName(contact.firstName, contact.lastName) || phone;

      // Live update for any open web inbox.
      broadcastSSE({
        type: 'contact_added',
        phone,
        name,
        source: 'ghl-webhook'
      });

      // iOS push — same phone payload as the message push, so tapping it
      // deep-links to that conversation.
      try {
        await sendNativeMessagePush({
          title: 'New Shore Academy contact 👋',
          body: `${name} just came in — go say hi.`,
          phone
        });
      } catch (pushErr) {
        console.error('[GHL-WEBHOOK] APNs push failed:', pushErr.message);
      }
    } catch (err) {
      // Never let a processing failure turn into a webhook retry storm.
      console.error('[GHL-WEBHOOK] Processing error:', err.message);
    }
  });

  return router;
};
