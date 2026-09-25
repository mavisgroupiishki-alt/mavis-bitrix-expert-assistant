'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function companyDealLookup(bitrixRestList) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function findDealsByCompanyName(companyNameQuery) {');
  const end = source.indexOf('\nmodule.exports = { processIncomingEmails };', start);
  assert.ok(start >= 0 && end > start, 'company deal lookup must be present in server.js');
  const context = {
    console: { log() {}, error() {} },
    normalizeCompanyNameForMatch: (value) => String(value || '').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, ''),
    bitrixRestList,
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.lookup = findDealsByCompanyName;`, context);
  return context.lookup;
}

test('does not attach a document to an unrelated fuzzy company match', async () => {
  const calls = [];
  const lookup = companyDealLookup(async (method, params) => {
    calls.push({ method, params });
    if (method === 'crm.company.list') return [{ ID: '1', TITLE: 'Грин...' }];
    return [{ ID: '9', TITLE: 'Unrelated deal' }];
  });

  assert.equal(await lookup('БелГИСС'), null);
  assert.equal(calls.length, 1);
});
