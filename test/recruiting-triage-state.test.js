'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { rabotaAwaitingApplicantReply, rabotaClarificationCount } = require('../recruiting-triage-state');

const question = 'Спасибо за отклик! Чтобы корректно оценить соответствие вакансии, уточните, пожалуйста: ...';

test('does not send a second clarification until the applicant replies', () => {
  const waiting = { items: [{ author: { participant_type: 'employer' }, text: question }] };
  const replied = { items: [...waiting.items, { author: { participant_type: 'applicant' }, text: 'Работал в CRM.' }] };

  assert.equal(rabotaAwaitingApplicantReply(waiting), true);
  assert.equal(rabotaAwaitingApplicantReply(replied), false);
  assert.equal(rabotaClarificationCount(replied), 1);
});
