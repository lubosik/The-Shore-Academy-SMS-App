/**
 * POST /webhook/send
 * Called by GHL custom webhook action to send an outbound SMS.
 * Mirrors the old bridge's /send endpoint format exactly.
 * Auth: x-webhook-secret header OR body.webhookSecret OR ?secret= query param.
 */

const { supabase, insertSmsMessage } = require('../db');
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
  const rawMedia = body.attachments || c.attachments || body.mediaUrls || c.mediaUrls || [];
  return {
    to:        body.to        || c.to        || body.phone       || body.contact?.phone,
    message:   body.message   || c.message   || body.text        || c.text,
    contactId: body.contactId || body.contactID || c.contactId   || c.contactID || body.contact?.id,
    name:      body.name      || c.name      || body.contact?.name ||
               [body.contact?.firstName, body.contact?.lastName].filter(Boolean).join(' ') || null,
    ghlMessageId: body.messageId || body.message_id || c.messageId || c.message_id || null,
    mediaUrls: Array.isArray(rawMedia)
      ? [...new Set(rawMedia
          .map(item => typeof item === 'string' ? item : item?.url)
          .filter(url => typeof url === 'string' && url.startsWith('https://')))]
          .slice(0, 10)
      : []
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

    const { to: rawTo, message = '', contactId, name, ghlMessageId, mediaUrls } = extractPayload(req.body);

    if (!rawTo || (!String(message).trim() && mediaUrls.length === 0)) {
      console.warn('GHL send webhook missing fields. Body keys:', Object.keys(req.body || {}));
      return res.status(400).json({ success: false, error: 'Missing required fields: to and message or attachments' });
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

      // An official GHL provider delivery always has messageId. Claim it in
      // the database before touching Telnyx so a retry cannot double-send.
      let claimedRow = null;
      if (ghlMessageId) {
        const { data: existing } = await supabase
          .from('sms_messages')
          .select('id, telnyx_message_id, status, created_at')
          .eq('ghl_message_id', ghlMessageId)
          .maybeSingle();

        if (existing?.telnyx_message_id) {
          return res.json({
            success: true,
            messageId: existing.telnyx_message_id,
            status: 'accepted',
            duplicate: true
          });
        }

        if (existing) {
          const { data: claimed } = await supabase
            .from('sms_messages')
            .update({ status: 'sending', created_at: new Date().toISOString() })
            .eq('id', existing.id)
            .in('status', ['queued', 'pending', 'failed'])
            .select('id')
            .maybeSingle();
          if (!claimed) {
            return res.status(202).json({ success: true, status: 'processing', duplicate: true });
          }
          claimedRow = claimed;
        } else {
          const { data: claimed, error: claimError } = await supabase
            .from('sms_messages')
            .insert({
              ghl_message_id: ghlMessageId,
              contact_phone: to,
              direction: 'outbound',
              body: message,
              media_urls: mediaUrls.length ? mediaUrls.map(url => ({ url })) : null,
              status: 'sending',
              source: 'ghl-provider'
            })
            .select('id')
            .maybeSingle();
          if (claimError?.code === '23505') {
            return res.status(202).json({ success: true, status: 'processing', duplicate: true });
          }
          if (claimError) throw new Error(claimError.message);
          claimedRow = claimed;
        }
      }

      // Send once via Telnyx. GHL already owns the conversation row; this is
      // the custom provider delivery leg, not a second logical message.
      let telnyxResult;
      try {
        telnyxResult = await sendSMS(to, message, mediaUrls.length ? mediaUrls : null);
      } catch (sendError) {
        if (claimedRow?.id) {
          await supabase.from('sms_messages')
            .update({ status: sendError.retrySafe ? 'failed' : 'sending' })
            .eq('id', claimedRow.id);
        }
        throw sendError;
      }
      const { messageId, status: providerStatus } = telnyxResult;
      const mediaRecord = mediaUrls.length ? mediaUrls.map(url => ({ url })) : null;

      if (claimedRow?.id) {
        const { error: updateError } = await supabase.from('sms_messages').update({
          telnyx_message_id: messageId,
          body: message,
          media_urls: mediaRecord,
          status: normaliseTelnyxStatus(providerStatus),
          source: 'ghl-provider'
        }).eq('id', claimedRow.id);
        if (updateError) throw new Error(updateError.message);
      } else {
        await insertSmsMessage({
          telnyx_message_id: messageId,
          ghl_message_id: ghlMessageId || null,
          contact_phone: to,
          direction: 'outbound',
          body: message,
          media_urls: mediaRecord,
          status: normaliseTelnyxStatus(providerStatus),
          source: 'ghl-provider'
        });
      }

      // Ensure contact exists in Supabase — only include optional fields when
      // present so an upsert can't blank out an existing name or GHL link.
      const contactRow = { phone: to, last_seen: new Date().toISOString() };
      if (name) contactRow.name = name;
      if (contactId) contactRow.ghl_contact_id = contactId;
      await supabase.from('sms_contacts').upsert(contactRow, { onConflict: 'phone' });

      // Push to inbox live
      broadcastSSE({
        type: 'new_message',
        phone: to,
        body: message,
        direction: 'outbound',
        media_urls: mediaRecord,
        telnyx_message_id: messageId,
        ghl_message_id: ghlMessageId || null
      });

      console.log(`GHL automation SMS sent to ${to}: ${message.slice(0, 60)}`);
      return res.json({ success: true, messageId, status: 'accepted' });

    } catch (err) {
      console.error('GHL send webhook error:', err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
