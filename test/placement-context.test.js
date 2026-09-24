'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { injectPlacementOptions, parsePlacementOptions } = require('../placement-context');

test('extracts the deal ID that Bitrix sends in POST placement options', () => {
  assert.deepEqual(parsePlacementOptions({ PLACEMENT_OPTIONS: '{"ID":"38100"}' }), { ID: '38100' });
});

test('injects placement options into the app page without allowing HTML injection', () => {
  const page = '<script>window.BITRIX_PLACEMENT_OPTIONS = {};</script>';
  const result = injectPlacementOptions(page, { ID: '38100', label: '</script><script>alert(1)</script>' });
  assert.match(result, /"ID":"38100"/);
  assert.doesNotMatch(result, /<\/script><script>alert/);
});
