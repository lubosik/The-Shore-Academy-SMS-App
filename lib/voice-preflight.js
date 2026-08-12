'use strict';
/**
 * lib/voice-preflight.js — reports whether Telnyx is actually configured to
 * place outbound calls, at boot, before anyone finds out by failing one.
 *
 * Written after a real incident: The Shore Academy's credential connection had
 * no outbound voice profile attached, so Telnyx rejected every outbound call
 * about two seconds in. Inbound was unaffected, because inbound does not need
 * one — so the fault stayed invisible until someone tried to dial out, and
 * even then the app could only say "call failed".
 *
 * A missing outbound voice profile is not something the app can detect from a
 * failed call: Telnyx rejects it upstream and never sends a call event, so the
 * only record is the phone's own client-side fallback. Asking Telnyx directly
 * is the only way to know, so this asks once per boot.
 *
 * Advisory only. It never throws and never blocks startup — a check that can
 * take the app down is worse than the fault it looks for.
 */

const TELNYX_API = 'https://api.telnyx.com/v2';

async function telnyxGet(path, apiKey) {
  const res = await fetch(`${TELNYX_API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`Telnyx ${path} → ${res.status}`);
  return res.json();
}

/**
 * @returns {{ ok: boolean, reason?: string, details?: object }}
 */
async function checkVoiceConfig() {
  const apiKey = process.env.TELNYX_API_KEY;
  const sipUser = process.env.TELNYX_IOS_SIP_USERNAME;

  if (!apiKey) return { ok: false, reason: 'TELNYX_API_KEY is not set' };
  if (!sipUser) return { ok: false, reason: 'TELNYX_IOS_SIP_USERNAME is not set — the iPhone has no SIP identity' };

  const { data: connections } = await telnyxGet('/credential_connections?page[size]=100', apiKey);
  const connection = (connections || []).find(c => c.user_name === sipUser);

  if (!connection) {
    return {
      ok: false,
      reason: `No Telnyx credential connection uses SIP user "${sipUser}" — the iPhone will register nowhere`
    };
  }

  const profileId = connection.outbound?.outbound_voice_profile_id;
  if (!profileId) {
    return {
      ok: false,
      reason: `Credential connection "${connection.connection_name}" has no outbound voice profile — Telnyx will reject every outbound call`,
      details: { connectionId: connection.id, connectionName: connection.connection_name }
    };
  }

  if (connection.active === false) {
    return {
      ok: false,
      reason: `Credential connection "${connection.connection_name}" is inactive`,
      details: { connectionId: connection.id }
    };
  }

  // The profile can exist but be disabled or exclude the destinations we call.
  let profile = null;
  try {
    ({ data: profile } = await telnyxGet(`/outbound_voice_profiles/${profileId}`, apiKey));
  } catch {
    // A profile we cannot read is not proof of a fault; the attachment is the
    // thing that actually gates calling, and that is present.
    return { ok: true, details: { connectionName: connection.connection_name, profileId } };
  }

  if (profile && profile.enabled === false) {
    return {
      ok: false,
      reason: `Outbound voice profile "${profile.name}" is disabled`,
      details: { profileId }
    };
  }

  const destinations = profile?.whitelisted_destinations || [];
  if (destinations.length && !destinations.includes('US')) {
    return {
      ok: false,
      reason: `Outbound voice profile "${profile.name}" does not permit US destinations`,
      details: { profileId, destinations: destinations.length }
    };
  }

  return {
    ok: true,
    details: {
      connectionName: connection.connection_name,
      profileName: profile?.name,
      profileId,
      destinations: destinations.length
    }
  };
}

/**
 * Run the check and report it. Fire-and-forget from server startup.
 */
async function reportVoiceConfig() {
  try {
    const result = await checkVoiceConfig();
    if (result.ok) {
      const d = result.details || {};
      console.log(`[VOICE-PREFLIGHT] Outbound calling is configured — connection "${d.connectionName}" → profile "${d.profileName || d.profileId}"${d.destinations ? ` (${d.destinations} destinations)` : ''}.`);
    } else {
      console.error('[VOICE-PREFLIGHT] OUTBOUND CALLING WILL FAIL:', result.reason);
      console.error('[VOICE-PREFLIGHT] Fix in the Telnyx portal under Voice → Credential Connections, or calls from the iPhone will fail about two seconds in with no other explanation.');
    }
    return result;
  } catch (err) {
    // Telnyx being briefly unreachable is not a configuration fault.
    console.warn('[VOICE-PREFLIGHT] Could not verify voice configuration:', err.message);
    return { ok: null, reason: err.message };
  }
}

module.exports = { checkVoiceConfig, reportVoiceConfig };
