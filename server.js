const express = require('express');
const path = require('path');
const helmet = require('helmet');

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
  let start = 0;
  for (;;) {
    const page = await bitrixRestCall(method, { ...params, start });
    const items = Array.isArray(page) ? page : (page && page.items) || [];
    out.push(...items);
    if (!Array.isArray(page) || items.length === 0 || out.length >= limit) break;
    start += items.length;
    if (out.length >= limit) break;
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
      'Фокус сценария: ассистент-исполнитель по аттестации организации после первичного звонка. Не режим подсказки, а рабочий маршрут исполнения. Ассистент сам ведёт сделку: пишет клиенту, ставит внутренние дела, двигает стадию, отчитывается эксперту-наблюдателю комментарием. Клиенту никогда не пишешь от имени человека-эксперта без подтверждения — пишешь как ассистент.',
      'ВАЖНО про канал связи в client_message: НИКОГДА не упоминай название конкретного мессенджера (Viber, Telegram, WhatsApp и т.п.), даже если клиент сам назвал его в звонке для пересылки чего-то конкретного. Вместо "пришлите в Viber" или "перешлите в Telegram" пиши просто "пришлите мне" / "перешлите мне" — без названия канала. Это исключает противоречие между тем, что сказано в тексте, и тем мессенджером, в котором клиент реально получает сообщение.',
      'Из звонка и сделки извлеки: вид работ, кто закрывает руководителя, есть ли директор с высшим строительным и 5 годами опыта, есть ли главный инженер и его аттестат, может ли один человек закрыть руководителя и ГИ, есть ли прораб/мастер под каждый вид работ, кого переводим/аттестуем/подбираем, канал связи, сроки и обещания.',
      'Сформируй конкретный ход работы: что уже сделал ассистент, что пишет клиенту, какие документы запрашивает, какие внутренние дела создаёт (НЕ для клиента — для эксперта/менеджера/руководителя), когда запускать ЛК Белстройцентра, когда ждать документы, когда передавать оформителям, когда собирать папку и что контролировать после подачи.',
      'По аттестации организации учитывай: Белстройцентр, бумажная подача, перечень копий, заявка через личный кабинет, договор/акты как успешное прохождение, замечания как отдельный этап устранения.',
      'Реши, нужно ли двигать стадию сделки в Bitrix дальше по воронке прямо сейчас. Двигай стадию только если по итогам звонка зафиксирован реальный переход (например: передача подтверждена и начали вести клиента; документы запрошены и ждём; пакет подан). Не двигай стадию, если есть критичные пробелы (нет вида работ, нет схемы специалистов) — в этом случае оставайся на текущей стадии и фиксируй это как риск.',
      'tasks — это только внутренние дела для сотрудников MAVIS (expert/manager/leader), никогда не задачи "для клиента". Если нужно действие от клиента — это идёт в client_message, а не в tasks.',
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
    const user = `${scenarioCfg.label}.

Задача:
${scenarioCfg.instruction}

Продуктовые правила и ограничения MAVIS GROUP:
${productGuidance}

Контекст сделки:
${context}

Верни JSON по схеме:
{
  "status": "ok|partial|risk|error",
  "status_label": "короткий статус по-русски",
  "summary": ["что понятно / найдено по сценарию"],
  "missing": ["чего не хватает / что нужно уточнить / что не найдено"],
  "risks": ["риски по срокам, оплатам, документам, передаче"],
  "next_steps": ["следующие действия эксперта, менеджера или руководителя"],
  "tasks": [{"title":"название задачи", "responsible":"expert|manager|leader", "deadline_hint":"когда", "description":"что сделать"}],
  "client_message": "черновик сообщения клиенту, если уместно; если клиенту писать рано — текст уточнения или пустая строка",
  "comment": "короткий комментарий в сделку для Bitrix",
  "stage_decision": {"should_move": false, "target_stage_hint": "ключевые слова целевой стадии по-русски, например 'ведём клиента' или 'ждём документы' или пусто", "reason": "почему двигаем или почему остаёмся на текущей стадии"}
}`;

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
    err.possiblyDelivered = response.status >= 500; // 500 у Wazzup не всегда значит "не доставлено"
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
// v60: СЕРВЕРНЫЙ АВТОПИЛОТ — фоновый polling, запускается автоматически
// без участия эксперта. Мониторит воронку производства, при появлении
// записи звонка в сделке на стадии "Эксперт назначен" — запускает полный
// цикл: расшифровка → анализ → сообщение клиенту → комментарий в сделку.
// ============================================================================

const AUTOPILOT_MARKER = '[MAVIS_AUTOPILOT_DONE]';
const AUTOPILOT_ERROR_MARKER = '[MAVIS_AUTOPILOT_ERROR]';
const AUTOPILOT_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 минут

// Дата запуска сервера — сделки созданные раньше этой даты не трогаем.
// Это гарантирует, что текущие 14 сделок на стадии "Эксперт назначен"
// не будут обработаны при первом запуске.
const AUTOPILOT_START_DATE = new Date();

// Кэш обработанных сделок (dealId → true), чтобы не перечитывать
// таймлайн каждые 10 минут для уже обработанных сделок.
const autopilotProcessed = new Set();

async function getExpertStageId() {
  // Ищем стадию "Эксперт назначен" в воронке 28 динамически.
  // Кэшируем результат, чтобы не делать запрос каждые 10 минут.
  if (getExpertStageId._cached) return getExpertStageId._cached;
  const stages = await bitrixRestCall('crm.dealcategory.stage.list', { id: config.autopilotCategoryId || 28 });
  const stage = (Array.isArray(stages) ? stages : []).find((s) =>
    /эксперт.*(назначен|назначён)/i.test(s.NAME || '') ||
    /назначен.*эксперт/i.test(s.NAME || '')
  );
  if (stage) {
    getExpertStageId._cached = stage.STATUS_ID;
    console.log(`[autopilot] Найдена стадия "${stage.NAME}" → STATUS_ID=${stage.STATUS_ID}`);
  }
  return getExpertStageId._cached || null;
}

async function dealAlreadyProcessed(dealId) {
  if (autopilotProcessed.has(String(dealId))) return true;
  // Проверяем таймлайн сделки на наличие маркера выполненного автопилота.
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID', 'COMMENT'],
      order: { ID: 'DESC' },
    }, 30);
    const done = comments.some((c) => String(c.COMMENT || '').includes(AUTOPILOT_MARKER) || String(c.COMMENT || '').includes(AUTOPILOT_ERROR_MARKER));
    if (done) autopilotProcessed.add(String(dealId));
    return done;
  } catch (_) {
    return false; // если не удалось прочитать таймлайн — не блокируем, попробуем обработать
  }
}

