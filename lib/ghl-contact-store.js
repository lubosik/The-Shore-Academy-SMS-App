'use strict';
/**
 * lib/ghl-contact-store.js — one place that writes GHL contacts into
 * sms_contacts, shared by the bulk import script and the realtime
 * new-contact webhook so the rules can never drift apart.
 *
 * Rules:
 *   - Phone is normalised to E.164; a contact with no usable phone is
 *     SKIPPED (this is an SMS app — no phone, no use).
 *   - Upsert key is ghl_contact_id (UNIQUE in the schema) so re-running an
 *     import never duplicates a person.
 *   - If the phone already exists from an inbound SMS but that row has no
 *     ghl_contact_id yet, the GHL id is filled in on the existing row
 *     instead of failing on the unique phone constraint.
 *   - GHL is the system of record: non-empty GHL values overwrite ours,
 *     but empty GHL values never blank out data we already have.
 */

const { supabase } = require('../db');
const { normalisePhone } = require('./phone');

function buildFullName(first, last) {
  return [first, last].filter(Boolean).join(' ').trim() || null;
}

/**
 * @param {object} c normalised GHL contact:
 *   { ghlId, firstName, lastName, email, phone, tags, dateAdded, country, source }
 * @param {string} fallbackSource stored in sms_contacts.source when GHL has none
 * @returns {{ action: 'inserted'|'updated'|'skipped-no-phone', phone: string|null }}
 * @throws on database errors (caller decides how to report)
 */
async function upsertGhlContact(c, fallbackSource = 'ghl') {
  const phone = normalisePhone(c.phone);
  if (!phone) return { action: 'skipped-no-phone', phone: null };

  const now = new Date().toISOString();
  const fields = {
    ghl_contact_id: c.ghlId,
    ghl_tags: Array.isArray(c.tags) ? c.tags : [],
    ghl_synced_at: now
  };
  // Only set fields GHL actually has a value for — never blank existing data.
  if (c.firstName) fields.first_name = c.firstName;
  if (c.lastName)  fields.last_name = c.lastName;
  const fullName = buildFullName(c.firstName, c.lastName);
  if (fullName)    fields.name = fullName;
  if (c.email)     fields.email = c.email;
  if (c.country)   fields.country = c.country;

  // 1. Already linked by GHL id?
  if (c.ghlId) {
    const { data: byId, error: idErr } = await supabase
      .from('sms_contacts')
      .select('id, phone')
      .eq('ghl_contact_id', c.ghlId)
      .maybeSingle();
    if (idErr) throw new Error(idErr.message);

    if (byId) {
      // Update the linked row. Only move the phone if it changed AND the new
      // phone is not already owned by a different row (unique constraint).
      const updates = { ...fields };
      if (byId.phone !== phone) {
        const { data: phoneOwner } = await supabase
          .from('sms_contacts')
          .select('id')
          .eq('phone', phone)
          .maybeSingle();
        if (!phoneOwner || phoneOwner.id === byId.id) updates.phone = phone;
      }
      const { error } = await supabase.from('sms_contacts').update(updates).eq('id', byId.id);
      if (error) throw new Error(error.message);
      return { action: 'updated', phone };
    }
  }

  // 2. Phone already known (e.g. they texted in before the import)?
  const { data: byPhone, error: phoneErr } = await supabase
    .from('sms_contacts')
    .select('id, ghl_contact_id')
    .eq('phone', phone)
    .maybeSingle();
  if (phoneErr) throw new Error(phoneErr.message);

  if (byPhone) {
    const { error } = await supabase.from('sms_contacts').update(fields).eq('id', byPhone.id);
    if (error) throw new Error(error.message);
    return { action: 'updated', phone };
  }

  // 3. Brand new contact.
  const insertRow = {
    phone,
    source: c.source || fallbackSource,
    unread_count: 0,
    ...fields
  };
  if (c.dateAdded) {
    insertRow.first_seen = c.dateAdded;
    insertRow.last_seen = c.dateAdded;
  }
  const { error: insErr } = await supabase.from('sms_contacts').insert(insertRow);
  if (insErr) {
    // 23505 = unique violation race (concurrent webhook/import) — retry as update.
    if (insErr.code === '23505') {
      const { error: retryErr } = await supabase
        .from('sms_contacts')
        .update(fields)
        .eq('phone', phone);
      if (retryErr) throw new Error(retryErr.message);
      return { action: 'updated', phone };
    }
    throw new Error(insErr.message);
  }
  return { action: 'inserted', phone };
}

module.exports = { upsertGhlContact, buildFullName };
