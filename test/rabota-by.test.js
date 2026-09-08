'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { apiUrl, createRabotaByClient, rabotaResponseToIntake } = require('../rabota-by');

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

test('uses only GET requests to the official Rabota.by API', async () => {
  const calls = [];
  const client = createRabotaByClient({
    accessToken: 'test-token',
    userAgent: 'MAVIS Recruiting/1.0 (hr@example.test)',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ collections: [], items: [] });
    },
  });

  await client.listCollections('136992897');
  await client.listResponses('https://api.hh.ru/negotiations/response?vacancy_id=136992897');
  await client.getResponse('123');

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.match(call.url, /^https:\/\/api\.hh\.ru\//);
    assert.match(call.url, /host=rabota\.by/);
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.headers.Authorization, 'Bearer test-token');
    assert.equal(call.options.headers['HH-User-Agent'], 'MAVIS Recruiting/1.0 (hr@example.test)');
  }
});

test('rejects URLs outside the official API origin', () => {
  assert.throws(() => apiUrl('https://example.test/negotiations'), /api\.hh\.ru/);
});

test('maps an employer response without demographics', () => {
  const intake = rabotaResponseToIntake({
    id: 'response-42',
    created_at: '2026-09-08T09:00:00+0300',
    age: 33,
    resume: {
      first_name: 'Иван', middle_name: 'Иванович', last_name: 'Иванов',
      phone: { formatted: '+375 29 000-00-00' }, email: 'ivan@example.test',
      title: 'Менеджер по продажам', alternate_url: 'https://rabota.by/resume/42', age: 33,
    },
  }, { vacancyId: '136992897', role: 'Менеджер по продажам' });

  assert.deepEqual(intake, {
    source: 'rabota.by', role: 'Менеджер по продажам', application_id: 'response-42', vacancy_id: '136992897',
    source_url: 'https://rabota.by/resume/42', received_at: '2026-09-08T09:00:00+0300', conditions: 'Менеджер по продажам',
    candidate: { full_name: 'Иван Иванович Иванов', phone: '+375 29 000-00-00', email: 'ivan@example.test', resume_url: 'https://rabota.by/resume/42' },
  });
  assert.equal('age' in intake, false);
  assert.equal('age' in intake.candidate, false);
});
