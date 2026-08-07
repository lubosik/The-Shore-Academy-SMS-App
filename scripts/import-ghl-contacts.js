#!/usr/bin/env node
'use strict';
/**
 * scripts/import-ghl-contacts.js — bulk import every GoHighLevel contact
 * into sms_contacts. Safe to re-run: upserts on ghl_contact_id, so nothing
 * ever duplicates.
 *
 * Usage:
 *   node scripts/import-ghl-contacts.js            # real import
 *   node scripts/import-ghl-contacts.js --dry-run  # report only, writes nothing
 *
 * Requires: GHL_PIT, GHL_LOCATION_ID, SUPABASE_URL, SUPABASE_SERVICE_KEY.
 *
 * Contacts with no usable phone number are SKIPPED and counted — this is an
 * SMS inbox; a contact we cannot text is useless here (they still live in GHL).
 */

require('dotenv').config();

const { forEachContactPage } = require('../lib/ghl-client');
const { upsertGhlContact } = require('../lib/ghl-contact-store');
const { normalisePhone } = require('../lib/phone');

const DRY_RUN = process.argv.includes('--dry-run');

let interrupted = false;
process.on('SIGINT', () => {
  console.log('\n[IMPORT] SIGINT received — finishing current page, then stopping cleanly...');
  interrupted = true;
});

function normaliseGhlContact(raw) {
  return {
    ghlId: raw.id,
    firstName: raw.firstName || null,
    lastName: raw.lastName || null,
    email: raw.email || null,
    phone: raw.phone || null,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    dateAdded: raw.dateAdded || null,
    country: raw.country || null,
    source: raw.source || null
  };
}

async function main() {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) {
    console.error('GHL_LOCATION_ID is not set. Aborting.');
    process.exit(1);
  }
  if (!process.env.GHL_PIT) {
    console.error('GHL_PIT is not set. Aborting.');
    process.exit(1);
  }
  if (!DRY_RUN && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY)) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_KEY are not set. Aborting.');
    process.exit(1);
  }

  console.log('The Shore Academy — GHL contact import');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Location: ${locationId}\n`);

  const stats = { fetched: 0, imported: 0, updated: 0, skippedNoPhone: 0, errors: 0 };
  const errorSamples = [];

  await forEachContactPage(locationId, async (contacts, { page, total }) => {
    if (interrupted) return;
    stats.fetched += contacts.length;
    console.log(`[IMPORT] Page ${page}: ${contacts.length} contacts (fetched ${stats.fetched}${total ? ` of ~${total}` : ''})`);

    for (const raw of contacts) {
      if (interrupted) return;
      const contact = normaliseGhlContact(raw);

      if (DRY_RUN) {
        const phone = normalisePhone(contact.phone);
        if (!phone) {
          stats.skippedNoPhone++;
          console.log(`  [DRY] SKIP no phone | ghl=${contact.ghlId} name="${[contact.firstName, contact.lastName].filter(Boolean).join(' ')}"`);
        } else {
          stats.imported++; // would-write; insert-vs-update not resolved without reading the DB
          console.log(`  [DRY] would upsert | ghl=${contact.ghlId} phone=...${phone.slice(-4)} tags=${contact.tags.length}`);
        }
        continue;
      }

      try {
        const { action } = await upsertGhlContact(contact, 'ghl-import');
        if (action === 'inserted') stats.imported++;
        else if (action === 'updated') stats.updated++;
        else stats.skippedNoPhone++;
      } catch (err) {
        stats.errors++;
        if (errorSamples.length < 10) errorSamples.push(`ghl=${contact.ghlId}: ${err.message}`);
      }
    }
  });

  console.log('\n──────────────── IMPORT SUMMARY ────────────────');
  console.log(`Mode:              ${DRY_RUN ? 'DRY RUN — nothing was written' : 'LIVE'}`);
  console.log(`Fetched from GHL:  ${stats.fetched}`);
  console.log(`Imported (new):    ${stats.imported}${DRY_RUN ? ' (would upsert — new-vs-update not split in dry run)' : ''}`);
  console.log(`Updated (existing):${stats.updated}`);
  console.log(`Skipped, no phone: ${stats.skippedNoPhone}`);
  console.log(`Errors:            ${stats.errors}`);
  if (errorSamples.length) {
    console.log('First errors:');
    for (const sample of errorSamples) console.log(`  - ${sample}`);
  }
  if (interrupted) console.log('NOTE: run was interrupted — re-run to finish (upsert makes it safe).');
  console.log('────────────────────────────────────────────────');

  process.exit(stats.errors > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error('[IMPORT] Fatal:', err.message);
  process.exit(1);
});
