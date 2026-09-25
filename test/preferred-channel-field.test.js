'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { enumLabelForValue, isPreferredChannelFieldLabel, preferredChannelFromValue } = require('../preferred-channel-field');

test('recognises both Russian wordings used for the preferred communication channel field', () => {
  assert.equal(isPreferredChannelFieldLabel('Предпочитаемый канал связи'), true);
  assert.equal(isPreferredChannelFieldLabel('Предпочтительный способ связи'), true);
  assert.equal(isPreferredChannelFieldLabel('Канал связи'), false);
});

test('resolves a Bitrix enum value returned only by userfield.get', () => {
  assert.equal(enumLabelForValue({ LIST: [{ ID: '42', VALUE: 'Viber' }] }, '42'), 'Viber');
  assert.equal(enumLabelForValue({ ENUM: [{ id: '7', value: 'E-mail' }] }, '7'), 'E-mail');
});

test('uses the first selected communication channel instead of forcing Telegram', () => {
  assert.equal(preferredChannelFromValue('Viber Telegram'), 'viber');
  assert.equal(preferredChannelFromValue('Telegram Viber'), 'telegram');
  assert.equal(preferredChannelFromValue('Вайбер'), 'viber');
});
