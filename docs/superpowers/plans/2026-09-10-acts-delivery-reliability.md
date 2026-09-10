# Acts Delivery Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop duplicate act delivery and give administrators a protected way to remove explicitly identified technical CRM comments from Production deals.

**Architecture:** Keep the server's existing Bitrix and Wazzup integration, but isolate channel ordering and in-flight locking in a small dependency-free module. The route reports cleanup candidates before it can delete anything.

**Tech Stack:** Node.js 18, `node:test`, Express, Bitrix REST.

## Global Constraints

- Do not add dependencies.
- Never send fallback after a Wazzup result marked `possiblyDelivered`.
- Scan only Production category `28` for historical cleanup.
- Normal human CRM comments are not cleanup candidates.

---

### Task 1: Delivery policy helpers

**Files:**
- Create: `acts-delivery.js`
- Create: `test/acts-delivery.test.js`
- Modify: `server.js:4817-4829`

**Interfaces:**
- Produces: `deliveryChannelPlan(preferredChannel)` and `createInFlightLock()`.

- [ ] **Step 1: Write the failing test**

```js
assert.deepEqual(deliveryChannelPlan('telegram'), ['telegram', 'viber', 'email']);
assert.deepEqual(deliveryChannelPlan('email'), ['email', 'telegram', 'viber']);
const locks = createInFlightLock();
assert.equal(typeof locks.acquire('48052:38072'), 'function');
assert.equal(locks.acquire('48052:38072'), null);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/acts-delivery.test.js`
Expected: FAIL because module does not exist.

- [ ] **Step 3: Write minimal implementation**

```js
function deliveryChannelPlan(preferred) {
  const all = ['telegram', 'viber', 'email'];
  return preferred && all.includes(preferred)
    ? [preferred, ...all.filter((channel) => channel !== preferred)]
    : all;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/acts-delivery.test.js`
Expected: PASS.

### Task 2: Apply delivery lock and fallback only policy

**Files:**
- Modify: `server.js:11989-12140,12147-12272`
- Test: `test/acts-delivery.test.js`

**Interfaces:**
- Consumes: `deliveryChannelPlan`, `createInFlightLock`.
- Produces: one in-flight claim per `taskId:dealId`.

- [ ] **Step 1: Import helpers and route `actsDeliveryChannelPlan` through `deliveryChannelPlan`.**
- [ ] **Step 2: Remove `emailCopy` and stop the channel loop after the first confirmed `primary`.**
- [ ] **Step 3: Acquire lock immediately before `actsSendActToClientByPreferredChannel`; return `duplicate: true` if unavailable; release in `finally`.**
- [ ] **Step 4: Run `node --test test/acts-delivery.test.js`.**

### Task 3: Preserve durable markers and add cleanup preview

**Files:**
- Modify: `server.js:5626,15472-15485`
- Modify: `server.js` near existing protected maintenance routes

**Interfaces:**
- Produces: `POST /api/maintenance/production-comment-cleanup`.

- [ ] **Step 1: Keep `AUTOPILOT_MARKER` in the stored comment while stripping only presentation-only marker strings.**
- [ ] **Step 2: Implement a pure predicate limited to known Wazzup/AI debug payload comments and a route with `execute=false` default.**
- [ ] **Step 3: Require `ACTS_MAINTENANCE_TOKEN` and `execute=true` before `crm.timeline.comment.delete`.**
- [ ] **Step 4: Test pure predicate and token guard with `node:test`.**

### Task 4: Verification

**Files:**
- Test: `test/*.test.js`

- [ ] **Step 1: Run `node --test`.**
- [ ] **Step 2: Run `node --check server.js`.**
- [ ] **Step 3: Run `git diff --check` and inspect the staged scope.**
