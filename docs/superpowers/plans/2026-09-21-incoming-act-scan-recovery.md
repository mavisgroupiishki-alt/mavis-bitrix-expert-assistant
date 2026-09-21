# Incoming Act Scan Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably identify signed incoming act scans from email and Wazzup and save only verified scans into the responsible expert's Bitrix folder.

**Architecture:** Keep the real-time webhook path restricted to an unambiguous active act request. Make the historical recovery job select candidate deals by the deal close month (not task creation month), and turn unsupported office documents into review candidates rather than silent rejections. Preserve the existing durable scan marker as the idempotency key before any repeated upload.

**Tech Stack:** Node.js 18, Express, ImapFlow, mailparser, Bitrix REST, OpenAI-compatible file analysis, `node:test`.

## Global Constraints

- Do not send an act, a client message, or a push notification while recovering scans.
- Do not save a file unless the classifier identifies a signed act with at least medium confidence.
- Do not select a random deal when one sender maps to multiple deals.
- Preserve the existing folder structure `Акты/<year>/Акты_<month>/Акты <expert> <month> <year>`.
- Do not add dependencies or expose any token in logs, tests, or output.

---

### Task 1: Make office-document outcomes explicit

**Files:**
- Modify: `server.js:10219-10353`
- Create: `test/acts-incoming-classification.test.js`

**Interfaces:**
- Produces: `actsIncomingFileKind(fileName, contentType)` returning `image`, `pdf`, `office`, or `unsupported`.
- Produces: `actsAiCheckSignedAct(buffer, fileName, contentType, messageText)` that sends image, PDF, and DOC/DOCX files to the configured compatible AI endpoint.

- [ ] **Step 1: Write the failing test.**

```js
assert.equal(actsIncomingFileKind('акт.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), 'office');
assert.equal(actsIncomingFileKind('скан.pdf', 'application/pdf'), 'pdf');
assert.equal(actsIncomingFileKind('архив.zip', 'application/zip'), 'unsupported');
```

- [ ] **Step 2: Run the focused test.**

Run: `node --test test/acts-incoming-classification.test.js`

Expected: FAIL because the helper is not exported.

- [ ] **Step 3: Implement the minimal helper and extend file input.**

```js
const kind = actsIncomingFileKind(fileName, contentType);
if (kind === 'image') content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }];
else if (kind === 'pdf' || kind === 'office') content = [{ type: 'file', file: { filename: fileName, file_data: dataUrl } }, { type: 'text', text: prompt }];
else return { isSignedAct: false, confidence: 'low', reason: 'unsupported incoming format' };
```

- [ ] **Step 4: Classify an AI transport error as uncertain.**

The returned reason must include `не сработала` so the current live path creates the existing pending marker instead of silently ignoring the document.

- [ ] **Step 5: Run the focused test again.**

Run: `node --test test/acts-incoming-classification.test.js`

Expected: PASS.

### Task 2: Align historical candidates with closed deals

**Files:**
- Modify: `server.js:10475-10665`
- Test: `test/acts-incoming-classification.test.js`

**Interfaces:**
- Consumes: `actsHistoricalMonthRange(monthRaw)`.
- Produces: `actsHistoricalLoadEmailCandidates(monthRaw)` where every candidate is a successful Production deal closed during `monthRaw`, with its linked act task, contact emails, phones, and expert folder.

- [ ] **Step 1: Write the failing candidate-selection test.**

```js
assert.deepEqual(
  selectClosedDealCandidates([
    { ID: '1', CLOSEDATE: '2026-09-10', STAGE_SEMANTIC_ID: 'S' },
    { ID: '2', CLOSEDATE: '2026-08-31', STAGE_SEMANTIC_ID: 'S' },
  ], '2026-09').map((deal) => deal.ID),
  ['1'],
);
```

- [ ] **Step 2: Replace the `tasks.task.list` month-created-date seed query.**

Use `crm.deal.list` with `CATEGORY_ID: config.productionCategoryId`, `STAGE_SEMANTIC_ID: 'S'`, `>=CLOSEDATE: range.startIso`, and `<CLOSEDATE: range.endIso`; load each deal's act task through `actsReconTasksForDeal` and retain exactly one linked act task.

