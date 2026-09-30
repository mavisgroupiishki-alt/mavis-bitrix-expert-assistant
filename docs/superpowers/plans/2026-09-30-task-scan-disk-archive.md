# Task Scan Disk Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an «Акты Счета» task enters the «СКАН ЕСТЬ» stage, archive every attached scan to the responsible expert's month folder on Bitrix Disk exactly once.

**Architecture:** Add a narrow polling worker to the existing Render service. It scans recently changed tasks in project 36 at stage 1480, resolves every task attachment with the existing Disk/chat resolver, and copies the binaries to the existing expert-folder helper. The worker holds a per-task lock and leaves a per-file task-comment marker, so a polling overlap or retry cannot duplicate a saved file.

**Tech Stack:** Node.js 18, Express, Bitrix24 REST (`tasks.task.get`, `disk.file.get`, `disk.folder.uploadfile`), existing Render service, Bitrix task automation.

## Global Constraints

- Only project `36` and stage `1480` («СКАН ЕСТЬ») are eligible.
- Do not move tasks, send client messages, or add CRM comments.
- Reuse the existing approved expert-folder convention unless the user explicitly authorizes a new hierarchy: `Акты/<year>/Акты_<month>/Акты <expert> <month> <year>`.
- The month is the task's `CREATED_DATE`; the expert is its `CREATED_BY` (the task's «Постановщик» in this board).
- Do not add dependencies, expose tokens, or deploy without explicit approval.

---

### Task 1: Define and test deterministic routing and deduplication helpers

**Files:**
- Modify: `server.js` near `actsFolderPeriod` and `actsResolveTaskFiles`
- Create: `test/acts-task-scan-archive.test.js`

**Interfaces:**
- Produces: `actsTaskScanArchiveEligibility(task)` returning `{ ok, reason, taskId, creatorId, createdDate }`.
- Produces: `actsTaskScanArchiveMarker(taskId, file)` returning a stable marker based on the task and source Disk file/attachment identifier.

- [ ] **Step 1: Write failing tests.**

```js
assert.deepEqual(
  actsTaskScanArchiveEligibility({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12T09:00:00+03:00' }),
  { ok: true, taskId: '7', creatorId: '1960', createdDate: '2026-03-12T09:00:00+03:00' },
);
assert.equal(actsTaskScanArchiveEligibility({ ID: '7', GROUP_ID: '36', STAGE_ID: '256' }).ok, false);
assert.equal(actsTaskScanArchiveMarker('7', { id: '22', name: 'акт.pdf' }), 'MAVIS_ACTS_TASK_SCAN_ARCHIVE task=7 file=22');
```

- [ ] **Step 2: Run the focused test and confirm it fails.**

Run: `node --test test/acts-task-scan-archive.test.js`

Expected: FAIL because the helpers are not exported.

- [ ] **Step 3: Implement the pure helpers.**

Read `GROUP_ID`, `STAGE_ID`, `CREATED_BY`, `CREATED_DATE`, and `ID` through `actsTaskField`. Return an explicit reason for every rejected task; do not infer the author from a linked CRM deal.

- [ ] **Step 4: Run the focused test and confirm it passes.**

Run: `node --test test/acts-task-scan-archive.test.js`

Expected: PASS.

### Task 2: Archive files through a protected endpoint

**Files:**
- Modify: `server.js` near `/api/acts/task-done`
- Test: `test/acts-task-scan-archive.test.js`

**Interfaces:**
- Produces: `actsArchiveTaskScan(taskId, source)` returning `{ ok, taskId, folder, saved, skipped, errors }`.
- Produces: `actsRunTaskScanArchivePoll(trigger)` that reads only recently changed tasks at stage 1480.

- [ ] **Step 1: Add a failing dependency-injected test.**

