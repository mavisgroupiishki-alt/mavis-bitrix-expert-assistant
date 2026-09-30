'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  canRetryScanRequestLegacyRecipientBlock,
  hasScanRequestSentMarker,
  isScanRequestExcludedStage,
  isScanRequestSeptember2026,
  scanRequestSentMarker,
  scanRequestStageTitle,
  scanRequestState,
  selectScanRequestActFile,
} = require('../scan-request-campaign');

test('limits the campaign to tasks created in September 2026', () => {
  assert.equal(isScanRequestSeptember2026('2026-09-01T00:00:00+03:00'), true);
  assert.equal(isScanRequestSeptember2026('2026-09-30T23:59:59+03:00'), true);
  assert.equal(isScanRequestSeptember2026('2026-10-01T00:00:00+03:00'), false);
  assert.equal(isScanRequestSeptember2026('not-a-date'), false);
});

test('keeps pending and blocked tasks out of automatic retries', () => {
  assert.equal(scanRequestState(['[MAVIS_SCAN_REQUEST_PENDING] task=49726'], 49726), 'pending');
  assert.equal(scanRequestState(['[MAVIS_SCAN_REQUEST_BLOCKED] task=49726'], 49726), 'blocked');
  assert.equal(scanRequestState([], 49726), 'ready');
});

test('retries only the old ambiguous-contact block after recipient fallback is enabled', () => {
  assert.equal(canRetryScanRequestLegacyRecipientBlock(['В сделке 2 контакта(ов), но не удалось определить последнюю переписку.']), true);
  assert.equal(canRetryScanRequestLegacyRecipientBlock(['Причина: act-file-not-found-in-task.']), false);
});

test('never falls back from an act file to an arbitrary task document', () => {
  assert.deepEqual(
    selectScanRequestActFile([{ name: 'счет.pdf', url: 'https://example.test/invoice' }], 'АКТ 2 Клиент'),
    { file: null, reason: 'act-file-not-found-in-task' },
  );
  assert.deepEqual(
    selectScanRequestActFile([
      { name: 'Акт №1.pdf', url: 'https://example.test/one' },
      { name: 'Акт №2.pdf', url: 'https://example.test/two' },
    ], 'АКТ 2 Клиент'),
    { file: { name: 'Акт №2.pdf', url: 'https://example.test/two' }, reason: '' },
  );
  assert.deepEqual(
    selectScanRequestActFile([
      { name: 'Акт №1.pdf', url: 'https://example.test/one' },
      { name: 'Акт №2.pdf', url: 'https://example.test/two' },
    ], 'АКТ Клиент'),
    { file: null, reason: 'ambiguous-act-files-in-task' },
  );
});

test('excludes only Archive and Scan exists stages', () => {
  assert.equal(isScanRequestExcludedStage('Архив'), true);
  assert.equal(isScanRequestExcludedStage('  СКАН   ЕСТЬ '), true);
  assert.equal(isScanRequestExcludedStage('Сделаны'), false);
});

test('looks up a freshly loaded stage without crashing when stage metadata is absent', () => {
  const stages = new Map([['1480', 'Архив']]);
  assert.equal(scanRequestStageTitle(stages, '1480'), 'Архив');
  assert.equal(scanRequestStageTitle(undefined, '1480'), '');
});

test('recognizes only the dedicated scan-request success marker', () => {
  const marker = scanRequestSentMarker(49726);
  assert.equal(hasScanRequestSentMarker([`Отправлено\n${marker}\n`], 49726), true);
  assert.equal(hasScanRequestSentMarker([marker], 49736), false);
  assert.equal(hasScanRequestSentMarker(['[MAVIS_ACTS_SENT] task=49726'], 49726), false);
});
