const express = require('express');
const path = require('path');
const helmet = require('helmet');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;

// Bitrix opens local apps in iframe. Disable frameguard but keep other sane defaults.
app.use(
  helmet({
    frameguard: false,
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function parseIdList(value) {
  return (value || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

const config = {
  leaderUserIds: parseIdList(process.env.LEADER_USER_IDS),
  adminUserIds: parseIdList(process.env.ADMIN_USER_IDS),
  ropUserIds: parseIdList(process.env.ROP_USER_IDS),
  productionCategoryId: process.env.PRODUCTION_CATEGORY_ID || '',
  // 0 or empty means: load all active deals via Bitrix pagination.
  maxDeals: Number(process.env.MAX_DEALS || 0),
  excludeClosedDeals: String(process.env.EXCLUDE_CLOSED_DEALS || 'true').toLowerCase() !== 'false',
  allowRopViewAll: String(process.env.ALLOW_ROP_VIEW_ALL || 'false').toLowerCase() === 'true',
  // Сколько сделок одновременно дозагружать по делам/задачам/комментариям.
  metaConcurrency: Number(process.env.META_CONCURRENCY || 3),
  // Сколько связанных сделок продаж одновременно открывать для уточнения менеджера в журнале ошибок.
  salesManagerConcurrency: Number(process.env.SALES_MANAGER_CONCURRENCY || 3),
  // Кому создавать задачи-эскалации по критическим проблемам. Если не задано — первый ID из LEADER_USER_IDS.
  escalationResponsibleId: process.env.ESCALATION_RESPONSIBLE_ID || '',
  // Кто должен быть наблюдателем в задачах-эскалациях. Если не задано — руководители + РОП.
  escalationAuditorIds: parseIdList(process.env.ESCALATION_AUDITOR_IDS || ''),
  // Важно для больших воронок: по умолчанию НЕ грузим метаданные по всем 400+ сделкам автоматически.
  // Иначе Bitrix получает сотни запросов и кабинет может висеть 10–20 минут.
  autoLoadMeta: String(process.env.AUTO_LOAD_META || 'false').toLowerCase() === 'true',
  // Если автоопределение поля “Услуга” на портале не сработает, сюда можно вписать код поля UF_CRM_...
  serviceFieldCode: process.env.SERVICE_FIELD_CODE || '',
  // v29: массовый ИИ-анализ проблемных сделок в кабинете руководителя.
  // По умолчанию анализируем только 5 сделок за запуск, чтобы не тратить кредиты и не перегружать API.
  managerAiLimit: Number(process.env.MANAGER_AI_LIMIT || 5),
  managerAiConcurrency: Number(process.env.MANAGER_AI_CONCURRENCY || 1),
  // v26: первый безопасный ИИ-анализ одной сделки. Ключ НЕ отдаётся в браузер.
  aiEnabled: String(process.env.AI_ENABLED || 'false').toLowerCase() === 'true',
  aiProvider: process.env.AI_PROVIDER || 'openai',
  aiModel: process.env.AI_MODEL || 'gpt-4o-mini',
  aiTemperature: Number(process.env.AI_TEMPERATURE || 0.2),
  // v26b: поддержка OpenAI-compatible VibeCode AI Router.
  // Для VibeCode: AI_PROVIDER=vibe, AI_BASE_URL=https://vibecode.bitrix24.tech/v1, AI_MODEL=bitrix/bitrixgpt-5.5.
  aiBaseUrl: process.env.AI_BASE_URL || '',
  // Необязательно: ручная карта стадий в формате JSON, если портал не отдаёт названия стадий через API.
  // Пример: {"C28:UC_MIFXBB":"2. Сбор информации"}
  stageMap: (() => { try { return JSON.parse(process.env.STAGE_MAP_JSON || '{}'); } catch (_) { return {}; } })(),

  // v36-v38: отправка перечней клиенту. Секреты Wazzup не отдаём в браузер.
  emailFrom: process.env.EMAIL_FROM || '',
  emailSenderName: process.env.EMAIL_SENDER_NAME || 'MAVIS GROUP',
  wazzupApiConfigured: Boolean(process.env.WAZZUP_API_KEY),
  wazzupViberConfigured: Boolean(process.env.WAZZUP_API_KEY && process.env.WAZZUP_VIBER_CHANNEL_ID),
  wazzupChannelConfigured: Boolean(process.env.WAZZUP_CHANNEL_ID || process.env.WAZZUP_TG_CHANNEL_ID || process.env.WAZZUP_TELEGRAM_CHANNEL_ID || process.env.WAZZUP_VIBER_CHANNEL_ID),
  wazzupChatType: process.env.WAZZUP_CHAT_TYPE || 'whatsapp',
  wazzupChannels: [
    process.env.WAZZUP_TG_CHANNEL_ID || process.env.WAZZUP_TELEGRAM_CHANNEL_ID ? { key: 'telegram', label: 'Telegram', chatType: process.env.WAZZUP_TG_CHAT_TYPE || process.env.WAZZUP_TELEGRAM_CHAT_TYPE || 'telegram', channelId: process.env.WAZZUP_TG_CHANNEL_ID || process.env.WAZZUP_TELEGRAM_CHANNEL_ID } : null,
    process.env.WAZZUP_VIBER_CHANNEL_ID ? { key: 'viber', label: 'Viber', chatType: process.env.WAZZUP_VIBER_CHAT_TYPE || 'viber', channelId: process.env.WAZZUP_VIBER_CHANNEL_ID } : null,
    process.env.WAZZUP_CHANNEL_ID ? { key: 'default', label: process.env.WAZZUP_CHANNEL_LABEL || 'Wazzup', chatType: process.env.WAZZUP_CHAT_TYPE || 'whatsapp', channelId: process.env.WAZZUP_CHANNEL_ID } : null,
  ].filter(Boolean).map((ch) => ({ key: ch.key, label: ch.label, chatType: ch.chatType, configured: Boolean(ch.channelId) })),
  wazzupEnabled: Boolean(process.env.WAZZUP_API_KEY && (process.env.WAZZUP_CHANNEL_ID || process.env.WAZZUP_TG_CHANNEL_ID || process.env.WAZZUP_TELEGRAM_CHANNEL_ID || process.env.WAZZUP_VIBER_CHANNEL_ID)),

  // v43: тестовый режим ассистента-исполнителя на одной сделке.
  executorMode: String(process.env.EXECUTOR_MODE || 'false').toLowerCase() === 'true',
  executorTestDealId: process.env.EXECUTOR_TEST_DEAL_ID || '',
  executorAllDeals: String(process.env.EXECUTOR_ALL_DEALS || 'false').toLowerCase() === 'true',
  executorExpertId: process.env.EXECUTOR_EXPERT_ID || '',
  executorLeaderId: process.env.EXECUTOR_LEADER_ID || process.env.EXECUTOR_EXPERT_ID || '',
  executorProduct: process.env.EXECUTOR_PRODUCT || 'attestation',
  preferredContactFieldCode: process.env.PREFERRED_CONTACT_FIELD_CODE || '',
  callTranscriptionEnabled: String(process.env.CALL_TRANSCRIPTION_ENABLED || 'false').toLowerCase() === 'true',
  transcribeProvider: process.env.TRANSCRIBE_PROVIDER || process.env.AI_PROVIDER || 'vibe',
  transcribeModel: process.env.TRANSCRIBE_MODEL || 'bitrix/deepdml/faster-whisper-large-v3-turbo-ct2',
  transcribeSendModel: String(process.env.TRANSCRIBE_SEND_MODEL || 'true').toLowerCase() !== 'false',
  transcribeBaseUrl: process.env.TRANSCRIBE_BASE_URL || process.env.AI_BASE_URL || '',

  // v54: живой бот в Wazzup-чате. BITRIX_WEBHOOK_URL — входящий вебхук Bitrix (создаётся в
  // разделе "Разработчикам" → "Входящий вебхук"), нужен серверу для работы с Bitrix без открытого
  // браузера (вебхук от Wazzup может прийти в любой момент, когда никто не открыл Bitrix).
  bitrixWebhookUrl: (process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, ''),
  // Только этот номер телефона обрабатывается живым ботом — пилотная сделка 34946.
  liveChatTestPhone: process.env.LIVE_CHAT_TEST_PHONE || '',
  liveChatTestDealId: process.env.LIVE_CHAT_TEST_DEAL_ID || process.env.EXECUTOR_TEST_DEAL_ID || '',
  // Wazzup присылает Authorization: Bearer {crmKey}, если crmKey задан в их настройках интеграции.
  // Если задан и здесь — сверяем заголовок, чтобы отбросить случайные/чужие запросы на вебхук.
  wazzupCrmKey: process.env.WAZZUP_CRM_KEY || '',
  liveChatEnabled: String(process.env.LIVE_CHAT_ENABLED || 'false').toLowerCase() === 'true',
  autopilotEnabled: String(process.env.AUTOPILOT_ENABLED || 'false').toLowerCase() === 'true',
  autopilotCategoryId: Number(process.env.AUTOPILOT_CATEGORY_ID || 28),
};

// Прямой вызов Bitrix REST через входящий вебхук — нужен, потому что вебхук Wazzup может прийти,
// когда никто не открыл Bitrix в браузере (там работа идёт через BX24.callMethod, что недоступно
// здесь). Используется только живым ботом (вебхук-обработчик), не основным приложением.
async function bitrixRestCall(method, params = {}) {
  if (!config.bitrixWebhookUrl) throw new Error('BITRIX_WEBHOOK_URL не задан в Render Environment — без него сервер не может сам обращаться к Bitrix.');
  const response = await fetch(`${config.bitrixWebhookUrl}/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const msg = data && (data.error_description || data.error) ? `${data.error}: ${data.error_description || ''}` : `HTTP ${response.status}`;
    throw new Error(`Bitrix REST ${method}: ${msg}`);
  }
  return data.result;
}

async function bitrixRestList(method, params = {}, limit = 200) {
  const out = [];
  const seenIds = new Set();
  let start = 0;
  for (;;) {
    const page = await bitrixRestCall(method, { ...params, start });
    const items = Array.isArray(page) ? page : (page && page.items) || [];
    // Дедупликация по полю ID — Bitrix иногда возвращает одни и те же записи
    // при пагинации (особенно при малом числе результатов).
    let newItems = 0;
    for (const item of items) {
      const id = item && (item.ID || item.id);
      if (id && seenIds.has(String(id))) continue;
      if (id) seenIds.add(String(id));
      out.push(item);
      newItems++;
    }
    // Останавливаемся если: пришёл не массив, пришло 0 новых элементов,
    // или меньше 50 (стандартный размер страницы Bitrix) — значит это последняя страница.
    if (!Array.isArray(page) || newItems === 0 || items.length < 50 || out.length >= limit) break;
    start += items.length;
  }
  return out.slice(0, limit);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mavis-bitrix-expert-assistant' });
});

app.get('/config.js', (_req, res) => {
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify(config)};`);
});


function clipText(value, max = 28000) {
  const text = String(value || '');
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[текст обрезан из-за технического лимита]';
}

function safeJsonParse(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (_) {}
  }
  const first = String(text).indexOf('{');
  const last = String(text).lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(String(text).slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

function normalizeAiResult(parsed, rawText) {
  const fallback = rawText || 'ИИ вернул пустой ответ.';
  const obj = parsed && typeof parsed === 'object' ? parsed : {};
  const arr = (v) => Array.isArray(v) ? v.map((x) => String(x || '').trim()).filter(Boolean) : [];
  const tasks = Array.isArray(obj.tasks) ? obj.tasks.map((t) => ({
    title: String(t.title || '').trim(),
    responsible: String(t.responsible || 'expert').trim(),
    deadline_hint: String(t.deadline_hint || '').trim(),
    description: String(t.description || '').trim(),
  })).filter((t) => t.title) : [];
  const stageDecisionRaw = obj.stage_decision && typeof obj.stage_decision === 'object' ? obj.stage_decision : {};
  const stage_decision = {
    should_move: Boolean(stageDecisionRaw.should_move),
    target_stage_hint: String(stageDecisionRaw.target_stage_hint || '').trim(),
    reason: String(stageDecisionRaw.reason || '').trim(),
  };
  return {
    status: ['ok','partial','risk','error'].includes(obj.status) ? obj.status : 'partial',
    status_label: String(obj.status_label || 'нужна проверка эксперта'),
    summary: arr(obj.summary).length ? arr(obj.summary) : [fallback],
    missing: arr(obj.missing),
    risks: arr(obj.risks),
    next_steps: arr(obj.next_steps),
    tasks,
    client_message: String(obj.client_message || '').trim(),
    comment: String(obj.comment || '').trim(),
    stage_decision,
    raw_text: rawText,
  };
}

function resolveAiProvider() {
  const provider = String(config.aiProvider || 'openai').toLowerCase().trim();
  const apiKey = process.env.AI_API_KEY || process.env.VIBE_API_KEY || process.env.OPENAI_API_KEY || '';
  if (provider === 'vibe' || provider === 'vibecode' || provider === 'bitrix') {
    return {
      provider: 'vibe',
      label: 'VibeCode AI Router',
      apiKey,
      baseUrl: (config.aiBaseUrl || process.env.VIBE_BASE_URL || 'https://vibecode.bitrix24.tech/v1').replace(/\/$/, ''),
      authHeader: { Authorization: `Bearer ${apiKey}` },
    };
  }
  return {
    provider: 'openai',
    label: 'OpenAI API',
    apiKey,
    baseUrl: (config.aiBaseUrl || 'https://api.openai.com/v1').replace(/\/$/, ''),
    authHeader: { Authorization: `Bearer ${apiKey}` },
  };
}



function productAiGuidance(productRaw, scenarioRaw = '') {
  const product = productRaw && typeof productRaw === 'object' ? productRaw : {};
  const key = String(product.key || 'general');
  const label = String(product.label || 'услуга');
  const scenario = String(scenarioRaw || 'deal_analyze');

  const common = [
    'Общие правила для всех продуктов MAVIS GROUP:',
    '1. Разделяй факты, которые прямо есть в данных, и предположения. Всё спорное выноси в missing или risks как “нужно подтвердить”.',
    '2. Не обещай клиенту сроки, если в сделке/комментариях нет подтверждённой даты. Пиши “после получения документов/оплаты сроки могут быть уточнены”.',
    '3. Если нет следующего дела/задачи — обязательно предложи задачу эксперту с ближайшим контрольным дедлайном.',
    '4. Если проблема относится к передаче из продаж — укажи задачу менеджеру и отдельно короткий пункт для РОП/руководителя.',
    '5. Черновик клиенту должен быть спокойным, человеческим, без внутренних формулировок “ошибка менеджера”, “просрочка эксперта”, “эскалация”.',
    '6. Для задач используй responsible: expert, manager или leader. Не выдумывай ФИО ответственного, если его нет в контексте.',
    '7. Не делай юридически значимые выводы и не утверждай, что документ точно примут органом, если это не подтверждено экспертом.',
  ];

  const guides = {
    stk: [
      'Продукт: СТК / СПК / свидетельство технической компетентности.',
      'Обязательно проверяй: область технической компетентности, виды работ, наличие специалистов под область, оборудование, средства измерений, поверку/калибровку/аренду/право использования СИ, перечень копий, счета/пошлины, дату подачи/выезда, замечания органа.',
      'Если нет данных по специалистам или СИ — это критичный риск, а не просто уточнение.',
      'Если не указано, предупреждал ли менеджер о пошлинах/дополнительных счетах — это риск конфликта по оплате.',
      'В клиентском сообщении проси подтвердить область работ, ответственного, документы по специалистам/оборудованию/СИ и оплату обязательных счетов, если они выставлены.',
    ],
    stk_periodic: [
      'Продукт: периодика / подтверждение СТК.',
      'Обязательно проверяй: действующее СТК, срок окончания/подтверждения, актуальную область, изменения по специалистам, оборудованию и СИ с прошлого подтверждения, перечень актуальных копий, счета/пошлины.',
      'Если клиент не сообщил изменения — нельзя считать, что изменений нет; нужно запросить подтверждение.',
      'Риск: пропуск срока периодики/подтверждения, устаревшие СИ, изменения в специалистах или оборудовании.',
      'В клиентском сообщении проси действующее СТК, подтверждение актуальности области/специалистов/оборудования/СИ и документы по перечню эксперта.',
    ],
    company_attestation: [
      'Продукт: аттестация организации / аттестация компании / категория.',
      'Обязательно проверяй: нужную категорию, виды работ, требования к специалистам, документы компании, опыт/объекты/договоры, оплату, обещанные сроки.',
      'Если категория или виды работ не подтверждены — риск подготовки неверного пакета документов.',
      'Если не хватает специалистов — фиксируй риск отказа/замечаний и задачу эксперту/менеджеру уточнить, кто есть и кого нужно подобрать/перевести.',
      'В клиентском сообщении проси подтвердить категорию/виды работ и передать документы компании и специалистов по перечню.',
    ],
    specialist_attestation: [
      'Продукт: аттестация специалиста.',
      'Обязательно проверяй: ФИО специалиста, должность, образование, стаж, текущее место работы, подходит ли должность и строительная компания для зачёта стажа, наличие действующей аттестации организации, дату экзамена/подачи, фото/заявление/формы, оплату.',
      'Если образование непрофильное или стаж не подтверждён — фиксируй как риск отказа/переноса, а не как обычное уточнение.',
      'Не утверждай, что специалист подходит, если в данных нет образования/стажа/должности.',
      'В клиентском сообщении проси документы специалиста, подтверждение должности/стажа/образования и желаемый срок аттестации/экзамена.',
    ],
    iso: [
      'Продукт: ISO / СУОТ / охрана труда / ISO 9001 / ISO 45001.',
      'Обязательно проверяй: какой стандарт нужен, цель сертификата (тендер, объект, контрагент, внутренний запрос), срочность, виды деятельности, численность, процессы/структуру компании, наличие действующей системы/документов, необходимость аудита/проверки, оплату.',
      'Если неясна цель сертификата — риск выбрать неверный стандарт/маршрут.',
      'Если срок связан с тендером — выделяй риск срыва срока и задачу срочно подтвердить дату, к которой нужен сертификат.',
      'В клиентском сообщении проси подтвердить стандарт, цель, срок, данные по компании, видам деятельности, штату и процессам.',
    ],
    recruiting: [
      'Продукт: подбор специалиста.',
      'Обязательно проверяй: кого ищем, квалификацию, документы/аттестации, регион, формат занятости, срок выхода, условия оплаты/оформления/перевода, кто ЛПР, ищет ли клиент сам параллельно.',
      'Если нет требований к специалисту или быстрого ЛПР — риск зависания подбора.',
      'Если клиент ищет сам параллельно — поставь задачу на регулярный контроль, чтобы не потерять сделку.',
      'В клиентском сообщении проси подтвердить требования к специалисту, сроки, формат, условия и порядок обратной связи по кандидатам.',
    ],
    general: [
      `Продукт не распознан точно. Текущая услуга: ${label}.`,
      'Не пытайся подставить правила конкретного продукта, если услуга не распознана. Сначала предложи уточнить состав услуги, ожидаемый результат, документы, оплату, сроки и ответственного со стороны клиента.',
      'В задачах обязательно поставь эксперту уточнить продуктовую логику и перечень документов.',
    ],
  };

  const scenarioHints = {
    handoff: [
      'Фокус сценария: качество передачи из продаж. Отдельно выдели, какие пункты должен исправить менеджер, какие эксперт может уточнить у клиента, а какие нужно передать РОП/руководителю.',
      'Не называй ошибкой то, что найдено косвенно: такие пункты помечай “нужно подтвердить”.',
    ],
    workplan: [
      'Фокус сценария: ход работы. Сформируй не общий пересказ, а маршрут: что делает MAVIS, что делает клиент, контрольные точки, следующий шаг и задачи.',
      'Черновик клиенту должен быть готовым к отправке после проверки экспертом.',
    ],
    documents: [
      'Фокус сценария: документы. Сверяй документы только по доступным названиям/упоминаниям. Если содержимое файла не прочитано — пиши “проверить вручную”, а не “документ подходит”.',
    ],
    manager_deal: [
      'Фокус сценария: руководитель/РОП. Пиши кратко: проблема, причина, риск, ответственный, 1–3 действия. Не уходи в длинные клиентские формулировки.',
    ],
    deal_analyze: [
      'Фокус сценария: общий анализ сделки. Сначала дай управленческий статус, затем пробелы, риски и действия.',
    ],
    executor_attestation_call: [
      'Ты — Игорь, ИИ-ассистент производственного отдела MAVIS GROUP. Пиши сообщение от лица компании, не упоминая себя и своё имя.',
      '',
      'ПРИОРИТЕТ ИНФОРМАЦИИ: звонок > комментарии менеджера > поля сделки. Имя клиента бери только из звонка — только личное имя (Александр, Юлия и т.д.). Никогда не используй название компании или полное ФИО как обращение. Если в звонке нет чёткого личного имени (только номер телефона, название компании, или непонятно) — начинай сообщение без обращения: просто "Добрый день!".',
      '',
      'БАЗА ЗНАНИЙ (используй при анализе, не объясняй клиенту):',
      '- СПК: нужны 2 аттестованных специалиста по основному месту работы. Совместитель — дополнительно. Орган: БИСП или Стройкомплекс.',
      '- АТТ СМР: руководитель (высшее строительное + стаж ≥5 лет) + ГИ (аттестованный). Подача бумажная в Белстройцентр.',
      '- ИСО/СУОТ: комиссия из 3 человек (один директор), бриф, пошлина до пятницы перед выездом.',
      '- АТТ специалиста: диплом + трудовая + 2 фото 3x4. Ориентир по экзамену — в течение месяца.',
      '- Если специалистов НЕТ/ИЩУТ — описывай требования к кандидатам (должность, образование, стаж, нужен ли аттестат), не проси документы на несуществующих людей.',
      '- Директор может закрывать должность прораба/ГИ через запись в трудовой книжке.',
      '',
      'ДЕДЛАЙНЫ: сначала смотри в поля сделки и комментарии менеджера. Если дат нет — считай сам от даты звонка (+2 рабочих дня на документы, +3 рабочих дня на оплаты). Выходные (сб, вс) пропускай при расчёте — если дедлайн падает на выходной, сдвигай на понедельник.',
      '',
      'ФОРМАТ client_message (строго):',
      '1. "[Имя из звонка], добрый день!" — никаких упоминаний себя, компании, мессенджера',
      '2. 1-2 предложения что уже понятно/есть (специалисты, СИ, что в порядке)',
      '3. Блок "**От вас:**" — нумерованный список конкретных действий с датами. Каждый пункт: "До [дата] — [что сделать]". Выходные учитывай.',
      '4. Блок "**С нашей стороны:**" — нумерованный список что делаем мы пошагово (проверяем специалистов, сверяем СИ, готовим документы, заказываем счета, подаём заявку и т.д.)',
      '5. Строка: "**Все документы присылайте на почту: mavis.group@mail.ru**" (жирный шрифт, без точки в конце)',
      '6. Последняя строка: "Мы всегда на связи — дополнительно свяжемся с вами [дата через 2 рабочих дня], чтобы зафиксировать всё по документам."',
      '',
      'После сообщения клиенту — отдельным блоком добавь перечень документов из context.document_list.docs (текстом, нумерованный список с заголовком "Перечень документов для [услуга]:"). Если услуга СПК — добавь под перечнем раздел "Средства измерений:" со списком нужных СИ.',
      '',
      'comment — для эксперта (3-5 строк): что выяснил из звонка, схема специалистов (кто есть/кого нет/кого ищем), что нужно от клиента, что делаем дальше.',
      '',
      'JSON с двумя полями: client_message (сообщение + перечень документов текстом в конце) и comment.',
    ],
  };

  return [...common, ...(guides[key] || guides.general), ...(scenarioHints[scenario] || scenarioHints.deal_analyze)].join('\n');
}

function aiScenarioConfig(scenarioRaw) {
  const scenario = String(scenarioRaw || 'deal_analyze').trim();
  const map = {
    deal_analyze: {
      label: 'ИИ-анализ сделки',
      instruction: 'Дай общий управленческий и экспертный анализ сделки: что понятно, чего не хватает, риски, следующие действия, задачи, черновик сообщения клиенту и комментарий в сделку.'
    },
    handoff: {
      label: 'ИИ-проверка передачи',
      instruction: 'Проверь качество передачи сделки из продаж в производство. Сравни производственную сделку и связанную сделку продаж. Особое внимание: услуга/товары, КП/состав/цена, город, специалисты, сроки и срочность, email и канал связи, пошлины/дополнительные счета, средства измерений, обещания менеджера, следующий шаг. Раздели вывод на: найдено точно, нужно подтвердить, не найдено/ошибки передачи, риски, что должен исправить менеджер, что должен сделать эксперт.'
    },
    workplan: {
      label: 'ИИ-ход работы',
      instruction: 'Сформируй ход работы по сделке для эксперта. Нужно: действия MAVIS GROUP, действия клиента, что уточнить, дедлайны/контрольные точки, риски сдвига сроков, черновик сообщения клиенту человеческим языком, комментарий в сделку, рекомендуемые задачи. Не обещай клиенту сроки, если они не указаны в данных.'
    },
    documents: {
      label: 'ИИ-проверка документов',
      instruction: 'Проверь входящие документы и данные по продуктовому чек-листу. Используй названия файлов, комментарии, дела, поля сделки и предварительную алгоритмическую сверку, если она есть в контексте. Раздели результат на: что найдено, что нужно открыть и проверить вручную, чего не хватает, какие риски, что запросить у клиента, задачи эксперту.'
    },
    manager_deal: {
      label: 'ИИ-анализ проблемной сделки для руководителя',
      instruction: 'Проанализируй проблемную производственную сделку глазами руководителя/РОП. Дай краткий управленческий вывод: почему сделка попала в проблемные, что мешает движению, кто должен сделать следующий шаг (эксперт/менеджер/руководитель), какие риски по клиенту и срокам, какие 1-3 действия нужно поставить в работу. Не пиши длинно; результат нужен для планёрки и контроля.'
    },
    executor_attestation_call: {
      label: 'Автопилот АТТ: анализ первичного звонка',
      instruction: 'Ты ассистент-исполнитель по сделке аттестации организации. На основании сделки, КП/комментариев и расшифровки первичного звонка сформируй рабочий маршрут исполнения. Обязательно: 1) кратко что понял из передачи и звонка; 2) схема специалистов: директор/руководитель, ГИ, прораб/мастер по видам работ, кого переводим/аттестуем/подбираем; 3) какие данные отсутствуют; 4) ход работы для клиента; 5) сообщение клиенту; 6) комментарий Кристине; 7) список ВНУТРЕННИХ дел/задач с ответственными expert|manager|leader и дедлайнами (никогда задач "для клиента"); 8) этап по ЛК Белстройцентра: запрос письма/ссылки, регистрация/заявка, номер заявки или остановка при капче/ошибке; 9) решение по стадии сделки в Bitrix: двигать дальше по воронке или оставить как есть, с понятной причиной.'
    },
    live_chat_classify: {
      label: 'Живой бот: классификатор безопасности входящего сообщения',
      instruction: 'Ты классификатор безопасности для автоответчика в чате с клиентом по сделке аттестации. Тебе дают историю переписки и новое входящее сообщение клиента. Определи: можно ли ассистенту ответить клиенту полностью автоматически, без участия живого человека (эксперта). ОТВЕЧАЙ "needs_human" (нужен живой человек), если сообщение содержит: жалобу, недовольство, конфликт, спор о цене или условиях, угрозу отказа/возврата, любую эмоционально напряжённую или чувствительную тему, юридический вопрос, запрос скидки, или вопрос, который не связан с текущим этапом сделки и на который нет явного ответа в контексте сделки. ОТВЕЧАЙ "safe_auto_reply" только если это конкретный фактический вопрос или ответ по ходу сделки (статус, что делать дальше, подтверждение данных, ответ на вопрос ассистента типа "есть ли у вас личный кабинет"), на который есть однозначный ответ из контекста сделки. При любой неопределённости — выбирай needs_human, лучше лишний раз позвать человека, чем дать клиенту неверный или неуместный автоматический ответ.'
    },
    live_chat_reply: {
      label: 'Живой бот: автоответ клиенту',
      instruction: 'Ты ассистент-исполнитель, который ведёт переписку с клиентом по сделке аттестации от имени MAVIS GROUP. Тебе дан полный контекст сделки (звонок, поля, история переписки) и новое сообщение клиента, которое уже проверено как безопасное для автоответа. Напиши короткий, человечный, деловой ответ клиенту по существу его сообщения. НИКОГДА не упоминай название конкретного мессенджера (Viber/Telegram/WhatsApp) в ответе. Не придумывай факты, которых нет в контексте сделки — если чего-то не знаешь, честно скажи, что уточнишь, и не отвечай вместо того, чтобы это вызвало needs_human на классификаторе. Тон — спокойный, доброжелательный, без канцелярита.'
    },
  };
  return { scenario, ...(map[scenario] || map.deal_analyze) };
}

async function callAiChatCompletion({ model, temperature, messages }) {
  const ai = resolveAiProvider();
  if (!ai.apiKey) {
    if (ai.provider === 'vibe') throw new Error('AI_API_KEY не задан. Для VibeCode вставь vibe_api... в Render Environment как AI_API_KEY.');
    throw new Error('AI_API_KEY не задан в Render Environment');
  }

  const response = await fetch(`${ai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      ...ai.authHeader,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data && data.error && data.error.message ? data.error.message : `HTTP ${response.status}`;
    throw new Error(`${ai.label}: ${msg}`);
  }
  return data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
}

app.post('/api/ai/analyze-deal', async (req, res) => {
  try {
    if (!config.aiEnabled) {
      res.status(400).json({ ok: false, error: 'ИИ пока выключен. Добавь AI_ENABLED=true и AI_API_KEY в Render Environment.' });
      return;
    }
    const allowedAiProviders = ['openai', 'vibe', 'vibecode', 'bitrix'];
    if (!allowedAiProviders.includes(String(config.aiProvider || '').toLowerCase())) {
      res.status(400).json({ ok: false, error: `Провайдер ${config.aiProvider} не поддерживается. Используй AI_PROVIDER=vibe или AI_PROVIDER=openai.` });
      return;
    }

    const payload = req.body || {};
    const scenarioCfg = aiScenarioConfig(payload.scenario);
    const productGuidance = productAiGuidance(payload.context && payload.context.product, scenarioCfg.scenario);
    const context = clipText(JSON.stringify(payload.context || {}, null, 2), 30000);
    const system = `Ты ИИ-ассистент эксперта производства MAVIS GROUP. Работаешь только как внутренний помощник эксперта, РОП и руководителя. Нельзя обещать клиенту сроки, гарантии или юридически значимые выводы, если их нет в данных. Клиенту ничего не отправляешь автоматически. Возвращай только валидный JSON без markdown.`;
    const isExecutorCall = scenarioCfg.scenario === 'executor_attestation_call';
    const jsonSchema = isExecutorCall
      ? `{"client_message": "первое сообщение клиенту (3-6 предложений): обращение, что обсудили, что нужно от клиента, что делаем мы", "document_message": "второе отдельное сообщение: полный перечень документов ИЛИ требования к специалистам если их нет в штате", "comment": "для эксперта в Bitrix (3-5 строк): что выяснил, схема специалистов, что нужно, что делаем"}`
      : `{"status":"ok|partial|risk|error","status_label":"короткий статус по-русски","summary":["что понятно / найдено по сценарию"],"missing":["чего не хватает / что нужно уточнить"],"risks":["риски"],"next_steps":["следующие действия"],"tasks":[{"title":"название","responsible":"expert|manager|leader","deadline_hint":"когда","description":"что сделать"}],"client_message":"черновик сообщения клиенту или пустая строка","comment":"короткий комментарий в сделку","stage_decision":{"should_move":false,"target_stage_hint":"","reason":""}}`;

    const user = `${scenarioCfg.label}.

Задача:
${scenarioCfg.instruction}

Продуктовые правила и ограничения MAVIS GROUP:
${productGuidance}

Контекст сделки:
${context}

Верни JSON по схеме:
${jsonSchema}`;

    const rawText = await callAiChatCompletion({
      model: config.aiModel,
      temperature: Number.isFinite(config.aiTemperature) ? config.aiTemperature : 0.2,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const parsed = safeJsonParse(rawText);
    res.json({ ok: true, provider: config.aiProvider, model: config.aiModel, scenario: scenarioCfg.scenario, scenario_label: scenarioCfg.label, result: normalizeAiResult(parsed, rawText) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});


function normalizeWazzupPhone(value) {
  // Wazzup для phone/chatId требует только цифры без плюса, пробелов и скобок.
  // Старые версии отправляли +375..., из-за этого Telegram/Wazzup мог возвращать Message data is invalid / HTTP 500.
  const digits = String(value || '').replace(/\D/g, '');
  return digits || '';
}

function normalizeWazzupUsername(value) {
  const text = String(value || '').trim().replace(/^@/, '');
  // username Telegram не может быть названием компании с пробелами/кавычками.
  return /^[A-Za-z0-9_]{5,32}$/.test(text) ? text : '';
}

function compactWazzupError(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  const parts = [];
  if (data.error) parts.push(String(data.error));
  if (data.description) parts.push(String(data.description));
  if (data.message) parts.push(String(data.message));
  if (data.data && data.data.fields) parts.push(`fields: ${JSON.stringify(data.data.fields)}`);
  if (data.requestId) parts.push(`requestId: ${data.requestId}`);
  return parts.filter(Boolean).join(' | ') || fallback;
}

function getConfiguredWazzupChannel(channelKey) {
  const key = String(channelKey || '').trim().toLowerCase();
  const channels = {
    telegram: {
      key: 'telegram',
      label: 'Telegram',
      channelId: process.env.WAZZUP_TG_CHANNEL_ID || process.env.WAZZUP_TELEGRAM_CHANNEL_ID || '',
      chatType: process.env.WAZZUP_TG_CHAT_TYPE || process.env.WAZZUP_TELEGRAM_CHAT_TYPE || 'telegram',
    },
    viber: {
      key: 'viber',
      label: 'Viber',
      channelId: process.env.WAZZUP_VIBER_CHANNEL_ID || '',
      chatType: process.env.WAZZUP_VIBER_CHAT_TYPE || 'viber',
    },
    default: {
      key: 'default',
      label: process.env.WAZZUP_CHANNEL_LABEL || 'Wazzup',
      channelId: process.env.WAZZUP_CHANNEL_ID || '',
      chatType: process.env.WAZZUP_CHAT_TYPE || 'whatsapp',
    },
  };
  if (key && channels[key] && channels[key].channelId) return channels[key];
  if (channels.telegram.channelId) return channels.telegram;
  if (channels.viber.channelId) return channels.viber;
  if (channels.default.channelId) return channels.default;
  return null;
}

function publicWazzupChannelList() {
  return ['telegram', 'viber', 'default']
    .map((key) => getConfiguredWazzupChannel(key))
    .filter(Boolean)
    .map((ch) => ({ key: ch.key, label: ch.label, chatType: ch.chatType, configured: true }));
}

// Определяем, какому из НАШИХ настроенных каналов (telegram/viber/default) соответствует
// channelId, присланный Wazzup во входящем сообщении — чтобы отвечать клиенту тем же каналом,
// которым он сам написал, а не жёстко одним и тем же каналом всегда.
function findChannelKeyByChannelId(channelId) {
  for (const key of ['telegram', 'viber', 'default']) {
    const ch = getConfiguredWazzupChannel(key);
    if (ch && ch.channelId && String(ch.channelId) === String(channelId)) return key;
  }
  return null;
}


app.get('/api/wazzup/channels', async (_req, res) => {
  try {
    const apiKey = process.env.WAZZUP_API_KEY || '';
    const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
    if (!apiKey) {
      res.status(400).json({ ok: false, error: 'WAZZUP_API_KEY не задан в Render Environment.' });
      return;
    }

    const response = await fetch(`${baseUrl}/channels`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data && (data.description || data.error || data.message) ? (data.description || data.error || data.message) : `HTTP ${response.status}`;
      res.status(response.status).json({ ok: false, error: `Wazzup: ${message}`, data });
      return;
    }

    const source = Array.isArray(data) ? data : Array.isArray(data && data.data) ? data.data : Array.isArray(data && data.channels) ? data.channels : [];
    const channels = source.map((ch) => ({
      channelId: String(ch.channelId || ch.id || ch.uuid || ''),
      transport: String(ch.transport || ch.type || ch.provider || ''),
      plainId: String(ch.plainId || ch.phone || ch.name || ch.title || ''),
      state: String(ch.state || ch.status || ''),
      isActive: Boolean(ch.state === 'active' || ch.state === 'connected' || ch.isActive || ch.enabled),
      rawState: ch.state || ch.status || '',
    })).filter((ch) => ch.channelId || ch.plainId);

    res.json({
      ok: true,
      baseUrl,
      configuredChannelId: process.env.WAZZUP_CHANNEL_ID || '',
      configuredChatType: process.env.WAZZUP_CHAT_TYPE || 'whatsapp',
      configuredChannels: publicWazzupChannelList(),
      channels,
      raw: data,
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// Вынесено в отдельную функцию, чтобы её мог использовать и маршрут /api/wazzup/send (ручная
// отправка через автопилот), и обработчик вебхука живого бота (автоответ клиенту) — одна и та же
// проверенная логика (минимальный payload для Telegram, повтор при 500).
async function sendWazzupMessageInternal({ channelKey, text, phone, chatId, username, dealId }) {
  const apiKey = process.env.WAZZUP_API_KEY || '';
  const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
  if (!apiKey) throw new Error('WAZZUP_API_KEY не задан в Render Environment.');

  const configured = getConfiguredWazzupChannel(channelKey);
  if (!configured || !configured.channelId) throw new Error(`Wazzup-канал ${channelKey || 'по умолчанию'} не задан в Render Environment.`);

  const cleanText = String(text || '').trim();
  if (!cleanText) throw new Error('Текст сообщения пустой.');
  const cleanPhone = normalizeWazzupPhone(phone || '');
  const cleanChatId = normalizeWazzupPhone(chatId || '');
  const cleanUsername = normalizeWazzupUsername(username || '');

  const payload = {
    channelId: configured.channelId,
    chatType: configured.chatType,
    text: cleanText,
    crmMessageId: `mavis-executor-${configured.key}-${dealId || 'deal'}-${Date.now()}`,
    clearUnanswered: false,
  };

  if (configured.chatType === 'telegram') {
    if (cleanChatId) {
      payload.chatId = cleanChatId;
    } else if (cleanPhone) {
      payload.phone = cleanPhone;
    } else if (cleanUsername) {
      payload.username = cleanUsername;
    } else {
      throw new Error('Для Telegram Wazzup не найден телефон/chatId/username клиента.');
    }
  } else {
    const recipientId = cleanChatId || cleanPhone;
    if (!recipientId) throw new Error(`Для ${configured.label} не найден chatId/телефон клиента.`);
    payload.chatId = recipientId;
  }

  const minimalPayload = { channelId: payload.channelId, chatType: payload.chatType, text: payload.text };
  if (payload.chatId) minimalPayload.chatId = payload.chatId;
  if (payload.phone) minimalPayload.phone = payload.phone;
  if (payload.username) minimalPayload.username = payload.username;
  const payloadToSend = configured.chatType === 'telegram' ? minimalPayload : payload;

  const attemptSend = async (attemptPayload) => {
    const resp = await fetch(`${baseUrl}/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(attemptPayload),
    });
    const text2 = await resp.text();
    const json = (() => { try { return JSON.parse(text2); } catch (_) { return {}; } })();
    return { resp, text: text2, json };
  };

  // v57: убрана повторная попытка с тем же payload при 500. Раньше при ошибке мы повторяли тот же
  // запрос через секунду — но если первая попытка реально доставила сообщение клиенту, а Wazzup
  // вернул 500 уже после доставки (известная у них транзиентная ошибка), повтор отправлял
  // ВТОРОЕ дублирующее сообщение с тем же текстом. Это подтвердилось на практике: клиент получил
  // одно и то же сообщение и в Telegram, и в Viber (фоллбек сработал из-за ложной "ошибки"
  // Telegram, хотя сообщение уже дошло). Теперь при ошибке сразу поднимаем исключение — пусть
  // вызывающий код (с Viber-фоллбеком) решает, что делать, без повтора внутри одного канала.
  const { resp: response, text: responseText, json: data } = await attemptSend(payloadToSend);
  if (!response.ok) {
    const message = compactWazzupError(data, responseText ? responseText.slice(0, 300) : `HTTP ${response.status} без тела ответа`);
    const err = new Error(`Wazzup ${configured.label}: ${message}`);
    err.safePayload = { ...payloadToSend, text: '[hidden]' };
    err.possiblyDelivered = response.status >= 500;
    throw err;
  }
  // Wazzup иногда возвращает 200 OK но с ошибкой в теле (например клиент заблокировал).
  // Проверяем тело ответа на признаки ошибки доставки.
  if (data && data.error) {
    const err = new Error(`Wazzup ${configured.label}: ошибка доставки — ${data.error} ${data.error_description || ''}`);
    err.safePayload = { ...payloadToSend, text: '[hidden]' };
    err.possiblyDelivered = false;
    throw err;
  }
  return { channel: { key: configured.key, label: configured.label, chatType: configured.chatType }, data };
}

app.post('/api/wazzup/send', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await sendWazzupMessageInternal({
      channelKey: body.channelKey || body.channel || '',
      text: body.text,
      phone: body.phone,
      chatId: body.chatId,
      username: body.telegramUsername || body.username,
      dealId: body.dealId,
    });
    res.json({ ok: true, ...result });
  } catch (error) {
    res.status(error.safePayload ? 502 : 500).json({ ok: false, error: error.message || String(error), safePayload: error.safePayload, possiblyDelivered: !!error.possiblyDelivered });
  }
});

app.get('/api/wazzup/webhook-status', async (_req, res) => {
  try {
    // Проверяем статус через тот же ключ, которым регистрировали — Sidecar если задан.
    const apiKey = process.env.WAZZUP_SIDECAR_KEY || process.env.WAZZUP_API_KEY || '';
    if (!apiKey) {
      res.status(400).json({ ok: false, error: 'WAZZUP_API_KEY не задан в Render Environment.' });
      return;
    }
    const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/webhooks`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const text = await response.text();
    const data = (() => { try { return JSON.parse(text); } catch (_) { return {}; } })();
    if (!response.ok) {
      res.status(response.status).json({ ok: false, error: compactWazzupError(data, text.slice(0, 300)) });
      return;
    }
    res.json({ ok: true, data });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

app.get('/api/debug/deal-activities/:dealId', async (req, res) => {
  try {
    const dealId = req.params.dealId;
    const acts = await bitrixRestList('crm.activity.list', {
      filter: { OWNER_ID: dealId, OWNER_TYPE_ID: 2 },
      order: { ID: 'DESC' },
      select: ['*', 'FILES'],
    }, 20);
    // Возвращаем сырые данные для диагностики — какие поля есть у каждой активности.
    const summary = acts.map((a) => ({
      ID: a.ID,
      TYPE_ID: a.TYPE_ID,
      SUBJECT: a.SUBJECT,
      PROVIDER_ID: a.PROVIDER_ID,
      PROVIDER_TYPE_ID: a.PROVIDER_TYPE_ID,
      STORAGE_ELEMENT_IDS: a.STORAGE_ELEMENT_IDS,
      hasDescription: Boolean(a.DESCRIPTION),
      descriptionSlice: String(a.DESCRIPTION || '').slice(0, 200),
      allKeys: Object.keys(a),
      urlsFound: JSON.stringify(a).match(/https?:\/\/[^\s"'<>]+/gi) || [],
    }));
    res.json({ ok: true, dealId, count: acts.length, activities: summary });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/autopilot/reset/:dealId', async (req, res) => {
  // Сбрасывает маркер автопилота для конкретной сделки — нужно если автопилот упал с ошибкой
  // и пометил сделку как обработанную, хотя реально ничего не сделал.
  try {
    const dealId = req.params.dealId;
    autopilotProcessed.delete(String(dealId));
    // Удаляем маркеры из таймлайна сделки.
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID', 'COMMENT'],
      order: { ID: 'DESC' },
    }, 30);
    const toDelete = comments.filter((c) =>
      String(c.COMMENT || '').includes(AUTOPILOT_MARKER) ||
      String(c.COMMENT || '').includes(AUTOPILOT_ERROR_MARKER)
    );
    for (const c of toDelete) {
      try { await bitrixRestCall('crm.timeline.comment.delete', { id: c.ID }); } catch (_) {}
    }
    // Принудительно запускаем автопилот для этой сделки прямо сейчас.
    const stageIds = await getAutopilotStageIds();
    const deal = await bitrixRestCall('crm.deal.get', { id: dealId });
    if (deal) {
      res.json({ ok: true, message: `Маркеры сброшены (${toDelete.length} шт.), запускаю автопилот...`, deletedComments: toDelete.length });
      runServerAutopilotForDeal(deal, deal.STAGE_ID || (stageIds[0] || null)).catch((e) => console.error(`[reset] ошибка: ${e.message}`));
    } else {
      res.json({ ok: false, error: `Сделка ${dealId} не найдена` });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/deals/siblings', async (req, res) => {
  // Находим другие сделки той же компании на той же стадии "Эксперт назначен".
  // Вызывается ручным автопилотом перед формированием контекста — чтобы объединить
  // все услуги одной компании в один общий ход работы и одно сообщение клиенту.
  try {
    const { companyId, categoryId, stageId, excludeDealId } = req.body || {};
    if (!companyId || !categoryId || !stageId) {
      return res.json({ ok: true, siblings: [] });
    }
    const siblings = await bitrixRestList('crm.deal.list', {
      filter: { COMPANY_ID: companyId, CATEGORY_ID: categoryId, STAGE_ID: stageId },
      select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'CURRENCY_ID',
        process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071',
      ],
    }, 20);
    const seen = new Set();
    const filtered = siblings.filter((s) => {
      if (seen.has(String(s.ID)) || String(s.ID) === String(excludeDealId)) return false;
      seen.add(String(s.ID));
      return true;
    });
    res.json({ ok: true, siblings: filtered });
  } catch (err) {
    res.json({ ok: true, siblings: [], error: err.message });
  }
});

app.post('/api/wazzup/register-webhook', async (req, res) => {
  try {
    // Для регистрации вебхука используем Sidecar API key (если задан) — именно он связан
    // с нативной Bitrix24-интеграцией Wazzup, и вебхуки в этом режиме приходят только
    // если зарегистрированы через тот же ключ, что используется интеграцией.
    const apiKey = process.env.WAZZUP_SIDECAR_KEY || process.env.WAZZUP_API_KEY || '';
    if (!apiKey) {
      res.status(400).json({ ok: false, error: 'Не задан ни WAZZUP_SIDECAR_KEY, ни WAZZUP_API_KEY в Render Environment.' });
      return;
    }
    const usingSidecar = !!process.env.WAZZUP_SIDECAR_KEY;
    const webhookUrl = String((req.body && req.body.webhookUrl) || '').trim();
    if (!webhookUrl) {
      res.status(400).json({ ok: false, error: 'webhookUrl не передан.' });
      return;
    }
    const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/webhooks`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        webhooksUri: webhookUrl,
        subscriptions: { messagesAndStatuses: true, contactsAndDealsCreation: false },
      }),
    });
    const text = await response.text();
    const data = (() => { try { return JSON.parse(text); } catch (_) { return {}; } })();
    if (!response.ok) {
      const message = compactWazzupError(data, text ? text.slice(0, 300) : `HTTP ${response.status}`);
      res.status(response.status).json({ ok: false, error: `Wazzup: ${message}` });
      return;
    }
    res.json({ ok: true, data, usingSidecar, keyUsed: usingSidecar ? 'WAZZUP_SIDECAR_KEY' : 'WAZZUP_API_KEY' });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// --- v54: живой бот в Wazzup-чате (пилот только для тестовой сделки) -----------------------

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

