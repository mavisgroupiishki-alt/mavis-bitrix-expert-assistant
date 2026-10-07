'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDate, transitionFields, validateProductionTransition } = require('../production-stage-transition');

const input = {
  deal: { ID: '38072', CATEGORY_ID: '28', STAGE_ID: 'C28:NEW' },
  categoryId: 28,
  dateFieldCode: 'UF_CRM_EXPECTED_CLOSE',
  targetStageId: 'C28:EXPERT',
  expectedCloseDate: '2026-10-20',
  stages: [{ STATUS_ID: 'C28:NEW' }, { STATUS_ID: 'C28:EXPERT' }],
};

test('accepts a production transition with a valid new date', () => {
  assert.deepEqual(validateProductionTransition(input), {
    expectedCloseDate: '2026-10-20', targetStageId: 'C28:EXPERT',
  });
});

test('rejects a blank or invalid expected close date', () => {
  assert.throws(() => validateProductionTransition({ ...input, expectedCloseDate: '' }), /дату/);
  assert.throws(() => validateProductionTransition({ ...input, expectedCloseDate: '2026-02-30' }), /дату/);
  assert.equal(normalizeDate('2026-10-20'), '2026-10-20');
});

test('rejects a deal from another funnel and an unknown stage', () => {
  assert.throws(() => validateProductionTransition({ ...input, deal: { ...input.deal, CATEGORY_ID: '1' } }), /Производства/);
  assert.throws(() => validateProductionTransition({ ...input, targetStageId: 'C28:UNKNOWN' }), /стадию/);
});

test('rejects transition into the same stage', () => {
  assert.throws(() => validateProductionTransition({ ...input, targetStageId: 'C28:NEW' }), /другую стадию/);
});

test('builds one crm.deal.update fields object for date and stage', () => {
  assert.deepEqual(transitionFields({
    targetStageId: 'C28:EXPERT', expectedCloseDate: '2026-10-20', dateFieldCode: 'UF_CRM_EXPECTED_CLOSE',
  }), { STAGE_ID: 'C28:EXPERT', UF_CRM_EXPECTED_CLOSE: '2026-10-20' });
});