async function transcribeAudioUrl(audioUrl, fileName) {
  const ai = resolveTranscribeProvider();
  if (!ai.apiKey) throw new Error('Не задан ключ для расшифровки (TRANSCRIBE_API_KEY / AI_API_KEY).');
  const audioResp = await fetch(audioUrl);
  if (!audioResp.ok) throw new Error(`Не удалось скачать аудио: HTTP ${audioResp.status}`);
  const arrayBuffer = await audioResp.arrayBuffer();
  const contentType = audioResp.headers.get('content-type') || 'audio/mpeg';
  const safeFileName = String(fileName || 'call.mp3').replace(/[^a-zA-Z0-9._-]/g, '_') || 'call.mp3';
  const configuredModel = config.transcribeModel || 'bitrix/deepdml/faster-whisper-large-v3-turbo-ct2';
  const shouldSendModel = Boolean(config.transcribeSendModel && configuredModel);
  async function attempt(includeModel) {
    const form = new FormData();
    if (includeModel) form.append('model', configuredModel);
    form.append('file', new Blob([arrayBuffer], { type: contentType }), safeFileName);
    form.append('language', 'ru');
    form.append('response_format', 'json');
    const r = await fetch(`${ai.baseUrl}/audio/transcriptions`, { method: 'POST', headers: { ...ai.authHeader }, body: form });
    const t = await r.text().catch(() => '');
    let d = {};
    try { d = t ? JSON.parse(t) : {}; } catch (_) { d = { raw: t }; }
    return { r, d };
  }
  let { r, d } = await attempt(shouldSendModel);
  if (!r.ok && r.status === 400 && shouldSendModel) { ({ r, d } = await attempt(false)); }
  if (!r.ok) throw new Error(`Расшифровка не удалась: HTTP ${r.status} — ${d.raw || JSON.stringify(d).slice(0, 200)}`);
  return String(d.text || d.transcript || '').trim();
}

