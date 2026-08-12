const { supabase, insertSmsMessage } = require('../db');
const { verifyWebhookSignature } = require('../telnyx');
const { sendPushToAll } = require('../push-notify');
const { sendNativeMessagePush } = require('../lib/apns-notify');
const { markOptedOut } = require('../lib/compliance');
const { rehostInboundMedia } = require('../lib/mms-media');
const { parseTapback, findTapbackTarget } = require('../lib/tapbacks');
const { normaliseTelnyxStatus, updateMessageStatus } = require('../lib/message-status');

const { findContactByPhone } = require('../lib/ghl-client');
const { upsertGhlContact } = require('../lib/ghl-contact-store');

const DELIVERY_EVENTS = new Set(['message.sent', 'message.delivered', 'message.finalized']);

/**
 * Fill in a name for someone who texted in before their GHL contact reached
 * us. Skipped entirely once the row already has a name, so the common case
 * costs nothing and GHL is not called on every inbound message.
 */
async function enrichContactFromGhl(phone) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId || !process.env.GHL_PIT) return;

  const { data: row } = await supabase
    .from('sms_contacts')
    .select('name, ghl_contact_id')
    .eq('phone', phone)
    .maybeSingle();
  if (row?.name && row?.ghl_contact_id) return;

  const contact = await findContactByPhone(locationId, phone);
  if (!contact) return;

  await upsertGhlContact({
    ghlId:     contact.id,
    firstName: contact.firstName || null,
    lastName:  contact.lastName || null,
    email:     contact.email || null,
    phone:     contact.phone || phone,
    tags:      Array.isArray(contact.tags) ? contact.tags : [],
    dateAdded: contact.dateAdded || null,
    country:   contact.country || null,
    source:    contact.source || null
  }, 'ghl-inbound-lookup');

  console.log(`[GHL] Named inbound contact ...${phone.slice(-4)} from GHL`);
}

