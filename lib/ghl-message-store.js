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
const { shouldAdvanceStatus } = require('./message-status');

/** Window for treating an existing row as the same message arriving twice. */
const NEAR_DUPLICATE_WINDOW_MS = 3 * 60 * 1000;

/**
 * GHL carries email, calls and internal notes on the same conversation object.
 * This is an SMS inbox and the thread UI renders SMS bubbles, so only text
 * messages are mirrored. Emails stay in GHL where they render properly.
 */
function isTextMessage(m) {
  const marker = String(m?.messageTypeString || m?.messageType || '').toUpperCase();
  if (marker) return marker === 'SMS' || marker === 'TYPE_SMS' || marker.endsWith('_SMS');

  // Numeric fallback for conversation-list payloads: 2 = SMS, 3 = email.
  const numericType = m?.messageTypeId ?? m?.type;
  if (numericType !== undefined && numericType !== null && numericType !== '') {
    return Number(numericType) === 2;
  }
  return false;
}

function normaliseMediaUrls(m) {
  const candidates = m?.attachments || m?.mediaUrls || m?.media_urls || m?.meta?.attachments || [];
  if (!Array.isArray(candidates)) return [];
  const seen = new Set();
  const urls = [];
  for (const item of candidates) {
    const raw = typeof item === 'string' ? item : (item?.url || item?.mediaUrl || item?.media_url);
    if (typeof raw !== 'string' || !raw.startsWith('https://') || seen.has(raw)) continue;
    seen.add(raw);
    urls.push(raw);
    if (urls.length >= 10) break;
  }
  return urls;
}

function messageBody(m) {
  const value = m?.body ?? m?.message ?? m?.text ?? '';
  return typeof value === 'string' ? value.trim() : String(value).trim();
}

function messageId(m) {
  const value = m?.id || m?.messageId || m?.message_id;
  return value ? String(value) : null;
}

