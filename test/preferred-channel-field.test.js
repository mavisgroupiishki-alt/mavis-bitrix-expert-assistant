'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { isPreferredChannelFieldLabel } = require('../preferred-channel-field');

test('recognises both Russian wordings used for the preferred communication channel field', () => {
  assert.equal(isPreferredChannelFieldLabel('Предпочитаемый канал связи'), true);
  assert.equal(isPreferredChannelFieldLabel('Предпочтительный способ связи'), true);
  assert.equal(isPreferredChannelFieldLabel('Канал связи'), false);
});