module.exports = (broadcastSSE) => {
  const router = require('express').Router();

  router.post('/telnyx', async (req, res) => {
    res.sendStatus(200);

    try {
      const rawBody = req.body;
      const body = JSON.parse(rawBody.toString());

      const sig = req.headers['x-telnyx-signature'];
      if (sig) {
        const valid = verifyWebhookSignature(rawBody, sig, process.env.WEBHOOK_SECRET);
        if (!valid) console.warn('Webhook signature mismatch — processing anyway');
      }

      const event = body?.data;
      const eventType = event?.event_type;
      const payload = event?.payload;

      // ── Delivery status update ──────────────────────────────────────────────
      if (DELIVERY_EVENTS.has(eventType)) {
        const messageId = payload?.id;
        if (!messageId) return;

        const toEntry = Array.isArray(payload.to) ? payload.to[0] : payload.to;
        const providerStatus = toEntry?.status || payload?.status || '';
        const toPhone = toEntry?.phone_number;

        const eventFallback = eventType === 'message.sent' ? 'sent' : null;
        const status = normaliseTelnyxStatus(providerStatus, eventFallback);
        const updated = await updateMessageStatus(supabase, messageId, status);

        if (updated) {
          broadcastSSE({ type: 'status_update', messageId, status, phone: updated.contact_phone });
          console.log(`Delivery update: ${messageId} → ${status}`);
        }
        return;
      }

      // ── Inbound message ─────────────────────────────────────────────────────
      if (eventType !== 'message.received') return;

      const messageId = payload?.id;
      const fromPhone = payload?.from?.phone_number;
      const text = payload?.text || '';
      const inboundMedia = Array.isArray(payload?.media) ? payload.media : [];

      // Accept text-only, media-only (picture with no caption), or both
      if (!messageId || !fromPhone || (!text && inboundMedia.length === 0)) return;

      const { data: existing } = await supabase
        .from('sms_messages')
        .select('id')
        .eq('telnyx_message_id', messageId)
        .maybeSingle();
      if (existing) { console.log('Duplicate message, skipping:', messageId); return; }

      // STOP / opt-out detection — check before anything else
      const stopPattern = /^(stop|stopall|stop all|unsubscribe|cancel|end|quit|opt[\s-]?out|stop the messages|stop texting|stop messaging|no more texts|no more messages|these emails|stop these emails)$/i;
      if (stopPattern.test(text.trim())) {
        console.log(`[OPT-OUT] Received STOP from ...${fromPhone.slice(-4)}`);
        await markOptedOut(fromPhone, text.trim());
        // Log the inbound stop message but do not send any auto-reply
        await supabase.from('sms_messages').insert({
          telnyx_message_id: messageId,
          contact_phone: fromPhone,
          direction: 'inbound',
          body: text,
          status: 'delivered',
          created_at: payload.received_at || new Date().toISOString()
        }).catch(() => {});
        broadcastSSE({ type: 'opt_out', phone: fromPhone });
        return;
      }

      await supabase.from('sms_contacts').upsert({
        phone: fromPhone,
        last_seen: new Date().toISOString()
      }, { onConflict: 'phone' });

      // A cold inbound SMS carries no name, so the thread would read as a bare
      // phone number until the GHL sync next runs. Ask GHL who this is now.
      // Deliberately never allowed to fail the webhook: a missing name is a
      // cosmetic problem, a dropped inbound message is not.
      try { await enrichContactFromGhl(fromPhone); }
      catch (err) { console.warn('[GHL] Inbound name lookup failed:', err.message); }

      // ── iPhone tapback (reaction) detection ─────────────────────────────────
      // "Loved \"...\"" / "Liked an image" etc. arrive as plain SMS text.
      // Attach the reaction to the message it targets and hide the raw text row
      // (the UI skips tapback rows that carry reply_to_message_id).
      const tapback = inboundMedia.length === 0 ? parseTapback(text) : null;
      if (tapback) {
        try {
          const target = await findTapbackTarget(supabase, fromPhone, tapback);
          if (target) {
            let reactions = Array.isArray(target.reactions) ? [...target.reactions] : [];
            if (tapback.action === 'add') {
              reactions = reactions.filter(r => !(r.type === tapback.type && r.source === 'customer'));
              reactions.push({ type: tapback.type, source: 'customer', at: new Date().toISOString() });
            } else {
              reactions = reactions.filter(r => !(r.type === tapback.type && r.source === 'customer'));
            }

            await supabase.from('sms_messages')
              .update({ reactions: reactions.length ? reactions : null })
              .eq('id', target.id);

            // Keep the raw row for audit + webhook-retry dedup, linked to its target
            await insertSmsMessage({
              telnyx_message_id: messageId,
              contact_phone: fromPhone,
              direction: 'inbound',
              body: text,
              status: 'delivered',
              reply_to_message_id: target.id,
              created_at: payload.received_at || new Date().toISOString()
            }).catch(() => {});

            broadcastSSE({ type: 'reaction_update', phone: fromPhone, message_id: target.id, reactions });

            const { data: reactor } = await supabase
              .from('sms_contacts').select('name').eq('phone', fromPhone).maybeSingle();
            sendPushToAll({
              title: reactor?.name || fromPhone,
              body: text,
              url: `/?thread=${encodeURIComponent(fromPhone)}`,
              icon: '/icons/icon-192.png',
              tag: `sms-${fromPhone}`
            }).catch(() => {});
            sendNativeMessagePush({
              title: reactor?.name || fromPhone,
              body: text,
              phone: fromPhone
            }).catch(err => console.error('APNs tapback error:', err.message));

            console.log(`[TAPBACK] ${tapback.action} ${tapback.type} on msg ${target.id} from ...${fromPhone.slice(-4)}`);
            return;
          }
          // No matching target — fall through and store as a normal message
        } catch (tapErr) {
          console.error('[TAPBACK] Error:', tapErr.message);
        }
      }

      // Re-host inbound pictures (Telnyx media URLs expire after 30 days)
      let mediaRecord = null;
      if (inboundMedia.length > 0) {
        const hosted = await rehostInboundMedia(messageId, inboundMedia);
        if (hosted.length > 0) mediaRecord = hosted;
      }

      let insertedRow = null;
      try {
        insertedRow = await insertSmsMessage({
          telnyx_message_id: messageId,
          contact_phone: fromPhone,
          direction: 'inbound',
          body: text,
          status: 'delivered',
          media_urls: mediaRecord,
          created_at: payload.received_at || new Date().toISOString()
        });
      } catch (dbErr) {
        console.error('Inbound DB insert error:', dbErr.message);
      }

      await supabase.from('sms_contacts').update({
        last_seen: new Date().toISOString()
      }).eq('phone', fromPhone);

      try { await supabase.rpc('increment_contact_messages', { p_phone: fromPhone }); } catch {}
      try { await supabase.rpc('increment_unread', { p_phone: fromPhone }); } catch {}

      broadcastSSE({
        type: 'new_message',
        phone: fromPhone,
        body: text,
        direction: 'inbound',
        id: insertedRow?.id || null,
        media_urls: mediaRecord
      });

      // Push notification to all subscribed devices
      const { data: contactRow } = await supabase
        .from('sms_contacts')
        .select('name')
        .eq('phone', fromPhone)
        .maybeSingle();
      const senderName = contactRow?.name || fromPhone;
      const pushBody = text
        ? (text.length > 100 ? text.slice(0, 97) + '…' : text)
        : `📷 Picture${mediaRecord && mediaRecord.length > 1 ? ` (${mediaRecord.length})` : ''}`;
      sendPushToAll({
        title: `New message from ${senderName}`,
        body: pushBody,
        url: `/?thread=${encodeURIComponent(fromPhone)}`,
        icon: '/icons/icon-192.png',
        tag: `sms-${fromPhone}`
      }).catch(err => console.error('Push notify error:', err.message));
      sendNativeMessagePush({
        title: `New message from ${senderName}`,
        body: pushBody,
        phone: fromPhone
      }).catch(err => console.error('APNs notify error:', err.message));

    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  });

  return router;
};
