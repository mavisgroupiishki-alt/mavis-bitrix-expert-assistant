'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function archiveHelpers() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const start = source.indexOf('const ACTS_TASK_SCAN_ARCHIVE_STAGE_ID');
  const end = source.indexOf('\nasync function actsRunTaskScanArchivePoll', start);
  assert.ok(start >= 0 && end > start, 'task scan archive helpers must be present in server.js');

  const context = {
    Set,
    Buffer,
    config: { actsProjectId: 36 },
    console: { log() {}, warn() {} },
    actsTaskField: (task, names) => names.map((name) => task[name]).find((value) => value !== undefined),
    actsResolveTaskFiles: async () => ({ files: [] }),
    actsDownloadRealFile: async () => ({ buffer: Buffer.from('file'), fileName: 'scan.pdf' }),
    actsGetTaskAuthorActFolder: async () => ({ expertFolderId: '90', expertFolder: 'Акты Елизавета март 2026' }),
    uploadFileToDiskFolder: async () => ({ ID: '100' }),
    docReturnGetTaskCommentRows: async () => [],
    docReturnAddTaskComment: async () => 'task.commentitem.add',
    bitrixRestCall: async () => ({}),
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.helpers = { actsTaskScanArchiveEligibility, actsTaskScanArchiveMarker, actsArchiveTaskScan };`, context);
  return context.helpers;
}

test('accepts only an Acts task at the Scan exists stage with author and creation date', () => {
  const { actsTaskScanArchiveEligibility } = archiveHelpers();
  assert.equal(
    JSON.stringify(actsTaskScanArchiveEligibility({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12T09:00:00+03:00' })),
    JSON.stringify({ ok: true, taskId: '7', creatorId: '1960', createdDate: '2026-03-12T09:00:00+03:00' }),
  );
  assert.equal(actsTaskScanArchiveEligibility({ ID: '7', GROUP_ID: '36', STAGE_ID: '256', CREATED_BY: '1960', CREATED_DATE: '2026-03-12' }).ok, false);
  assert.equal(actsTaskScanArchiveEligibility({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480' }).ok, false);
});

test('uses the source file identity for a stable per-file duplicate marker', () => {
  const { actsTaskScanArchiveMarker } = archiveHelpers();
  assert.equal(
    actsTaskScanArchiveMarker('7', { id: '22', name: 'акт.pdf' }),
    '[MAVIS_ACTS_TASK_SCAN_ARCHIVE] task=7 file=22',
  );
  assert.equal(
    actsTaskScanArchiveMarker('7', { attachedId: 'n9', id: '22', name: 'акт.pdf' }),
    '[MAVIS_ACTS_TASK_SCAN_ARCHIVE] task=7 file=n9',
  );
});

test('archives every real task attachment once and uses the task creation date for the folder', async () => {
  const { actsArchiveTaskScan } = archiveHelpers();
  const uploaded = [];
  const comments = [];
  const task = { ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12T09:00:00+03:00' };
  const result = await actsArchiveTaskScan('7', 'test', {
    getTask: async () => task,
    resolveFiles: async () => ({ files: [
      { id: '22', name: 'акт.pdf', url: 'https://mavisgroup.bitrix24.by/download/22' },
      { attachedId: 'n23', id: '23', name: 'приложение.pdf', url: 'https://mavisgroup.bitrix24.by/download/23' },
      { name: 'only-name.pdf', source: 'task-name-only' },
    ] }),
    download: async (file) => ({ buffer: Buffer.from(file.id || file.attachedId), fileName: file.name }),
    getFolder: async (creatorId, createdDate) => {
      assert.equal(creatorId, '1960');
      assert.equal(createdDate, '2026-03-12T09:00:00+03:00');
      return { expertFolderId: '90', expertFolder: 'Акты Елизавета март 2026' };
    },
    upload: async (folderId, fileName) => { uploaded.push({ folderId, fileName }); return { ID: String(uploaded.length) }; },
    getComments: async () => [],
    addComment: async (_task, text) => { comments.push(text); return 'task.commentitem.add'; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.saved.length, 2);
  assert.deepEqual(uploaded, [
    { folderId: '90', fileName: 'акт.pdf' },
    { folderId: '90', fileName: 'приложение.pdf' },
  ]);
  assert.match(comments[0], /task=7 file=22/);
  assert.match(comments[1], /task=7 file=n23/);
});

test('skips an attachment that already has an archive marker', async () => {
  const { actsArchiveTaskScan } = archiveHelpers();
  const result = await actsArchiveTaskScan('7', 'test', {
    getTask: async () => ({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12' }),
    resolveFiles: async () => ({ files: [{ id: '22', name: 'акт.pdf', url: 'https://mavisgroup.bitrix24.by/download/22' }] }),
    getComments: async () => [{ POST_MESSAGE: '[MAVIS_ACTS_TASK_SCAN_ARCHIVE] task=7 file=22' }],
    download: async () => { throw new Error('must not download duplicate'); },
    getFolder: async () => { throw new Error('must not create folder for duplicate'); },
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.saved), '[]');
  assert.equal(JSON.stringify(result.skipped), JSON.stringify([{ fileName: 'акт.pdf', reason: 'already-archived' }]));
});
