const { supabase, insertSmsMessage } = require('../db');
const { sendSMS } = require('../telnyx');
const { formatPhone, isOptedOut } = require('../lib/compliance');
const { normaliseTelnyxStatus } = require('../lib/message-status');
const { recordOutboundInGhl, sendOutboundViaGhl } = require('../lib/ghl-writeback');

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/', async (req, res) => {
    try {
      const { to, message, mediaUrls, replyToMessageId } = req.body;
      const media = Array.isArray(mediaUrls)
        ? mediaUrls.filter(u => typeof u === 'string' && u.startsWith('https://')).slice(0, 10)
        : [];
      const text = (message || '').trim();

      if (!to) return res.status(400).json({ error: 'to required' });
      const normalisedTo = formatPhone(to);
      if (!normalisedTo) return res.status(400).json({ error: 'Invalid phone number format' });
      if (!text && media.length === 0) return res.status(400).json({ error: 'message or media required' });
      if (text.length > 1600) return res.status(400).json({ error: 'Message too long' });
      if (await isOptedOut(normalisedTo)) {
        return res.status(403).json({ error: 'This contact opted out of messages' });
      }

      // GHL is Shore's system of record. By default it owns the single send
      // and hands delivery to its configured Telnyx provider, which makes the
      // message exist in the exact GHL conversation immediately. `telnyx` is
      // an explicit emergency rollback mode; never call both providers for
      // the same request because an ambiguous retry can double-text someone.
      const outboundMode = String(process.env.GHL_OUTBOUND_MODE || 'ghl').toLowerCase();
      const throughGhl = outboundMode !== 'telnyx';
      const provider = throughGhl
        ? await sendOutboundViaGhl(normalisedTo, text, media)
        : await sendSMS(normalisedTo, text, media.length ? media : null);

      if (provider?.skipped) {
        throw new Error(`GHL send unavailable: ${provider.skipped}`);
      }
      const messageId = provider.messageId;
      if (!messageId) throw new Error('Messaging provider did not return a message id');
      const providerStatus = provider.status;

      const mediaRecord = media.length ? media.map(u => ({ url: u })) : null;
      const replyTo = Number.isFinite(Number(replyToMessageId)) && replyToMessageId !== null && replyToMessageId !== undefined
        ? Number(replyToMessageId)
        : null;

      // Store the Telnyx row immediately. Delivery webhooks can arrive within
      // milliseconds; inserting first means a delivered callback always has a
      // row to update.
      let inserted = null;
      try {
        inserted = await insertSmsMessage({
          telnyx_message_id: throughGhl ? null : messageId,
          ghl_message_id: throughGhl ? messageId : null,
          contact_phone: normalisedTo,
          direction: 'outbound',
          body: text,
          status: normaliseTelnyxStatus(providerStatus),
          media_urls: mediaRecord,
          reply_to_message_id: replyTo,
          source: throughGhl ? 'ghl-send' : 'app'
        });
      } catch (dbErr) {
        console.error('Send DB insert error:', dbErr.message);
      }

      await supabase.from('sms_contacts').upsert({
        phone: normalisedTo,
        last_seen: new Date().toISOString()
      }, { onConflict: 'phone' });

      // Dominic works in the app, not GHL, so without this GHL only ever sees
      // its own automated sends and thinks every thread is one-sided. Recorded,
      // never re-sent: this uses /messages/outbound, not /messages, which would
      // deliver the text a second time.
      if (!throughGhl) {
        recordOutboundInGhl(normalisedTo, text, media)
          .catch(err => console.error('[GHL-WB] outbound:', err.message));
      }

      broadcastSSE({
        type: 'new_message',
        phone: normalisedTo,
        body: text,
        direction: 'outbound',
        id: inserted?.id || null,
        telnyx_message_id: throughGhl ? null : messageId,
        ghl_message_id: throughGhl ? messageId : null,
        media_urls: mediaRecord,
        reply_to_message_id: replyTo
      });

      res.json({
        success: true,
        messageId,
        id: inserted?.id || null,
        provider: throughGhl ? 'ghl' : 'telnyx'
      });
    } catch (err) {
      console.error('Send error:', err.message);
      res.status(500).json({ error: 'Failed to send message' });
    }
  });

  return router;
};
