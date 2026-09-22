'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { categoryForQuestion, selectLiveDeals } = require('../dashboard-live-bitrix');

test('selects the live production deals for an expert and a human stage name', () => {
  const result = selectLiveDeals({
    question: 'покажи сделки на стадии сбор информации у эксперта Елизаветы Горбатовой',
    category: categoryForQuestion('покажи сделки на стадии сбор информации у эксперта Елизаветы Горбатовой'),
    stages: [{ STATUS_ID: 'C28:PREPARATION', NAME: '2. Сбор информации' }, { STATUS_ID: 'C28:CHECK', NAME: '9. Проверка органом' }],
    users: [{ ID: '7', NAME: 'Елизавета', LAST_NAME: 'Горбатова' }, { ID: '8', NAME: 'Ольга', LAST_NAME: 'Панькова' }],
    deals: [
      { ID: '1', TITLE: 'Верная сделка', STAGE_ID: 'C28:PREPARATION', ASSIGNED_BY_ID: '7', OPPORTUNITY: '1500' },
      { ID: '2', TITLE: 'Другая стадия', STAGE_ID: 'C28:CHECK', ASSIGNED_BY_ID: '7', OPPORTUNITY: '900' },
      { ID: '3', TITLE: 'Другой эксперт', STAGE_ID: 'C28:PREPARATION', ASSIGNED_BY_ID: '8', OPPORTUNITY: '800' },
    ],
    portalUrl: 'https://mavisgroup.bitrix24.by',
  });

  assert.equal(result.category.id, 28);
  assert.deepEqual(result.filters.stages, ['2. Сбор информации']);
  assert.deepEqual(result.filters.experts, ['Елизавета Горбатова']);
  assert.equal(result.matching_count, 1);
  assert.equal(result.matching_amount, 1500);
  assert.equal(result.deals[0].url, 'https://mavisgroup.bitrix24.by/crm/deal/details/1/');
});

test('does not send deal names to AI for a count-only question', () => {
  const result = selectLiveDeals({
    question: 'сколько сделок на стадии сбор информации у эксперта Елизаветы Горбатовой',
    category: { id: 28, label: 'Производство' },
    stages: [{ STATUS_ID: 'C28:PREPARATION', NAME: '2. Сбор информации' }],
    users: [{ ID: '7', NAME: 'Елизавета', LAST_NAME: 'Горбатова' }],
    deals: [{ ID: '1', TITLE: 'Не передавать в AI', STAGE_ID: 'C28:PREPARATION', ASSIGNED_BY_ID: '7', OPPORTUNITY: '1500' }],
  });

  assert.equal(result.matching_count, 1);
  assert.deepEqual(result.deals, []);
});

test('does not treat a generic question word as a request for a deal list', () => {
  const result = selectLiveDeals({
    question: 'какая сумма на стадии сбор информации',
    category: { id: 28, label: 'Производство' },
    stages: [{ STATUS_ID: 'C28:PREPARATION', NAME: '2. Сбор информации' }],
    deals: [{ ID: '1', TITLE: 'Не передавать в AI', STAGE_ID: 'C28:PREPARATION', OPPORTUNITY: '1500' }],
  });

  assert.equal(result.matching_amount, 1500);
  assert.deepEqual(result.deals, []);
});

test('uses the dormant funnel for questions about stuck deals', () => {
  assert.deepEqual(categoryForQuestion('сколько сделок в зависших сейчас'), { id: 30, label: 'Зависшие' });
});
