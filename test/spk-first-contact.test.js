'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  closeDateDays,
  firstContactAction,
  firstContactSchedule,
  isSpkFirstContactService,
  spkChecklist,
} = require('../spk-first-contact');

test('uses 14 days for SPK with specialists and 21 days for selection or attestation', () => {
  assert.equal(closeDateDays({ needsSelection: false, service: 'СПК' }), 14);
  assert.equal(closeDateDays({ needsSelection: true, service: 'СПК' }), 21);
  assert.equal(closeDateDays({ needsSelection: false, service: 'СПК + аттестация специалиста' }), 21);
});

test('accepts SPK and attestation services for the first-contact scenario', () => {
  assert.equal(isSpkFirstContactService('СПК'), true);
  assert.equal(isSpkFirstContactService('Аттестация ОБ'), true);
  assert.equal(isSpkFirstContactService('СУОТ'), false);
});

test('starts first contact today before noon and next workday after noon', () => {
  const beforeNoon = firstContactSchedule(new Date('2026-10-08T08:30:00.000Z')); // 11:30 Minsk
  assert.equal(beforeNoon.startAt.toISOString(), '2026-10-08T08:30:00.000Z');
  assert.equal(beforeNoon.deadlineAt.toISOString(), '2026-10-08T12:30:00.000Z');

  const afterNoonFriday = firstContactSchedule(new Date('2026-10-09T10:30:00.000Z')); // 13:30 Minsk Friday
  assert.equal(afterNoonFriday.startAt.toISOString(), '2026-10-12T06:00:00.000Z');
  assert.equal(afterNoonFriday.deadlineAt.toISOString(), '2026-10-12T10:00:00.000Z');

  const sunday = firstContactSchedule(new Date('2026-10-11T06:00:00.000Z')); // 09:00 Minsk Sunday
  assert.equal(sunday.startAt.toISOString(), '2026-10-12T06:00:00.000Z');
});

test('uses only the concise SPK document checklist', () => {
  const text = spkChecklist().join('\n');
  assert.match(text, /свидетельство о регистрации/i);
  assert.match(text, /Средства измерения/i);
  assert.match(text, /ИПС «Стройпрофи»/i);
  assert.doesNotMatch(text, /нивелирная рейка/i);
});

test('reminds after four working hours and escalates after one working day', () => {
  assert.equal(firstContactAction({ completed: true, elapsedWorkingHours: 12 }), 'none');
  assert.equal(firstContactAction({ completed: false, elapsedWorkingHours: 3 }), 'wait');
  assert.equal(firstContactAction({ completed: false, elapsedWorkingHours: 4 }), 'remind');
  assert.equal(firstContactAction({ completed: false, elapsedWorkingHours: 4, reminderSent: true }), 'wait');
  assert.equal(firstContactAction({ completed: false, elapsedWorkingHours: 9, reminderSent: true }), 'escalate');
});
