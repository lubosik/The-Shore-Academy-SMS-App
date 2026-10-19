'use strict';

// The Telnyx bridge rejects SMS above ten concatenated segments. One Unicode
// character (including an emoji or a curly dash) changes the entire message
// from GSM-7 to UCS-2, reducing each multipart segment from 153 to 67 units.
const MAX_SEGMENTS = 10;
const GSM_BASIC = new Set(Array.from(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'
));
const GSM_EXTENDED = new Set(Array.from('^{}\\[~]|€'));

function smsSegments(text) {
  let septets = 0;
  for (const char of text) {
    if (GSM_BASIC.has(char)) septets++;
    else if (GSM_EXTENDED.has(char)) septets += 2;
    else {
      const units = text.length; // JavaScript length is UTF-16/UCS-2 code units.
      return { encoding: 'UCS-2', units, count: units <= 70 ? 1 : Math.ceil(units / 67) };
    }
  }
  return { encoding: 'GSM-7', units: septets, count: septets <= 160 ? 1 : Math.ceil(septets / 153) };
}

function gsmSafeText(text) {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[—–−]/g, '-')
    .replace(/•/g, '-')
    .replace(/…/g, '...')
    .replace(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, '')
    .replace(/ {3,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function prepareSms(text, { hasMedia = false } = {}) {
  const original = smsSegments(text);
  if (hasMedia || original.count <= MAX_SEGMENTS) {
    return { text, changed: false, segments: original };
  }

  const safe = gsmSafeText(text);
  const segments = smsSegments(safe);
  if (safe && segments.count <= MAX_SEGMENTS) {
    return { text: safe, changed: safe !== text, segments };
  }
  const error = new Error(`This text needs ${original.count} SMS parts; the limit is ${MAX_SEGMENTS}. Shorten it or attach an image to send it as MMS.`);
  error.code = 'sms_too_long';
  error.segments = original;
  throw error;
}

module.exports = { MAX_SEGMENTS, smsSegments, gsmSafeText, prepareSms };