// Находим сделку по номеру телефона контакта. Пилот ограничен одним номером (LIVE_CHAT_TEST_PHONE),
// поэтому ищем именно сделку из LIVE_CHAT_TEST_DEAL_ID, но всё равно сверяем номер контакта —
// это явная защита, чтобы бот не начал случайно отвечать по другой сделке/контакту.
async function findDealForPhone(phoneDigits) {
  if (!config.liveChatTestDealId) return null;
  const deal = await bitrixRestCall('crm.deal.get', { id: config.liveChatTestDealId });
  if (!deal) return null;
  if (deal.CONTACT_ID) {
    try {
      const contact = await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID });
      const phones = Array.isArray(contact && contact.PHONE) ? contact.PHONE.map((p) => normalizePhoneDigits(p.VALUE)) : [];
      if (phones.length && !phones.some((p) => p.endsWith(phoneDigits) || phoneDigits.endsWith(p))) {
        return null; // номер не совпадает с контактом тестовой сделки — не трогаем
      }
    } catch (_) { /* если контакт не открылся — на пилоте всё равно работаем по deal id, не блокируем */ }
  }
  return deal;
}

// Лог переписки храним как комментарии в таймлайне сделки с префиксом — переиспользуем как
// контекст для каждого следующего ответа, без отдельной БД.
const LIVE_CHAT_LOG_PREFIX = '[MAVIS_LIVE_CHAT]';

