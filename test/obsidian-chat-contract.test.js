'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('exposes a dedicated token-protected Obsidian chat endpoint', () => {
  assert.match(source, /function obsidianChatAuthorized\(req\)/);
  assert.match(source, /process\.env\.MAVIS_OBSIDIAN_TOKEN/);
  assert.match(source, /app\.post\('\/api\/obsidian-chat'/);
  assert.match(source, /OBSIDIAN_CHAT_MAX_CONTEXT_CHARS/);
  assert.match(source, /Obsidian Mavis Knowledge/);
});

test('isolates Obsidian chat capacity and bounds the upstream AI wait', () => {
  assert.match(source, /function beginObsidianChatRequest\(\)/);
  assert.match(source, /OBSIDIAN_CHAT_MAX_IN_FLIGHT/);
  assert.match(source, /OBSIDIAN_CHAT_MAX_REQUESTS_PER_MINUTE/);
  assert.match(source, /OBSIDIAN_CHAT_AI_TIMEOUT_MS/);
  assert.match(source, /const finishRequest = beginObsidianChatRequest\(\);/);
  assert.match(source, /timeoutMs: OBSIDIAN_CHAT_AI_TIMEOUT_MS/);
  assert.match(source, /AbortSignal\.timeout\(timeoutMs\)/);
});
