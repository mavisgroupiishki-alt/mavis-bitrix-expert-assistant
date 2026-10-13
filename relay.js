const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const RELAY_TOKEN = String(process.env.RELAY_TOKEN || '');
const VIBE_API_KEY = String(process.env.VIBE_API_KEY || process.env.AI_API_KEY || '');
const VIBE_BASE_URL = String(process.env.VIBE_BASE_URL || 'https://vibecode.bitrix24.tech/v1').replace(/\/$/, '');
const VIBE_MODEL = String(process.env.VIBE_MODEL || 'bitrix/bitrixgpt-5.5');
const MAX_CONTEXT_CHARS = 32000;
const MAX_QUESTION_CHARS = 2000;
const MAX_REQUESTS_PER_MINUTE = 12;
const requestWindow = new Map();

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '48kb' }));

function safeEqual(actual, expected) {
  const left = Buffer.from(actual || '');
  const right = Buffer.from(expected || '');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(req) {
  const value = String(req.get('authorization') || '');
  return value.startsWith('Bearer ') && safeEqual(value.slice(7), RELAY_TOKEN);
}

function allowRequest(req) {
  const key = String(req.ip || 'unknown');
  const now = Date.now();
  const history = (requestWindow.get(key) || []).filter((time) => now - time < 60_000);
  if (history.length >= MAX_REQUESTS_PER_MINUTE) return false;
  history.push(now);
  requestWindow.set(key, history);
  return true;
}

function boundedText(value, maximum) {
  return String(value || '').trim().slice(0, maximum);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'vibecode-relay', modelConfigured: Boolean(VIBE_MODEL) });
});

app.post('/api/obsidian-chat', async (req, res) => {
  if (!RELAY_TOKEN || !VIBE_API_KEY) return res.status(503).json({ ok: false, error: 'relay_not_configured' });
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
  if (!allowRequest(req)) return res.status(429).json({ ok: false, error: 'rate_limited' });

  const question = boundedText(req.body?.question, MAX_QUESTION_CHARS);
  const context = boundedText(req.body?.context, MAX_CONTEXT_CHARS);
  if (!question) return res.status(400).json({ ok: false, error: 'question_required' });

  try {
    const response = await fetch(`${VIBE_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(55_000),
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': VIBE_API_KEY,
      },
      body: JSON.stringify({
        model: VIBE_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: 'Ты помощник корпоративной базы знаний. Отвечай по-русски. Используй только переданный контекст. Сначала дай короткий вывод, затем нумерованные следующие шаги. Не раскрывай персональные данные и не придумывай факты.',
          },
          { role: 'user', content: `Вопрос: ${question}\n\nКонтекст:\n${context}` },
        ],
      }),
    });
    if (!response.ok) return res.status(502).json({ ok: false, error: 'vibecode_upstream_unavailable' });
    const payload = await response.json();
    const answer = boundedText(payload?.choices?.[0]?.message?.content, 20_000);
    if (!answer) return res.status(502).json({ ok: false, error: 'vibecode_empty_response' });
    return res.json({ ok: true, answer, facts: [], recommendations: [] });
  } catch (_error) {
    return res.status(504).json({ ok: false, error: 'vibecode_timeout' });
  }
});

app.listen(PORT, () => console.log(`vibecode-relay listening on ${PORT}`));
