'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { companyReviewSearchTerms, companySearchTerms, matchTaskToDeal, splitTasksForDeal } = require('../public/signing-documents');

test('prefers the direct CRM deal link over every other company indicator', () => {
  const result = matchTaskToDeal({
    dealId: '38100',
    companyName: 'ООО «Чужая компания»',
    companyUnp: '123456789',
    task: { ID: '10', TITLE: 'Договор для другой компании', UF_CRM_TASK: ['D_38100'] },
  });
  assert.equal(result.kind, 'crm-link');
  assert.equal(result.confidence, 'confirmed');
});

test('keeps a task with matching UNP for manual review until it has a CRM deal link', () => {
  const result = matchTaskToDeal({
    dealId: '38100',
    companyName: 'ООО «Эд Сервис»',
    companyUnp: '123456789',
    task: { ID: '11', TITLE: 'Счёт для ЭД-СЕРВИС', DESCRIPTION: 'УНП 123456789' },
  });
  assert.equal(result.kind, 'unp');
  assert.equal(result.confidence, 'review');
});

test('does not show a task linked to another deal even when the company UNP matches', () => {
  const result = matchTaskToDeal({
    dealId: '38100',
    companyName: 'ООО «Эд Сервис»',
    companyUnp: '123456789',
    task: { ID: '111', TITLE: 'Счёт — Эд Сервис, УНП 123456789', UF_CRM_TASK: ['D_38101'] },
  });
  assert.equal(result.confidence, 'none');
  assert.equal(result.kind, 'other-deal');
});

test('keeps every company-name match for manual review', () => {
  const direct = matchTaskToDeal({
    dealId: '38100',
    companyName: 'ООО «Эд Сервис»',
    task: { ID: '12', TITLE: 'Договор — Эд Сервис' },
  });
  const weak = matchTaskToDeal({
    dealId: '38100',
    companyName: 'ООО «Строй Сервис Плюс»',
    task: { ID: '13', TITLE: 'Счёт — Строй Инвест' },
  });
  assert.equal(direct.confidence, 'review');
  assert.equal(weak.confidence, 'review');
});

test('builds bounded search variants for a shortened company name', () => {
  const terms = companySearchTerms('ООО «Строй Сервис Плюс»');
  assert.ok(terms.includes('строй сервис плюс'));
  assert.ok(terms.includes('строй сервис'));
  assert.ok(terms.includes('строй-сервис'));
  assert.ok(terms.length <= 8);
});

test('prioritizes UNP and a shortened name while bounding manual-review searches', () => {
  const terms = companyReviewSearchTerms('ООО «Строй Сервис Плюс»', '123456789');
  assert.equal(terms[0], '123456789');
  assert.ok(terms.includes('строй сервис плюс'));
  assert.ok(terms.includes('строй сервис'));
  assert.ok(terms.length <= 4);
});

test('treats every stage except Archive as a document awaiting signature', () => {
  const result = splitTasksForDeal({
    dealId: '38100',
    companyName: 'ООО «Эд Сервис»',
    archiveStageId: '264',
    tasks: [
      { ID: '14', TITLE: 'Договор — Эд Сервис', STAGE_ID: '264', UF_CRM_TASK: ['D_38100'] },
      { ID: '15', TITLE: 'Счёт — Эд Сервис', STAGE_ID: '123', UF_CRM_TASK: ['D_38100'] },
    ],
  });
  assert.equal(result.archived.length, 1);
  assert.equal(result.pending.length, 1);
});

test('shows a non-archived company-name match as a document awaiting signature', () => {
  const result = splitTasksForDeal({
    dealId: '38100',
    companyName: 'ООО «ВитАрхитектСтрой»',
    archiveStageId: '264',
    knownStageIds: ['123', '264'],
    tasks: [{ ID: '18', TITLE: 'ДОГОВОР ВитАрхитектСтрой', STAGE_ID: '123' }],
  });
  assert.equal(result.pending.length, 1);
  assert.equal(result.review.length, 0);
  assert.equal(result.pending[0].match.kind, 'company-name');
});

test('keeps a task with an unknown stage out of the pending count', () => {
  const result = splitTasksForDeal({
    dealId: '38100',
    companyName: 'ООО «Эд Сервис»',
    archiveStageId: '264',
    knownStageIds: ['123', '264'],
    tasks: [{ ID: '16', TITLE: 'Счёт — Эд Сервис', STAGE_ID: '', UF_CRM_TASK: ['D_38100'] }],
  });
  assert.equal(result.pending.length, 0);
  assert.equal(result.review.length, 1);
});

test('does not treat a deal ID mentioned in a task description as a CRM link', () => {
  const result = matchTaskToDeal({
    dealId: '38100',
    companyName: 'ООО «Эд Сервис»',
    task: { ID: '17', TITLE: 'Счёт', DESCRIPTION: 'Старая ссылка: D_38100' },
  });
  assert.equal(result.kind, 'deal-id-in-text');
  assert.equal(result.confidence, 'review');
});
