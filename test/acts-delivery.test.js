'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canUseEmailFallbackAfterWazzupError, createInFlightLock, deliveryChannelPlan, isTechnicalProductionComment, isWazzupRepeatedCrmMessageError } = require('../acts-delivery');
const { MAIL_PROCESSED_FLAG, markMailProcessedAndUnread, unreadUnprocessedMailSearch } = require('../mail-processing');
const { authorizationMatchesToken, requestMatchesToken, requestToken, tokenMatches } = require('../request-auth');

test('uses the preferred channel first and falls back only after it', () => {
  assert.deepEqual(deliveryChannelPlan('telegram'), ['telegram', 'viber', 'email']);
  assert.deepEqual(deliveryChannelPlan('viber'), ['viber', 'telegram', 'email']);
  assert.deepEqual(deliveryChannelPlan('email'), ['email', 'telegram', 'viber']);
  assert.deepEqual(deliveryChannelPlan(''), ['telegram', 'viber', 'email']);
  assert.deepEqual(deliveryChannelPlan('telegram', { telegramEnabled: false }), ['viber', 'email']);
  assert.deepEqual(deliveryChannelPlan('viber', { telegramEnabled: false }), ['viber', 'email']);
  assert.deepEqual(deliveryChannelPlan('email', { telegramEnabled: false }), ['email', 'viber']);
});

test('treats a repeated Wazzup crmMessageId as an accepted idempotent delivery', () => {
  assert.equal(isWazzupRepeatedCrmMessageError({ error: 'REPEATED_CRM_MESSAGE_ID' }), true);
  assert.equal(isWazzupRepeatedCrmMessageError({}, 'Wazzup: REPEATED_CRM_MESSAGE_ID'), true);
  assert.equal(isWazzupRepeatedCrmMessageError({ error: 'POST_MESSAGE_ERROR' }), false);
});

test('uses Email after a confirmed Wazzup failure, but never after an uncertain delivery', () => {
  assert.equal(canUseEmailFallbackAfterWazzupError({ possiblyDelivered: false }), true);
  assert.equal(canUseEmailFallbackAfterWazzupError(new Error('POST_MESSAGE_ERROR')), true);
  assert.equal(canUseEmailFallbackAfterWazzupError({ possiblyDelivered: true }), false);
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

  assert.deepEqual(unreadUnprocessedMailSearch(), { seen: false, answered: false });
  await markMailProcessedAndUnread(client, 125);
  assert.deepEqual(calls, [
    ['add', 125, [MAIL_PROCESSED_FLAG]],
    ['remove', 125, ['\\Seen']],
  ]);
});

test('falls back to seen when an IMAP server rejects the standard processing flag', async () => {
  const calls = [];
  const client = {
    async messageFlagsAdd(uid, flags) {
      calls.push(['add', uid, flags]);
      if (flags.includes(MAIL_PROCESSED_FLAG)) throw new Error('flag unsupported');
    },
    async messageFlagsRemove() { throw new Error('must not remove seen'); },
  };

  const result = await markMailProcessedAndUnread(client, 126);
  assert.equal(result.keptUnread, false);
  assert.deepEqual(calls, [
    ['add', 126, [MAIL_PROCESSED_FLAG]],
    ['add', 126, ['\\Seen']],
  ]);
});

test('keeps an email unread when CRM already has a durable processing marker', async () => {
  const calls = [];
  const client = {
    async messageFlagsAdd(uid, flags) {
      calls.push(['add', uid, flags]);
      if (flags.includes(MAIL_PROCESSED_FLAG)) throw new Error('flag unsupported');
    },
    async messageFlagsRemove(uid, flags) { calls.push(['remove', uid, flags]); },
  };

  const result = await markMailProcessedAndUnread(client, 127, { durableProcessedMarker: true });
  assert.equal(result.keptUnread, true);
  assert.deepEqual(calls, [
    ['add', 127, [MAIL_PROCESSED_FLAG]],
    ['remove', 127, ['\\Seen']],
  ]);
});