function serverCollectActivityAudioCandidates(activity) {
  const out = [];
  const push = (candidate) => {
    if (!candidate) return;
    const c = { ...candidate, activityId: activity.ID, subject: activity.SUBJECT || '', provider: activity.PROVIDER_ID || '' };
    const key = c.url || c.fileId || c.value;
    if (!key) return;
    out.push(c);
  };
  const scan = (value, path = '') => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      const urls = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
      urls.forEach((url) => {
        if (/record|call|audio|mp3|wav|m4a|download|disk|bitrix/i.test(url)) push({ type: 'url', url, value: url, path });
      });
      return;
    }
    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
      if (/file|record|storage|disk/i.test(path)) push({ type: 'fileId', fileId: String(value), value: String(value), path });
      return;
    }
    if (Array.isArray(value)) return value.forEach((v, i) => scan(v, `${path}[${i}]`));
    if (typeof value === 'object') {
      const url = value.DOWNLOAD_URL || value.downloadUrl || value.url || value.URL || value.link || value.LINK;
      const id = value.ID || value.id || value.FILE_ID || value.fileId || value.file_id || value.VALUE;
      if (url) push({ type: 'url', url: String(url), value: String(url), path });
      if (id && /file|record|storage|disk/i.test(`${path} ${Object.keys(value).join(' ')}`)) push({ type: 'fileId', fileId: String(id), value: String(id), path });
      Object.entries(value).forEach(([k, v]) => scan(v, path ? `${path}.${k}` : k));
    }
  };
  scan(activity, 'activity');
  const uniq = [];
  const seen = new Set();
  out.forEach((x) => {
    const key = `${x.type}:${x.url || x.fileId}`;
    if (!seen.has(key)) { seen.add(key); uniq.push(x); }
  });
  return uniq;
}

async function serverResolveCandidateDownloadUrl(candidate) {
  if (candidate.url) return candidate.url;
  if (!candidate.fileId) return '';
  try {
    const file = await bitrixRestCall('disk.file.get', { id: candidate.fileId });
    return file && (file.DOWNLOAD_URL || file.downloadUrl || file.download_url || file.url || file.LINK || file.link) || '';
  } catch (_) { return ''; }
}

async function findCallForDeal(dealId) {
  // Точная копия логики findCallRecordingsForDeal из app.js — поддерживает Asterisk/Zruchna и
  // любые другие провайдеры телефонии, не только стандартный Bitrix TYPE_ID=2.
  const acts = await bitrixRestList('crm.activity.list', {
    filter: { OWNER_ID: dealId, OWNER_TYPE_ID: 2 },
    order: { ID: 'DESC' },
    select: ['*'],
  }, 80);
  const callActs = acts.filter((a) => {
    const text = [a.SUBJECT, a.DESCRIPTION, a.PROVIDER_ID, a.TYPE_ID, a.PROVIDER_TYPE_ID].join(' ').toLowerCase();
    return /звон|call|voximplant|telephony|телеф|asterisk|zruchna/.test(text) || String(a.TYPE_ID || '') === '2';
  });
  const candidates = [];
  callActs.forEach((a) => candidates.push(...serverCollectActivityAudioCandidates(a)));
  for (const c of candidates) {
    c.downloadUrl = await serverResolveCandidateDownloadUrl(c);
  }
  const ready = candidates.filter((c) => c.downloadUrl || c.url);
  if (!ready.length) return null;
  const best = ready[0];
  return { activityId: best.activityId, subject: best.subject, url: best.downloadUrl || best.url, fileName: `call-${dealId}.mp3` };
}

function detectServiceFromDeal(deal) {
  const serviceField = process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071';
  return String(deal[serviceField] || deal.UF_CRM_1765113071 || '').trim();
}

function detectPreferredChannel(deal) {
  const field = process.env.PREFERRED_CONTACT_FIELD_CODE || 'UF_CRM_1781189436900';
  const val = String(deal[field] || '').toLowerCase();
  if (val.includes('телеграм') || val.includes('telegram') || val.includes('tg')) return 'telegram';
  if (val.includes('вайбер') || val.includes('viber')) return 'viber';
  if (val.includes('email') || val.includes('почта') || val.includes('mail')) return 'email';
  return 'telegram'; // дефолт
}

async function getContactPhone(deal) {
  if (!deal.CONTACT_ID) return null;
  try {
    const contact = await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID });
    const phones = Array.isArray(contact && contact.PHONE) ? contact.PHONE : [];
    const phone = phones[0] && phones[0].VALUE ? String(phones[0].VALUE).replace(/\D/g, '') : null;
    return phone || null;
  } catch (_) { return null; }
}

