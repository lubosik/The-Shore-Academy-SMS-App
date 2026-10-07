// Inspect a Shore Academy build and optionally add it to an existing beta group.
// Run in GitHub Actions: the App Store Connect key stays in repository secrets.
import { createPrivateKey, sign } from 'node:crypto';

const APP_ID = '6800407508';
const buildNumber = process.env.BUILD_NUMBER;
const groupId = process.env.BETA_GROUP_ID || '';
const notifyTesters = process.env.NOTIFY_TESTERS === 'true';
const keyId = process.env.ASC_KEY_ID;
const issuerId = process.env.ASC_ISSUER_ID;
const encodedKey = process.env.ASC_KEY_P8_BASE64;
if (!keyId || !issuerId || !encodedKey || !/^\d+$/.test(buildNumber)) {
  throw new Error('Missing App Store Connect credentials or invalid build number');
}

const key = createPrivateKey(Buffer.from(encodedKey, 'base64'));
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const unsigned = [
  base64url({ alg: 'ES256', kid: keyId, typ: 'JWT' }),
  base64url({ iss: issuerId, iat: now, exp: now + 900, aud: 'appstoreconnect-v1' })
].join('.');
const token = `${unsigned}.${sign('sha256', Buffer.from(unsigned), {
  key, dsaEncoding: 'ieee-p1363'
}).toString('base64url')}`;

async function request(path, options = {}) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    }
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const details = (error.errors || []).map(item => `${item.code}: ${item.detail}`).join('; ');
    throw new Error(`App Store Connect ${response.status}: ${details || response.statusText}`);
  }
  return response.status === 204 ? null : response.json();
}

const query = new URLSearchParams({
  'filter[app]': APP_ID,
  'filter[version]': buildNumber,
  'fields[builds]': 'version,processingState,expired,buildAudienceType',
  limit: '20'
});
let build;
for (let attempt = 0; attempt < (groupId ? 40 : 1); attempt++) {
  const builds = (await request(`/v1/builds?${query}`)).data;
  if (builds.length > 1) throw new Error(`Expected one Shore Academy build ${buildNumber}; found ${builds.length}`);
  build = builds[0];
  if (build?.attributes.processingState === 'VALID') break;
  if (build && build.attributes.processingState !== 'PROCESSING') break;
  if (attempt < 39 && groupId) await new Promise(resolve => setTimeout(resolve, 15_000));
}
if (!build) throw new Error(`Shore Academy build ${buildNumber} was not found`);
console.log(`Build ${buildNumber}: ${build.attributes.processingState}, expired=${build.attributes.expired}, audience=${build.attributes.buildAudienceType}`);
if (build.attributes.processingState !== 'VALID' || build.attributes.expired) {
  throw new Error('Build is not available for testing');
}

const groupsResponse = await request(`/v1/apps/${APP_ID}/betaGroups?limit=200`);
if (groupsResponse.links?.next) throw new Error('More than 200 groups; inspect pagination before publishing');
const groups = groupsResponse.data;
if (groups.length === 0) throw new Error('This app has no beta tester group');

let assignedTesterCount = 0;
for (const group of groups) {
  const [groupBuilds, testers] = await Promise.all([
    request(`/v1/betaGroups/${group.id}/relationships/builds?limit=200`),
    request(`/v1/betaGroups/${group.id}/relationships/betaTesters?limit=200`)
  ]);
  if (groupBuilds.links?.next || testers.links?.next) {
    throw new Error(`Group ${group.attributes.name} exceeds the inspected page limit`);
  }
  if (groupBuilds.data.some(item => item.id === build.id)) assignedTesterCount += testers.data.length;
  console.log(JSON.stringify({
    group: group.attributes.name,
    id: group.id,
    internal: group.attributes.isInternalGroup,
    allBuilds: group.attributes.hasAccessToAllBuilds,
    testers: testers.data.length,
    currentBuild: groupBuilds.data.some(item => item.id === build.id),
    priorBuildIds: groupBuilds.data.filter(item => item.id !== build.id).map(item => item.id)
  }));
}

if (groupId) {
  const group = groups.find(item => item.id === groupId);
  if (!group) throw new Error('Requested group does not belong to the Shore Academy app');
  if (build.attributes.buildAudienceType === 'INTERNAL_ONLY' && !group.attributes.isInternalGroup) {
    throw new Error('Internal-only build cannot be assigned to an external group');
  }
  await request(`/v1/betaGroups/${groupId}/relationships/builds`, {
    method: 'POST',
    body: JSON.stringify({ data: [{ type: 'builds', id: build.id }] })
  });
  const assigned = await request(`/v1/betaGroups/${groupId}/relationships/builds?limit=200`);
  if (!assigned.data.some(item => item.id === build.id)) throw new Error('Assignment did not appear in the group');
  const testers = await request(`/v1/betaGroups/${groupId}/relationships/betaTesters?limit=200`);
  assignedTesterCount += testers.data.length;
  console.log(`Verified build ${buildNumber} is assigned to group ${group.attributes.name}`);
}

if (notifyTesters) {
  if (assignedTesterCount === 0) throw new Error('No assigned testers; notification was not sent');
  await request('/v1/buildBetaNotifications', {
    method: 'POST',
    body: JSON.stringify({
      data: {
        type: 'buildBetaNotifications',
        relationships: { build: { data: { type: 'builds', id: build.id } } }
      }
    })
  });
  console.log(`Asked TestFlight to notify assigned testers about build ${buildNumber}`);
}
