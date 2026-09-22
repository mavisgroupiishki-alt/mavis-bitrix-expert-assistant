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

function historicalWazzupImporter(environment = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function actsHistoricalWazzupAccessToken() {');
  const end = source.indexOf('\nasync function actsLogWazzupIncomingWebhookStatus()', start);
  assert.ok(start >= 0 && end > start, 'historical Wazzup importer must be present in server.js');

  const context = {
    console: { log() {} },
    process: { env: environment },
    actsCleanText: (value) => String(value || '').trim(),
    actsHistoricalLoadEmailCandidates: async () => {
      throw new Error('candidate loader should not run without the Wazzup OAuth token');
    },
    actsHistoricalFetchWazzupDump: async () => {
      throw new Error('dump should not run without the Wazzup OAuth token');
    },
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.run = actsRunHistoricalWazzupImport;`, context);
  return context.run;
}

test('historical candidate loader starts with an empty closed-deal result', async () => {
  const load = historicalCandidateLoader();
  const result = await load('2026-09');
  assert.equal(result.candidates.length, 0);
});

test('historical email scan includes explicit act subjects from senders absent in CRM', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function actsRunHistoricalEmailImport(monthRaw) {');
  const end = source.indexOf('\nfunction actsHistoricalCsvParse(', start);
  assert.ok(start >= 0 && end > start, 'historical email importer must be present in server.js');
  const importer = source.slice(start, end);
  assert.match(importer, /subject:\s*'акт'/);
  assert.match(importer, /byEmail\.get\(sender\)\s*\|\|\s*candidates/);
});

test('historical Wazzup importer fails before starting an extra email candidate scan without OAuth', async () => {
  const run = historicalWazzupImporter();
  await assert.rejects(run('2026-09'), /Не задан WAZZUP_CLIENT_ACCESS_TOKEN/);
});

test('historical Wazzup importer only accepts the child-account OAuth token', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function actsHistoricalWazzupAccessToken() {');
  const end = source.indexOf('\nasync function actsHistoricalFetchWazzupDump(', start);
  const context = {
    process: { env: { WAZZUP_SIDECAR_KEY: 'sidecar-key', WAZZUP_CLIENT_ACCESS_TOKEN: 'oauth-token' } },
    actsCleanText: (value) => String(value || '').trim(),
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.getToken = actsHistoricalWazzupAccessToken;`, context);
  const result = context.getToken();
  assert.equal(result.token, 'oauth-token');
  assert.equal(result.source, 'client_access_token');
});

test('historical Wazzup importer rejects API keys as a substitute for OAuth', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function actsHistoricalWazzupAccessToken() {');
  const end = source.indexOf('\nasync function actsHistoricalFetchWazzupDump(', start);
  const context = {
    process: { env: { WAZZUP_SIDECAR_KEY: 'sidecar-key', WAZZUP_API_KEY: 'api-key' } },
    actsCleanText: (value) => String(value || '').trim(),
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.getToken = actsHistoricalWazzupAccessToken;`, context);
  const result = context.getToken();
  assert.equal(result.token, '');
  assert.equal(result.source, '');
});
