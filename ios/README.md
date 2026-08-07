# Shore Academy — iOS app

Native iPhone client for The Shore Academy SMS/voice inbox. It provides the
conversation inbox, SMS/MMS composer, contacts and order detail, call history,
and native calling. Incoming business calls use PushKit and CallKit for the
full-screen system call UI.

This is not a separate system. It talks to the same Railway backend and the
same Supabase database as the web inbox, reusing the existing endpoints.

There is **no Automations tab**: The Shore Academy runs all messaging
automation in GoHighLevel, so the app deliberately contains no automation
queue, history, or cancellation UI.

---

## Project facts

| Item | Value |
|---|---|
| Bundle ID | `com.theshoreacademy.inbox` |
| Display name | Shore Academy |
| Apple Team ID | `PQFYN2CD77` (same developer account as before the rebrand) |
| Deployment target | iOS 16.0, iPhone only |
| Telnyx SDK | `TelnyxRTC` 4.1.2 (Swift Package Manager) |
| Backend URL | **placeholder** — see below |
| Capabilities | Push Notifications, Background Modes → Voice over IP + Audio |

### Backend URL is a placeholder

`Core/AppConfig.swift` currently points at `https://REPLACE-WITH-RAILWAY-URL`.
The Shore Academy Railway deployment **has not been created yet**. Set the real
generated Railway URL there before shipping any build. Do not guess one — a
wrong URL produces a silent login failure that is very hard to diagnose.

### Telnyx / voice setup is NOT done

None of the client-specific telephony exists yet for this app:

- No Shore Academy Telnyx phone number, Call Control app, or credential
  connection has been configured.
- The **VoIP Services certificate does not exist yet.** A fresh CSR for this
  app is at `certs/ShoreInbox_VoIP.certSigningRequest`; the Account Holder
  steps are in `APPLE-ACCOUNT-HOLDER-CHECKLIST.md`, and
  `scripts/prepare-telnyx-cert.sh` converts the returned certificate for the
  Telnyx portal.
- Until the certificate is issued, uploaded to Telnyx, and attached to a Shore
  Academy SIP credential connection, incoming calls will not ring the iPhone
  when the app is backgrounded or terminated.

Messaging (SMS/MMS inbox) only needs the backend URL and login; calling needs
the full Telnyx setup above plus the backend `/api/voice/*` routes.

## How the call path works

```
Client dials the business number
        │
        ▼
Telnyx Call Control ──▶ POST /webhooks/voice  (existing backend, unchanged)
        │                    answer → greeting → transfer
        ▼
transfer to sip:<TELNYX_SIP_USERNAME>@sip.telnyx.com
        │
        ├─ iPhone on the socket?  → SIP INVITE straight to the app
        └─ iPhone asleep/killed?  → Telnyx sends a VoIP push via APNs
                                      │
                                      ▼
                        iOS relaunches the app in the background
                                      │
                        AppDelegate.pushRegistry(didReceiveIncomingPushWith:)
                                      │
                        TelnyxVoiceManager.handleVoIPPush
                          ├─ processVoIPNotification()  → socket reattaches
                          └─ CallKit reportNewIncomingCall() → PHONE RINGS
```

The critical rule: **every VoIP push must result in a reported call before the
PushKit handler returns.** If it doesn't, iOS kills the app, and repeated
offences make iOS stop delivering VoIP pushes entirely. `handleVoIPPush` is
written so that it always reports, even when credentials are missing or the
payload is malformed.

## Source layout

```
ios/
├── project.yml                  XcodeGen spec (for Macs that can run Xcode)
├── ShoreInbox.xcodeproj/        committed — CI needs it; regenerate with scripts/
├── certs/
│   ├── ShoreInbox_VoIP.certSigningRequest  ← send THIS to the account holder
│   └── voip_push_private_key.pem           ← NEVER leaves this machine (gitignored)
└── ShoreInbox/
    ├── App/
    │   ├── ShoreInboxApp.swift     SwiftUI entry point
    │   ├── AppDelegate.swift       PushKit + standard APNs callbacks
    │   ├── MessageNotificationManager.swift  message alerts + deep links
    │   ├── SessionModel.swift      Authentication + voice state
    │   └── FeatureModels.swift     Inbox/contact/call feature state
    ├── Core/
    │   ├── AppConfig.swift         Server URL (PLACEHOLDER), push environment
    │   ├── APIClient.swift         Typed access to existing authenticated APIs
    │   ├── MobileModels.swift      Native API data-transfer models
    │   ├── CredentialStore.swift   Keychain (survives cold launch from push)
    │   └── Log.swift               OSLog — how you debug the terminated-app path
    ├── Voice/
    │   ├── TelnyxVoiceManager.swift  TxClient + TxClientDelegate + CallKit bridge
    │   ├── CallKitCoordinator.swift  CXProvider / CXCallController
    │   └── CallModels.swift          UI-facing call state, phone formatting
    ├── UI/
    │   ├── Theme.swift              Shore Academy palette — single source of truth
    │   ├── LoginView.swift          Login + animated ocean wave backdrop
    │   └── …                        Inbox, contacts, calls, settings
    └── Resources/                   Info.plist, entitlements, asset catalog
```

## Brand and theme

All colour lives in `UI/Theme.swift` (`ShoreTheme`). Brand kit: navy `#123A5A`
(primary), cream `#E6D6B8` (secondary), orange `#E85A2E` (accent, used
sparingly for urgent/destructive states and unread badges). Every token is a
dynamic colour with light and dark variants; do not add hex literals to views.
The login screen draws a layered animated wave (TimelineView + Canvas) that
freezes when Reduce Motion is enabled.

## Backend relationship

The app reuses authenticated endpoints that already serve the browser:

