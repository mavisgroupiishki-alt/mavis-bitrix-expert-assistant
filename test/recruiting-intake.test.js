'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { intakeKey, intakeTitle, normalizeRecruitingIntake } = require('../recruiting-intake');

test('normalizes an intake and creates a stable source key', () => {
  const intake = normalizeRecruitingIntake({
    source: 'kufar.by',
    role: 'прораб',
    application_id: '  response-42 ',
    candidate: { full_name: 'Иван Иванов', resume_url: 'https://example.test/resume' },
  });
  assert.equal(intake.source, 'Kufar');
  assert.equal(intake.role, 'Прораб');
  assert.equal(intakeKey(intake), 'Kufar|response-42');
  assert.equal(intakeTitle(intake), 'Кандидат: Иван Иванов — Прораб');
});

test('requires the idempotency key and rejects unsupported input', () => {
  assert.throws(() => normalizeRecruitingIntake({ source: 'Kufar', role: 'Прораб' }), /application_id/);
  assert.throws(() => normalizeRecruitingIntake({ source: 'unknown', role: 'Прораб', application_id: '1' }), /source/);
  assert.throws(() => normalizeRecruitingIntake({ source: 'Kufar', role: 'designer', application_id: '1' }), /role/);
});

test('drops unsafe resume URLs without rejecting the intake', () => {
  const intake = normalizeRecruitingIntake({
    source: 'rabota.by', role: 'manager', application_id: '9', candidate: { resume_url: 'javascript:alert(1)' },
  });
  assert.equal(intake.candidate.resumeUrl, '');
});
