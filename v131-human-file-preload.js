'use strict';

/*
 * MAVIS v131 — HUMAN FILE REPLY
 *
 * Узкий безопасный runtime-слой поверх текущего server.js:
 * 1) Wazzup-файл определяется по contentUri, а не только type=image/document.
 * 2) Мгновенный тестовый ответ Бобика переписывается на естественный ответ
 *    по смыслу присланного документа.
 * 3) Боевой server.js, таймеры актов, CJM, возврат оригиналов и остальные процессы не меняются.
 */

const express = require('express');

const V131_MARKER = 'ACTS_HUMAN_FILE_REPLY_V131';
const incomingFiles = new Map();
const nativeFetch = globalThis.fetch.bind(globalThis);

function text(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

function safeMessageId(v) {
  return text(v).replace(/\s+/g, '_').slice(0, 160);
}

function digits(v) {
  return text(v).replace(/\D/g, '');
}

function wazzupContentHostAllowed(uri) {
  try {
    const host = new URL(text(uri)).hostname.toLowerCase();
    return host === 'wazzup24.com' || host.endsWith('.wazzup24.com');
  } catch (_) {
    return false;
  }
}

function configuredChannelIds() {
  return new Set([
    process.env.WAZZUP_CHANNEL_ID,
    process.env.WAZZUP_TG_CHANNEL_ID,
    process.env.WAZZUP_TELEGRAM_CHANNEL_ID,
    process.env.WAZZUP_VIBER_CHANNEL_ID,
  ].map(text).filter(Boolean));
}

function knownChannel(msg) {
  const ids = configuredChannelIds();
  // Если ни один channelId не задан, не ослабляем проверку здесь:
  // обычный server.js сам решит, можно ли обрабатывать webhook.
  return ids.size > 0 && ids.has(text(msg && msg.channelId));
}

function rememberIncomingFile(msg) {
  if (!msg || msg.isEcho || text(msg.status).toLowerCase() !== 'inbound') return;
  if (!msg.contentUri || !wazzupContentHostAllowed(msg.contentUri)) return;
  if (!knownChannel(msg)) return;

  const rawId = text(msg.messageId);
  const id = safeMessageId(rawId);
  if (!id) return;

  const snapshot = {
    messageId: rawId,
    safeId: id,
    contentUri: text(msg.contentUri),
    text: text(msg.text || msg.caption || ''),
    type: text(msg._mavisOriginalType || msg.type).toLowerCase(),
    chatType: text(msg.chatType).toLowerCase(),
    channelId: text(msg.channelId),
    chatId: text(msg.chatId),
    phone: digits((msg.contact && msg.contact.phone) || msg.chatId || ''),
    fileName: text(
      msg.fileName || msg.filename || msg.name ||
      (msg.content && (msg.content.fileName || msg.content.filename || msg.content.name)) ||
      (msg.data && (msg.data.fileName || msg.data.filename || msg.data.name)) || ''
    ),
    receivedAt: Date.now(),
  };

  incomingFiles.set(id, snapshot);
  if (rawId && rawId !== id) incomingFiles.set(rawId, snapshot);

  // Не держим данные бесконечно.
  setTimeout(() => {
    incomingFiles.delete(id);
    if (rawId) incomingFiles.delete(rawId);
  }, 30 * 60 * 1000).unref?.();
}

function normalizeIncomingContentTypes(req) {
  const messages = Array.isArray(req && req.body && req.body.messages)
    ? req.body.messages
    : [];

  for (const msg of messages) {
    if (!msg || msg.isEcho || text(msg.status).toLowerCase() !== 'inbound') continue;
    if (!msg.contentUri) continue;

    rememberIncomingFile(msg);

    // v129 пропускает type=file/audio/прочие. Для реального файла contentUri —
    // главный признак; нормализуем в document только внутри нашего webhook.
    const originalType = text(msg.type).toLowerCase();
    if (!['image', 'document'].includes(originalType)) {
      msg._mavisOriginalType = originalType;
      msg.type = 'document';
      console.log(`[v131] Wazzup content normalized: type=${originalType || 'empty'} -> document; message=${msg.messageId || '?'}`);
    }
  }
}

// Оборачиваем регистрацию только одного существующего маршрута.
// Другие Express-маршруты не затрагиваются.
const originalPost = express.application.post;
express.application.post = function v131Post(path, ...handlers) {
  const isWazzupWebhook =
    path === '/api/wazzup/webhook' ||
    (Array.isArray(path) && path.includes('/api/wazzup/webhook'));

  if (!isWazzupWebhook) {
    return originalPost.call(this, path, ...handlers);
  }

  const wrapped = handlers.map((handler, index) => {
    if (typeof handler !== 'function' || index !== 0) return handler;
    return function v131WazzupWebhookWrapper(req, res, next) {
      try {
        normalizeIncomingContentTypes(req);
      } catch (e) {
        console.warn(`[v131] inbound normalization error: ${e.message || e}`);
      }
      return handler.call(this, req, res, next);
    };
  });

  return originalPost.call(this, path, ...wrapped);
};

async function loadDealContext(dealId) {
  const hook = text(process.env.BITRIX_WEBHOOK_URL).replace(/\/+$/, '');
  if (!hook || !dealId) return null;
  try {
    const r = await nativeFetch(`${hook}/crm.deal.get.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dealId }),
    });
    const data = await r.json().catch(() => ({}));
    return r.ok ? (data && data.result ? data.result : null) : null;
  } catch (_) {
    return null;
  }
}

function resolveAi() {
  const provider = text(process.env.AI_PROVIDER || 'openai').toLowerCase();
  const apiKey = text(
    process.env.AI_API_KEY ||
    process.env.VIBE_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
  );

  const isVibe = ['vibe', 'vibecode', 'bitrix'].includes(provider);
  const baseUrl = text(
    process.env.AI_BASE_URL ||
    (isVibe ? 'https://vibecode.bitrix24.tech/v1' : 'https://api.openai.com/v1')
  ).replace(/\/+$/, '');

  return {
    apiKey,
    baseUrl,
    model: text(process.env.AI_MODEL || 'gpt-4o-mini'),
  };
}

function fileNameFromRecord(record, response, contentType) {
  if (record.fileName) return record.fileName;

  const disposition = text(response && response.headers && response.headers.get('content-disposition'));
  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf) {
    try { return decodeURIComponent(utf[1].replace(/^["']|["']$/g, '')); } catch (_) {}
  }
  const plain = disposition.match(/filename="?([^";]+)"?/i);
  if (plain) return plain[1].trim();

  try {
    const u = new URL(record.contentUri);
    const last = decodeURIComponent(u.pathname.split('/').pop() || '');
    if (last && /\.[a-z0-9]{2,6}$/i.test(last)) return last;
  } catch (_) {}

  if (/pdf/i.test(contentType)) return 'document.pdf';
  if (/png/i.test(contentType)) return 'image.png';
  if (/jpe?g/i.test(contentType)) return 'image.jpg';
  return 'document';
}

function naturalFallback(record, fileName = '') {
  const joined = `${fileName} ${record && record.text || ''}`.toLowerCase();

  if (/диплом/.test(joined)) return 'Спасибо, диплом получили. Передали в работу.';
  if (/поверк|калибров|средств.*измер/.test(joined)) return 'Спасибо, документы по поверке получили. Учтём их в комплекте.';
  if (/договор/.test(joined)) return 'Спасибо, договор получили. Передали в работу.';
  if (/сч[её]т|invoice/.test(joined)) return 'Спасибо, счёт получили. Передали в работу.';
  if (/плат[её]ж|платежк|квитанц/.test(joined)) return 'Спасибо, подтверждение оплаты получили. Передали в работу.';
  if (/трудов/.test(joined)) return 'Спасибо, трудовую получили. Передали в работу.';
  if (/аттестат/.test(joined)) return 'Спасибо, аттестат получили. Передали в работу.';
  if (/паспорт/.test(joined)) return 'Спасибо, документ получили. Передали в работу.';
  return 'Спасибо, файл получили. Передали в работу.';
}

function sanitizeReply(obj, fallback) {
  const reply = text(obj && obj.reply);
  const isAct = Boolean(obj && obj.isAct);
  if (!reply) return fallback;

  // Технический язык клиенту не показываем.
  if (/(классификац|автоматизац|тестов(ая|ой|ую|ое)|боев(ых|ые|ой)|активн(ый|ого)\s+контрол|искусственн.*интеллект|\bии\b)/i.test(reply)) {
    return fallback;
  }

  // Если модель сама решила, что это НЕ акт, слово "акт" в ответ клиенту запрещено.
  if (!isAct && /акт(?:а|ом|ы|е|у)?\b/i.test(reply)) {
    return fallback;
  }

  return reply.slice(0, 800);
}

async function analyzeIncomingFileHuman(record, dealId) {
  if (!record) return 'Спасибо, файл получили. Передали в работу.';

  let response;
  let buffer = null;
  let contentType = '';
  let fileName = record.fileName || '';

  try {
    response = await nativeFetch(record.contentUri, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MAVIS-v131/1.0)',
        'Accept': 'application/pdf,image/*,application/octet-stream,*/*',
      },
    });

    if (response.ok) {
      const contentLength = Number(response.headers.get('content-length') || 0);
      contentType = text(response.headers.get('content-type')).split(';')[0].toLowerCase();
      fileName = fileNameFromRecord(record, response, contentType);

      if (!contentLength || contentLength <= 12 * 1024 * 1024) {
        const ab = await response.arrayBuffer();
        if (ab.byteLength <= 12 * 1024 * 1024) buffer = Buffer.from(ab);
      }
    }
  } catch (e) {
    console.warn(`[v131] file download for human reply failed: ${e.message || e}`);
  }

  const fallback = naturalFallback(record, fileName);
  const ai = resolveAi();
  if (!ai.apiKey) return fallback;

  const deal = await loadDealContext(dealId);
  const serviceField = text(process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071');
  const dealTitle = text(deal && deal.TITLE);
  const service = text(deal && (deal[serviceField] || deal.UF_CRM_1765113071));

  const prompt = [
    'Ты сотрудник MAVIS GROUP и отвечаешь клиенту в обычной деловой переписке.',
    'Клиент прислал файл. Сначала пойми, что именно он прислал и какую роль этот документ может играть в текущей сделке.',
    '',
    'КРИТИЧЕСКИЕ ПРАВИЛА:',
    '— Не считай любой файл актом.',
    '— Упоминай акт ТОЛЬКО если сам файл действительно является актом выполненных работ/оказанных услуг или клиент прямо написал про акт.',
    '— Если это другой нужный документ (диплом, договор, счёт, платёжка, трудовая, аттестат, поверка, свидетельство и т.п.), отвечай именно про этот документ.',
    '— Не используй технические слова: проверка, классификация, ИИ, автоматизация, тестовая сделка, боевые действия, активный контроль.',
    '— Не рассказывай клиенту внутреннюю механику.',
    '— Не придумывай сроки, результат рассмотрения и факты, которых не видно.',
    '— Если документ непонятен, просто поблагодари за файл и скажи, что получили и передали в работу.',
    '— Ответ должен звучать как живой внимательный сотрудник: 1–3 коротких предложения.',
    '',
    dealTitle ? `Сделка: ${dealTitle}.` : '',
    service ? `Услуга: ${service}.` : '',
    fileName ? `Имя файла: ${fileName}.` : '',
    record.text ? `Текст клиента вместе с файлом: ${record.text.slice(0, 1200)}` : 'Текста клиента вместе с файлом нет.',
    '',
    'Верни только JSON:',
    '{"documentType":"что за документ","isAct":true|false,"isSignedAct":true|false,"isRelevantToDeal":true|false|null,"reply":"готовый ответ клиенту"}',
  ].filter(Boolean).join('\n');

  let content = prompt;
  if (buffer && /^image\/(jpeg|jpg|png|webp)$/i.test(contentType)) {
    const mime = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
    content = [
      { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
      { type: 'text', text: prompt },
    ];
  } else if (buffer && (contentType === 'application/pdf' || /\.pdf$/i.test(fileName))) {
    content = [
      {
        type: 'file',
        file: {
          filename: fileName || 'document.pdf',
          file_data: `data:application/pdf;base64,${buffer.toString('base64')}`,
        },
      },
      { type: 'text', text: prompt },
    ];
  }

  try {
    const r = await nativeFetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ai.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: ai.model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content }],
      }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(
        data && data.error && (data.error.message || data.error_description) ||
        `HTTP ${r.status}`
      );
    }

    const raw = text(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
    const match = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(match ? match[0] : raw || '{}');
    return sanitizeReply(obj, fallback);
  } catch (e) {
    console.warn(`[v131] human file AI failed: ${e.message || e}`);
    return fallback;
  }
}

async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Перехватываем ТОЛЬКО исходящий мгновенный тестовый ответ на файл.
// Все остальные fetch-запросы сервера проходят один-в-один.
globalThis.fetch = async function v131Fetch(input, init = {}) {
  const url = typeof input === 'string' ? input : text(input && input.url);
  const method = text(init && init.method || 'GET').toUpperCase();

  if (method === 'POST' && /\/message(?:\?.*)?$/i.test(url) && init && init.body) {
    try {
      const payload = JSON.parse(String(init.body));
      const testDealId = text(
        process.env.ACTS_SMART_DIALOG_TEST_DEAL_ID ||
        process.env.CJM_TEST_DEAL_ID ||
        '38072'
      );
      const prefix = `mavis-acts-test-file-${testDealId}-`;
      const crmId = text(payload.crmMessageId);

      if (crmId.startsWith(prefix)) {
        const messageId = crmId.slice(prefix.length);
        const record = incomingFiles.get(messageId);
        const fallback = naturalFallback(record || {}, record && record.fileName || '');

        const reply = await withTimeout(
          analyzeIncomingFileHuman(record, testDealId),
          22000,
          fallback
        );

        payload.text = text(reply) || fallback;
        init = { ...init, body: JSON.stringify(payload) };

        console.log(
          `[v131] human file reply deal=${testDealId}; message=${messageId || '?'}; ` +
          `source=${record ? 'matched-inbound' : 'fallback'}`
        );

        if (record) {
          incomingFiles.delete(record.safeId);
          if (record.messageId) incomingFiles.delete(record.messageId);
        }
      }
    } catch (e) {
      console.warn(`[v131] outgoing human reply rewrite error: ${e.message || e}`);
    }
  }

  return nativeFetch(input, init);
};

console.log(`[startup] ${V131_MARKER}=ON; Wazzup any-contentUri=ON; Bobik human-file-reply=ON.`);
