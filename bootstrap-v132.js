#!/usr/bin/env node
'use strict';

/*
  MAVIS v132 — runtime builder.
  Берёт текущий server.js из репозитория, точечно меняет только:
  - обработку входящих Wazzup-файлов;
  - мгновенный ответ Бобика на файл;
  - принятие contentUri независимо от Wazzup type.
  После этого запускает получившийся server.runtime-v132.js.
*/

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SOURCE = path.join(ROOT, 'server.js');
const RUNTIME = path.join(ROOT, 'server.runtime-v132.js');

function fail(message) {
  console.error(`[v132] FATAL: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(SOURCE)) fail('server.js не найден.');

let src = fs.readFileSync(SOURCE, 'utf8');

if (!src.includes('ACTS_SMART_DIALOG_V129')) {
  fail('В server.js не найден ACTS_SMART_DIALOG_V129. Нужна текущая версия сервера.');
}

function replaceFunction(source, functionName, replacement) {
  const signature = `function ${functionName}(`;
  const asyncSignature = `async function ${functionName}(`;
  let start = source.indexOf(asyncSignature);
  if (start < 0) start = source.indexOf(signature);
  if (start < 0) fail(`не найдена функция ${functionName}`);

  const brace = source.indexOf('{', start);
  if (brace < 0) fail(`не найдена открывающая скобка ${functionName}`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = brace; i < source.length; i++) {
    const c = source[i];
    const n = source[i + 1];

    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = '';
      continue;
    }

    if (c === '/' && n === '/') { lineComment = true; i++; continue; }
    if (c === '/' && n === '*') { blockComment = true; i++; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }

    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(0, start) + replacement.trim() + source.slice(i + 1);
      }
    }
  }
  fail(`не найдена закрывающая скобка ${functionName}`);
}

const humanAnalyzer = String.raw`
// ACTS_HUMAN_FILE_REPLY_V132_RUNTIME
function actsHumanFileFallbackReply(fileName = '', messageText = '') {
  const joined = \`\${String(fileName || '')} \${String(messageText || '')}\`.toLowerCase();

  if (/диплом/.test(joined)) return 'Спасибо, диплом получили. Передали в работу.';
  if (/трудов/.test(joined)) return 'Спасибо, трудовую получили. Передали в работу.';
  if (/аттестат/.test(joined)) return 'Спасибо, аттестат получили. Передали в работу.';
  if (/поверк|калибров|средств.*измер/.test(joined)) return 'Спасибо, документы по поверке получили. Учтём их в комплекте.';
  if (/договор/.test(joined)) return 'Спасибо, договор получили. Передали в работу.';
  if (/сч[её]т|invoice/.test(joined)) return 'Спасибо, счёт получили. Передали в работу.';
  if (/плат[её]ж|платежк|квитанц/.test(joined)) return 'Спасибо, подтверждение оплаты получили. Передали в работу.';
  if (/паспорт/.test(joined)) return 'Спасибо, документ получили. Передали в работу.';
  if (/свидетельств/.test(joined)) return 'Спасибо, свидетельство получили. Передали в работу.';
  return 'Спасибо, файл получили. Передали в работу.';
}

async function actsAiAnalyzeIncomingFileHuman(buffer, fileName, contentType, messageText = '', deal = null, hasActiveControl = false) {
  const fallbackReply = actsHumanFileFallbackReply(fileName, messageText);
  const ai = resolveAiProvider();

  if (!ai.apiKey) {
    return {
      reply: fallbackReply,
      documentType: 'документ',
      confidence: 'low',
      isAct: false,
      isSignedAct: false,
      reason: 'AI key unavailable',
    };
  }

  let service = '';
  try { service = deal ? await resolveDealServiceName(deal) : ''; } catch (_) {}

  let docs = [];
  try {
    const list = getDocumentListForService(service || '');
    docs = Array.isArray(list && list.docs) ? list.docs.slice(0, 25) : [];
  } catch (_) {}

  const prompt = [
    'Ты сотрудник MAVIS GROUP и отвечаешь клиенту в обычной рабочей переписке.',
    'Клиент прислал файл. Сначала определи, что именно это за документ и зачем он может быть нужен в текущей сделке.',
    '',
    'ВАЖНО:',
    '1. НЕ считай любой файл актом.',
    '2. Упоминай акт только если сам файл действительно является актом выполненных работ/оказанных услуг либо клиент прямо пишет про акт.',
    '3. Если это другой документ — диплом, договор, счёт, платёжка, трудовая, аттестат, поверка, свидетельство, паспорт и т.п. — отвечай именно про этот документ.',
    '4. Никогда не пиши клиенту слова: проверка, классификация, ИИ, автоматизация, тестовая сделка, боевые действия, активный контроль.',
    '5. Не рассказывай внутреннюю механику.',
    '6. Если документ понятен и относится к работе — коротко подтверди получение.',
    '7. Если это подписанный акт — поблагодари и подтверди получение подписанного акта.',
    '8. Если это акт, но подпись не видна — мягко скажи, что файл получили, и попроси подписанный экземпляр.',
    '9. Если документ не удалось уверенно определить — просто: "Спасибо, файл получили. Передали в работу."',
    '10. Ответ должен звучать как живой внимательный сотрудник: 1–3 коротких предложения.',
    '11. Не обещай сроков и результата рассмотрения, которых нет в данных.',
    '',
    deal && deal.TITLE ? \`Сделка: \${String(deal.TITLE).slice(0, 300)}.\` : '',
    service ? \`Услуга: \${service}.\` : '',
    docs.length ? \`Ожидаемые документы по услуге: \${docs.join(' | ')}\` : '',
    \`Имя файла: \${fileName || 'без имени'}.\`,
    messageText ? \`Текст клиента вместе с файлом: \${String(messageText).slice(0, 1500)}\` : 'Текста клиента вместе с файлом нет.',
    hasActiveControl
      ? 'В системе может существовать контроль возврата акта, но клиенту нельзя упоминать его, если сам присланный файл не является актом.'
      : '',
    '',
    'Верни ТОЛЬКО JSON:',
    '{"documentType":"конкретный тип документа","confidence":"high|medium|low","isAct":true|false,"isSignedAct":true|false,"isRelevantToDeal":true|false|null,"reply":"готовый естественный ответ клиенту","reason":"кратко для внутреннего лога"}',
  ].filter(Boolean).join('\n');

  const ext = String(fileName || '').split('.').pop().toLowerCase();
  const isImage = ['jpg','jpeg','png','webp'].includes(ext) || /^image\//i.test(contentType || '');
  const isPdf = ext === 'pdf' || /^application\/pdf/i.test(contentType || '') || (buffer && buffer.subarray(0, 4).toString() === '%PDF');

  let content = prompt;

  if (buffer && isImage) {
    const mime = /^image\//i.test(contentType || '')
      ? String(contentType).split(';')[0]
      : (ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg');

    content = [
      { type: 'image_url', image_url: { url: \`data:\${mime};base64,\${buffer.toString('base64')}\` } },
      { type: 'text', text: prompt },
    ];
  } else if (buffer && isPdf) {
    content = [
      {
        type: 'file',
        file: {
          filename: fileName || 'document.pdf',
          file_data: \`data:application/pdf;base64,\${buffer.toString('base64')}\`,
        },
      },
      { type: 'text', text: prompt },
    ];
  }

  try {
    const response = await fetch(\`\${ai.baseUrl}/chat/completions\`, {
      method: 'POST',
      headers: {
        ...ai.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.aiModel,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content }],
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg = data && data.error && (data.error.message || data.error_description)
        ? (data.error.message || data.error_description)
        : \`HTTP \${response.status}\`;
      throw new Error(msg);
    }

    const raw = String(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '');
    const matched = raw.match(/\{[\s\S]*\}/);
    const obj = JSON.parse(matched ? matched[0] : raw || '{}');

    let reply = actsCleanText(obj.reply || '');
    const isAct = Boolean(obj.isAct);

    if (!reply) reply = fallbackReply;

    // Клиенту не показываем техническую внутреннюю лексику.
    if (/(классификац|автоматизац|тестов(ая|ой|ую|ое)|боев(ых|ые|ой)|активн(ый|ого)\s+контрол|искусственн.*интеллект|\bии\b)/i.test(reply)) {
      reply = fallbackReply;
    }

    // Если модель сама решила, что документ НЕ акт — слово "акт" в ответе запрещено.
    if (!isAct && /акт(?:а|ом|ы|е|у)?\b/i.test(reply)) {
      reply = fallbackReply;
    }

    return {
      reply: reply.slice(0, 1000),
      documentType: actsCleanText(obj.documentType || 'документ'),
      confidence: String(obj.confidence || 'low').toLowerCase(),
      isAct,
      isSignedAct: Boolean(obj.isSignedAct),
      isRelevantToDeal: obj.isRelevantToDeal === true ? true : obj.isRelevantToDeal === false ? false : null,
      reason: actsCleanText(obj.reason || ''),
    };
  } catch (e) {
    console.warn(\`[acts-dialog-test] v132 human file analysis failed: \${e.message || e}\`);
    return {
      reply: fallbackReply,
      documentType: 'документ',
      confidence: 'low',
      isAct: false,
      isSignedAct: false,
      reason: String(e.message || e),
    };
  }
}
`;

if (!src.includes('ACTS_HUMAN_FILE_REPLY_V132_RUNTIME')) {
  const anchor = 'function actsBuildSmartDialogTestFileReply(';
  const pos = src.indexOf(anchor);
  if (pos < 0) fail('не найден actsBuildSmartDialogTestFileReply для вставки v132.');
  src = src.slice(0, pos) + humanAnalyzer + '\n\n' + src.slice(pos);
}

// Ответ строится только из уже готового человеческого reply.
src = replaceFunction(src, 'actsBuildSmartDialogTestFileReply', String.raw`
function actsBuildSmartDialogTestFileReply(check, hasActiveControl) {
  const reply = actsCleanText(check && check.reply || '');
  if (reply) return reply;
  return actsHumanFileFallbackReply('', '');
}
`);

// Полностью заменяем файловую функцию Бобика, не трогая боевую actsProcessIncomingAttachments.
src = replaceFunction(src, 'actsProcessIncomingWazzupMessage', String.raw`
async function actsProcessIncomingWazzupMessage(msg) {
  const phone = normalizePhoneDigits((msg.contact && msg.contact.phone) || msg.chatId || '');
  const channel = String(msg.chatType || findChannelKeyByChannelId(msg.channelId) || 'messenger').toLowerCase();

  const rawType = String(msg.type || '').toLowerCase();
  const fallbackExt = rawType === 'image' ? '.jpg' : rawType === 'document' ? '.pdf' : '.bin';
  const fromUrl = actsIncomingFileNameFromUrl(msg.contentUri, '');
  const fallback = fromUrl || \`Входящий_файл_\${phone ? phone.slice(-4) : 'клиент'}_\${Date.now()}\${fallbackExt}\`;
  const downloaded = await actsDownloadIncomingUrl(msg.contentUri, fallback);

  console.log(\`[acts-incoming] Wazzup \${channel}: inbound \${downloaded.fileName}, phone=***\${phone.slice(-4)}, message=\${msg.messageId || '?'}, type=\${rawType || '-'}\`);

  // Боевая логика актов остаётся прежней и отдельно решает, является ли файл подписанным актом.
  const waitingBefore = await actsFindWaitingStatesByComm('PHONE', phone).catch(() => []);
  const result = await actsProcessIncomingAttachments({
    source: channel === 'viber' ? 'Viber' : channel === 'telegram' ? 'Telegram' : 'Wazzup',
    commType: 'PHONE',
    commValue: phone,
    messageText: msg.text || msg.caption || '',
    attachments: [downloaded],
    skipCompanyFolder: false,
  });

  // Мгновенный видимый тест только для Бобика.
  if (config.actsSmartDialogTestImmediateFileReply) {
    let testCtx =
      waitingBefore.find(
        (x) => String(x && x.state && x.state.dealId || '') === String(config.actsSmartDialogTestDealId || '')
      ) || null;

    if (!testCtx) {
      const resolved = await actsResolveSmartDialogTestDealByPhone(phone).catch(() => null);
      if (resolved) testCtx = { state: null, deal: resolved.deal };
    }

    if (testCtx && testCtx.deal) {
      const check = await actsAiAnalyzeIncomingFileHuman(
        downloaded.buffer,
        downloaded.fileName,
        downloaded.contentType || '',
        msg.text || msg.caption || '',
        testCtx.deal,
        Boolean(testCtx.state)
      );

      await actsSendSmartDialogTestFileReply({
        msg,
        phone,
        deal: testCtx.deal,
        check,
        hasActiveControl: Boolean(testCtx.state),
      }).catch((e) => console.warn(\`[acts-dialog-test] v132 file reply: \${e.message || e}\`));
    }
  }

  return result;
}
`);

// Wazzup иногда присылает file/прочий type. contentUri + известный канал + Wazzup host уже достаточны.
const oldSafeType = "  const type = String(msg.type || '').toLowerCase();\n  if (!['image', 'document'].includes(type)) return false;\n";
if (src.includes(oldSafeType)) {
  src = src.replace(oldSafeType, '');
}

// Все входящие contentUri-файлы идут в файловую обработку, независимо от строкового type.
src = src.split("if (!msg.contentUri || !['image','document'].includes(String(msg.type || '').toLowerCase())) continue;")
         .join("if (!msg.contentUri) continue;");

// Файл с подписью не должен параллельно трактоваться как отдельное текстовое сообщение.
src = src.split("if (msg.contentUri && ['image','document'].includes(String(msg.type || '').toLowerCase())) continue;")
         .join("if (msg.contentUri) continue;");

// Диагностика.
src = src.replace(
  'ТЕСТ БОБИКА: на входящий файл отправлен мгновенный осмысленный ответ.',
  'ТЕСТ БОБИКА v132: входящий файл обработан по смыслу документа; отправлен естественный ответ.'
);

src = src.replace(
  "reason: check && check.reason || '',",
  "reason: check && check.reason || '',\n      humanReply: check && check.reply || '',",
);

fs.writeFileSync(RUNTIME, src, 'utf8');

console.log('[startup] ACTS_HUMAN_FILE_REPLY_V132=ON; runtime server built.');
console.log(`[startup] v132 runtime file: ${path.basename(RUNTIME)}`);

require(RUNTIME);
