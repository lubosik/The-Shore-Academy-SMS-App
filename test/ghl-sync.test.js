'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SUPABASE_URL ||= 'https://unit-test.supabase.co';
process.env.SUPABASE_SERVICE_KEY ||= 'unit-test-service-key';
process.env.GHL_PIT ||= 'unit-test-pit';

const {
  isTextMessage,
  normaliseGhlMessage,
  mediaFingerprint,
  storeGhlMessage
} = require('../lib/ghl-message-store');
const {
  getConversationMessages,
  forEachConversationPage
} = require('../lib/ghl-client');
const { safeAttachments } = require('../lib/ghl-writeback');

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

class MemoryQuery {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.operation = 'select';
    this.filters = [];
    this.projection = '*';
    this.max = null;
  }

  select(columns) { this.projection = columns; return this; }
  insert(value) { this.operation = 'insert'; this.value = value; return this; }
  update(value) { this.operation = 'update'; this.value = value; return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  gte(key, value) { this.filters.push(row => row[key] >= value); return this; }
  lte(key, value) { this.filters.push(row => row[key] <= value); return this; }
  lt(key, value) { this.filters.push(row => row[key] < value); return this; }
  limit(value) { this.max = value; return this; }
  maybeSingle() { return this.execute(true); }
  then(resolve, reject) { return this.execute(false).then(resolve, reject); }

  async execute(single) {
    const rows = this.db[this.table] || (this.db[this.table] = []);
    if (this.operation === 'insert') {
      const values = Array.isArray(this.value) ? this.value : [this.value];
      for (const value of values) rows.push({ id: value.id || rows.length + 1, ...value });
      return { data: null, error: null };
    }

    const matched = rows.filter(row => this.filters.every(filter => filter(row)));
    if (this.operation === 'update') {
      for (const row of matched) Object.assign(row, this.value);
      return { data: single ? (matched[0] || null) : matched, error: null };
    }

    const data = this.max === null ? matched : matched.slice(0, this.max);
    return { data: single ? (data[0] || null) : data, error: null };
  }
}

function memoryClient(seed = {}) {
  const db = {
    sms_messages: (seed.sms_messages || []).map(row => ({ ...row })),
    sms_contacts: (seed.sms_contacts || []).map(row => ({ ...row }))
  };
  return { db, client: { from: table => new MemoryQuery(db, table) } };
}

test('official GHL SMS variants and image-only messages normalise into the exact phone thread', () => {
  const variants = ['SMS', 'TYPE_SMS', 'TYPE_CAMPAIGN_SMS', 'TYPE_CUSTOM_PROVIDER_SMS'];
  for (let i = 0; i < 1_000; i++) {
    const marker = variants[i % variants.length];
    const result = normaliseGhlMessage({
      messageId: `ghl-${i}`,
      messageType: marker,
      body: i % 2 ? `message ${i}` : '',
      attachments: i % 2 ? [] : [`https://media.example/${i}.jpg`],
      direction: i % 3 ? 'outbound' : 'inbound',
      to: i % 3 ? '(561) 555-0100' : undefined,
      from: i % 3 ? undefined : '+15615550100',
      dateAdded: 1_765_000_000_000 + i,
      status: i % 5 ? 'delivered' : 'pending'
    }, '+15615550100');

    assert.equal(result.phone, '+15615550100');
    assert.equal(result.ghlId, `ghl-${i}`);
    assert.equal(result.mediaUrls.length, i % 2 ? 0 : 1);
  }

  assert.equal(isTextMessage({ messageType: 'Email' }), false);
  assert.equal(isTextMessage({ messageTypeString: 'TYPE_SMS' }), true);
});

test('same caption with different pictures is not considered a duplicate', () => {
  assert.notEqual(
    mediaFingerprint([{ url: 'https://media.example/a.jpg' }]),
    mediaFingerprint([{ url: 'https://media.example/b.jpg' }])
  );
});

test('app-to-GHL MMS keeps only unique public HTTPS attachments', () => {
  assert.deepEqual(safeAttachments([
    { url: 'https://media.example/one.jpg' },
    'https://media.example/two.png',
    'https://media.example/two.png',
    'file:///private/photo.jpg',
    'http://insecure.example/photo.jpg'
  ]), [
    'https://media.example/one.jpg',
    'https://media.example/two.png'
  ]);
});

test('a later GHL poll updates media/status in place without duplicating the phone thread', async () => {
  const { db, client } = memoryClient({
    sms_contacts: [{ id: 1, phone: '+15615550100', last_seen: '2025-01-01T00:00:00.000Z' }]
  });

  const first = await storeGhlMessage({
    id: 'ghl-stable-1',
    messageType: 'SMS',
    direction: 'outbound',
    to: 'The Shore Academy',
    body: 'Here is the waiver',
    status: 'pending',
    dateAdded: '2026-08-15T10:00:00.000Z'
  }, '+15615550100', { client });
  assert.equal(first, 'inserted');

  const second = await storeGhlMessage({
    messageId: 'ghl-stable-1',
    messageTypeString: 'TYPE_SMS',
    direction: 'outbound',
    body: 'Here is the waiver',
    attachments: ['https://media.example/waiver.jpg'],
    status: 'delivered',
    dateAdded: '2026-08-15T10:00:00.000Z'
  }, '+15615550100', { client });

  assert.equal(second, 'updated');
  assert.equal(db.sms_messages.length, 1);
  assert.equal(db.sms_messages[0].contact_phone, '+15615550100');
  assert.equal(db.sms_messages[0].status, 'delivered');
  assert.deepEqual(db.sms_messages[0].media_urls, [{ url: 'https://media.example/waiver.jpg' }]);
});

test('conversation message pagination walks beyond GHL default first page', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    if (calls.length === 1) {
      return jsonResponse({ messages: {
        messages: [{ id: 'm3' }, { id: 'm2' }],
        lastMessageId: 'm2',
        nextPage: true
      } });
    }
    return jsonResponse({ messages: {
      messages: [{ id: 'm1' }],
      lastMessageId: 'm1',
      nextPage: false
    } });
  };

  try {
    const rows = await getConversationMessages('conversation/id', { limit: 2 });
    assert.deepEqual(rows.map(row => row.id), ['m3', 'm2', 'm1']);
    assert.match(calls[0], /conversation%2Fid\/messages/);
    assert.match(calls[1], /lastMessageId=m2/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('conversation search pagination uses timestamp and id cursor', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async url => {
    calls.push(String(url));
    if (calls.length === 1) {
      return jsonResponse({
        conversations: [
          { id: 'c2', lastMessageDate: 200 },
          { id: 'c1', lastMessageDate: 100 }
        ],
        total: 3
      });
    }
    return jsonResponse({ conversations: [{ id: 'c0', lastMessageDate: 50 }], total: 3 });
  };

  const seen = [];
  try {
    await forEachConversationPage('location-1', page => { seen.push(...page); }, { limit: 2 });
    assert.deepEqual(seen.map(row => row.id), ['c2', 'c1', 'c0']);
    assert.match(calls[1], /startAfterDate=100/);
    assert.match(calls[1], /id=c1/);
  } finally {
    global.fetch = originalFetch;
  }
});
