/**
 * POST /webhook/send
 * Called by GHL custom webhook action to send an outbound SMS.
 * Mirrors the old bridge's /send endpoint format exactly.
 * Auth: x-webhook-secret header OR body.webhookSecret OR ?secret= query param.
 */

const { supabase } = require('../db');
const { sendSMS } = require('../telnyx');
const { formatPhone, isOptedOut } = require('../lib/compliance');
const { normaliseTelnyxStatus } = require('../lib/message-status');

function isAuthorized(req) {
  // Fail closed. This previously returned true when WEBHOOK_SECRET was unset,
  // which turns a public endpoint that sends SMS into an open relay the moment
  // the variable goes missing from the environment.
  if (!process.env.WEBHOOK_SECRET) {
    console.error('[GHL-SEND] WEBHOOK_SECRET is not set — refusing to send.');
    return false;
  }
  const provided =
    req.get('x-webhook-secret') ||
    req.body?.webhookSecret ||
    req.query?.secret;
  return provided === process.env.WEBHOOK_SECRET;
}

function extractPayload(body = {}) {
  const c = body.customData || body.custom_data || body.data?.customData || {};
  return {
    to:        body.to        || c.to        || body.phone       || body.contact?.phone,
    message:   body.message   || c.message   || body.text        || c.text,
    contactId: body.contactId || body.contactID || c.contactId   || c.contactID || body.contact?.id,
    name:      body.name      || c.name      || body.contact?.name ||
               [body.contact?.firstName, body.contact?.lastName].filter(Boolean).join(' ') || null
  };
}

function isValidPhone(phone) {
  if (!phone) return false;
  const digits = String(phone).replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/send', async (req, res) => {
    if (!isAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { to: rawTo, message, contactId, name } = extractPayload(req.body);

    if (!rawTo || !message) {
      console.warn('GHL send webhook missing fields. Body keys:', Object.keys(req.body || {}));
      return res.status(400).json({ success: false, error: 'Missing required fields: to, message' });
    }

    if (!isValidPhone(rawTo)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number: ' + rawTo });
    }
    const to = formatPhone(String(rawTo)) || String(rawTo);

    try {
      // Never send to someone who said STOP — GHL doesn't know about our
      // Telnyx-level opt-outs, so this gate is enforced here.
      if (await isOptedOut(to)) {
        console.log(`GHL send webhook blocked: ${to} has opted out`);
        return res.status(403).json({ success: false, error: 'Contact has opted out of SMS' });
      }

      // Send via Telnyx
      const { messageId, status: providerStatus } = await sendSMS(to, message);

      // Insert before secondary contact work so an immediate Telnyx delivery
      // callback always has a row to update.
      await supabase.from('sms_messages').insert({
        telnyx_message_id: messageId,
        contact_phone: to,
        direction: 'outbound',
        body: message,
        status: normaliseTelnyxStatus(providerStatus)
      });

      // Ensure contact exists in Supabase — only include optional fields when
      // present so an upsert can't blank out an existing name or GHL link.
      const contactRow = { phone: to, last_seen: new Date().toISOString() };
      if (name) contactRow.name = name;
      if (contactId) contactRow.ghl_contact_id = contactId;
      await supabase.from('sms_contacts').upsert(contactRow, { onConflict: 'phone' });

      // Push to inbox live
      broadcastSSE({ type: 'new_message', phone: to, body: message, direction: 'outbound' });

      console.log(`GHL automation SMS sent to ${to}: ${message.slice(0, 60)}`);
      return res.json({ success: true, messageId, status: 'accepted' });

    } catch (err) {
      console.error('GHL send webhook error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