async function getContactEmail(deal) {
  if (!deal.CONTACT_ID) return null;
  try {
    const contact = await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID });
    const emails = Array.isArray(contact && contact.EMAIL) ? contact.EMAIL : [];
    return emails[0] && emails[0].VALUE ? String(emails[0].VALUE).trim() : null;
  } catch (_) { return null; }
}

async function sendEmailThroughBitrix(dealId, responsibleId, toEmail, dealTitle, text) {
  // Отправляем письмо через Bitrix crm.activity.add (тип EMAIL).
  // Это стандартный способ отправить email из Bitrix без внешнего SMTP —
  // письмо уходит с ящика подключённого к Bitrix и фиксируется в таймлайне сделки.
  await bitrixRestCall('crm.activity.add', {
    fields: {
      TYPE_ID: 4, // 4 = Email
      SUBJECT: `Ход работы по сделке: ${dealTitle}`,
      DESCRIPTION: text,
      DESCRIPTION_TYPE: 1, // 1 = text
      DIRECTION: 2, // 2 = исходящее
      OWNER_TYPE_ID: 2, // 2 = Deal
      OWNER_ID: dealId,
      RESPONSIBLE_ID: responsibleId || 1,
      COMPLETED: 'N',
      COMMUNICATIONS: [{ VALUE: toEmail, ENTITY_ID: 0, ENTITY_TYPE_ID: 3, TYPE: 'EMAIL' }],
    },
  });
}

async function findSiblingDeals(deal, stageId) {
  // Ищем другие сделки той же компании на той же стадии "Эксперт назначен".
  // Это нужно чтобы не слать клиенту 3-4 отдельных сообщения по каждой услуге,
  // а сформировать один общий ход работы по всем услугам сразу.
  if (!deal.COMPANY_ID) return [];
  try {
    const siblings = await bitrixRestList('crm.deal.list', {
      filter: {
        COMPANY_ID: deal.COMPANY_ID,
        CATEGORY_ID: config.autopilotCategoryId || 28,
        STAGE_ID: stageId,
      },
      select: ['ID', 'TITLE', 'STAGE_ID', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'COMPANY_ID',
        'OPPORTUNITY', 'CURRENCY_ID',
        process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071',
        process.env.PREFERRED_CONTACT_FIELD_CODE || 'UF_CRM_1781189436900',
      ],
    }, 20);
    // Исключаем текущую сделку из списка.
    return siblings.filter((s) => String(s.ID) !== String(deal.ID));
  } catch (_) { return []; }
}

function formatSiblingServicesNote(siblings) {
  if (!siblings.length) return '';
  const services = siblings.map((s) => {
    const svc = String(s[process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071'] || s.TITLE || `Сделка ${s.ID}`).trim();
    return `• ${svc} (сделка ${s.ID})`;
  }).join('\n');
  return `\n\n⚠️ Внимание: по этой компании найдено ${siblings.length + 1} сделки на стадии «Эксперт назначен». Ход работы сформирован общий для всех услуг:\n${services}`;
}

async function buildDealContext(deal, transcript) {
  const service = detectServiceFromDeal(deal);
  // ENTITY_TYPE в crm.timeline.comment.list принимает строку 'deal' (не числовой ID).
  // Используем также ENTITY_ID без префикса как требует REST API.
  let commentsText = '';
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal' },
      select: ['ID', 'COMMENT', 'DATE_CREATE'],
      order: { ID: 'DESC' },
    }, 30);
    commentsText = comments.map((c) => `${c.DATE_CREATE || c.CREATED || ''}: ${c.COMMENT || ''}`).join('\n');
  } catch (_) { commentsText = ''; }

  return {
    deal: {
      id: deal.ID,
      title: deal.TITLE,
      stage: deal.STAGE_ID,
      service,
      sum: deal.OPPORTUNITY,
      currency: deal.CURRENCY_ID,
      assignedById: deal.ASSIGNED_BY_ID,
    },
    product: { label: service, key: 'auto' },
    service,
    call_transcript: transcript,
    comments: commentsText,
    channel: detectPreferredChannel(deal),
    executor_mode: {
      enabled: true,
      preferredChannel: detectPreferredChannel(deal),
    },
  };
}

