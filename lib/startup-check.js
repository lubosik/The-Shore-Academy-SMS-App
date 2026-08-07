'use strict';

/**
 * lib/startup-check.js — fail loudly and specifically, before anything else.
 *
 * Without this, a missing variable surfaces as a library error thrown while
 * `require`-ing a module: the Supabase client throws "supabaseUrl is required"
 * and web-push throws on malformed VAPID keys. On a platform that only shows
 * "service unavailable" against a health check, that is close to undiagnosable.
 *
 * Must be called BEFORE requiring ./db or ./push-notify.
 */

// Without these the app cannot do its job at all.
const REQUIRED = [
  ['SUPABASE_URL',          'the database'],
  ['SUPABASE_SERVICE_KEY',  'the database'],
  ['INBOX_PASSWORD',        'logging in'],
  ['SESSION_SECRET',        'signing the session cookie'],
  ['TELNYX_API_KEY',        'sending and receiving SMS'],
  ['TELNYX_PHONE_NUMBER',   'sending and receiving SMS']
];

// Each of these disables one feature. The app still starts.
const OPTIONAL = [
  ['GHL_PIT',            'GoHighLevel contact import'],
  ['GHL_LOCATION_ID',    'GoHighLevel contact import'],
  ['GHL_WEBHOOK_SECRET', 'the GoHighLevel new-contact webhook'],
  ['VAPID_PUBLIC_KEY',   'browser push notifications'],
  ['VAPID_PRIVATE_KEY',  'browser push notifications'],
  ['APNS_KEY_ID',        'iPhone notifications'],
  ['APNS_TEAM_ID',       'iPhone notifications'],
  ['APNS_KEY_P8_BASE64', 'iPhone notifications'],
  ['TELNYX_SIP_USERNAME', 'native calling'],
  ['TELNYX_SIP_PASSWORD', 'native calling']
];

function present(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '';
}

module.exports = function startupCheck() {
  const missing = REQUIRED.filter(([name]) => !present(name));
  const absent  = OPTIONAL.filter(([name]) => !present(name));

  if (absent.length) {
    const features = [...new Set(absent.map(([, feature]) => feature))];
    console.warn('[STARTUP] Running with reduced functionality. Unset: ' +
      absent.map(([name]) => name).join(', '));
    features.forEach(feature => console.warn(`[STARTUP]   disabled — ${feature}`));
  }

  if (!missing.length) {
    console.log('[STARTUP] All required configuration present.');
    return;
  }

  // One clear block rather than a stack trace from inside a dependency.
  console.error('');
  console.error('================ CONFIGURATION ERROR ================');
  console.error('The app cannot start. These variables are not set:');
  console.error('');
  missing.forEach(([name, need]) => console.error(`  ${name}  — needed for ${need}`));
  console.error('');
  console.error('Set them in the deployment environment, then redeploy.');
  console.error('====================================================');
  console.error('');
  process.exit(1);
};
