'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadTaskReader(call) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('function docReturnIsTransientRestReadError');
  const end = source.indexOf('\nasync function docReturnLoadBasicContext', start);
  assert.ok(start >= 0 && end > start, 'doc-return task reader must be present in server.js');

  const context = {
    DOC_RETURN_PROJECT_ID: '36',
    DOC_RETURN_TASK_READ_RETRIES: 1,
    console: { warn() {} },
    docReturnTaskValue: (task, names) => names.map((name) => task[name]).find((value) => value !== undefined),
    setTimeout,
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.loadTask = docReturnLoadTask;`, context);
  return (taskId, options = {}) => context.loadTask(taskId, {
    call,
    wait: async () => {},
    ...options,
  });
}

test('retries one transient Bitrix task read without retrying invalid task data', async () => {
  let calls = 0;
  const loadTask = loadTaskReader(async () => {
    calls++;
    if (calls === 1) throw new Error('fetch failed');
    return { task: { ID: '47400', GROUP_ID: '36' } };
  });

  const task = await loadTask('47400');
  assert.equal(task.ID, '47400');
  assert.equal(calls, 2);
});

test('does not retry a missing task or a task from another project', async () => {
  let missingCalls = 0;
  const loadMissing = loadTaskReader(async () => {
    missingCalls++;
    return null;
  });
  await assert.rejects(() => loadMissing('47400'), /не найдена/);
  assert.equal(missingCalls, 1);

  let foreignCalls = 0;
  const loadForeign = loadTaskReader(async () => {
    foreignCalls++;
    return { task: { ID: '47400', GROUP_ID: '999' } };
  });
  await assert.rejects(() => loadForeign('47400'), /не из проекта/);
  assert.equal(foreignCalls, 1);
});
