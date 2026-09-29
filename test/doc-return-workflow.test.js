'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { docReturnNextAction } = require('../doc-return-workflow');

const stages = { email: '1126', call: '1128' };

test('starts a reminder chain for an overdue task in Эл. Почта', () => {
  assert.equal(docReturnNextAction({
    stageId: stages.email,
    stages,
    deadlineExpired: true,
    state: { first: false, second: false, call: false },
  }), 'reminder-1');
});

test('waits 14-day deadlines, sends exactly two reminders, then moves to call', () => {
  assert.equal(docReturnNextAction({
    stageId: stages.email,
    stages,
    deadlineExpired: false,
    state: { first: false, second: false, call: false },
  }), 'wait-deadline');
  assert.equal(docReturnNextAction({
    stageId: stages.email,
    stages,
    deadlineExpired: true,
    state: { first: true, second: false, call: false },
  }), 'reminder-2');
  assert.equal(docReturnNextAction({
    stageId: stages.email,
    stages,
    deadlineExpired: true,
    state: { first: true, second: true, call: false },
  }), 'move-to-call');
  assert.equal(docReturnNextAction({
    stageId: stages.email,
    stages,
    deadlineExpired: true,
    state: { first: true, second: true, call: true },
  }), 'already-in-call-flow');
});
