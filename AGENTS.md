# Repository instructions

## Purpose and architecture

This repository contains the Shore Academy Inbox web backend/UI and its
native iPhone client. The Shore Academy is an ocean-safety and
surf-lifesaving school in South Florida; the app is a shared SMS/MMS + voice
inbox on one Telnyx number (+15613630929).

- The web application is a Node.js/Express service targeting Railway
  (`<RAILWAY_URL>` — not yet provisioned). It uses Supabase for application
  data and integrates with Telnyx (messaging + voice), GoHighLevel
  (contacts), web push, and APNs.
- **This app has NO automation features.** The Shore Academy runs all
  marketing automation in GoHighLevel. There are no flows, no scheduled
  queues, no AI analysis, no e-commerce (WooCommerce/ShipStation) code. Do
  not reintroduce any of it.
- **GoHighLevel is the contact system of record.** Contacts arrive two ways:
  a bulk import (`scripts/import-ghl-contacts.js`, upserts on
  `ghl_contact_id`, re-runnable) and a realtime GHL workflow webhook
  (`routes/webhook-ghl-contact.js` at `POST /webhook/ghl/contact/:secret`).
  The GHL API client is `lib/ghl-client.js`. Shared upsert rules live in
  `lib/ghl-contact-store.js` — change them there, not in callers.
- Shore app one-off messages use GHL as the single canonical sender by default
  (`GHL_OUTBOUND_MODE=ghl`): GHL creates the message in the exact contact
  conversation, then its configured Telnyx provider delivers it. Never add a
  second direct Telnyx send to that path. `GHL_OUTBOUND_MODE=telnyx` is an
  emergency rollback and only mirrors outbound rows when a real Marketplace
  `GHL_CONVERSATION_PROVIDER_ID` is available.
- Manual GHL sends are mirrored into the app by `sync-ghl.js` every 60 seconds.
  A true real-time fast path requires an installed Marketplace/OAuth webhook
  subscription for signed `OutboundMessage` events; a PIT cannot subscribe.
- STOP/opt-out compliance lives in `lib/compliance.js` backed by the
  `sms_optouts` table. Every outbound SMS path must check `isOptedOut()`
  first. This is a legal requirement; never remove or bypass it.
- The iOS application is native SwiftUI with UIKit bridges for PushKit and
  CallKit. It is not a WebView, Capacitor, React Native, Flutter, or another
  wrapper. It reuses the authenticated inbox, messaging, contacts,
  voice-token, and call-log endpoints.
- SIP credentials are native-only: `/api/voice/token` requires the iOS app's
  explicit client marker and rejects browser user agents. The browser bundle
  contains no Telnyx SDK loader. Do not re-enable shared browser calling
  without designing explicit per-agent routing; otherwise web sessions compete
  with iPhones for calls.
- Incoming and missed call presentation is native-only through Telnyx VoIP
  push and CallKit. Browser VAPID notifications remain enabled for messages,
  but the voice webhook must not send browser call notifications.
- Live iOS SIP routing prefers the complete Railway pair
  `TELNYX_IOS_SIP_USERNAME` / `TELNYX_IOS_SIP_PASSWORD`. The legacy
  `TELNYX_SIP_*` pair is the rollback fallback; never overwrite or delete it
  during an iOS credential rotation.
- Keep Telnyx `pushWhenActive` disabled. Foreground calls already reach CallKit
  through the live SDK socket; SDK 4.1.2 replaces that socket while processing
  an active-state push, which can lose the INVITE during Answer.
- Native message alerts use standard UserNotifications/APNs from the Telnyx
  inbound-message webhook (`lib/apns-notify.js`). The GHL new-contact webhook
  reuses the same sender. This is separate from browser VAPID and VoIP
  PushKit.
- Call recording stays functional, but provider download URLs must never be
  returned to a client. `lib/private-recordings.js` archives audio into the
  private `call-recordings` bucket and `/api/voice/recordings/:id` creates an
  authenticated, short-lived playback redirect. Apply
  `scripts/private-recordings-migration.sql` before deploying related code.
  Retention deletion is destructive and must remain disabled until its dry run
  and target rows are approved.

## Important paths

- `server.js`, `routes/`, `lib/`, `db.js`, `telnyx.js`: backend entry point
  and services.
- `public/`: browser UI. `public/app.jsx` is the source and `public/app.js` is
  its Babel build output.
- `scripts/schema.sql`: full database schema (idempotent — safe to re-run).
- `scripts/private-recordings-migration.sql`: private call-recording bucket and
  lifecycle columns for existing deployments.
- `scripts/import-ghl-contacts.js`: bulk GHL contact import (`--dry-run`
  supported). Do NOT run against production merely as validation.
- `scripts/test-mms-flows.js`: integration harness for MMS/replies/tapbacks —
  uses the configured Supabase project and a reserved fake number; Telnyx and
  push are mocked and created rows are cleaned.
- `scripts/test-ui-visual.js <scratch-dir>`: fixture-only Playwright UI check.
- `ios/`: Swift source, XcodeGen project, CI docs. Owned separately from the
  backend — coordinate before touching bundle identifiers or client markers
  (`x-vici-client` header, `com.vicipeptides.inbox` bundle id) because the
  shipped iOS client still sends/uses them.
- `.github/workflows/`: iOS build + TestFlight workflows.

## Web setup and checks

Use npm because `package-lock.json` is authoritative.

```bash
npm ci
npm run build
find . -path './node_modules' -prune -o -path './.git' -prune -o -type f -name '*.js' -exec node --check {} \;
```

Do not run migrations, imports, or send scripts merely as validation.

## Signing and secret handling

- Never commit, print, paste into chat, or add to build artifacts: `.p8`,
  `.p12`, `.pem` private keys, provisioning profiles, `.env`, session cookies,
  API tokens (including the GHL PIT), signing certificates, or secret values.
- APNs provider delivery requires an Apple Developer APNs key. Store its key
  ID, team ID, and base64 `.p8` only as Railway runtime variables
  `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_KEY_P8_BASE64`.
- Every environment variable the app uses is documented in `.env.example`.

## Deployment safety

- Treat pushes to `main` as deployments once Railway is wired, even when a
  change appears documentation-only.
- Do not push, merge, trigger a signed archive, upload to TestFlight, rotate
  or revoke credentials, run database migrations, or modify GitHub/Apple/
  Railway secrets without explicit approval.
- Preserve unrelated local changes. Never use force push, destructive reset,
  clean, or rebase published work during routine maintenance.
