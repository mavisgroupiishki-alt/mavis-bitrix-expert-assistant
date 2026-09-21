'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function historicalCandidateLoader() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function actsHistoricalLoadEmailCandidates(monthRaw) {');
  const end = source.indexOf('\nfunction actsHistoricalPickCandidate(', start);
  assert.ok(start >= 0 && end > start, 'historical candidate loader must be present in server.js');

  const context = {
    Map,
    Set,
    console: { log() {}, warn() {} },
    config: { productionCategoryId: 28 },
    actsHistoricalMonthRange: () => ({ startIso: '2026-09-01', endIso: '2026-10-01' }),
    actsHistoricalAwait: (promise) => promise,
    bitrixRestList: async () => [],
    bitrixRestCall: async () => [],
    actsResolveExpertFolderName: () => '',
    actsReconTasksForDeal: async () => [],
    actsReconIsActTask: () => false,
    actsTaskField: () => '',
    normalizePhoneDigits: () => '',
    actsCleanText: (value) => String(value || ''),
    getCompanyName: async () => '',
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.load = actsHistoricalLoadEmailCandidates;`, context);
  return context.load;
}

test('historical candidate loader starts with an empty closed-deal result', async () => {
  const load = historicalCandidateLoader();
  const result = await load('2026-09');
  assert.equal(result.candidates.length, 0);
});
