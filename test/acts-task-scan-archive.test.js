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
    actsGetTaskCreatorActFolder: async () => ({ expertFolderId: '90', expertFolder: 'Акты Елизавета март 2026' }),
    uploadFileToDiskFolder: async () => ({ ID: '100' }),
    docReturnGetTaskCommentRows: async () => [],
    docReturnAddTaskComment: async () => 'task.commentitem.add',
    bitrixRestCall: async () => ({}),
  };
  vm.runInNewContext(`${source.slice(start, end)}; globalThis.helpers = { actsTaskScanArchiveEligibility, actsTaskScanArchiveMarker, actsTaskScanArchiveLatestFile, actsArchiveTaskScan };`, context);
  return context.helpers;
}

test('accepts only an Acts task at the Scan exists stage with creator and creation date', () => {
  const { actsTaskScanArchiveEligibility } = archiveHelpers();
  assert.equal(
    JSON.stringify(actsTaskScanArchiveEligibility({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12T09:00:00+03:00' })),
    JSON.stringify({ ok: true, taskId: '7', creatorId: '1960', createdDate: '2026-03-12T09:00:00+03:00' }),
  );
  assert.equal(actsTaskScanArchiveEligibility({ ID: '7', GROUP_ID: '36', STAGE_ID: '256', CREATED_BY: '1960', CREATED_DATE: '2026-03-12' }).ok, false);
  assert.equal(actsTaskScanArchiveEligibility({ ID: '7', GROUP_ID: '36', STAGE_ID: '256', CREATED_BY: '1960', CREATED_DATE: '2026-03-12' }, ['256']).ok, true);
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

test('selects the newest attachment by its date and then by file identity', () => {
  const { actsTaskScanArchiveLatestFile } = archiveHelpers();
  assert.equal(
    actsTaskScanArchiveLatestFile([
      { id: '22', name: 'old.pdf', date: '2026-08-03T10:00:00+03:00' },
      { id: '23', name: 'new.pdf', date: '2026-08-03T11:00:00+03:00' },
    ]).name,
    'new.pdf',
  );
  assert.equal(actsTaskScanArchiveLatestFile([{ id: '22' }, { id: '23' }]).id, '23');
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

test('skips a non-expert creator instead of retrying the same attachments forever', async () => {
  const { actsArchiveTaskScan } = archiveHelpers();
  const result = await actsArchiveTaskScan('7', 'test', {
    getTask: async () => ({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12' }),
    resolveFiles: async () => ({ files: [{ id: '22', name: 'scan.pdf', url: 'https://mavisgroup.bitrix24.by/download/22' }] }),
    getFolder: async () => { throw new Error('Постановщик задачи «Ирина» не сопоставлен с папками актов.'); },
    download: async () => { throw new Error('must not download without an expert folder'); },
    getComments: async () => [],
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.saved), '[]');
  assert.equal(JSON.stringify(result.errors), '[]');
  assert.equal(JSON.stringify(result.skipped), JSON.stringify([{ fileName: 'scan.pdf', reason: 'creator-folder-unmapped' }]));
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

test('recognizes an archive marker followed by the human-readable archive note', async () => {
  const { actsArchiveTaskScan } = archiveHelpers();
  const result = await actsArchiveTaskScan('7', 'test', {
    getTask: async () => ({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12' }),
    resolveFiles: async () => ({ files: [{ id: '22', name: 'акт.pdf', url: 'https://mavisgroup.bitrix24.by/download/22' }] }),
    getComments: async () => [{ POST_MESSAGE: '[MAVIS_ACTS_TASK_SCAN_ARCHIVE] task=7 file=22\nСкан сохранён на Битрикс Диск.' }],
    download: async () => { throw new Error('must not download duplicate'); },
    getFolder: async () => { throw new Error('must not create folder for duplicate'); },
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.saved), '[]');
  assert.equal(JSON.stringify(result.skipped), JSON.stringify([{ fileName: 'акт.pdf', reason: 'already-archived' }]));
});

test('recognizes an archive marker read from the task chat', async () => {
  const { actsArchiveTaskScan } = archiveHelpers();
  const result = await actsArchiveTaskScan('7', 'test', {
    getTask: async () => ({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12' }),
    resolveFiles: async () => ({ files: [{ id: '22', name: 'акт.pdf', url: 'https://mavisgroup.bitrix24.by/download/22' }] }),
    getComments: async () => ['[MAVIS_ACTS_TASK_SCAN_ARCHIVE] task=7 file=22\nСкан сохранён на Битрикс Диск.'],
    download: async () => { throw new Error('must not download duplicate'); },
    getFolder: async () => { throw new Error('must not create folder for duplicate'); },
  });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.saved), '[]');
  assert.equal(JSON.stringify(result.skipped), JSON.stringify([{ fileName: 'акт.pdf', reason: 'already-archived' }]));
});

test('archives only the latest real attachment when requested for a historical backfill', async () => {
  const { actsArchiveTaskScan } = archiveHelpers();
  const uploaded = [];
  const result = await actsArchiveTaskScan('7', 'backfill:2026-08', {
    latestOnly: true,
    getTask: async () => ({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-08-12' }),
    resolveFiles: async () => ({ files: [
      { id: '22', name: 'old.pdf', date: '2026-08-12T10:00:00+03:00' },
      { id: '23', name: 'latest.pdf', date: '2026-08-12T11:00:00+03:00' },
      { name: 'text only', source: 'task-name-only' },
    ] }),
    getFolder: async () => ({ expertFolderId: '90', expertFolder: 'Акты Елизавета август 2026' }),
    download: async (file) => ({ buffer: Buffer.from(file.id), fileName: file.name }),
    upload: async (_folderId, fileName) => { uploaded.push(fileName); },
    getComments: async () => [],
    addComment: async () => 'task.commentitem.add',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(uploaded, ['latest.pdf']);
});
