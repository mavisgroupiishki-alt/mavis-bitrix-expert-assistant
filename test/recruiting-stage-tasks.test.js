'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isRecruitingAutomationPaused, recruitingStageTaskMarker, recruitingStageTaskPlan } = require('../recruiting-stage-tasks');

test('routes a manager decision to the explicitly selected approver', () => {
  const plan = recruitingStageTaskPlan({ stageId: 'C34:HR_DECISION', role: 'Менеджер по продажам', decisionOwner: ['817'], recruiterId: '2216' });
  assert.equal(plan.responsibleId, '817');
  assert.match(plan.title, /решение/i);
});

test('routes a decision with no approver and all foreman decisions to the recruiter', () => {
  const missingOwner = recruitingStageTaskPlan({ stageId: 'C34:HR_DECISION', role: 'Эксперт', decisionOwner: '', recruiterId: '2216' });
  const foreman = recruitingStageTaskPlan({ stageId: 'C34:HR_DECISION', role: 'Прораб', decisionOwner: '817', recruiterId: '2216' });
  assert.equal(missingOwner.responsibleId, '2216');
  assert.match(missingOwner.title, /согласующего/i);
  assert.equal(foreman.responsibleId, '2216');
  assert.match(foreman.description, /автоматический отсев/i);
});

test('keeps the marker deterministic and skips paused automation', () => {
  const first = recruitingStageTaskMarker({ dealId: '42', stageId: 'C34:EXECUTING', movedTime: '2026-09-08T12:00:00+03:00' });
  const second = recruitingStageTaskMarker({ dealId: '42', stageId: 'C34:EXECUTING', movedTime: '2026-09-08T12:00:00+03:00' });
  assert.equal(first, second);
  assert.match(first, /^\[MAVIS_RECRUITING_STAGE_TASK:42:/);
  assert.equal(isRecruitingAutomationPaused('2', '2', '3'), true);
  assert.equal(isRecruitingAutomationPaused('1', '2', '3'), false);
});
