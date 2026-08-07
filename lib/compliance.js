'use strict';
/**
 * lib/compliance.js — SMS compliance helpers: phone formatting and opt-outs.
 *
 * STOP handling is a legal requirement (TCPA/CTIA), not a feature. Opt-outs
 * live in their own table:
 *
 *   sms_optouts (phone text primary key, reason text, created_at timestamptz)
 *
 * Ported from the original Vici flows/utils.js, where opt-outs were encoded
 * as sentinel rows in the automation send log. Behaviour is identical — only
 * the storage changed.
 */

const { supabase } = require('../db');

// ---------------------------------------------------------------------------
// Phone formatting
// ---------------------------------------------------------------------------

function formatPhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10)                         return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1')    return '+' + digits;
  if (raw.startsWith('+') && digits.length >= 10)   return '+' + digits;
  return null;
}

// ---------------------------------------------------------------------------
// Opt-outs
// ---------------------------------------------------------------------------

async function isOptedOut(phone) {
  if (!phone) return false;
  try {
    const { data } = await supabase
      .from('sms_optouts')
      .select('phone')
      .eq('phone', phone)
      .maybeSingle();
    return !!data;
  } catch {
    // Fail open on the READ so a transient DB error can't crash a webhook;
    // the send path treats "unknown" as "allowed", same as the original.
    return false;
  }
}

async function markOptedOut(phone, reason = 'STOP') {
  if (!phone) return;
  try {
    const { error } = await supabase.from('sms_optouts').upsert({
      phone,
      reason: String(reason).slice(0, 300)
    }, { onConflict: 'phone', ignoreDuplicates: true });
    if (error) throw new Error(error.message);
  } catch (err) {
    // This must be loud: a failed opt-out write is a compliance problem.
    console.error(`[OPT-OUT] FAILED to record opt-out for ...${phone.slice(-4)}: ${err.message}`);
  }
}

module.exports = { formatPhone, isOptedOut, markOptedOut };