async function appendLiveChatLog(dealId, direction, text) {
  const tag = direction === 'in' ? 'Клиент' : direction === 'out' ? 'Ассистент' : 'Эскалация';
  const comment = `${LIVE_CHAT_LOG_PREFIX} ${tag}: ${text}`;
  await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: comment } });
}

async function loadLiveChatHistory(dealId, limit = 20) {
  const comments = await bitrixRestList('crm.timeline.comment.list', { filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' }, order: { ID: 'DESC' } }, 100);
  const relevant = comments
    .filter((c) => String(c.COMMENT || '').includes(LIVE_CHAT_LOG_PREFIX))
    .slice(0, limit)
    .reverse()
    .map((c) => String(c.COMMENT || '').replace(LIVE_CHAT_LOG_PREFIX, '').trim());
  return relevant;
}

async function createEscalationTask(dealId, expertId, reason, clientText) {
  if (!expertId) return null;
  return bitrixRestCall('tasks.task.add', {
    fields: {
      TITLE: `СРОЧНО: клиент написал в чат, нужен живой ответ — сделка ${dealId}`,
      DESCRIPTION: `Ассистент не отвечает автоматически.\n\nПричина: ${reason}\n\nСообщение клиента:\n${clientText}`,
      RESPONSIBLE_ID: expertId,
      UF_CRM_TASK: [`D_${dealId}`],
      PRIORITY: 2,
    },
  });
}

app.post('/api/wazzup/webhook', async (req, res) => {
  // Wazzup при регистрации вебхука шлёт тестовый POST {test: true} и ждёт 200 немедленно.
  if (req.body && req.body.test) {
    res.status(200).json({ ok: true });
    return;
  }
  // Всегда отвечаем 200 быстро (Wazzup ждёт 200 в течение 30с), а основную работу делаем
  // не блокируя ответ надолго — но для простоты и надёжности логики на пилоте обрабатываем
  // синхронно и просто не делаем тяжёлых лишних шагов.
  try {
    if (config.wazzupCrmKey) {
      const auth = req.headers.authorization || '';
      if (auth !== `Bearer ${config.wazzupCrmKey}`) {
        res.status(200).json({ ok: true }); // отвечаем 200, но дальше не обрабатываем чужой запрос
        return;
      }
    }

    if (!config.liveChatEnabled) {
      res.status(200).json({ ok: true });
      return;
    }

    const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    for (const msg of messages) {
      try {
        // Только входящие текстовые сообщения от клиента (не эхо исходящих, не статусы).
        if (msg.isEcho || msg.status !== 'inbound') continue;
        const text = String(msg.text || '').trim();
        if (!text) continue; // картинки/документы сюда тоже приходят, но этап 6 (сбор документов) — отдельная логика, не часть живого чата

        const contactPhone = normalizePhoneDigits((msg.contact && msg.contact.phone) || msg.chatId || '');
        const testPhone = normalizePhoneDigits(config.liveChatTestPhone);
        if (!testPhone || !contactPhone.endsWith(testPhone.slice(-9))) continue; // пилот — только тестовый номер

        const deal = await findDealForPhone(contactPhone);
        if (!deal) continue;
        const dealId = deal.ID;

        const replyChannelKey = findChannelKeyByChannelId(msg.channelId);
        if (!replyChannelKey) {
          // Сообщение пришло по каналу, который не настроен в Render Environment (например, Viber
          // не сконфигурирован) — не пытаемся угадать, эскалируем к человеку сразу, не тратя
          // вызовы ИИ на классификацию/генерацию ответа, который всё равно не сможем отправить.
          await appendLiveChatLog(dealId, 'escalation', `Канал входящего сообщения (channelId=${msg.channelId}) не настроен в Render — бот не может ответить через него автоматически. Сообщение клиента: ${text}`);
          await createEscalationTask(dealId, config.executorExpertId, 'входящий канал не настроен для автоответа', text);
          continue;
        }

        await appendLiveChatLog(dealId, 'in', text);

        const history = await loadLiveChatHistory(dealId, 20);
        const dealSummary = `Сделка ${dealId}, услуга: ${deal.UF_CRM_1765113071 || 'не указана'}, стадия: ${deal.STAGE_ID || ''}.`;

        const classifyCfg = aiScenarioConfig('live_chat_classify');
        const classifyRaw = await callAiChatCompletion({
          model: config.aiModel,
          temperature: 0,
          messages: [
            { role: 'system', content: `${classifyCfg.instruction}\n\nОтветь ТОЛЬКО JSON: {"decision":"safe_auto_reply"|"needs_human","reason":"короткое объяснение"}` },
            { role: 'user', content: `${dealSummary}\n\nИстория переписки (последние сообщения):\n${history.join('\n')}\n\nНовое сообщение клиента: ${text}` },
          ],
        });
        let classification = { decision: 'needs_human', reason: 'не удалось разобрать ответ классификатора' };
        try { classification = JSON.parse(classifyRaw); } catch (_) { /* оставляем безопасный дефолт needs_human */ }

        if (classification.decision !== 'safe_auto_reply') {
          await appendLiveChatLog(dealId, 'escalation', `${classification.reason || 'требуется живой человек'} (сообщение клиента: ${text})`);
          await createEscalationTask(dealId, config.executorExpertId, classification.reason || 'классификатор отметил как требующее живого ответа', text);
          continue;
        }

        const replyCfg = aiScenarioConfig('live_chat_reply');
        const replyRaw = await callAiChatCompletion({
          model: config.aiModel,
          temperature: 0.3,
          messages: [
            { role: 'system', content: `${replyCfg.instruction}\n\nОтветь ТОЛЬКО JSON: {"reply":"текст ответа клиенту"}` },
            { role: 'user', content: `${dealSummary}\n\nИстория переписки (последние сообщения):\n${history.join('\n')}\n\nНовое сообщение клиента: ${text}` },
          ],
        });
        let replyText = '';
        try { replyText = JSON.parse(replyRaw).reply || ''; } catch (_) { /* пусто => не отправляем */ }
        if (!replyText) {
          await appendLiveChatLog(dealId, 'escalation', `ИИ не сформировал ответ — эскалация (сообщение клиента: ${text})`);
          await createEscalationTask(dealId, config.executorExpertId, 'ИИ не смог сформировать автоответ', text);
          continue;
        }

        await sendWazzupMessageInternal({
          channelKey: replyChannelKey,
          text: replyText,
          chatId: msg.chatId,
          phone: contactPhone,
          dealId,
        });
        await appendLiveChatLog(dealId, 'out', replyText);
      } catch (innerError) {
        console.error('[live-chat-webhook] ошибка обработки одного сообщения:', innerError.message || innerError);
      }
    }

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[live-chat-webhook] общая ошибка:', error.message || error);
    res.status(200).json({ ok: true }); // всегда 200, чтобы Wazzup не отключил вебхук из-за наших ошибок
  }
});



function resolveTranscribeProvider() {
  const provider = String(config.transcribeProvider || config.aiProvider || 'vibe').toLowerCase().trim();
  const apiKey = process.env.TRANSCRIBE_API_KEY || process.env.AI_API_KEY || process.env.VIBE_API_KEY || process.env.OPENAI_API_KEY || '';
  const baseUrl = (config.transcribeBaseUrl || config.aiBaseUrl || (provider === 'openai' ? 'https://api.openai.com/v1' : 'https://vibecode.bitrix24.tech/v1')).replace(/\/$/, '');
  // VibeCode официально принимает X-Api-Key и Authorization: Bearer.
  // Для speech-to-text используем X-Api-Key как основной вариант, чтобы не путать с OpenAI BYOK.
  const authHeader = baseUrl.includes('vibecode.bitrix24.tech')
    ? { 'X-Api-Key': apiKey }
    : { Authorization: `Bearer ${apiKey}` };
  return { provider, apiKey, baseUrl, authHeader };
}

app.post('/api/ai/transcribe-url', async (req, res) => {
  try {
    if (!config.callTranscriptionEnabled) {
      res.status(400).json({ ok: false, error: 'Расшифровка звонков выключена. Добавь CALL_TRANSCRIPTION_ENABLED=true в Render.' });
      return;
    }
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) {
      res.status(400).json({ ok: false, error: 'Не передан URL аудиозаписи.' });
      return;
    }
    const ai = resolveTranscribeProvider();
    if (!ai.apiKey) {
      res.status(400).json({ ok: false, error: 'Не задан ключ для расшифровки. Добавь TRANSCRIBE_API_KEY или AI_API_KEY.' });
      return;
    }

    const audioResp = await fetch(url);
    if (!audioResp.ok) throw new Error(`Не удалось скачать аудио: HTTP ${audioResp.status}`);
    const arrayBuffer = await audioResp.arrayBuffer();
    const contentType = audioResp.headers.get('content-type') || 'audio/mpeg';
    const fileName = String(req.body.fileName || 'call-record.mp3').replace(/[^a-zA-Z0-9._-]/g, '_') || 'call-record.mp3';

    const configuredModel = config.transcribeModel || 'bitrix/deepdml/faster-whisper-large-v3-turbo-ct2';
    const shouldSendModel = Boolean(config.transcribeSendModel && configuredModel);

    async function callTranscription(includeModel) {
      const form = new FormData();
      // VibeCode speech-to-text работает через /v1/audio/transcriptions. В новых AI Router моделях можно указать model.
      // Если конкретный портал/endpoint вернёт 400 из-за model, ниже есть автоматический fallback без поля model.
      if (includeModel) form.append('model', configuredModel);
      form.append('file', new Blob([arrayBuffer], { type: contentType }), fileName);
      form.append('language', 'ru');
      form.append('response_format', 'json');
      const response = await fetch(`${ai.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { ...ai.authHeader },
        body: form,
      });
      const responseText = await response.text().catch(() => '');
      let data = {};
      try { data = responseText ? JSON.parse(responseText) : {}; } catch (_e) { data = { raw: responseText }; }
      return { response, data };
    }

    let usedModelField = shouldSendModel;
    let retryWithoutModel = false;
    let { response, data } = await callTranscription(shouldSendModel);

    // Документация VibeCode показывает пример без поля model, поэтому при 400 пробуем второй раз без model.
    if (!response.ok && response.status === 400 && shouldSendModel && ai.baseUrl.includes('vibecode.bitrix24.tech')) {
      retryWithoutModel = true;
      usedModelField = false;
      ({ response, data } = await callTranscription(false));
    }

    if (!response.ok) {
      const providerHint = ai.baseUrl.includes('vibecode')
        ? 'VibeCode поддерживает /v1/audio/transcriptions через Whisper Large v3 Turbo. Проверь: ключ vibe_api/vibe_app, scope vibe:ai, что файл не пустой, и что Bitrix отдал реальный аудиофайл, а не HTML-страницу/заглушку.'
        : 'Проверь ключ, модель, формат и размер файла аудио.';
      const msg = data && data.error && data.error.message ? data.error.message : (data.error || data.message || data.raw || `HTTP ${response.status}`);
      res.status(500).json({
        ok: false,
        error: `Расшифровка аудио: ${msg}`,
        diagnostics: {
          provider: ai.provider,
          baseUrl: ai.baseUrl,
          model: configuredModel,
          modelFieldSent: usedModelField,
          retryWithoutModel,
          audioContentType: contentType,
          audioBytes: arrayBuffer.byteLength,
          fileName,
          httpStatus: response.status,
          hint: providerHint,
          providerResponse: data,
        },
      });
      return;
    }
    const text = data.text || data.transcript || data.result || '';
    res.json({ ok: true, provider: ai.provider, model: configuredModel, modelFieldSent: usedModelField, retryWithoutModel, text, raw: data, diagnostics: { audioContentType: contentType, audioBytes: arrayBuffer.byteLength, fileName } });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
  }
});

// Main app page used as "Путь вашего обработчика" in Bitrix24.
app.all(['/', '/app', '/deal'], (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Installation page used as "Путь для первоначальной установки" in Bitrix24.
// For first MVP we complete installation from the iframe via BX24.installFinish().
app.all('/install', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'install.html'));
});

// ============================================================================
// v82: ОБРАБОТКА ПОЧТЫ — клиенты присылают документы на mavis.group@mail.ru,
// сервер читает новые письма по IMAP, сверяет отправителя с контактами CRM,
// сохраняет вложения на Bitrix Диск в папку компании, ставит задачу эксперту.
// ============================================================================

const EMAIL_POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 минут
let commonDriveRootId = null; // кэш ID корневой папки Общего диска

async function getCommonDriveRootId() {
  if (commonDriveRootId) return commonDriveRootId;
  // Находим общее хранилище компании (не личный диск пользователя).
  const storages = await bitrixRestCall('disk.storage.getlist', {});
  const companyStorage = (Array.isArray(storages) ? storages : []).find((s) =>
    /common|group|company|общ/i.test(s.NAME || '') || s.ENTITY_TYPE === 'group' || s.ENTITY_TYPE === 'common'
  ) || (Array.isArray(storages) ? storages[0] : null);
  if (!companyStorage) throw new Error('Не найдено общее хранилище Bitrix Диска (disk.storage.getlist пусто).');

  const storageInfo = await bitrixRestCall('disk.storage.get', { id: companyStorage.ID });
  commonDriveRootId = storageInfo.ROOT_OBJECT_ID;
  console.log(`[email] Корень Общего диска → ID ${commonDriveRootId}`);
  return commonDriveRootId;
}

function normalizeCompanyNameForMatch(name) {
  // Убираем организационно-правовую форму и пунктуацию для нечёткого сравнения названий —
  // папка на Диске может называться "Эд Сервис", а в CRM компания "ООО "Эд Сервис"".
  return String(name || '')
    .toLowerCase()
    .replace(/\b(ооо|оао|зао|чп|уп|ип|зполиц|чтуп|общество с ограниченной ответственностью|частное предприятие)\b/gi, '')
    .replace(/[«»"'.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getOrCreateCompanyFolder(companyName) {
  // Папки компаний лежат прямо в корне Общего диска (не во вложенной структуре).
  const rootId = await getCommonDriveRootId();
  const safeName = String(companyName || 'Без названия').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 200);
  const targetNormalized = normalizeCompanyNameForMatch(safeName);

  const children = await bitrixRestList('disk.folder.getchildren', { id: rootId }, 500);
  // Сначала точное совпадение, потом нечёткое (без ООО/кавычек).
  let folder = children.find((c) => c.TYPE === 'folder' && c.NAME === safeName);
  if (!folder) {
    folder = children.find((c) => c.TYPE === 'folder' && normalizeCompanyNameForMatch(c.NAME) === targetNormalized && targetNormalized);
  }
  if (!folder) {
    folder = await bitrixRestCall('disk.folder.addsubfolder', { id: rootId, data: { NAME: safeName } });
    console.log(`[email] Создана новая папка компании "${safeName}" → ID ${folder.ID}`);
  } else {
    console.log(`[email] Найдена существующая папка компании "${folder.NAME}" → ID ${folder.ID}`);
  }
  return folder.ID;
}

async function uploadFileToDiskFolder(folderId, fileName, buffer) {
  const base64 = buffer.toString('base64');
  const safeFileName = String(fileName || 'file').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
  const result = await bitrixRestCall('disk.folder.uploadfile', {
    id: folderId,
    data: { NAME: safeFileName },
    fileContent: [safeFileName, base64],
    generateUniqueName: true,
  });
  return result;
}

async function findContactAndDealsByEmail(senderEmail) {
  // Сверяем email отправителя с контактами CRM.
  const cleanEmail = String(senderEmail || '').trim().toLowerCase();
  if (!cleanEmail) return null;
  try {
    const contacts = await bitrixRestList('crm.contact.list', {
      filter: { EMAIL: cleanEmail },
      select: ['ID', 'NAME', 'LAST_NAME', 'EMAIL', 'COMPANY_ID'],
    }, 5);
    if (!contacts.length) return null;
    const contact = contacts[0];

    // Находим сделки этого контакта на стадии "Сбор информации" (туда автопилот переводит после звонка).
    const stageIds = await getAutopilotStageIds();
    const prepStageId = getPreparationStageId();
    const targetStages = [...new Set([...stageIds, prepStageId].filter(Boolean))];
    const allDeals = [];
    for (const stageId of targetStages) {
      const deals = await bitrixRestList('crm.deal.list', {
        filter: { CONTACT_ID: contact.ID, CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: stageId },
        select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'COMPANY_ID', process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071'],
      }, 20);
      allDeals.push(...deals);
    }
    const seen = new Set();
    const uniqueDeals = allDeals.filter((d) => { if (seen.has(d.ID)) return false; seen.add(d.ID); return true; });
    return { contact, deals: uniqueDeals };
  } catch (e) {
    console.warn(`[email] Ошибка поиска контакта по email ${cleanEmail}: ${e.message}`);
    return null;
  }
}

async function getCompanyName(companyId) {
  if (!companyId) return null;
  try {
    const company = await bitrixRestCall('crm.company.get', { id: companyId });
    return company ? company.TITLE : null;
  } catch (_) { return null; }
}

function attachmentMatchesAnyDoc(fileName, docList) {
  // Простая проверка: имя файла содержит ключевые слова из перечня (диплом, трудовая, аттестат и т.п.)
  if (!docList || !docList.docs) return true; // если перечня нет — не фильтруем, сохраняем всё
  const lower = String(fileName || '').toLowerCase();
  const keywords = ['диплом', 'трудов', 'аттестат', 'паспорт', 'устав', 'свидетельств', 'договор', 'скан', 'копия', 'pdf', 'jpg', 'jpeg', 'png', 'doc'];
  return keywords.some((k) => lower.includes(k)) || /\.(pdf|jpg|jpeg|png|docx?|xlsx?)$/i.test(lower);
}

async function createDocumentReceivedTask(dealId, expertId, expertName, companyName, fileNames, folderId) {
  const petName = getDiminutiveName(expertName);
  const taskTitle = `${petName}, клиент прислал документы на почту 📨`;
  const fileList = fileNames.map((f) => `— ${f}`).join('\n');
  const taskDesc = `${petName}, клиент (${companyName}) прислал документы на почту mavis.group@mail.ru 😊\n\nЯ сохранил их на Диск в папку компании.\n\nЧто пришло:\n${fileList}\n\nПроверь, всё ли пришло и можно ли двигаться дальше по сделке 🙌`;

  await bitrixRestCall('tasks.task.add', {
    fields: {
      TITLE: taskTitle,
      DESCRIPTION: taskDesc,
      RESPONSIBLE_ID: expertId,
      UF_CRM_TASK: [`D_${dealId}`],
      PRIORITY: 1,
    },
  });
}

async function analyzeDocumentWithVision(fileBuffer, fileName, mimeType) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
  const isPdf = ext === 'pdf';

  if (!isImage && !isPdf) {
    // Для Word/Excel — только по имени файла.
    return { docType: classifyFileByName(fileName), confidence: 'low', byName: true };
  }

  try {
    const base64 = fileBuffer.toString('base64');
    const mediaType = isImage ? (mimeType || `image/${ext === 'jpg' ? 'jpeg' : ext}`) : 'image/jpeg';

    // PDF конвертируем в base64 и отправляем как image_url (GPT поддерживает PDF через data URL).
    const dataUrl = `data:${mediaType};base64,${base64}`;

    const ai = resolveTranscribeProvider();
    const response = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...ai.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.aiModel,
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
            {
              type: 'text',
              text: `Определи что это за документ. Ответь ТОЛЬКО JSON без пояснений:
{"docType": "диплом"|"трудовая"|"аттестат"|"паспорт"|"устав"|"свидетельство о регистрации"|"договор"|"доверенность"|"приказ"|"справка"|"средство измерений"|"другое", "person": "ФИО если видно или null", "confidence": "high"|"medium"|"low"}`,
            },
          ],
        }],
      }),
    });

    const data = await response.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || '';
    try {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
    } catch (_) {}
    return { docType: 'другое', confidence: 'low' };
  } catch (e) {
    console.warn(`[email] Vision анализ файла "${fileName}" не удался: ${e.message}`);
    return { docType: classifyFileByName(fileName), confidence: 'low', byName: true };
  }
}

async function checkDocumentCompleteness(deal, receivedDocs, companyName) {
  // Сверяем полученные документы с перечнем для данной услуги.
  // receivedDocs = [{ fileName, docType, person, confidence }]
  const service = detectServiceFromDeal(deal);
  const docList = getDocumentListForService(service);

  const systemPrompt = `Ты — Игорь, ИИ-ассистент MAVIS GROUP. Проверяешь комплектность документов от клиента.
Отвечай только JSON.`;

  const userPrompt = `Услуга: ${service}
Требуемый перечень документов: ${JSON.stringify(docList.docs, null, 2)}
Полученные документы: ${JSON.stringify(receivedDocs, null, 2)}

Проверь комплектность и ответь JSON:
{
  "complete": true/false,
  "received_summary": "краткое описание что пришло (1-2 предложения)",
  "missing": ["список чего не хватает"],
  "extra_notes": "любые важные замечания (например документ нечитаем, не тот человек и т.д.) или null",
  "expert_comment": "готовый текст комментария эксперту (3-5 строк): что пришло, чего не хватает, что делать дальше"
}`;

  try {
    const rawText = await callAiChatCompletion({
      model: config.aiModel,
      temperature: 0.1,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    });
    let result = {};
    try { result = JSON.parse(rawText); } catch (_) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) try { result = JSON.parse(match[0]); } catch (_2) {}
    }
    return result;
  } catch (e) {
    console.warn(`[email] Проверка комплектности не удалась: ${e.message}`);
    return null;
  }
}


async function runStageMonitoring() {
  await checkExpertFirstCallReminder();
  await checkCollectionStageStuck();
  await checkSelectionStage();
  await checkDocsReadyStage();
  await checkWonStage();
  await checkRefundStage();
}


async function runAutopilotPollingCycle() {
  if (!config.bitrixWebhookUrl) {
    console.log('[autopilot] BITRIX_WEBHOOK_URL не задан — фоновый автопилот не запускается.');
    return;
  }
  if (!config.autopilotEnabled) {
    return; // AUTOPILOT_ENABLED=false — выключен
  }

  try {
    const stageIds = await getAutopilotStageIds();
    if (!stageIds.length) {
      console.warn('[autopilot] Стадии не найдены в воронке — проверь AUTOPILOT_CATEGORY_ID.');
      return;
    }

    const startDateStr = AUTOPILOT_START_DATE.toISOString().slice(0, 19);
    // Собираем сделки по каждой стадии отдельно (Bitrix не поддерживает массив в STAGE_ID фильтре).
    const allDeals = [];
    const seenIds = new Set();
    for (const stageId of stageIds) {
      const deals = await bitrixRestList('crm.deal.list', {
        filter: {
          CATEGORY_ID: config.autopilotCategoryId || 28,
          STAGE_ID: stageId,
          '>=MOVED_TIME': startDateStr,
        },
        select: ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'COMPANY_ID',
          'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE', 'MOVED_TIME',
          process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071',
          process.env.PREFERRED_CONTACT_FIELD_CODE || 'UF_CRM_1781874759140',
          'UF_CRM_1781189436900', // старый код поля канала
        ],
      }, 50);
      for (const d of deals) {
        if (!seenIds.has(String(d.ID))) { seenIds.add(String(d.ID)); allDeals.push(d); }
      }
    }

    console.log(`[autopilot] Цикл: найдено ${allDeals.length} сделок на стадиях [${stageIds.join(', ')}] после ${startDateStr}.`);

    for (const deal of allDeals) {
      if (autopilotProcessed.has(String(deal.ID))) continue;
      const alreadyDone = await dealAlreadyProcessed(deal.ID);
      if (alreadyDone) continue;
      // Передаём первую стадию (Эксперт назначен) как эталон для поиска сопутствующих сделок.
      await runServerAutopilotForDeal(deal, deal.STAGE_ID);
      await new Promise((r) => setTimeout(r, 5000));
    }

    // Проверяем ожидающие задачи-триггеры Этапа 4 (эксперт поставил галочку).
    if (pendingAttStage4Tasks.size > 0) {
      await checkPendingAttStage4Tasks();
    }

    // Проверяем сделки ожидающие контроля документов (Этап 5).
    if (pendingDocsCheck.size > 0) {
      await checkPendingDocsReminders();
    }

    // Мониторинг всех стадий воронки (пункты 1, 3, 7, 8, 9).
    await runStageMonitoring();

    // Ежемесячные сверки актов (1 числа) и оригиналов (1 и 15 числа).
    await runMonthlyActsReconciliation().catch(e => console.error('[acts] Ошибка сверки актов:', e.message));
    await runOriginalsReconciliation().catch(e => console.error('[acts] Ошибка сверки оригиналов:', e.message));

    // Проверяем нераспределённые сделки — уведомляем Таню если висят 4+ рабочих часа.
    await checkUnassignedDeals();
  } catch (err) {
    console.error('[autopilot] Ошибка polling-цикла:', err.message || err);
  }
}

// Запуск polling после старта сервера.
app.listen(PORT, () => {
  console.log(`MAVIS Bitrix Expert Assistant is running on port ${PORT}`);

  if (config.bitrixWebhookUrl && config.autopilotEnabled) {
    console.log(`[autopilot] Фоновый автопилот включён (интервал ${AUTOPILOT_POLL_INTERVAL_MS / 60000} мин). Старт с ${AUTOPILOT_START_DATE.toISOString()}.`);
    // Первый запуск через 2 минуты после старта (дать серверу прогреться).
    setTimeout(() => {
      runAutopilotPollingCycle();
      setInterval(runAutopilotPollingCycle, AUTOPILOT_POLL_INTERVAL_MS);
    }, 2 * 60 * 1000);
  } else {
    console.log('[autopilot] Фоновый автопилот выключен. Для включения задай AUTOPILOT_ENABLED=true и BITRIX_WEBHOOK_URL в Render.');
  }

  if (process.env.MAIL_IMAP_USER && process.env.MAIL_IMAP_PASSWORD && config.bitrixWebhookUrl) {
    console.log(`[email] Обработка почты включена (интервал ${EMAIL_POLL_INTERVAL_MS / 60000} мин).`);
    setTimeout(() => {
      processIncomingEmails();
      setInterval(processIncomingEmails, EMAIL_POLL_INTERVAL_MS);
    }, 3 * 60 * 1000); // старт через 3 минуты, чтобы не конфликтовать с первым циклом автопилота
  } else {
    console.log('[email] Обработка почты выключена. Для включения задай MAIL_IMAP_USER и MAIL_IMAP_PASSWORD в Render.');
  }
});