- `POST /auth/login` — the same shared inbox password as the web app
- `/api/conversations` and `/api/send` — threads and SMS/MMS
- `/api/contacts` — contact and order data
- `/api/voice/token` and `/api/voice/logs` — native calling and history
- `/api/mobile-push` — native APNs device registration and test delivery

Railway must stay running: it owns the database access, webhooks, and
integrations. Provider credentials remain there and are never embedded in iOS.

`GET /api/voice/token` requires the native app's `X-Vici-Client: ios` header.
That header name is legacy from the codebase this app was built from, but it is
**checked by the backend**, which is owned separately — do not rename it on one
side only.

The SIP credentials are cached in the Keychain (`kSecAttrAccessibleAfterFirstUnlock`)
so a push-woken cold launch can connect without waiting on the network.

## Message delivery status

Outbound SMS/MMS bubbles show the provider lifecycle, not a guessed receipt:

- **Queued** — accepted by Telnyx and waiting to be sent.
- **Sent** — handed to the carrier, with delivery not yet confirmed.
- **Delivered** — the carrier/device confirmed delivery.
- **Failed** — sending or delivery failed.
- **Status unavailable** — Telnyx's ten-day message lookup window has expired,
  so no final provider receipt can be recovered.

SMS and MMS do not expose when the recipient opens or reads the message, so
**Delivered does not mean Read**. Opening a thread reconciles recent non-final
rows against Telnyx, which repairs a status when a delivery webhook arrived
before its database row or was otherwise missed.

## Build

This local Mac cannot compile the app — see `BUILD-ENVIRONMENT.md`. Source-only
builds and signed TestFlight builds run through GitHub Actions
(`.github/workflows/ios-build.yml` and `ios-testflight.yml`).

`ShoreInbox.xcodeproj` **is committed**, because CI needs a project and a
shared scheme to build. It is generated, not hand-maintained — after adding or
removing a Swift file:

```bash
python3 ios/scripts/generate-xcodeproj.py
```

IDs derive from file paths, so regenerating without changes produces no diff.
Forgetting fails the CI build with the exact command to run.

On a Mac that *can* run Xcode, `xcodegen generate` from `project.yml` produces
the equivalent project and is the nicer route; the Python generator exists
because XcodeGen cannot run on macOS 13.

**CallKit does not work in the Simulator.** All testing must be on a real device.

## Order of operations for launch

1. ✅ Code rebranded for The Shore Academy (this repo)
2. ⬜ Deploy the Shore Academy backend to Railway; put the real URL in
   `AppConfig.swift`
3. ⬜ Account Holder registers App ID `com.theshoreacademy.inbox` and creates
   the VoIP Services certificate from `certs/ShoreInbox_VoIP.certSigningRequest`
4. ⬜ Convert and upload the certificate to Telnyx
   (`scripts/prepare-telnyx-cert.sh`), attach it to the Shore Academy SIP
   credential connection
5. ⬜ Configure GitHub Actions secrets for this app's App Store Connect access
6. ⬜ Non-signing `iOS Build` workflow passes
7. ⬜ TestFlight build installed on a physical iPhone; run `TESTING.md`

## Known gotchas baked into the code

- **Push environment must match the build.** Debug builds get a sandbox APNs
  token; TestFlight/App Store get production. `AppConfig.pushEnvironmentIsProduction`
  pins this off `#if DEBUG`. Mismatch here is the number-one cause of
  "the push never arrives".
- **CallKit UUID must equal `metadata.call_id`.** The SDK creates a placeholder
  call keyed on that UUID; report a different one and answering silently fails
  and the call UI gets stuck.
- **Answering before the socket reattaches is safe.** The SDK stashes the
  answer action and applies it when the INVITE lands. Don't poll for the call.
- **Login before push.** The device token only registers with Telnyx on a
  successful `connect()`. A fresh install must be opened once.
- **`pushWhenActive` stays false.** A foreground SDK socket receives the INVITE
  directly and `onIncomingCall` still reports it through CallKit. With SDK
  4.1.2, also processing a push while connected replaces that socket and can
  lose the INVITE during Answer. Locked/background calls still use PushKit.

## Missed-call and unread badges

iOS gives an app a single Home Screen badge, so it carries both halves of the
inbox: unread messages plus missed calls nobody has looked at. Five unread and
two missed shows **7** on the icon, **5** on Inbox and **2** on Calls.

The missed count clears by *seeing* call history, not by opening each call —
the same rule WhatsApp uses. Switching the Calls tab to **History** clears it.
Staying on **Keypad** does not.

"Seen" is tracked in two places, deliberately:

| Where | Purpose |
|---|---|
| `call_logs.seen_at` | Lets the server compute the badge it attaches to message pushes, and clears the count on a second signed-in device |
| `shore.calls.seen-missed-ids` in `UserDefaults` | Keeps the in-app badge correct offline, when the mark request fails, and before the migration below is applied |

**One-time migration:** run `scripts/missed-calls-seen-migration.sql` (backend
repo) in the Supabase SQL editor once the Shore Academy database exists. Until
it is applied, everything still works, with one gap — an incoming SMS push
resets the Home Screen badge to the unread count alone, dropping the
missed-call part until the app is next opened.

## Native message notifications

The repository-side implementation is complete. The inbound Telnyx webhook
targets both browser VAPID subscriptions and standard iOS APNs device tokens.
The iOS app registers its current token after login, shows foreground
banners/sounds, and deep-links notification taps into the matching
conversation.

Production activation still needs the one-time database migration, Railway
variables, and a distinct Apple Developer APNs signing key described in
`MESSAGE-NOTIFICATIONS.md`. The App Store Connect build/upload key is not an
APNs provider key, and VoIP PushKit credentials must remain call-only.
