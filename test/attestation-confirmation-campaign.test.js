'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ATTESTATION_CONFIRMATION_SUBJECT,
  ATTESTATION_CONFIRMATION_URL,
  attestationConfirmationCampaignEmail,
} = require('../attestation-confirmation-campaign');

test('builds the attestation confirmation email with the supplied UTM link', () => {
  const email = attestationConfirmationCampaignEmail();

  assert.equal(email.subject, ATTESTATION_CONFIRMATION_SUBJECT);
  assert.match(email.text, new RegExp(ATTESTATION_CONFIRMATION_URL.replace(/[.?]/g, '\\$&')));
  assert.match(email.html, new RegExp(`href="${ATTESTATION_CONFIRMATION_URL.replace(/[.?]/g, '\\$&')}"`));
  assert.match(email.text, /с 1 по 31 декабря/);
});
