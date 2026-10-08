# SPK First Contact Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На этапе «1. Эксперт назначен» для СПК автоматически установить плановую дату, создать задачу первого контакта с краткой подсказкой по копиям и проконтролировать её закрытие.

**Architecture:** Робот этапа передаёт ID сделки в защищённый маршрут сервиса. Маршрут проверяет, что сделка находится в воронке «Производство», на этапе назначения эксперта и относится к СПК, затем ставит срок и одну задачу с маркером. Периодическая проверка читает только эти маркированные задачи: через четыре рабочих часа создаёт одно напоминание эксперту, а после одного полного рабочего дня уведомляет Татьяну.

**Tech Stack:** Node.js/Express, Bitrix24 REST, существующие роботы CRM, Node built-in tests.

## Global Constraints

- Работать только с категорией «Производство» (`CATEGORY_ID=28`) и этапом `C28:NEW`.
- Работать только со сделками СПК.
- Не менять ответственного по сделке и не создавать задачу повторно.
- В подсказку включать только сокращённый перечень из документа «Перечень копий СПК».
- Алла Ягур и Роман Авсеенко не участвуют в распределении; этот контур их не затрагивает.

---

### Task 1: Контракт первого касания СПК

**Files:**
- Create: `spk-first-contact.js`
- Create: `test/spk-first-contact.test.js`

**Interfaces:**
- Produces: `spkChecklist()`.
- Produces: `closeDateDays({ needsSelection, service })` returning `14` or `21`.
- Produces: `firstContactSchedule(assignedAt)` returning `startAt` and `deadlineAt`.

- [ ] **Step 1: Write failing tests for the concise SPK checklist, 14/21-day rule, and before/after-noon timing.**

```js
assert.equal(closeDateDays({ needsSelection: false, service: 'СПК' }), 14);
assert.equal(closeDateDays({ needsSelection: true, service: 'СПК' }), 21);
assert.match(spkChecklist(), /свидетельство о регистрации/);
```

- [ ] **Step 2: Run the focused test.**

Run: `node --test test/spk-first-contact.test.js`

- [ ] **Step 3: Implement deterministic helpers.**

```js
function closeDateDays({ needsSelection, service }) {
  return needsSelection || /подбор|аттестация/i.test(service || '') ? 21 : 14;
}
```

- [ ] **Step 4: Run the focused test and commit.**

Run: `node --test test/spk-first-contact.test.js`

### Task 2: Создание задачи и плановой даты по роботу этапа

**Files:**
- Modify: `server.js`
- Test: `test/spk-first-contact.test.js`

**Interfaces:**
- Consumes: `GET /api/production/spk-first-contact?distribution_token=...&deal_id=...`.
- Produces: one marked Bitrix task assigned to `ASSIGNED_BY_ID` and a new expected close date.

- [ ] **Step 1: Add an idempotent protected route.**

```js
if (String(deal.CATEGORY_ID) !== '28' || String(deal.STAGE_ID) !== STAGE_IDS.expertAssigned) {
  return { ok: false, skipped: true };
}
```

- [ ] **Step 2: Update the existing expected-close-date field and create the marked first-contact task.**

```js
await bitrixRestCall('crm.deal.update', { id: deal.ID, fields: { [dateField]: closeDate } });
await bitrixRestCall('tasks.task.add', { fields: { TITLE, DESCRIPTION, RESPONSIBLE_ID: deal.ASSIGNED_BY_ID, UF_CRM_TASK: [`D_${deal.ID}`] } });
```

- [ ] **Step 3: Add tests for non-SPK deals, duplicate delivery, and the assigned expert.**

- [ ] **Step 4: Run the complete test suite and commit.**

Run: `npm test`

### Task 3: Контроль незакрытой задачи

**Files:**
- Modify: `server.js`
- Test: `test/spk-first-contact.test.js`

**Interfaces:**
- Consumes: marked task status, actual start time, and deadline.
- Produces: one reminder task after four working hours and one leader notification after a full working day.

- [ ] **Step 1: Write tests for completed, active, reminder, and escalation paths.**

```js
assert.equal(firstContactAction({ status: 'completed', elapsedWorkingHours: 8 }), 'none');
assert.equal(firstContactAction({ status: 'in_progress', elapsedWorkingHours: 4 }), 'remind');
assert.equal(firstContactAction({ status: 'in_progress', elapsedWorkingHours: 9 }), 'escalate');
```

- [ ] **Step 2: Implement marker-based scanning so unrelated tasks are never read as a first-contact task.**

- [ ] **Step 3: Add durable Bitrix timeline markers for the reminder and escalation.**

- [ ] **Step 4: Run focused and complete tests, then commit.**

Run: `node --test test/spk-first-contact.test.js && npm test`

### Task 4: Bitrix robot and live verification

**Files:**
- Modify: stage `1. Эксперт назначен` robots in Bitrix24.

**Interfaces:**
- Consumes: transition to `C28:NEW`.
- Produces: one request to `/api/production/spk-first-contact` with the deal ID.

- [ ] **Step 1: Add an immediate outgoing-webhook robot to the stage.**

- [ ] **Step 2: Move a dedicated test SPK deal into the stage with an assigned expert.**

- [ ] **Step 3: Verify the date, the task, the short checklist, and that the responsible person did not change.**

- [ ] **Step 4: Verify the deployed service reports a live successful deployment.**

## Self-review

- The plan covers the abbreviated SPK list, the expected date, first-contact timing, the reminder, and the leader escalation.
- The date rule is deterministic: `Нужен подбор=Да` or a service containing «подбор»/«аттестация» gives 21 days; otherwise 14 days.
- The robot is limited to the assignment stage and the server independently verifies category, stage, service, task marker, and idempotency.
