'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectAudioPayload } = require('../autopilot-audio-validation');

test('rejects an HTML or text response masquerading as a call recording', () => {
  const result = inspectAudioPayload('text/html; charset=utf-8', Buffer.from('<!doctype html><title>Document</title>'));

  assert.deepEqual(result, { ok: false, reason: 'content-type=text/html' });
});

test('rejects textual bytes even when an upstream service labels them as audio', () => {
  const result = inspectAudioPayload('audio/mpeg', Buffer.from('<!doctype html><title>Document</title>'));

  assert.deepEqual(result, { ok: false, reason: 'текстовое содержимое' });
});

test('accepts an MP3 recording delivered as application/octet-stream', () => {
  const result = inspectAudioPayload('application/octet-stream', Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]));

  assert.deepEqual(result, { ok: true });
});
