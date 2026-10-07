# Скрытый переход стадии Производства — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить в существующее локальное приложение Bitrix24 единый контролируемый переход сделки Производства: менеджер выбирает целевую стадию и новую предполагаемую дату закрытия, после чего приложение одним обновлением сохраняет оба значения без бизнес-процесса и задач.

**Architecture:** Новая панель во вкладке `ИИ-ассистент` получает стадии текущей воронки через Bitrix REST от имени открывшего пользователя. Клиент валидирует дату и доступный этап, затем вызывает `crm.deal.update` с `STAGE_ID` и существующим полем «Предполагаемая дата закрытия продукта» в едином запросе. Сценарий не создаёт задач, комментариев и процессов. После пилота прямое перемещение по полосе стадий будет закрыто CRM-правами для ролей Производства, иначе его можно обойти.

**Tech Stack:** существующий Node/Express local app, Bitrix24 JS SDK (`BX24.callMethod`), HTML/CSS/vanilla JS, Node built-in tests.

## Global Constraints

- Только воронка Производства `CATEGORY_ID=28`.
- Использовать существующее поле даты; не создавать дополнительных CRM-полей.
- Не создавать задач, комментариев, роботов или БП.
- Нельзя менять стадию при пустой или прошедшей дате.
- Нельзя менять другую сделку или сделку другой воронки.
- Обычная запись в истории смены стадии Bitrix остаётся; это не задача и не БП.

---

### Task 1: Контракт и тестируемая валидация перехода

**Files:**
- Create: `production-stage-transition.js`
- Create: `test/production-stage-transition.test.js`

**Interfaces:**
- Produces: `validateProductionTransition({ deal, categoryId, dateFieldCode, targetStageId, expectedCloseDate, stages, today })`.
- Produces: `transitionFields({ targetStageId, expectedCloseDate, dateFieldCode })`.

- [ ] **Step 1: Write failing validation tests**

```js
assert.throws(() => validateProductionTransition({
  deal: { ID: '1', CATEGORY_ID: 28 }, categoryId: 28, dateFieldCode: 'UF_DATE',
  targetStageId: 'C28:STAGE', expectedCloseDate: '', stages: [{ STATUS_ID: 'C28:STAGE' }], today: '2026-10-07',
}), /дату/);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/production-stage-transition.test.js`

- [ ] **Step 3: Implement deterministic validation**

```js
function transitionFields({ targetStageId, expectedCloseDate, dateFieldCode }) {
  return { STAGE_ID: targetStageId, [dateFieldCode]: expectedCloseDate };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/production-stage-transition.test.js`

### Task 2: Hidden-task-free transition UI in the existing deal tab

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `validateProductionTransition` rules mirrored client-side for immediate user feedback.
- Produces: button `#production-stage-transition` and modal `#stage-transition-dialog`.

- [ ] **Step 1: Add the transition panel and modal**

```html
<button id="production-stage-transition" class="primary">Перевести сделку</button>
<dialog id="stage-transition-dialog">
  <select id="stage-transition-target" required></select>
  <input id="stage-transition-date" type="date" required>
  <button id="stage-transition-submit" class="primary">Сохранить и перевести</button>
</dialog>
```

- [ ] **Step 2: Load current stages and date field metadata**

```js
const stages = await bxCall('crm.dealcategory.stage.list', { id: Number(deal.CATEGORY_ID) });
const dateField = Object.entries(state.fields).find(([, meta]) => /предполагаемая дата закрытия продукта/i.test(meta.title || meta.formLabel || ''));
```

- [ ] **Step 3: Update date and stage in one REST update**

```js
await bxCall('crm.deal.update', {
  id: Number(state.currentDealId),
  fields: { STAGE_ID: targetStageId, [dateFieldCode]: expectedCloseDate },
});
```

- [ ] **Step 4: Show success state and refresh the current deal**

```js
await loadDealTab(state.currentDealId);
```

### Task 3: Server-side guard for the custom route

**Files:**
- Modify: `server.js`
- Test: `test/production-stage-transition.test.js`

**Interfaces:**
- Consumes: `POST /api/production/transition` JSON `{ dealId, targetStageId, expectedCloseDate }`.
- Produces: `{ ok, dealId, stageId, expectedCloseDate }`.

- [ ] **Step 1: Add endpoint tests for other funnel, unknown stage and blank date**

```js
assert.throws(() => validateProductionTransition({ deal: { CATEGORY_ID: 1 }, categoryId: 28, ...input }), /Производства/);
```

- [ ] **Step 2: Implement the endpoint with webhook-side revalidation**

```js
const deal = await bitrixRestCall('crm.deal.get', { id: dealId });
const stages = await bitrixRestCall('crm.dealcategory.stage.list', { id: 28 });
validateProductionTransition({ deal, categoryId: 28, dateFieldCode, targetStageId, expectedCloseDate, stages });
await bitrixRestCall('crm.deal.update', { id: dealId, fields: transitionFields(...) });
```

- [ ] **Step 3: Make the browser call the server endpoint instead of exposing a direct unrestricted transition path**

```js
await fetch('/api/production/transition', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
```

- [ ] **Step 4: Run route and unit tests**

Run: `node --test test/production-stage-transition.test.js`

### Task 4: Verification and controlled rollout

**Files:**
- Modify: `README_V152_PRODUCTION_STAGE_TRANSITION.md`

- [ ] **Step 1: Run all existing tests**

Run: `npm test`

- [ ] **Step 2: Test on the existing test deal**

Expected: choosing a date and a target stage changes both fields; timeline contains normal stage-change history only, with no “Задание бизнес-процесса”.

- [ ] **Step 3: Restrict direct stage transfer in the CRM role configuration**

Expected: selected Production roles can use the app action but cannot bypass it by clicking the stage bar. This changes users’ CRM permissions and requires explicit approval at rollout.

- [ ] **Step 4: Document rollback**

Rollback: hide the app’s transition button and restore the previous CRM-role stage permissions; no migration or data deletion is involved.

## Self-review

- The plan covers the modal, field/stage validation, a single update call, no-task constraint, server revalidation, tests and a permission-based bypass block.
- It intentionally does not create CRM fields or robots.
- The only account-wide change is Task 4 Step 3, isolated for explicit approval.