- [ ] **Step 3: Keep ambiguity safe.**

If a deal has zero or more than one eligible linked act task, append a diagnostic error and skip it; do not choose by task title.

- [ ] **Step 4: Preserve the month of the deal closure.**

Set `state.createdDate` to `deal.CLOSEDATE` so `actsSaveIncomingScanForState` stores the verified file in the month of closing, not the date of an old task.

- [ ] **Step 5: Run the focused test.**

Run: `node --test test/acts-incoming-classification.test.js`

Expected: PASS.

### Task 3: Make recovery outcomes auditable without unsafe uploads

**Files:**
- Modify: `server.js:10585-10700,10920-11010`
- Test: `test/acts-incoming-classification.test.js`

**Interfaces:**
- Produces: recovery result entries `{ fileName, sender, dealId, reason }` in `saved`, `ambiguous`, `rejected`, and `errors`.
- Consumes: `actsHistoricalPickCandidate(candidates, aiCompany)`.

- [ ] **Step 1: Make unsupported/transport-failed files visible as review candidates.**

```js
if (!check.isSignedAct && isUncertainActCheck(check)) {
  result.ambiguous.push({ fileName, sender, candidates: possible.map((x) => x.state.taskId), reason: check.reason });
  continue;
}
```

- [ ] **Step 2: Keep actual rejections separate.**

Only a classifier result confidently identifying a non-act or unsigned act belongs in `rejected`.

- [ ] **Step 3: Reuse the same review accounting in the historical Wazzup importer.**

An unknown type, download failure, or AI transport error increments `errors` or `ambiguous`; it must not increment `rejected`.

- [ ] **Step 4: Run focused tests.**

Run: `node --test test/acts-incoming-classification.test.js`

Expected: PASS.

### Task 4: Verify the change and run a dry recovery report

**Files:**
- Modify: `server.js`
- Test: `test/*.test.js`

- [ ] **Step 1: Run syntax and all existing tests.**

Run: `node --check server.js && node --test`

Expected: exit code 0.

- [ ] **Step 2: Run `git diff --check` and inspect only the acts-import scope.**

Run: `git diff --check && git diff -- server.js test/acts-incoming-classification.test.js`

Expected: no whitespace errors; no unrelated changes.

- [ ] **Step 3: Deploy only after the code checks pass.**

Verify Render starts successfully and logs the corrected candidate counts. Do not enable a month import that writes Bitrix files until the dry report identifies the exact candidates.

### Task 5: Prevent the historical candidate loader from failing before its first deal

**Files:**
- Modify: `server.js:10460-10490`
- Create: `test/acts-historical-import.test.js`

**Interfaces:**
- Consumes: `actsHistoricalLoadEmailCandidates(monthRaw)` with mocked empty CRM and employee responses.
- Produces: an empty candidate array without throwing when no deals exist for the requested month.

- [ ] **Step 1: Write the failing regression test.**

```js
const result = await loadHistoricalCandidates('2026-09');
assert.deepEqual(result.candidates, []);
```

The harness extracts this one loader from `server.js` and replaces Bitrix calls with empty successful responses. Before the fix, the startup log references the removed `userCache` variable and throws a `ReferenceError`.

- [ ] **Step 2: Run the focused test.**

Run: `node --test test/acts-historical-import.test.js`

Expected: FAIL with `userCache is not defined`.

- [ ] **Step 3: Apply the single-variable fix.**

```js
console.log(`[acts-historical] Загружен справочник сотрудников: ${users.length}.`);
```

- [ ] **Step 4: Run the focused and complete test suite.**

Run: `node --test test/acts-historical-import.test.js && node --check server.js && node --test`

Expected: all commands exit 0.

## Self-Review

- **Spec coverage:** Task 1 prevents DOC/DOCX false negatives; Task 2 fixes the close-month selection error; Task 3 makes uncertainty inspectable; Task 4 verifies code and deployment without sending clients anything.
- **Placeholder scan:** no TBD/TODO placeholders.
- **Type consistency:** all candidate entries retain the existing `{ state, deal, emails, phones, expertFolder, companyName }` structure consumed by both email and Wazzup importers.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-21-incoming-act-scan-recovery.md`. Inline execution is appropriate because the user has already instructed us to fix the issue now.