async function runServerAutopilotForDeal(deal, stageId) {
  const dealId = deal.ID;
  const logPrefix = `[autopilot deal=${dealId}]`;
  console.log(`${logPrefix} Запускаю автопилот для "${deal.TITLE}"`);

  try {
    // 1. Ищем запись звонка.
    const callRecord = await findCallForDeal(dealId);
    if (!callRecord) {
      console.log(`${logPrefix} Запись звонка не найдена — пропускаю, попробую в следующем цикле.`);
      return;
    }

    // 2. Расшифровываем.
    console.log(`${logPrefix} Расшифровываю звонок: ${callRecord.subject || callRecord.url}`);
    const transcript = await transcribeAudioUrl(callRecord.url, callRecord.fileName);
    if (!transcript || transcript.length < 30) {
      throw new Error(`Расшифровка слишком короткая или пустая: "${transcript.slice(0, 100)}"`);
    }

    // 3. Ищем сделки-компаньоны (другие услуги той же компании на той же стадии).
    const siblings = stageId ? await findSiblingDeals(deal, stageId) : [];
    const hasMultipleDeals = siblings.length > 0;
    if (hasMultipleDeals) {
      console.log(`${logPrefix} Найдено ${siblings.length} сопутствующих сделок по компании ${deal.COMPANY_ID}: ${siblings.map((s) => s.ID).join(', ')}`);
    }

    // 4. Строим объединённый контекст.
    console.log(`${logPrefix} Запускаю ИИ-анализ...`);
    const context = await buildDealContext(deal, transcript);
    if (hasMultipleDeals) {
      context.sibling_deals = siblings.map((s) => ({
        id: s.ID, title: s.TITLE, service: detectServiceFromDeal(s), sum: s.OPPORTUNITY,
      }));
      context.multiple_deals_note = `По этой компании одновременно в работе ${siblings.length + 1} услуги. Сформируй один общий ход работы и одно общее сообщение клиенту, упомянув все услуги. Не пиши отдельные сообщения для каждой услуги.`;
    }

    const scenarioCfg = aiScenarioConfig('executor_attestation_call');
    const productGuidance = productAiGuidance(context.product, scenarioCfg.scenario);
    const systemPrompt = [
      'Ты ИИ-ассистент Игорь, помощник эксперта производства MAVIS GROUP.',
      'ВАЖНО про канал связи в client_message: НИКОГДА не упоминай название конкретного мессенджера (Viber, Telegram, WhatsApp). Пиши просто "пришлите мне" / "отправьте мне" без названия канала.',
      'Возвращай только валидный JSON без markdown.',
    ].join('\n');
    const userPrompt = `${scenarioCfg.label}.\n\nЗадача:\n${scenarioCfg.instruction}\n\nПродуктовые правила:\n${productGuidance}\n\nКонтекст сделки:\n${JSON.stringify(context, null, 2).slice(0, 28000)}\n\nВерни JSON:\n{"status":"ok|partial|risk","status_label":"короткий статус по-русски","summary":["что понял из звонка и сделки"],"missing":["чего не хватает"],"risks":["риски"],"next_steps":["следующие шаги"],"tasks":[],"client_message":"полный текст сообщения клиенту с ходом работы по ВСЕМ услугам компании","comment":"полный ход работы для комментария в Bitrix","stage_decision":{"should_move":false,"target_stage_hint":"","reason":""}}`;

    const rawText = await callAiChatCompletion({
      model: config.aiModel,
      temperature: 0.2,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    });
    let aiResult = {};
    try { aiResult = JSON.parse(rawText); } catch (_) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) try { aiResult = JSON.parse(match[0]); } catch (_2) { aiResult = {}; }
    }

    const clientMessage = String(aiResult.client_message || '').trim();
    const dealComment = String(aiResult.comment || (aiResult.summary && aiResult.summary.join('; ')) || 'Автопилот выполнен').trim();
    const siblingNote = formatSiblingServicesNote(siblings);

    // 5. Отправляем сообщение клиенту: предпочитаемый → Telegram → Viber → Email.
    if (clientMessage) {
      const phone = await getContactPhone(deal);
      const email = await getContactEmail(deal);
      const preferredChannel = detectPreferredChannel(deal);
      const wazzupChannelsToTry = [];
      if (preferredChannel !== 'email') {
        wazzupChannelsToTry.push(preferredChannel);
        if (preferredChannel !== 'telegram') wazzupChannelsToTry.push('telegram');
        if (preferredChannel !== 'viber') wazzupChannelsToTry.push('viber');
      }
      let sent = false;
      if (phone) {
        for (const channelKey of wazzupChannelsToTry) {
          const ch = getConfiguredWazzupChannel(channelKey);
          if (!ch || !ch.channelId) continue;
          try {
            await sendWazzupMessageInternal({ channelKey, text: clientMessage, phone, dealId });
            console.log(`${logPrefix} Сообщение отправлено через ${channelKey}.`);
            sent = true;
            break;
          } catch (sendErr) {
            console.warn(`${logPrefix} ${channelKey} не сработал: ${sendErr.message} — пробуем следующий.`);
          }
        }
      }
      if (!sent && email) {
        try {
          await sendEmailThroughBitrix(dealId, deal.ASSIGNED_BY_ID, email, deal.TITLE, clientMessage);
          console.log(`${logPrefix} Сообщение отправлено через Email: ${email}.`);
          sent = true;
        } catch (emailErr) {
          console.error(`${logPrefix} Email не сработал: ${emailErr.message}`);
        }
      }
      if (!sent) console.warn(`${logPrefix} Не удалось отправить сообщение ни через один канал.`);
    }

    // 6. Комментарий в текущую сделку.
    const commentText = `${AUTOPILOT_MARKER}${siblingNote}\n\n${dealComment}`;
    await bitrixRestCall('crm.timeline.comment.add', {
      fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: commentText },
    });
    autopilotProcessed.add(String(dealId));

    // 7. Помечаем сопутствующие сделки — чтобы автопилот не запустился по ним отдельно.
    for (const sibling of siblings) {
      try {
        await bitrixRestCall('crm.timeline.comment.add', {
          fields: {
            ENTITY_ID: sibling.ID, ENTITY_TYPE: 'deal',
            COMMENT: `${AUTOPILOT_MARKER}\nОбработано совместно со сделкой ${dealId} (${deal.TITLE}). Ход работы и сообщение клиенту — в той сделке.`,
          },
        });
        autopilotProcessed.add(String(sibling.ID));
      } catch (_) {}
    }
    console.log(`${logPrefix} Готово.${hasMultipleDeals ? ` Помечены сопутствующие сделки: ${siblings.map((s) => s.ID).join(', ')}.` : ''}`);

  } catch (err) {
    console.error(`${logPrefix} Ошибка: ${err.message}`);
    try {
      await bitrixRestCall('crm.timeline.comment.add', {
        fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: `${AUTOPILOT_ERROR_MARKER}\nАвтопилот Игорь столкнулся с ошибкой: ${err.message}` },
      });
    } catch (_) {}
    autopilotProcessed.add(String(dealId));
  }
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
    const stageId = await getExpertStageId();
    if (!stageId) {
      console.warn('[autopilot] Стадия "Эксперт назначен" не найдена в воронке — проверь AUTOPILOT_CATEGORY_ID.');
      return;
    }

    // Берём сделки на нужной стадии, у которых переход на эту стадию произошёл ПОСЛЕ
    // старта сервера. MOVED_TIME — дата последней смены стадии, это точнее чем DATE_CREATE
    // (сделка могла быть создана давно, но перейти на "Эксперт назначен" уже после деплоя).
    const startDateStr = AUTOPILOT_START_DATE.toISOString().slice(0, 19);
    const deals = await bitrixRestList('crm.deal.list', {
      filter: {
        CATEGORY_ID: config.autopilotCategoryId || 28,
        STAGE_ID: stageId,
        '>=MOVED_TIME': startDateStr,
      },
      select: ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'COMPANY_ID',
        'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE', 'MOVED_TIME',
        process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071',
        process.env.PREFERRED_CONTACT_FIELD_CODE || 'UF_CRM_1781189436900',
      ],
    }, 50);

    console.log(`[autopilot] Цикл: найдено ${deals.length} сделок на стадии "${stageId}" после ${startDateStr}.`);

    for (const deal of deals) {
      if (autopilotProcessed.has(String(deal.ID))) continue;
      const alreadyDone = await dealAlreadyProcessed(deal.ID);
      if (alreadyDone) continue;
      await runServerAutopilotForDeal(deal, stageId);
      // Пауза между сделками чтобы не перегружать ИИ API и Bitrix.
      await new Promise((r) => setTimeout(r, 5000));
    }
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
});
