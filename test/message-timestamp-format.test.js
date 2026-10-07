'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.jsx'), 'utf8');
const start = source.indexOf('function formatTime(ts, now = new Date(), timeZone = TZ)');
const end = source.indexOf('\n}', start) + 2;
const formatTime = new Function('TZ', `${source.slice(start, end)}; return formatTime;`)('America/New_York');
const now = new Date('2026-10-07T18:00:00Z');

test('today, yesterday, and older messages have clear calendar-day labels', () => {
  assert.equal(formatTime('2026-10-07T17:03:00Z', now), '13:03');
  assert.equal(formatTime('2026-10-06T20:03:00Z', now), 'Yesterday 16:03');
  assert.equal(formatTime('2026-10-05T20:03:00Z', now), '5 Oct 16:03');
  assert.equal(formatTime('2025-10-05T20:03:00Z', now), '5 Oct 2025 16:03');
});

test('selected zone determines the day boundary and daylight saving offset', () => {
  const midnight = new Date('2026-10-07T02:00:00Z');
  assert.equal(formatTime('2026-10-07T01:03:00Z', midnight), '21:03');
  assert.equal(formatTime('2026-10-07T01:03:00Z', midnight, 'Europe/London'), '02:03');
  assert.equal(formatTime('2026-10-06T23:03:00Z', midnight, 'Europe/London'), '00:03');
  assert.equal(formatTime('2026-10-05T23:03:00Z', midnight, 'Europe/London'), 'Yesterday 00:03');
  assert.equal(formatTime('2026-01-05T20:03:00Z', new Date('2026-01-07T18:00:00Z')), '5 Jan 15:03');
});

test('missing or invalid timestamps are empty', () => {
  for (const value of [null, undefined, '', 'bad']) assert.equal(formatTime(value, now), '');
});

test('the committed browser bundle contains the updated formatter', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(bundle, /Yesterday/);
  assert.match(bundle, /shore-inbox-time-zone/);
});
