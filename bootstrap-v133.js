#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const SOURCE = path.join(ROOT, 'server.js');
const RUNTIME = path.join(ROOT, 'server.runtime-v133.js');

function log(msg) {
  console.log('[v133] ' + msg);
}

function warn(msg) {
  console.warn('[v133] ' + msg);
}

function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error('не найден стартовый якорь: ' + label);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error('не найден конечный якорь: ' + label);
  return source.slice(0, start) + replacement.trim() + '\n\n' + source.slice(end);
}

function replaceAllLiteral(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (!count) {
    warn('якорь не найден, пропускаю: ' + label);
    return source;
  }
  log(label + ': заменено ' + count);
  return source.split(from).join(to);
}

function startOriginalServer(reason) {
  warn('v133 не применён: ' + reason);
  warn('ЗАПУСКАЮ ИСХОДНЫЙ server.js — сервис не будет падать.');
  require(SOURCE);
}

if (!fs.existsSync(SOURCE)) {
  console.error('[v133] FATAL: server.js не найден.');
  process.exit(1);
}

let src = fs.readFileSync(SOURCE, 'utf8');

try {
  if (!src.includes('ACTS_SMART_DIALOG_V129')) {
    throw new Error('в server.js нет маркера ACTS_SMART_DIALOG_V129');
  }

  const humanAnalyzer = String.raw`
// ACTS_HUMAN_FILE_REPLY_V133_RUNTIME
function actsHumanFileFallbackReply(fileName, messageText) {
  const joined = (String(fileName || '') + ' ' + String(messageText || '')).toLowerCase();

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

async function actsAiAnalyzeIncomingFileHuman(buffer, fileName, contentType, messageText, deal, hasActiveControl) {
  const fallbackReply = actsHumanFileFallbackReply(fileName, messageText);
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
    '9. Если документ не удалось уверенно определить — просто поблагодари за файл и скажи, что передали в работу.',
    '10. Ответ должен звучать как живой внимательный сотрудник: 1–3 коротких предложения.',
    '11. Не обещай сроков и результата рассмотрения, которых нет в данных.',
    '',
    deal && deal.TITLE ? 'Сделка: ' + String(deal.TITLE).slice(0, 300) + '.' : '',
    service ? 'Услуга: ' + service + '.' : '',
    docs.length ? 'Ожидаемые документы по услуге: ' + docs.join(' | ') : '',
    'Имя файла: ' + (fileName || 'без имени') + '.',
    messageText ? 'Текст клиента вместе с файлом: ' + String(messageText).slice(0, 1500) : 'Текста клиента вместе с файлом нет.',
    hasActiveControl
      ? 'В системе может существовать контроль возврата акта, но клиенту нельзя упоминать его, если сам присланный файл не является актом.'
      : '',
    '',
    'Верни ТОЛЬКО JSON:',
    '{"documentType":"конкретный тип документа","confidence":"high|medium|low","isAct":true|false,"isSignedAct":true|false,"isRelevantToDeal":true|false|null,"reply":"готовый естественный ответ клиенту","reason":"кратко для внутреннего лога"}'
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
      { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + buffer.toString('base64') } },
      { type: 'text', text: prompt }
    ];
  } else if (buffer && isPdf) {
    content = [
      {
        type: 'file',
        file: {
          filename: fileName || 'document.pdf',
          file_data: 'data:application/pdf;base64,' + buffer.toString('base64')
        }
      },
      { type: 'text', text: prompt }
    ];
  }

  try {
    const raw = await callAiChatCompletion({
      model: config.aiModel,
      temperature: 0.2,
      messages: [{ role: 'user', content: content }]
    });

    const matched = String(raw || '').match(/\{[\s\S]*\}/);
    const obj = JSON.parse(matched ? matched[0] : String(raw || '{}'));

    let reply = actsCleanText(obj.reply || '');
    const isAct = Boolean(obj.isAct);

    if (!reply) reply = fallbackReply;

    if (/(классификац|автоматизац|тестов(ая|ой|ую|ое)|боев(ых|ые|ой)|активн(ый|ого)\s+контрол|искусственн.*интеллект|\bии\b)/i.test(reply)) {
      reply = fallbackReply;
    }

    if (!isAct && /акт(?:а|ом|ы|е|у)?\b/i.test(reply)) {
      reply = fallbackReply;
    }

    return {
      reply: reply.slice(0, 1000),
      documentType: actsCleanText(obj.documentType || 'документ'),
      confidence: String(obj.confidence || 'low').toLowerCase(),
      isAct: isAct,
      isSignedAct: Boolean(obj.isSignedAct),
      isRelevantToDeal: obj.isRelevantToDeal === true ? true : obj.isRelevantToDeal === false ? false : null,
      reason: actsCleanText(obj.reason || '')
    };
  } catch (e) {
    console.warn('[acts-dialog-test] v133 human file analysis failed: ' + (e.message || e));
    return {
      reply: fallbackReply,
      documentType: 'документ',
      confidence: 'low',
      isAct: false,
      isSignedAct: false,
      reason: String(e.message || e)
    };
  }
}
`;

  if (!src.includes('ACTS_HUMAN_FILE_REPLY_V133_RUNTIME')) {
    const anchor = 'function actsBuildSmartDialogTestFileReply(';
    const pos = src.indexOf(anchor);
    if (pos < 0) throw new Error('не найден actsBuildSmartDialogTestFileReply');
    src = src.slice(0, pos) + humanAnalyzer + '\n\n' + src.slice(pos);
    log('human analyzer: установлен');
  }

  src = replaceBetween(
    src,
    'function actsBuildSmartDialogTestFileReply(',
    'async function actsSendSmartDialogTestFileReply',
    String.raw`
function actsBuildSmartDialogTestFileReply(check, hasActiveControl) {
  const reply = actsCleanText(check && check.reply || '');
  if (reply) return reply;
  return actsHumanFileFallbackReply('', '');
}
`,
    'actsBuildSmartDialogTestFileReply'
  );
  log('natural reply builder: установлен');

  src = replaceBetween(
    src,
    'async function actsProcessIncomingWazzupMessage(msg) {',
    '// ======================= /v71: ВХОДЯЩИЕ СКАНЫ АКТОВ =========================',
    String.raw`
async function actsProcessIncomingWazzupMessage(msg) {
  const phone = normalizePhoneDigits((msg.contact && msg.contact.phone) || msg.chatId || '');
  const channel = String(msg.chatType || findChannelKeyByChannelId(msg.channelId) || 'messenger').toLowerCase();

  const rawType = String(msg.type || '').toLowerCase();
  const fallbackExt = rawType === 'image' ? '.jpg' : rawType === 'document' ? '.pdf' : '.bin';
  const fromUrl = actsIncomingFileNameFromUrl(msg.contentUri, '');
  const fallback = fromUrl || ('Входящий_файл_' + (phone ? phone.slice(-4) : 'клиент') + '_' + Date.now() + fallbackExt);
  const downloaded = await actsDownloadIncomingUrl(msg.contentUri, fallback);

  console.log('[acts-incoming] Wazzup ' + channel + ': inbound ' + downloaded.fileName + ', phone=***' + phone.slice(-4) + ', message=' + (msg.messageId || '?') + ', type=' + (rawType || '-'));

  const waitingBefore = await actsFindWaitingStatesByComm('PHONE', phone).catch(() => []);
  const result = await actsProcessIncomingAttachments({
    source: channel === 'viber' ? 'Viber' : channel === 'telegram' ? 'Telegram' : 'Wazzup',
    commType: 'PHONE',
    commValue: phone,
    messageText: msg.text || msg.caption || '',
    attachments: [downloaded],
    skipCompanyFolder: false
  });

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
        msg: msg,
        phone: phone,
        deal: testCtx.deal,
        check: check,
        hasActiveControl: Boolean(testCtx.state)
      }).catch((e) => console.warn('[acts-dialog-test] v133 file reply: ' + (e.message || e)));
    }
  }

  return result;
}
`,
    'actsProcessIncomingWazzupMessage'
  );
  log('Wazzup file handler: установлен');

  src = replaceBetween(
    src,
    'function wazzupWebhookSafeInboundFile(msg) {',
    'function wazzupWebhookMessageLogSummary(msg) {',
    String.raw`
function wazzupWebhookSafeInboundFile(msg) {
  if (!msg || msg.isEcho || String(msg.status || '').toLowerCase() !== 'inbound') return false;
  if (!msg.contentUri || !wazzupWebhookContentHostAllowed(msg.contentUri)) return false;
  return wazzupWebhookKnownChannel(msg);
}
`,
    'wazzupWebhookSafeInboundFile'
  );
  log('safe inbound contentUri: установлен');

  src = replaceAllLiteral(
    src,
    "if (!msg.contentUri || !['image','document'].includes(String(msg.type || '').toLowerCase())) continue;",
    "if (!msg.contentUri) continue;",
    'accept any Wazzup contentUri'
  );

  src = replaceAllLiteral(
    src,
    "if (msg.contentUri && ['image','document'].includes(String(msg.type || '').toLowerCase())) continue;",
    "if (msg.contentUri) continue;",
    'skip file from text dialog'
  );

  src = src.split('ТЕСТ БОБИКА: на входящий файл отправлен мгновенный осмысленный ответ.')
           .join('ТЕСТ БОБИКА v133: входящий файл обработан по смыслу документа; отправлен естественный ответ.');

  fs.writeFileSync(RUNTIME, src, 'utf8');

  const check = cp.spawnSync(process.execPath, ['--check', RUNTIME], {
    encoding: 'utf8'
  });

  if (check.status !== 0) {
    throw new Error('runtime syntax check failed: ' + String(check.stderr || check.stdout || '').slice(0, 1600));
  }

  log('server.runtime-v133.js syntax: OK');

  if (process.env.MAVIS_V133_BUILD_ONLY === '1') {
    log('BUILD_ONLY: готово');
    process.exit(0);
  }

  console.log('[startup] ACTS_HUMAN_FILE_REPLY_V133=ON; runtime server built and checked.');
  require(RUNTIME);

} catch (e) {
  startOriginalServer(e && e.message ? e.message : String(e));
}
