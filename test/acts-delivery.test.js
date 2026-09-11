'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createInFlightLock, deliveryChannelPlan, isTechnicalProductionComment } = require('../acts-delivery');
const { MAIL_PROCESSED_KEYWORD, markMailProcessedAndUnread, unreadUnprocessedMailSearch } = require('../mail-processing');
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

test('keeps processed client emails unread while persisting a separate processing marker', async () => {
  const calls = [];
  const client = {
    async messageFlagsAdd(uid, flags) { calls.push(['add', uid, flags]); },
    async messageFlagsRemove(uid, flags) { calls.push(['remove', uid, flags]); },
  };

  assert.deepEqual(unreadUnprocessedMailSearch(), { seen: false, unKeyword: MAIL_PROCESSED_KEYWORD });
  await markMailProcessedAndUnread(client, 125);
  assert.deepEqual(calls, [
    ['add', 125, [MAIL_PROCESSED_KEYWORD]],
    ['remove', 125, ['\\Seen']],
  ]);
});

test('falls back to seen when an IMAP server rejects custom processing markers', async () => {
  const calls = [];
  const client = {
    async messageFlagsAdd(uid, flags) {
      calls.push(['add', uid, flags]);
      if (flags.includes(MAIL_PROCESSED_KEYWORD)) throw new Error('keywords unsupported');
    },
    async messageFlagsRemove() { throw new Error('must not remove seen'); },
  };

  const result = await markMailProcessedAndUnread(client, 126);
  assert.equal(result.keptUnread, false);
  assert.deepEqual(calls, [
    ['add', 126, [MAIL_PROCESSED_KEYWORD]],
    ['add', 126, ['\\Seen']],
  ]);
});
