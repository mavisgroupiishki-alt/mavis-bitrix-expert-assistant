'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { trustedBitrixFileUrl } = require('../acts-file-security');

const options = { portalUrl: 'https://mavisgroup.bitrix24.by/rest/1/token/' };

test('accepts the configured Bitrix portal and Bitrix24 download subdomains', () => {
  assert.equal(trustedBitrixFileUrl('https://mavisgroup.bitrix24.by/bitrix/tools/disk/uf.php?x=1', options), true);
  assert.equal(trustedBitrixFileUrl('https://cdn.bitrix24.by/download/file.docx', options), true);
});

test('rejects non-HTTPS and arbitrary redirect hosts unless explicitly configured', () => {
  assert.equal(trustedBitrixFileUrl('http://mavisgroup.bitrix24.by/file.docx', options), false);
  assert.equal(trustedBitrixFileUrl('https://attacker.example/file.docx', options), false);
  assert.equal(trustedBitrixFileUrl('https://files.mavis.example/file.docx', {
    ...options,
    additionalHosts: 'files.mavis.example',
  }), true);
});