function parseGhlDate(value) {
  if (value === undefined || value === null || value === '') return new Date();
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const number = Number(value);
    const milliseconds = number < 10_000_000_000 ? number * 1000 : number;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? new Date() : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function normaliseGhlStatus(value, direction) {
  const status = String(value || '').toLowerCase();
  if (status === 'failed' || status === 'undelivered' || status === 'error') return 'failed';
  if (status === 'pending' || status === 'queued' || status === 'scheduled') return 'queued';
  if (status === 'sent') return 'sent';
  if (status === 'delivered' || status === 'read') return 'delivered';
  return direction === 'inbound' ? 'delivered' : 'sent';
}

function mediaFingerprint(media) {
  return (media || []).map(item => typeof item === 'string' ? item : item?.url).filter(Boolean).sort().join('\n');
}

function normaliseGhlMessage(m, fallbackPhone) {
  if (!isTextMessage(m)) return { skipped: 'skipped-not-sms' };
  const body = messageBody(m);
  const mediaUrls = normaliseMediaUrls(m);
  if (!body && mediaUrls.length === 0) return { skipped: 'skipped-empty' };

  const raw = m.direction === 'inbound' ? (m.from || fallbackPhone) : (m.to || fallbackPhone);
  const phone = normalisePhone(raw ? String(raw) : null)
             || normalisePhone(fallbackPhone ? String(fallbackPhone) : null);
  if (!phone) return { skipped: 'skipped-no-phone' };

  const sentAt = parseGhlDate(m.dateAdded ?? m.date_added ?? m.createdAt);
  const direction = m.direction === 'inbound' ? 'inbound' : 'outbound';
  return {
    ghlId: messageId(m),
    phone,
    body,
    mediaUrls,
    sentAt,
    direction,
    status: normaliseGhlStatus(m.status, direction)
  };
}

/**
 * True when this app already sent or received the message itself, so the GHL
 * copy is a mirror of our own row rather than new information.
 */
async function findNearDuplicate({ phone, direction, body, mediaUrls, sentAt }, client = supabase) {
  if (!body && mediaUrls.length === 0) return null;
  const from = new Date(sentAt.getTime() - NEAR_DUPLICATE_WINDOW_MS).toISOString();
  const to   = new Date(sentAt.getTime() + NEAR_DUPLICATE_WINDOW_MS).toISOString();

  const { data, error } = await client
    .from('sms_messages')
    .select('id, body, media_urls, ghl_message_id')
    .eq('contact_phone', phone)
    .eq('direction', direction)
    .gte('created_at', from)
    .lte('created_at', to)
    .limit(20);

  if (error) throw new Error(error.message);
  const mediaKey = mediaFingerprint(mediaUrls);
  return (data || []).find(row => (
    (row.body || '').trim() === body.trim()
    && mediaFingerprint(row.media_urls) === mediaKey
  )) || null;
}

/**
 * Store one GHL message.
 *
 * @param {object} m raw GHL message
 * @param {string} fallbackPhone conversation phone, used when the message omits one
 * @returns {'inserted'|'updated'|'linked'|'skipped-duplicate'|'skipped-not-sms'|'skipped-no-phone'|'skipped-empty'}
 */
async function storeGhlMessage(m, fallbackPhone, { client = supabase } = {}) {
  const normalised = normaliseGhlMessage(m, fallbackPhone);
  if (normalised.skipped) return normalised.skipped;
  const { ghlId, phone, body, mediaUrls, sentAt, direction, status } = normalised;
  if (ghlId) {
    const { data: existing, error } = await client
      .from('sms_messages')
      .select('id, body, status, media_urls, created_at')
      .eq('ghl_message_id', ghlId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (existing) {
      const update = {};
      if ((existing.body || '') !== body) update.body = body;
      if (shouldAdvanceStatus(existing.status, status)) update.status = status;
      if (mediaFingerprint(existing.media_urls) !== mediaFingerprint(mediaUrls)) {
        update.media_urls = mediaUrls.length ? mediaUrls.map(url => ({ url })) : null;
      }
      const existingMs = Date.parse(existing.created_at);
      if (!Number.isFinite(existingMs) || existingMs !== sentAt.getTime()) {
        update.created_at = sentAt.toISOString();
      }
      if (Object.keys(update).length) {
        const { error: updateError } = await client.from('sms_messages').update(update).eq('id', existing.id);
        if (updateError) throw new Error(updateError.message);
        return 'updated';
      }
      return 'skipped-duplicate';
    }
  }

  // Same message already here from the Telnyx side — link, do not duplicate.
  const twin = await findNearDuplicate({ phone, direction, body, mediaUrls, sentAt }, client);
  if (twin) {
    if (!twin.ghl_message_id && ghlId) {
      await client.from('sms_messages').update({ ghl_message_id: ghlId }).eq('id', twin.id);
      return 'linked';
    }
    return 'skipped-duplicate';
  }

  const row = {
    ghl_message_id: ghlId || null,
    contact_phone:  phone,
    direction,
    body,
    status,
    media_urls:     mediaUrls.length ? mediaUrls.map(url => ({ url })) : null,
    source:         'ghl-mirror',
    created_at:     sentAt.toISOString()
  };

  const { error } = await client.from('sms_messages').insert(row);
  if (error) {
    // 23505 = the unique index caught a concurrent insert of the same message.
    if (error.code === '23505') return 'skipped-duplicate';
    throw new Error(error.message);
  }
  // Keep Inbox ordering in step with GHL. Do not use now(): an old backfill
  // must not jump above a genuinely recent conversation.
  await client.from('sms_contacts')
    .update({ last_seen: sentAt.toISOString() })
    .eq('phone', phone)
    .lt('last_seen', sentAt.toISOString());

  return 'inserted';
}

module.exports = {
  storeGhlMessage,
  isTextMessage,
  normaliseMediaUrls,
  messageBody,
  messageId,
  parseGhlDate,
  normaliseGhlStatus,
  normaliseGhlMessage,
  mediaFingerprint,
  NEAR_DUPLICATE_WINDOW_MS
};
