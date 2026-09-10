'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createInFlightLock, deliveryChannelPlan, isTechnicalProductionComment } = require('../acts-delivery');
const { authorizationMatchesToken, requestMatchesToken, requestToken, tokenMatches } = require('../request-auth');

test('uses the preferred channel first and falls back only after it', () => {
  assert.deepEqual(deliveryChannelPlan('telegram'), ['telegram', 'viber', 'email']);
  assert.deepEqual(deliveryChannelPlan('viber'), ['viber', 'telegram', 'email']);
  assert.deepEqual(deliveryChannelPlan('email'), ['email', 'telegram', 'viber']);
  assert.deepEqual(deliveryChannelPlan(''), ['telegram', 'viber', 'email']);
});

test('allows only one concurrent delivery for the same task and deal', () => {
  const lock = createInFlightLock();
  const release = lock.acquire('48052:38072');
  assert.equal(typeof release, 'function');
  assert.equal(lock.acquire('48052:38072'), null);
  release();
  assert.equal(typeof lock.acquire('48052:38072'), 'function');
});

test('targets only explicitly known technical CRM comments for cleanup', () => {
  assert.equal(isTechnicalProductionComment('[WAZZUP_AI_INBOUND] action=resend_act confidence=0.98\n{"task":48052}'), true);
  assert.equal(isTechnicalProductionComment('[MAVIS_AUTOPILOT_SEND_PENDING]\nНе удалось отправить ход работы клиенту.'), true);
  assert.equal(isTechnicalProductionComment('⚠️ ИИгорь не смог отправить ход работы клиенту: HTTP 500'), true);
  assert.equal(isTechnicalProductionComment('Игорь не смог отправить ход работы клиенту: timeout'), true);
  assert.equal(isTechnicalProductionComment('Клиент попросил повторно отправить акт. Акт отправлен повторно.'), false);
  assert.equal(isTechnicalProductionComment('[MAVIS_ACTS_SENT] task=48052\nКлиенту отправлен акт.'), false);
});

test('requires an exact non-empty token for protected routes', () => {
  const bearerRequest = { get: () => 'Bearer secret' };
  assert.equal(requestToken(bearerRequest), 'secret');
  assert.equal(requestMatchesToken(bearerRequest, 'secret'), true);
  assert.equal(requestMatchesToken({ body: { token: 'secret' }, get: () => '' }, 'secret'), true);
  assert.equal(authorizationMatchesToken(bearerRequest, 'secret'), true);
  assert.equal(authorizationMatchesToken({ body: { token: 'secret' }, get: () => '' }, 'secret'), false);
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('secret', 'wrong'), false);
});
