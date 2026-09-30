'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { VISION_MAX_DOCUMENT_BYTES, visionInputPolicy } = require('../vision-input-policy');

test('allows a supported document within the Vision payload limit', () => {
  const result = visionInputPolicy(Buffer.from('%PDF-1.7'), 'акт.pdf', 'application/pdf');
  assert.equal(result.allowed, true);
  assert.equal(result.isPdf, true);
});

test('skips an oversized supported document before it can cause a provider 413', () => {
  const result = visionInputPolicy(Buffer.alloc(VISION_MAX_DOCUMENT_BYTES + 1), 'scan.jpg', 'image/jpeg');
  assert.deepEqual({ allowed: result.allowed, reason: result.reason }, { allowed: false, reason: 'file-too-large' });
});
