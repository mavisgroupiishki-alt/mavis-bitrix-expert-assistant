'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { analysisComment, clarificationMessage, hasCompleteNumericScores, normalizeScorecard, professionalResumeContext, rejectionMessage } = require('../recruiting-scorecard');

test('normalizes the approved 100-point manager scorecard and routes by threshold', () => {
  const invite = normalizeScorecard({ scores: { b2b: 25, cold: 15, discovery: 15, crm: 15, complex: 10, metrics: 10, learning: 5, conditions: 5 } });
  const clarify = normalizeScorecard({ scores: { b2b: 10, cold: 7, discovery: 8, crm: 8, complex: 4, metrics: 4, learning: 2, conditions: 2 } });
  const reject = normalizeScorecard({ scores: { b2b: 0, cold: 0, discovery: 0, crm: 0, complex: 0, metrics: 0, learning: 0, conditions: 0 } });

  assert.equal(invite.total, 100);
  assert.equal(invite.action, 'invite');
  assert.equal(clarify.action, 'clarify');
  assert.equal(reject.action, 'reject');
  assert.ok(clarify.questions.length > 0 && clarify.questions.length <= 3);
  assert.match(analysisComment(invite), /100\/100/);
  assert.equal(hasCompleteNumericScores({ scores: { b2b: 1 } }), false);
  assert.equal(hasCompleteNumericScores({ scores: invite.scores }), true);
});

test('keeps demographic data out of the AI resume context and makes neutral candidate messages', () => {
  const context = professionalResumeContext({
    age: 33,
    resume: {
      first_name: 'Иван', last_name: 'Иванов', age: 33, title: 'B2B sales',
      skill_set: ['CRM', 'Переговоры'],
      experience: [{ position: 'Менеджер', company: 'Тест', description: 'Вёл клиентов. Мне 33 года, телефон +375 29 000-00-00.' }],
    },
  }, ['Мой телефон +375 29 000-00-00, работал с CRM.']);

  assert.equal(JSON.stringify(context).includes('33'), false);
  assert.equal(JSON.stringify(context).includes('Иван'), false);
  assert.equal(JSON.stringify(context).includes('33 года'), false);
  assert.match(JSON.stringify(context), /\[телефон\]/);
  assert.match(clarificationMessage(['Первый вопрос', 'Второй вопрос', 'Третий вопрос']), /1\. Первый вопрос/);
  assert.doesNotMatch(rejectionMessage(), /возраст|пол|резюме/i);
});
