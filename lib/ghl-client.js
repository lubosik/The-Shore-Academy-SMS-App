'use strict';
/**
 * lib/ghl-client.js — thin fetch wrapper for the GoHighLevel v2 API.
 *
 * GoHighLevel is The Shore Academy's contact system of record. This client
 * only READS contacts; all automation lives inside GHL itself.
 *
 * API facts (verified):
 *   - Base URL:  https://services.leadconnectorhq.com
 *   - Headers:   Authorization: Bearer <GHL_PIT>, Version: 2021-07-28
 *   - Search:    POST /contacts/search  { locationId, pageLimit, searchAfter }
 *                → { contacts: [...], total }. Each contact carries a
 *                `searchAfter` array; pass the LAST contact's value in the
 *                next request for deep pagination. Stop on empty `contacts`.
 *   - Rate limit: 100 requests / 10 seconds → pageLimit 100 + ~200ms pause,
 *                exponential backoff on HTTP 429.
 */

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';
const PAGE_LIMIT = 100;
const PAGE_PAUSE_MS = 200;
const MAX_RETRIES = 5;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireToken() {
  const token = process.env.GHL_PIT;
  if (!token) throw new Error('GHL_PIT is not set — add the private integration token to the environment');
  return token;
}

/**
 * Low-level request with 429 exponential backoff.
 * Throws on non-OK responses (after retries for 429/5xx).
 */
async function ghlRequest(method, path, body = null) {
  const token = requireToken();
  let attempt = 0;

  for (;;) {
    let res;
    try {
      res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Version: API_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch (netErr) {
      if (attempt >= MAX_RETRIES) throw new Error(`GHL network error after ${attempt} retries: ${netErr.message}`);
      const wait = 1000 * 2 ** attempt;
      console.warn(`[GHL] Network error (${netErr.message}) — retrying in ${wait}ms`);
      await sleep(wait);
      attempt++;
      continue;
    }

    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) throw new Error('GHL rate limit: still 429 after max retries');
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 1000 * 2 ** attempt;
      console.warn(`[GHL] 429 rate limited — backing off ${wait}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(wait);
      attempt++;
      continue;
    }

    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }

    if (!res.ok) {
      const detail = json?.message
        ? (Array.isArray(json.message) ? json.message.join('; ') : json.message)
        : text.slice(0, 300);
      const err = new Error(`GHL ${method} ${path} → ${res.status}: ${detail}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }

    return json;
  }
}

/**
 * Fetch one page of contacts.
 * @param {object} opts
 * @param {string} opts.locationId   sub-account location id
 * @param {number} [opts.pageLimit]  page size (max 100)
 * @param {Array}  [opts.searchAfter] cursor from the previous page's last contact
 * @returns {{ contacts: Array, total: number }}
 */
async function searchContactsPage({ locationId, pageLimit = PAGE_LIMIT, searchAfter = null }) {
  const body = { locationId, pageLimit };
  if (searchAfter) body.searchAfter = searchAfter;
  const json = await ghlRequest('POST', '/contacts/search', body);
  return { contacts: json?.contacts || [], total: json?.total ?? null };
}

/**
 * Iterate ALL contacts in a location, page by page.
 * Calls `onPage(contacts, { page, total })` for each non-empty page.
 * Respects the 100 req / 10 s rate limit with a pause between pages.
 */
async function forEachContactPage(locationId, onPage) {
  if (!locationId) throw new Error('locationId is required');
  let searchAfter = null;
  let page = 0;
  let total = null;

  for (;;) {
    const result = await searchContactsPage({ locationId, searchAfter });
    if (total === null) total = result.total;
    if (!result.contacts.length) break;

    page++;
    await onPage(result.contacts, { page, total });

    const last = result.contacts[result.contacts.length - 1];
    if (!last?.searchAfter) break; // no cursor → cannot paginate further
    searchAfter = last.searchAfter;
    await sleep(PAGE_PAUSE_MS);
  }

  return { pages: page, total };
}

module.exports = { ghlRequest, searchContactsPage, forEachContactPage };