```js
const result = await actsArchiveTaskScan('7', 'test', {
  getTask: async () => ({ ID: '7', GROUP_ID: '36', STAGE_ID: '1480', CREATED_BY: '1960', CREATED_DATE: '2026-03-12T09:00:00+03:00' }),
  getUser: async () => ({ ID: '1960', NAME: 'Елизавета', LAST_NAME: 'Горбатова' }),
  resolveFiles: async () => ({ files: [{ id: '22', name: 'акт.pdf', url: 'https://example.test/act.pdf' }] }),
  download: async () => ({ buffer: Buffer.from('pdf'), fileName: 'акт.pdf', contentType: 'application/pdf' }),
  getFolder: async () => ({ expertFolderId: '900', expertFolder: 'Акты Елизавета март 2026' }),
  upload: async () => ({ ID: '500' }),
});
assert.equal(result.saved.length, 1);
assert.equal(result.folder, 'Акты Елизавета март 2026');
```

- [ ] **Step 2: Implement minimal archive flow.**

Load the task with the fields required by `actsResolveTaskFiles`; reject a non-eligible task before resolving files. Resolve every actual file (not `task-name-only`), download its bytes using the current safe file downloader, create/use the expert folder from `CREATED_DATE` and `CREATED_BY`, then call `uploadFileToDiskFolder`. Record stable duplicate markers in the task only after the specific upload succeeds, so retries do not copy the same source file again.

- [ ] **Step 3: Add failure-path tests.**

```js
assert.match((await actsArchiveTaskScan('7', 'test', noFilesDeps)).errors[0], /файл/i);
assert.equal((await actsArchiveTaskScan('7', 'test', wrongStageDeps)).ok, false);
```

Confirm failed downloads are reported and do not create their marker; a later robot retry can therefore save them.

- [ ] **Step 4: Add the polling worker.**

Use `tasks.task.list` with project `36`, stage `1480`, and a small `CHANGED_DATE` overlap. Start with a bounded lookback after deploy, run at most once per minute, and re-fetch each task before archive. Do not log file bytes or URLs with embedded credentials.

- [ ] **Step 5: Run the focused test.**

Run: `node --test test/acts-task-scan-archive.test.js`

Expected: PASS.

### Task 3: Start the worker and prove the full path

**Files:**
- Modify: `README_V150_TASK_SCAN_DISK_ARCHIVE.md`

**Interfaces:**
- Consumes: `ACTS_TASK_SCAN_ARCHIVE_ENABLED=true` and the existing Bitrix service webhook.
- Produces: one task-comment marker for every copied source file.

- [ ] **Step 1: Enable the stage polling worker.**

Configure no new Bitrix outgoing webhook. The existing robot editor exposes only a handler URL and would require placing a reusable secret in the URL; the worker instead uses the already configured server-to-Bitrix credential and catches the stage transition within one minute.

- [ ] **Step 2: Run all code verification.**

Run: `node --check server.js && node --test && git diff --check`

Expected: all commands exit `0`.

- [ ] **Step 3: Perform a single controlled live test.**

Use a newly created non-client test task in project 36 with a harmless PDF, set its creator to one of the configured experts, and move it to stage `1480`. Verify exactly one file appears in that expert's month folder and that re-running the robot returns it as skipped rather than duplicating it.

- [ ] **Step 4: Record the deployment and test evidence.**

Document the exact folder convention, endpoint name, robot stage ID, and test task ID in `README_V150_TASK_SCAN_DISK_ARCHIVE.md`. Do not include credentials.

## Self-Review

- Spec coverage: task creation month, expert ownership, every attached scan, stage-only activation, Bitrix Disk storage, and per-file no-duplicate behavior are covered by Tasks 1–3.
- Intentional gap: the requested abbreviated path «Акты → Акты март Лиза» conflicts with the established year-based folder convention. The implementation must not change hierarchy until the user chooses.
- Placeholder scan: no implementation placeholders remain; the only required user decision is the conflicting destination hierarchy.
- Type consistency: task ID is a string at every public boundary; Bitrix APIs receive numeric IDs only at the existing REST wrappers.
