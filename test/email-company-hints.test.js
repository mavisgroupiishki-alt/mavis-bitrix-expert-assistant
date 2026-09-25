'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function companyHintsFromMailSubject() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function companyHintsFromMailSubject(subject) {');
  const end = source.indexOf('\nasync function getOrCreateCompanyFolder(', start);
  assert.ok(start >= 0 && end > start, 'mail subject company-hint extractor must be present in server.js');
  const context = {};
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.extract = companyHintsFromMailSubject;`, context);
  return context.extract;
}

test('extracts an explicitly quoted company name from an email subject', () => {
  const extract = companyHintsFromMailSubject();
  assert.deepEqual(
    [...extract('RE: Заявка на расширение области ООО "Анлиар"')],
    ['Анлиар'],
  );
});

test('does not treat an arbitrary subject as a company name', () => {
  const extract = companyHintsFromMailSubject();
  assert.deepEqual([...extract('Fwd: документы во вложении')], []);
});
