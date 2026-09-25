'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createAutopilotRetryGate } = require('../autopilot-retry');

test('suppresses retries only until the configured cooldown expires', () => {
  const gate = createAutopilotRetryGate();
  const startedAt = new Date('2026-09-24T08:00:00.000Z');

  gate.defer('28242:activity:991', 60, startedAt);

  assert.equal(gate.isDeferred('28242:activity:991', new Date('2026-09-24T08:30:00.000Z')), true);
  assert.equal(gate.isDeferred('28242:activity:991', new Date('2026-09-24T09:00:00.000Z')), false);
});

test('clearing a retry gate permits a newly available call to be processed immediately', () => {
  const gate = createAutopilotRetryGate();
  const now = new Date('2026-09-24T08:00:00.000Z');

  gate.defer('38772:no-call', 60, now);
  gate.clear('38772:no-call');

  assert.equal(gate.isDeferred('38772:no-call', new Date('2026-09-24T08:01:00.000Z')), false);
});
