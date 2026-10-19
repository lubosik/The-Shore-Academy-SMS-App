'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { smsSegments, prepareSms } = require('../lib/sms-segments');

test('long Unicode lesson becomes one send under the ten-part limit', () => {
  const lesson = `Hi! Ocean safety lesson:\n\n🧭 On the sand\n • Sun safety — sunscreen and hydration\n\n🌊 In the shallows\n • Spotting rip currents\n\n🏄 In the water\n • Flip, float, follow\n${' Safe swimming matters.'.repeat(42)}`;
  assert.ok(smsSegments(lesson).count > 10);
  const result = prepareSms(lesson);
  assert.equal(result.changed, true);
  assert.equal(result.segments.encoding, 'GSM-7');
  assert.ok(result.segments.count <= 10);
  assert.match(result.text, /Sun safety - sunscreen/);
  assert.match(result.text, /Flip, float, follow/);
});

test('short Unicode and MMS are left exactly as composed', () => {
  assert.deepEqual(prepareSms('🌊 See you at the beach!'), {
    text: '🌊 See you at the beach!',
    changed: false,
    segments: smsSegments('🌊 See you at the beach!')
  });
  const long = '🌊'.repeat(800);
  assert.equal(prepareSms(long, { hasMedia: true }).text, long);
});

test('unrecoverably long SMS is stopped with a useful error', () => {
  assert.throws(() => prepareSms('A'.repeat(1600)), /limit is 10/);
  assert.throws(() => prepareSms('界'.repeat(800)), /limit is 10/);
});

test('GSM extension characters use two septets', () => {
  assert.deepEqual(smsSegments('^'.repeat(81)), { encoding: 'GSM-7', units: 162, count: 2 });
});
