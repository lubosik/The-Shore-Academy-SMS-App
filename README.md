# Shore Academy Inbox

SMS/MMS and voice inbox for **The Shore Academy**, an ocean-safety and
surf-lifesaving school in South Florida. One shared Telnyx number
(`+15613630929`) for texting and calling students and parents, with a web
inbox and a native iPhone client.

## What this app is — and is not

- **It is** a human-operated inbox: send/receive SMS and MMS, iPhone-style
  tapbacks and replies, voice calls with recordings, missed-call tracking,
  browser and native push notifications.
- **It is not** an automation platform. The Shore Academy runs ALL marketing
  automation in **GoHighLevel (GHL)**. This app contains no flows, no
  scheduled sequences, no AI conversation analysis, and no e-commerce
  integrations.
- **GHL is the contact system of record.** Contacts are imported from GHL in
  bulk and kept fresh in real time via a GHL workflow webhook. Each contact
  stores its `ghl_contact_id` and GHL tags.

## Architecture

- Node.js / Express (`server.js`), deployed on Railway (`<RAILWAY_URL>` — not
  yet provisioned).
- Supabase (PostgreSQL) for application data — schema in
  `scripts/schema.sql` (`sms_contacts`, `sms_messages`, `call_logs`,
  `sms_optouts`, push device tables).
- Telnyx for SMS/MMS (`/webhook/telnyx`) and voice Call Control
  (`/webhooks/voice`).
- Native iOS client in `ios/` (SwiftUI + CallKit/PushKit); browser UI in
  `public/`.

## GoHighLevel integration

Three pieces, all read-or-notify only:

1. **`lib/ghl-client.js`** — fetch wrapper for the GHL v2 API
   (`https://services.leadconnectorhq.com`, `Version: 2021-07-28`, PIT
   bearer auth, `searchAfter` deep pagination, 429 backoff).
2. **`scripts/import-ghl-contacts.js`** — bulk import of every GHL contact
   into `sms_contacts`. Upserts on `ghl_contact_id`, skips contacts without a
   usable phone, supports `--dry-run`. Safe to re-run.
3. **`routes/webhook-ghl-contact.js`** — `POST /webhook/ghl/contact/:secret`,
   fed by a GHL **Workflow "Webhook" action** (configured by hand in the GHL
   UI; workflow webhooks carry no signature, so a shared secret rides in the
   URL and is compared timing-safely). Upserts the new contact and pushes a
   "New contact" notification to the iPhone.

There is also `POST /webhook/send` — a GHL workflow can send an outbound SMS
through the Telnyx number (authenticated with `WEBHOOK_SECRET`; opt-outs are
enforced server-side).

## Compliance

STOP/opt-out handling lives in `lib/compliance.js` and the `sms_optouts`
table. Inbound STOP (and variants) records the opt-out; every outbound send
path checks it first. This is a legal requirement — do not weaken it.

## Setup

```bash
npm ci
cp .env.example .env   # fill in every value — see the comments in that file
npm run build          # builds public/app.js from public/app.jsx
node server.js
```

Apply `scripts/schema.sql` to the Supabase project before first boot.

One-time contact load (after `GHL_PIT` + `GHL_LOCATION_ID` are set):

```bash
node scripts/import-ghl-contacts.js --dry-run   # preview
node scripts/import-ghl-contacts.js             # real import (re-runnable)
```

## Deploy

Railway, via `railway.json` / `Procfile` (`node server.js`, healthcheck
`/health`). Set every variable from `.env.example` in Railway before
deploying. Point the Telnyx messaging webhook at
`https://<RAILWAY_URL>/webhook/telnyx` and the voice webhook at
`https://<RAILWAY_URL>/webhooks/voice`. Point the GHL new-contact workflow
webhook at `https://<RAILWAY_URL>/webhook/ghl/contact/<GHL_WEBHOOK_SECRET>`.
