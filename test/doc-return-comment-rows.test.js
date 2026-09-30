'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function getCommentRows(raw) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('async function docReturnGetTaskCommentRows');
  const end = source.indexOf('\nasync function docReturnResolveCommentFiles', start);
  assert.ok(start >= 0 && end > start, 'comment reader must be present in server.js');
  const context = {
    bitrixRestCall: async () => raw,
    console: { warn() {} },
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.getCommentRows = docReturnGetTaskCommentRows;`, context);
  return context.getCommentRows(49768);
}

test('reads comment rows when Bitrix wraps them in an object keyed by comment ID', async () => {
  const rows = await getCommentRows({
    result: {
      41: { ID: '41', POST_MESSAGE: '[MAVIS_ACTS_TASK_SCAN_ARCHIVE] task=49768 file=88' },
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ID, '41');
});
