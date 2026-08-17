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
  aiControlFieldCode: process.env.AI_CONTROL_FIELD_CODE || process.env.STOP_AI_FIELD_CODE || 'UF_CRM_1784898776915',
  serverTasksEnabled: String(process.env.SERVER_TASKS_ENABLED || 'false').toLowerCase() === 'true',
  stageMonitoringEnabled: String(process.env.STAGE_MONITORING_ENABLED || 'false').toLowerCase() === 'true',
  requireAssignedExpertCall: String(process.env.REQUIRE_ASSIGNED_EXPERT_CALL || 'true').toLowerCase() !== 'false',
  strictPreferredChannel: String(process.env.STRICT_PREFERRED_CHANNEL || 'true').toLowerCase() !== 'false',
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

  // v45: ИИгорь — диагностика воронки прорабов.
  foremanCategoryId: Number(process.env.FOREMAN_CATEGORY_ID || 32),
  foremanStageFree: process.env.FOREMAN_STAGE_FREE || '',
  foremanStageBusy: process.env.FOREMAN_STAGE_BUSY || '',
  foremanStageCertExpiring: process.env.FOREMAN_STAGE_CERT_EXPIRING || '',
  // v52: стадия, куда переводим прораба после закрытия производственной сделки.
  // Не заменяет FOREMAN_STAGE_FREE, чтобы свободные кандидаты продолжали искаться только в 'Свободен'.
  foremanStageAfterClose: process.env.FOREMAN_STAGE_AFTER_CLOSE || process.env.FOREMAN_STAGE_CONTROL_DISMISSAL || '',
  foremanFieldWorkType: process.env.FOREMAN_FIELD_WORK_TYPE || '',
  foremanFieldCertExpires: process.env.FOREMAN_FIELD_CERT_EXPIRES || '',
  foremanFieldPhone: process.env.FOREMAN_FIELD_PHONE || '',
  foremanFieldCertNumber: process.env.FOREMAN_FIELD_CERT_NUMBER || '',
  foremanFieldProductionDeal: process.env.FOREMAN_FIELD_PRODUCTION_DEAL || '',

  // v47: ИИгорь — автоматическая связка производственных сделок с воронкой прорабов.
  // Поле в сделке производства, где хранится ID/ссылка на сделку прораба из воронки 32.
  foremanProductionSpecialistField: process.env.FOREMAN_PRODUCTION_SPECIALIST_FIELD || process.env.FOREMAN_PRODUCTION_FOREMAN_FIELD || 'UF_CRM_1784528226',
  // v54: если создали новое множественное поле 'Специалисты', ставим true.
  // Тогда ИИгорь не заменяет старого прораба, а добавляет нового в массив значений.
  foremanProductionSpecialistFieldMultiple: String(process.env.FOREMAN_PRODUCTION_SPECIALIST_FIELD_MULTIPLE || 'false').toLowerCase() === 'true',
  foremanAutomationEnabled: String(process.env.FOREMAN_AUTOMATION_ENABLED || 'false').toLowerCase() === 'true',
  foremanPollIntervalMinutes: Number(process.env.FOREMAN_POLL_INTERVAL_MINUTES || 60),
  foremanLookbackDays: Number(process.env.FOREMAN_LOOKBACK_DAYS || 45),
  foremanCreateSuggestionTasks: String(process.env.FOREMAN_CREATE_SUGGESTION_TASKS || 'true').toLowerCase() !== 'false',
  foremanTasksEnabled: String(process.env.FOREMAN_TASKS_ENABLED || 'true').toLowerCase() !== 'false',
  foremanSuggestionScanEnabled: String(process.env.FOREMAN_SUGGESTION_SCAN_ENABLED || 'true').toLowerCase() !== 'false',
  foremanMaxProductionDeals: Number(process.env.FOREMAN_MAX_PRODUCTION_DEALS || 300),
  // v51: Роботы Bitrix запускают ИИгоря сразу при привязке/закрытии сделки.
  // Если задан FOREMAN_ROBOT_TOKEN, его нужно передавать в body/query робота как token.
  foremanRobotToken: process.env.FOREMAN_ROBOT_TOKEN || '',
  foremanPropagateToCompanyDeals: String(process.env.FOREMAN_PROPAGATE_TO_COMPANY_DEALS || 'true').toLowerCase() !== 'false',
  // v53: антидубль для бизнес-процессов Bitrix. Когда сервер сам проставляет прораба
  // в соседние сделки компании, бизнес-процесс на этих сделках тоже может запуститься.
  // Эти флаги не дают создавать 4–5 одинаковых уведомлений/комментариев.
  foremanAddPropagationComments: String(process.env.FOREMAN_ADD_PROPAGATION_COMMENTS || 'false').toLowerCase() === 'true',
  foremanSkipPropagatedWebhookMinutes: Number(process.env.FOREMAN_SKIP_PROPAGATED_WEBHOOK_MINUTES || 20),

  // v55: пушинг актов — при успешном закрытии производства создать задачу на сбор оригинала акта.
  actsTasksEnabled: String(process.env.ACTS_TASKS_ENABLED || 'true').toLowerCase() !== 'false',
  actsProjectId: Number(process.env.ACTS_PROJECT_ID || 36),
  actsResponsibleId: process.env.ACTS_RESPONSIBLE_ID || process.env.TANYA_USER_ID || '2182',
  actsAuditorIds: parseIdList(process.env.ACTS_AUDITOR_IDS || ''),
  // Если знаешь ID стадии "Сбор" в проекте Акты счета — укажи. Если пусто, задача создаётся в проекте без принудительной стадии.
  actsCollectionStageId: process.env.ACTS_COLLECTION_STAGE_ID || '',
  actsTaskTitlePrefix: process.env.ACTS_TASK_TITLE_PREFIX || 'СОБРАТЬ АКТ',
  actsDuplicateWindowDays: Number(process.env.ACTS_DUPLICATE_WINDOW_DAYS || 120),
  // v57: когда задача в проекте "Акты счета" перешла в "Сделано", отправляем акт клиенту.
  actsSendToClientEnabled: String(process.env.ACTS_SEND_TO_CLIENT_ENABLED || 'true').toLowerCase() !== 'false',
  // v58: канал отправки акта больше НЕ задаём жёстко. Берём из поля "Предпочитаемый способ связи":
  // Email -> письмо, Telegram -> Wazzup Telegram, Viber -> Wazzup Viber.
  // ACTS_SEND_CHANNEL оставлен только как legacy/fallback для старых ручных тестов, в основной логике не используется.
  actsSendChannel: process.env.ACTS_SEND_CHANNEL || '',
  actsDoneStageId: process.env.ACTS_DONE_STAGE_ID || '',
  actsClientMessage: process.env.ACTS_CLIENT_MESSAGE || '',
};

// Прямой вызов Bitrix REST через входящий вебхук — нужен, потому что вебхук Wazzup может прийти,
// когда никто не открыл Bitrix в браузере (там работа идёт через BX24.callMethod, что недоступно
// здесь). Используется только живым ботом (вебхук-обработчик), не основным приложением.
async function bitrixRestCall(method, params = {}) {
  // v44: ассистент-исполнитель НЕ создаёт задачи автоматически.
  // Все серверные задачи выключены по умолчанию, чтобы не было дублей каждые 30 минут.
  // Если когда-то нужно вернуть серверные задачи — явно поставь SERVER_TASKS_ENABLED=true.
  if (String(method || '').toLowerCase() === 'tasks.task.add' && !config.serverTasksEnabled) {
    const title = params && params.fields ? String(params.fields.TITLE || '') : '';
    const isForemanTask = /^ИИгорь:/i.test(title) && config.foremanTasksEnabled;
    const isActsTask = (title.includes('[MAVIS_ACTS_ORIGINAL]') || /^СОБРАТЬ АКТ/i.test(title) || /^АКТ/i.test(title)) && config.actsTasksEnabled;
    if (!isForemanTask && !isActsTask) {
      console.log(`[tasks] blocked by SERVER_TASKS_ENABLED=false: ${title || 'без названия'}`);
      return { task: { id: null, blocked: true } };
    }
    console.log(`[tasks] allowed as ${isActsTask ? 'acts' : 'foreman'} task: ${title || 'без названия'}`);
  }
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
      'ПРИОРИТЕТ ИНФОРМАЦИИ: звонок > комментарии менеджера > поля сделки. Не используй имя клиента в приветствии — начинай сообщение нейтрально: «Добрый день!».',
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
      '1. "Добрый день!" — без имени клиента и без упоминаний себя, компании, мессенджера',
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
      instruction: 'Сформируй ход работы по сделке для эксперта. Нужно: действия MAVIS GROUP, действия клиента, что уточнить, дедлайны/контрольные точки, риски сдвига сроков, черновик сообщения клиенту человеческим языком, комментарий в сделку, рекомендуемые действия. Не обещай клиенту сроки, если они не указаны в данных.'
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
      instruction: 'Ты ассистент-исполнитель по сделке аттестации организации. На основании сделки, КП/комментариев и расшифровки первичного звонка сформируй рабочий маршрут исполнения. Обязательно: 1) кратко что понял из передачи и звонка; 2) схема специалистов: директор/руководитель, ГИ, прораб/мастер по видам работ, кого переводим/аттестуем/подбираем; 3) какие данные отсутствуют; 4) ход работы для клиента; 5) сообщение клиенту; 6) комментарий Кристине; 7) список следующих действий ассистента без постановки задач в Bitrix; 8) этап по ЛК Белстройцентра: запрос письма/ссылки, регистрация/заявка, номер заявки или остановка при капче/ошибке; 9) решение по стадии сделки в Bitrix: двигать дальше по воронке или оставить как есть, с понятной причиной.'
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
async function sendWazzupMessageInternal({ channelKey, text, phone, chatId, username, dealId, ignoreStrictPreferredChannel = false }) {
  const apiKey = process.env.WAZZUP_API_KEY || '';
  const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
  if (!apiKey) throw new Error('WAZZUP_API_KEY не задан в Render Environment.');

  const configured = getConfiguredWazzupChannel(channelKey);
  if (!configured || !configured.channelId) throw new Error(`Wazzup-канал ${channelKey || 'по умолчанию'} не задан в Render Environment.`);

  if (dealId) {
    const deal = await loadFreshDeal(dealId);
    if (isDealAiDisabled(deal)) throw new Error('Поле ИИ=Нет — отправка клиенту заблокирована.');
    if (config.strictPreferredChannel && !ignoreStrictPreferredChannel) {
      const preferred = detectPreferredChannel(deal);
      if (!preferred || preferred === 'email') {
        throw new Error(`Строгий режим канала: в сделке не выбран Telegram/Viber для Wazzup (выбрано: ${preferred || 'не распознано'}).`);
      }
      if (configured.key !== preferred) {
        throw new Error(`Строгий режим канала: выбран ${preferredChannelLabel(preferred)}, поэтому ${configured.label} не используем.`);
      }
    }
  }

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


async function sendWazzupFileInternal({ channelKey, contentUri, phone, chatId, username, dealId, fileName }) {
  const apiKey = process.env.WAZZUP_API_KEY || '';
  const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
  if (!apiKey) throw new Error('WAZZUP_API_KEY не задан в Render Environment.');

  const configured = getConfiguredWazzupChannel(channelKey || 'viber');
  if (!configured || !configured.channelId) throw new Error(`Wazzup-канал ${channelKey || 'viber'} не задан в Render Environment.`);

  const url = String(contentUri || '').trim();
  if (!url) throw new Error('contentUri файла пустой — Wazzup не сможет забрать файл.');

  const cleanPhone = normalizeWazzupPhone(phone || '');
  const cleanChatId = normalizeWazzupPhone(chatId || '');
  const cleanUsername = normalizeWazzupUsername(username || '');

  const payload = {
    channelId: configured.channelId,
    chatType: configured.chatType,
    contentUri: url,
    crmMessageId: `mavis-acts-file-${configured.key}-${dealId || 'deal'}-${Date.now()}`,
    clearUnanswered: false,
  };

  if (configured.chatType === 'telegram') {
    if (cleanChatId) payload.chatId = cleanChatId;
    else if (cleanPhone) payload.phone = cleanPhone;
    else if (cleanUsername) payload.username = cleanUsername;
    else throw new Error('Для Telegram Wazzup не найден телефон/chatId/username клиента.');
  } else {
    const recipientId = cleanChatId || cleanPhone;
    if (!recipientId) throw new Error(`Для ${configured.label} не найден chatId/телефон клиента.`);
    payload.chatId = recipientId;
  }

  const resp = await fetch(`${baseUrl}/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const responseText = await resp.text();
  const data = (() => { try { return JSON.parse(responseText); } catch (_) { return {}; } })();
  if (!resp.ok || (data && data.error)) {
    const message = compactWazzupError(data, responseText ? responseText.slice(0, 300) : `HTTP ${resp.status} без тела ответа`);
    const err = new Error(`Wazzup ${configured.label} файл ${fileName || ''}: ${message}`);
    err.safePayload = { ...payload, contentUri: '[hidden]' };
    err.possiblyDelivered = resp.status >= 500;
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

function normalizeControlValue(value) {
  if (Array.isArray(value)) return value.map(normalizeControlValue).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(normalizeControlValue).join(' ');
  return String(value === undefined || value === null ? '' : value).toLowerCase().trim();
}

function isNoValue(value) {
  const v = normalizeControlValue(value);
  return /^(нет|no|false|0|n|off|выкл|отключено|не трогать)$/i.test(v) || v.includes('ии нет') || v.includes('не трогать');
}

function isDealAiDisabled(deal) {
  if (!deal) return false;
  const codes = [...new Set([config.aiControlFieldCode, 'UF_CRM_1784898776915'].filter(Boolean))];
  return codes.some((code) => Object.prototype.hasOwnProperty.call(deal, code) && isNoValue(deal[code]));
}

async function loadFreshDeal(dealOrId) {
  const id = typeof dealOrId === 'object' ? dealOrId.ID : dealOrId;
  if (!id) return dealOrId || null;
  try {
    const fresh = await bitrixRestCall('crm.deal.get', { id });
    return typeof dealOrId === 'object' ? { ...dealOrId, ...(fresh || {}) } : fresh;
  } catch (_) {
    return dealOrId || null;
  }
}

async function isDealAiDisabledAsync(dealOrId) {
  const deal = await loadFreshDeal(dealOrId);
  return isDealAiDisabled(deal);
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


async function processIncomingEmails() {
  const emailUser = process.env.MAIL_IMAP_USER || '';
  const emailPass = process.env.MAIL_IMAP_PASSWORD || '';
  const imapHost = process.env.MAIL_IMAP_HOST || 'imap.mail.ru';
  const imapPort = Number(process.env.MAIL_IMAP_PORT || 993);

  if (!emailUser || !emailPass) {
    console.log('[email] MAIL_IMAP_USER / MAIL_IMAP_PASSWORD не заданы — обработка почты выключена.');
    return;
  }
  if (!config.bitrixWebhookUrl) {
    console.log('[email] BITRIX_WEBHOOK_URL не задан — обработка почты невозможна.');
    return;
  }

  // ✅ ФИЛЬТР СПАМА: Список автоматических отправителей которых игнорируем
  const SPAM_SENDERS = [
    /robot@/i,
    /noreply@/i,
    /no-reply@/i,
    /support@/i,
    /admin@/i,
    /notification@/i,
    /alert@/i,
    /info@yandex/i,
    /info@npmos/i,
    /hello@atevi/i, // платёжные напоминания
    /docudream@edn/i, // электронные торги
    /auction24/i,
    /invoice@/i,
    /billing@/i,
  ];

  function isSpamSender(email) {
    return SPAM_SENDERS.some(pattern => pattern.test(email));
  }

  let client;
  try {
    client = new ImapFlow({
      host: imapHost,
      port: imapPort,
      secure: true,
      auth: { user: emailUser, pass: emailPass },
      logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      // Ищем непрочитанные письма.
      const uids = await client.search({ seen: false });
      if (!uids || !uids.length) {
        console.log('[email] Новых писем нет.');
        return;
      }
      console.log(`[email] Найдено ${uids.length} непрочитанных писем.`);

      for (const uid of uids) {
        try {
          const msgData = await client.fetchOne(uid, { source: true });
          if (!msgData || !msgData.source) continue;
          const parsed = await simpleParser(msgData.source);

          const senderEmail = parsed.from && parsed.from.value && parsed.from.value[0] ? parsed.from.value[0].address : '';
          const subject = parsed.subject || '';
          const attachments = (parsed.attachments || []).filter((a) => a.size > 0);

          console.log(`[email] Письмо от ${senderEmail}, тема: "${subject}", вложений: ${attachments.length}`);

          // ✅ ФИЛЬТР СПАМА
          if (isSpamSender(senderEmail)) {
            console.log(`[email] ⏭️ Спам от ${senderEmail} — помечаю прочитанным и пропускаю`);
            await client.messageFlagsAdd(uid, ['\\Seen']);
            continue;
          }

          // Письма без вложений не обрабатываем
          if (!attachments.length) {
            await client.messageFlagsAdd(uid, ['\\Seen']);
            continue;
          }

          // ✅ 1. ПЕРВЫЙ СПОСОБ: Ищем email в CRM
          let matchInfo = await findContactAndDealsByEmail(senderEmail);
          
          if (!matchInfo || !matchInfo.deals.length) {
            console.log(`[email] Email ${senderEmail} не найден в CRM — пробую Vision анализ...`);
            
            // ✅ 2. ВТОРОЙ СПОСОБ: Vision анализ вложений
            let visionCompany = null;
            let visionConfidence = 'low';
            
            for (const att of attachments) {
              try {
                // ✅ УЛУЧШЕННЫЙ ПРОМПТ для Vision
                const analysis = await analyzeDocumentWithVisionForCompany(att.content, att.filename || 'file', att.contentType);
                
                if (analysis.company && analysis.confidence !== 'low') {
                  visionCompany = analysis.company;
                  visionConfidence = analysis.confidence;
                  console.log(`[email] ✅ Vision нашёл компанию: "${visionCompany}" (${analysis.confidence})`);
                  break;
                }
              } catch (_) {}
              await new Promise((r) => setTimeout(r, 500));
            }

            // ✅ 3. ЕСЛИ Vision сработал - ищем сделку по названию компании в Bitrix
            if (visionCompany) {
              console.log(`[email] 🔍 Ищу сделку по названию компании: "${visionCompany}"`);
              matchInfo = await findDealsByCompanyName(visionCompany);
            }

            // ✅ 4. ЕСЛИ НИЧЕГО НЕ СРАБОТАЛО - загружаем в "Неопределённые"
            if (!matchInfo || !matchInfo.deals || !matchInfo.deals.length) {
              console.log(`[email] ⚠️ Компания не определена — загружаю в папку "Неопределённые"`);
              
              try {
                const undefFolder = await getOrCreateCompanyFolder('Неопределённые документы');
                const savedFiles = [];
                
                for (const att of attachments) {
                  try {
                    await uploadFileToDiskFolder(undefFolder, `${new Date().toISOString().slice(0,10)}_${att.filename || 'file'}`, att.content);
                    savedFiles.push(att.filename || 'файл');
                    console.log(`[email] 📁 Загружен в "Неопределённые": "${att.filename}"`);
                  } catch (upErr) {
                    console.warn(`[email] Ошибка загрузки ${att.filename}: ${upErr.message}`);
                  }
                }
                
                // Помечаем прочитанным
                await client.messageFlagsAdd(uid, ['\\Seen']);
                console.log(`[email] ✅ Загружено ${savedFiles.length} файлов в "Неопределённые"`);
              } catch (e) {
                console.warn(`[email] Ошибка загрузки в "Неопределённые": ${e.message}`);
              }
              continue;
            }
          }

          // ✅ ЕСЛИ СДЕЛКА НАЙДЕНА - обрабатываем как обычно
          const { contact, deals } = matchInfo;
          const companyName = await getCompanyName(contact.COMPANY_ID) || deals[0].TITLE || `Контакт ${contact.ID}`;
          const folderId = await getOrCreateCompanyFolder(companyName);

          console.log(`[email] ✅ Найдена сделка! Загружаю в папку: "${companyName}"`);

          // Сохраняем файлы и анализируем
          const savedFileNames = [];
          const analyzedDocs = [];
          
          for (const att of attachments) {
            try {
              await uploadFileToDiskFolder(folderId, att.filename || 'file', att.content);
              savedFileNames.push(att.filename || 'без имени');
            } catch (upErr) {
              console.warn(`[email] Не удалось загрузить файл ${att.filename}: ${upErr.message}`);
            }
            
            // Анализируем через Vision
            try {
              const analysis = await analyzeDocumentWithVision(att.content, att.filename || 'file', att.contentType);
              analyzedDocs.push({ fileName: att.filename || 'без имени', ...analysis });
              console.log(`[email] "${att.filename}" → ${analysis.docType} (${analysis.confidence})`);
            } catch (_) {
              analyzedDocs.push({ fileName: att.filename || 'без имени', docType: 'другое', confidence: 'low' });
            }
            await new Promise((r) => setTimeout(r, 1000));
          }

          // Добавляем комментарий в сделку
          if (savedFileNames.length) {
            for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю без задач/комментариев/сообщений.`);
        continue;
      }

              try {
                const expertUsers = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
                const expertUser = Array.isArray(expertUsers) ? expertUsers[0] : expertUsers;
                const expertName = expertUser ? `${expertUser.NAME || ''} ${expertUser.LAST_NAME || ''}`.trim() : '';
                const petName = getDiminutiveName(expertName);

                const completeness = await checkDocumentCompleteness(deal, analyzedDocs, companyName);
                const isComplete = completeness && completeness.complete;
                const missingList = completeness && completeness.missing && completeness.missing.length
                  ? completeness.missing.map((m) => `— ${m}`).join('\n')
                  : '';
                const expertComment = completeness && completeness.expert_comment
                  ? completeness.expert_comment
                  : `Клиент прислал: ${savedFileNames.join(', ')}`;

                const commentText = isComplete
                  ? `✅ ${petName}, комплект документов собран! Можно готовить пакет.\n\n${expertComment}`
                  : `📨 ${petName}, клиент прислал документы — не полный комплект.\n\n${expertComment}${missingList ? `\n\nНе хватает:\n${missingList}` : ''}`;

                await bitrixRestCall('crm.timeline.comment.add', {
                  fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: commentText },
                });

                if (!isComplete) {
                  const tomorrow = addWorkingDays(new Date(), 1);
                  tomorrow.setHours(18, 0, 0, 0);
                  await bitrixRestCall('tasks.task.add', {
                    fields: {
                      TITLE: `${petName}, клиент прислал документы — нужно проверить комплект`,
                      DESCRIPTION: commentText,
                      RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
                      DEADLINE: tomorrow.toISOString().slice(0, 19) + '+03:00',
                      UF_CRM_TASK: [`D_${deal.ID}`],
                      PRIORITY: 1,
                    },
                  });
                }
              } catch (taskErr) {
                console.warn(`[email] Ошибка обработки сделки ${deal.ID}: ${taskErr.message}`);
              }
            }
          }

          await client.messageFlagsAdd(uid, ['\\Seen']);
        } catch (msgErr) {
          console.error(`[email] Ошибка обработки письма uid=${uid}: ${msgErr.message}`);
        }
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`[email] Ошибка IMAP-подключения: ${err.message}`);
  } finally {
    if (client) { try { await client.logout(); } catch (_) {} }
  }
}

// ✅ НОВАЯ ФУНКЦИЯ: Vision анализ ДЛЯ КОМПАНИИ
// Отправляет специальный промпт чтобы найти название компании
async function analyzeDocumentWithVisionForCompany(fileContent, fileName, contentType) {
  try {
    // Кодируем в base64
    const base64Content = Buffer.isBuffer(fileContent) 
      ? fileContent.toString('base64') 
      : Buffer.from(fileContent).toString('base64');

    // Определяем тип медиа
    let mediaType = 'application/pdf';
    if (contentType) {
      mediaType = contentType;
    } else if (fileName) {
      if (fileName.match(/\.(jpg|jpeg|png|gif)$/i)) mediaType = 'image/jpeg';
      else if (fileName.match(/\.pdf$/i)) mediaType = 'application/pdf';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: base64Content,
                },
              },
              {
                type: 'text',
                text: `Это деловой документ. Определи:
1. Название компании/организации в документе (ООО, ИП, АО и т.д.)
2. Уровень уверенности: high (явно видно), medium (можно определить), low (не ясно)

Ответь ТОЛЬКО JSON: {"company": "название", "confidence": "high|medium|low"}

ВАЖНО: Ищи в начале документа, на бланке, в подписях. Если название компании не видно — вернись {"company": null, "confidence": "low"}`,
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn(`[email] Vision API error: ${response.status}`);
      return { company: null, confidence: 'low' };
    }

    const data = await response.json();
    const textContent = data.content?.find((c) => c.type === 'text')?.text || '';

    try {
      const result = JSON.parse(textContent);
      return {
        company: result.company,
        confidence: result.confidence || 'low',
      };
    } catch (_) {
      return { company: null, confidence: 'low' };
    }
  } catch (err) {
    console.warn(`[email] Ошибка Vision анализа: ${err.message}`);
    return { company: null, confidence: 'low' };
  }
}

// ✅ НОВАЯ ФУНКЦИЯ: Поиск сделки по названию компании
async function findDealsByCompanyName(companyNameQuery) {
  try {
    // Нормализуем название
    const normalized = normalizeCompanyNameForMatch(companyNameQuery);

    if (!normalized) return null;

    // Ищем компанию в CRM (нечёткий поиск)
    const companies = await bitrixRestList('crm.company.list', {
      filter: { '~TITLE': normalized },
      select: ['ID', 'TITLE'],
    }, 50);

    if (!companies || !companies.length) {
      console.log(`[email] Компания "${companyNameQuery}" не найдена в CRM`);
      return null;
    }

    const company = companies[0];
    console.log(`[email] Найдена компания: "${company.TITLE}"`);

    // Ищем сделки этой компании
    const deals = await bitrixRestList('crm.deal.list', {
      filter: {
        COMPANY_ID: company.ID,
        STAGE_ID: ['C28:5', 'C28:6', 'C28:7'], // Подбор, Сбор информации, Документы готовы
      },
      select: ['ID', 'TITLE', 'ASSIGNED_BY_ID'],
    }, 50);

    if (!deals || !deals.length) {
      console.log(`[email] Сделки компании "${company.TITLE}" не найдены`);
      return null;
    }

    return {
      contact: { COMPANY_ID: company.ID },
      deals: deals,
    };
  } catch (err) {
    console.error(`[email] Ошибка поиска сделки: ${err.message}`);
    return null;
  }
}

module.exports = { processIncomingEmails };


// ============================================================================
// v60: СЕРВЕРНЫЙ АВТОПИЛОТ — фоновый polling, запускается автоматически
// без участия эксперта. Мониторит воронку производства, при появлении
// записи звонка в сделке на стадии "Эксперт назначен" — запускает полный
// цикл: расшифровка → анализ → сообщение клиенту → комментарий в сделку.
// ============================================================================

// ============================================================================
// МОНИТОРИНГ НЕРАСПРЕДЕЛЁННЫХ СДЕЛОК
// Каждые 10 минут проверяет сделки на стадии "Не распределённые" воронки 28.
// Если сделка висит 4+ рабочих часа (9:00–18:00 пн–пт) — уведомляет Таню Куровскую.
// Повторяет каждые 4 рабочих часа пока не распределят.
// ============================================================================

const TANYA_USER_ID = 2182; // Татьяна Куровская
const NPS_GROUP_ID = 114;   // Группа задач "Сбор NPS"
const UNASSIGNED_NOTIFIED = new Map(); // dealId → lastNotifiedAt (Date)

function isWorkingHour(date = new Date()) {
  const day = date.getDay(); // 0=вс, 6=сб
  const hour = date.getHours();
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

function workingHoursBetween(from, to) {
  // Считаем рабочие часы (9-18, пн-пт) между двумя датами.
  let count = 0;
  const cur = new Date(from);
  while (cur < to) {
    if (isWorkingHour(cur)) count++;
    cur.setHours(cur.getHours() + 1);
  }
  return count;
}

async function hasRecentUnassignedTask(dealId) {
  // Проверяем есть ли уже задача по этой сделке созданная за последние 4 рабочих часа.
  // Это защита от дублирования после рестарта сервера когда UNASSIGNED_NOTIFIED очищается.
  try {
    const tasks = await bitrixRestList('tasks.task.list', {
      filter: {
        RESPONSIBLE_ID: TANYA_USER_ID,
        '>=CREATED_DATE': addWorkingDays(new Date(), -1).toISOString().slice(0, 10),
        UF_CRM_TASK: `D_${dealId}`,
      },
      select: ['ID', 'TITLE', 'CREATED_DATE'],
    }, 10);
    const now = new Date();
    return tasks.some((t) => {
      const created = new Date(t.CREATED_DATE);
      return workingHoursBetween(created, now) < 4;
    });
  } catch (_) { return false; }
}

async function generateDocListDocx(deal) {
  try {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
    const service = detectServiceFromDeal(deal);
    const docList = getDocumentListForService(service);
    const companyName = deal.TITLE || `Сделка ${deal.ID}`;
    const children = [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: `Перечень документов: ${docList.title}`, bold: true, size: 28, font: 'Arial' })] }),
      new Paragraph({ children: [new TextRun({ text: `Компания: ${companyName}`, size: 22, font: 'Arial', color: '666666' })], spacing: { after: 200 } }),
      ...docList.docs.map((doc, i) => new Paragraph({ children: [new TextRun({ text: `${i + 1}. ${doc}`, size: 22, font: 'Arial' })], spacing: { before: 80, after: 80 } })),
    ];
    if (/спк|стк/i.test(service)) {
      children.push(
        new Paragraph({ children: [new TextRun({ text: '', size: 22 })], spacing: { before: 200 } }),
        new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: 'Средства измерений', bold: true, size: 24, font: 'Arial' })] }),
        ...['Рулетка (поверка)', 'Линейка металлическая (поверка)', 'Нивелир (поверка)', 'Теодолит (поверка)', 'Уровень строительный (поверка)', 'Штангенциркуль (поверка)', 'Щупы, комплект (поверка)', 'Угольник (поверка)', 'Влагомер (поверка)', 'Гигрометр (поверка)', 'Плотномер (поверка)', 'Рейка 2000/3000 мм (аттестация)', 'Динамометрический ключ (поверка)', '2 манометра (поверка)']
          .map((si, i) => new Paragraph({ children: [new TextRun({ text: `${i + 1}. ${si}`, size: 22, font: 'Arial', color: '1a5276' })], spacing: { before: 60, after: 60 } }))
      );
    }
    children.push(
      new Paragraph({ children: [new TextRun({ text: '', size: 22 })], spacing: { before: 300 } }),
      new Paragraph({ children: [new TextRun({ text: 'Все документы присылайте на почту: mavis.group@mail.ru', bold: true, size: 22, font: 'Arial', color: '1a5276' })] }),
    );
    const doc = new Document({ sections: [{ children }], styles: { default: { document: { run: { font: 'Arial', size: 22 } } } } });
    return await Packer.toBuffer(doc);
  } catch (e) {
    console.warn(`[autopilot] Не удалось создать docx перечня: ${e.message}`);
    return null;
  }
}

// ✅ НОВАЯ ФУНКЦИЯ: Создать или найти папку по месяцу
async function getOrCreateMonthFolder(rootId = 0) {
  try {
    const now = new Date();
    const monthFolder = now.toISOString().slice(0, 7); // "YYYY-MM"
    
    const children = await bitrixRestList('disk.folder.getchildren', { id: rootId }, 500);
    let monthFolderObj = children.find((c) => c.TYPE === 'folder' && c.NAME === monthFolder);
    
    if (!monthFolderObj) {
      monthFolderObj = await bitrixRestCall('disk.folder.addsubfolder', { 
        id: rootId, 
        data: { NAME: monthFolder } 
      });
      console.log(`[disk] Создана папка месяца: ${monthFolder}`);
    }
    
    return monthFolderObj.ID;
  } catch (e) {
    console.error(`[disk] Ошибка при создании папки месяца: ${e.message}`);
    return rootId;
  }
}

async function uploadDocxToDisk(buffer, fileName) {
  try {
    // ✅ ИСПРАВЛЕНО: Загружаем в папку месяца вместо корня
    const monthFolderId = await getOrCreateMonthFolder(0);
    const base64 = buffer.toString('base64');
    const result = await bitrixRestCall('disk.folder.uploadfile', {
      id: monthFolderId,
      data: { NAME: fileName },
      fileContent: [fileName, base64],
      generateUniqueName: true,
    });
    return result && (result.DOWNLOAD_URL || result.downloadUrl) || null;
  } catch (e) {
    console.error(`[disk] Ошибка загрузки ${fileName}: ${e.message}`);
    return null;
  }
}

async function findNpsForCompany(companyName, companyId) {
  // Ищем задачи NPS в группе 114 по названию компании.
  try {
    const tasks = await bitrixRestList('tasks.task.list', {
      filter: { GROUP_ID: NPS_GROUP_ID },
      select: ['ID', 'TITLE', 'DESCRIPTION', 'RESPONSIBLE_ID', 'CREATED_DATE', 'UF_AUTO_892018444'],
      order: { CREATED_DATE: 'DESC' },
    }, 200);

    // Нормализуем название компании для поиска.
    const normName = normalizeCompanyNameForMatch(companyName);
    const companyTasks = tasks.filter((t) => {
      const title = normalizeCompanyNameForMatch(t.TITLE || '');
      const desc = normalizeCompanyNameForMatch(t.DESCRIPTION || '');
      return title.includes(normName) || desc.includes(normName) || (normName && (title.includes(normName.slice(0, 6)) || desc.includes(normName.slice(0, 6))));
    });

    if (!companyTasks.length) return null;

    // Берём последнюю задачу NPS.
    const lastTask = companyTasks[0];

    // Ищем оценку NPS в описании (обычно число от 0 до 10).
    const descText = String(lastTask.DESCRIPTION || lastTask.TITLE || '');
    const scoreMatch = descText.match(/nps[:\s]*(\d+)|оценк[аи][:\s]*(\d+)|балл[ов]*[:\s]*(\d+)|(\d+)\s*балл|(\d+)\/10/i);
    const score = scoreMatch ? parseInt(scoreMatch[1] || scoreMatch[2] || scoreMatch[3] || scoreMatch[4] || scoreMatch[5]) : null;

    // Ищем имя эксперта — ответственный за задачу NPS.
    let expertName = '';
    try {
      const u = await bitrixRestCall('user.get', { ID: lastTask.RESPONSIBLE_ID });
      const user = Array.isArray(u) ? u[0] : u;
      expertName = user ? `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim() : '';
    } catch (_) {}

    // Если NPS низкий (≤6) — пробуем найти причину в описании.
    let reason = null;
    if (score !== null && score <= 6) {
      // Спрашиваем ИИ чтобы кратко объяснил причину низкого NPS.
      try {
        const rawText = await callAiChatCompletion({
          model: config.aiModel,
          temperature: 0.1,
          messages: [{
            role: 'user',
            content: `Из текста NPS-опроса выяви главную причину низкой оценки в одной короткой фразе (до 10 слов). Текст: "${descText.slice(0, 1000)}". Ответь только фразой без кавычек, или "причина не указана".`,
          }],
        });
        reason = rawText.trim().replace(/^["']|["']$/g, '');
      } catch (_) {}
    }

    return { score, expertName, reason, taskId: lastTask.ID };
  } catch (e) {
    console.warn(`[unassigned] Ошибка поиска NPS: ${e.message}`);
    return null;
  }
}

async function isNewClient(companyId, companyName) {
  // Клиент новый если у компании нет других закрытых/завершённых сделок в CRM.
  if (!companyId) return true;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { COMPANY_ID: companyId, 'STAGE_SEMANTIC_ID': 'S' }, // S = успешно закрытые
      select: ['ID'],
    }, 5);
    return deals.length === 0;
  } catch (_) { return true; }
}

async function getPreviousExpert(companyId) {
  // Ищем последнего ответственного по завершённым сделкам этой компании.
  if (!companyId) return null;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { COMPANY_ID: companyId },
      select: ['ID', 'ASSIGNED_BY_ID', 'DATE_MODIFY'],
      order: { DATE_MODIFY: 'DESC' },
    }, 3);
    if (!deals.length) return null;
    const u = await bitrixRestCall('user.get', { ID: deals[0].ASSIGNED_BY_ID });
    const user = Array.isArray(u) ? u[0] : u;
    return user ? `${user.NAME || ''}`.trim() : null;
  } catch (_) { return null; }
}

async function notifyTanyaAboutUnassignedDeal(deal) {
  const dealId = deal.ID;
  const companyId = deal.COMPANY_ID;
  const companyName = deal.TITLE || `Сделка ${dealId}`;

  // Определяем новый клиент или нет.
  const isNew = await isNewClient(companyId, companyName);
  let msgBody = '';

  if (isNew) {
    msgBody = `Таня, распредели новую сделку! Это новый клиент 🆕\n\nСделка: ${companyName} (ID ${dealId})\nhttps://mavisgroup.bitrix24.by/crm/deal/details/${dealId}/`;
  } else {
    // Ищем NPS и предыдущего эксперта.
    const nps = await findNpsForCompany(companyName, companyId);
    const prevExpert = await getPreviousExpert(companyId);
    const expertLine = prevExpert ? `, с ним работал${prevExpert.endsWith('а') ? 'а' : ''} ${prevExpert}` : '';

    if (!nps) {
      msgBody = `Таня, распредели новую сделку! Клиент не новый${expertLine}, NPS не найден.\n\nСделка: ${companyName} (ID ${dealId})\nhttps://mavisgroup.bitrix24.by/crm/deal/details/${dealId}/`;
    } else if (nps.score !== null && nps.score <= 6) {
      const reasonLine = nps.reason && nps.reason !== 'причина не указана' ? ` — ${nps.reason}` : '';
      msgBody = `Таня, распредели новую сделку! Клиент не новый — НО у него низкий NPS ${nps.score} баллов${reasonLine}${expertLine}.\n\nСделка: ${companyName} (ID ${dealId})\nhttps://mavisgroup.bitrix24.by/crm/deal/details/${dealId}/`;
    } else {
      const scoreText = nps.score !== null ? ` ${nps.score} баллов` : '';
      msgBody = `Таня, распредели новую сделку! Клиент не новый, его NPS${scoreText}${expertLine}.\n\nСделка: ${companyName} (ID ${dealId})\nhttps://mavisgroup.bitrix24.by/crm/deal/details/${dealId}/`;
    }
  }

  // Создаём задачу Тане.
  const deadline = new Date();
  deadline.setHours(deadline.getHours() + 2);
  try {
    await bitrixRestCall('tasks.task.add', {
      fields: {
        TITLE: `Распредели сделку: ${companyName}`,
        DESCRIPTION: msgBody,
        RESPONSIBLE_ID: TANYA_USER_ID,
        DEADLINE: deadline.toISOString().slice(0, 19) + '+03:00',
        UF_CRM_TASK: [`D_${dealId}`],
        PRIORITY: 2, // высокий
      },
    });
  } catch (e) {
    console.warn(`[unassigned] Не удалось создать задачу Тане: ${e.message}`);
  }

  // Отправляем уведомление в Битрикс (сообщение во внутреннем чате).
  try {
    await bitrixRestCall('im.notify.system.add', {
      USER_ID: TANYA_USER_ID,
      MESSAGE: msgBody,
    });
  } catch (e) {
    // Пробуем альтернативный метод — личное сообщение через im.message.add.
    try {
      await bitrixRestCall('im.message.add', {
        DIALOG_ID: TANYA_USER_ID,
        MESSAGE: msgBody,
      });
    } catch (e2) {
      console.warn(`[unassigned] Не удалось отправить уведомление Тане: ${e2.message}`);
    }
  }

  console.log(`[unassigned] Таня уведомлена о сделке ${dealId} (${companyName})`);
}

async function checkUnassignedDeals() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;

  try {
    // Находим стадию "Не распределённые" в воронке 28.
    const stages = await bitrixRestCall('crm.dealcategory.stage.list', { id: config.autopilotCategoryId || 28 });
    const newStage = (Array.isArray(stages) ? stages : []).find((s) =>
      /не распредел/i.test(s.NAME || '') || s.STATUS_ID === 'C28:NEW'
    );
    if (!newStage) return;

    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: newStage.STATUS_ID },
      select: ['ID', 'TITLE', 'COMPANY_ID', 'DATE_CREATE', 'MOVED_TIME'],
      order: { DATE_CREATE: 'ASC' },
    }, 50);

    const now = new Date();
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю без задач/комментариев/сообщений.`);
        continue;
      }

      const createdAt = new Date(deal.DATE_CREATE || deal.MOVED_TIME);
      const workedHours = workingHoursBetween(createdAt, now);

      if (workedHours < 4) continue; // ещё не пора

      const lastNotified = UNASSIGNED_NOTIFIED.get(String(deal.ID));
      if (lastNotified) {
        const hoursSinceNotify = workingHoursBetween(lastNotified, now);
        if (hoursSinceNotify < 4) continue;
      } else {
        // Map пуст (рестарт сервера) — проверяем задачи в Bitrix.
        const hasRecent = await hasRecentUnassignedTask(deal.ID);
        if (hasRecent) {
          UNASSIGNED_NOTIFIED.set(String(deal.ID), now); // восстанавливаем в Map
          continue;
        }
      }

      // Проверяем что сейчас рабочее время прежде чем слать уведомление.
      if (!isWorkingHour(now)) continue;

      await notifyTanyaAboutUnassignedDeal(deal);
      UNASSIGNED_NOTIFIED.set(String(deal.ID), now);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) {
    console.error('[unassigned] Ошибка проверки нераспределённых сделок:', e.message);
  }
}

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

async function getAutopilotStageIds() {
  if (getAutopilotStageIds._cached) return getAutopilotStageIds._cached;
  const stages = await bitrixRestCall('crm.dealcategory.stage.list', { id: config.autopilotCategoryId || 28 });
  const allStages = Array.isArray(stages) ? stages : [];

  const expertStage = allStages.find((s) =>
    /эксперт.*(назначен|назначён)/i.test(s.NAME || '') || /назначен.*эксперт/i.test(s.NAME || '')
  );
  const infoStage = allStages.find((s) =>
    /сбор.*(информ|данн)/i.test(s.NAME || '') || /(информ|данн).*сбор/i.test(s.NAME || '')
  );
  // Кэшируем также ID стадии "Сбор информации" отдельно — нужен для перевода сделки.
  const prepStage = infoStage || allStages.find((s) => /подготовк|preparation/i.test(s.NAME || '') || String(s.STATUS_ID || '').includes('PREPARATION'));
  if (prepStage) {
    getAutopilotStageIds._prepStageId = prepStage.STATUS_ID;
    console.log(`[autopilot] Стадия "Сбор информации": "${prepStage.NAME}" → ${prepStage.STATUS_ID}`);
  }

  const result = [];
  if (expertStage) { result.push(expertStage.STATUS_ID); console.log(`[autopilot] Стадия 1: "${expertStage.NAME}" → ${expertStage.STATUS_ID}`); }
  if (infoStage && infoStage !== prepStage) { result.push(infoStage.STATUS_ID); console.log(`[autopilot] Стадия 2: "${infoStage.NAME}" → ${infoStage.STATUS_ID}`); }
  else if (prepStage && !expertStage) result.push(prepStage.STATUS_ID);

  // Если стадию "Сбор информации" не нашли по regex — берём из переменной PREPARATION_STAGE_ID.
  const envPrepStage = process.env.PREPARATION_STAGE_ID;
  if (envPrepStage && !result.includes(envPrepStage)) {
    result.push(envPrepStage);
    getAutopilotStageIds._prepStageId = envPrepStage;
    console.log(`[autopilot] Стадия "Сбор информации" из PREPARATION_STAGE_ID: ${envPrepStage}`);
  }
  // Если нашли только одну стадию через regex — добавляем её
  if (!result.length && allStages.length) {
    // Fallback: берём C28:NEW и C28:PREPARATION напрямую если известны
    const byId = allStages.filter((s) => ['C28:NEW', 'C28:PREPARATION'].includes(s.STATUS_ID));
    byId.forEach((s) => result.push(s.STATUS_ID));
  }
  if (result.length) getAutopilotStageIds._cached = result;
  return result;
}

function getPreparationStageId() {
  // Сначала смотрим в переменную окружения (самый надёжный способ).
  // Добавь в Render: PREPARATION_STAGE_ID=C28:UC_MIFXBB (или какой у вас ID стадии "Сбор информации")
  return process.env.PREPARATION_STAGE_ID || getAutopilotStageIds._prepStageId || 'C28:PREPARATION';
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

function activityDateValue(act) {
  const raw = act.END_TIME || act.START_TIME || act.DEADLINE || act.CREATED || act.DATE_CREATE || act.LAST_UPDATED || act.LAST_ACTIVITY_TIME;
  const d = raw ? new Date(raw) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

function activityActorIds(act) {
  const ids = [];
  const push = (v) => { if (v !== undefined && v !== null && String(v).trim()) ids.push(String(v).trim()); };
  ['RESPONSIBLE_ID', 'AUTHOR_ID', 'CREATED_BY_ID', 'EDITOR_ID', 'LAST_UPDATED_BY', 'ASSOCIATED_ENTITY_ID'].forEach((k) => push(act[k]));
  const scan = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (/user.*id|responsible|author|created_by/i.test(k)) push(v);
      if (v && typeof v === 'object') scan(v);
    }
  };
  scan(act.SETTINGS);
  scan(act.PROVIDER_PARAMS);
  return [...new Set(ids)];
}

function activityPassesExpertGate(act, deal, opts = {}) {
  const assignedId = String(opts.assignedById || (deal && deal.ASSIGNED_BY_ID) || '').trim();
  const minDateRaw = opts.minDate || (deal && deal.MOVED_TIME) || '';
  const minDate = minDateRaw ? new Date(minDateRaw) : null;
  const actDate = activityDateValue(act);
  if (minDate && actDate && !Number.isNaN(minDate.getTime())) {
    // Даём 2 минуты люфта на расхождения часовых поясов/API.
    if (actDate.getTime() < minDate.getTime() - 2 * 60 * 1000) return { ok: false, reason: 'звонок был до передачи/перестановки на стадию эксперта' };
  }
  if (config.requireAssignedExpertCall && assignedId) {
    const actorIds = activityActorIds(act);
    if (actorIds.length && !actorIds.includes(assignedId)) return { ok: false, reason: `звонок не ответственного эксперта: actors=${actorIds.join(',')}, assigned=${assignedId}` };
  }
  return { ok: true, reason: 'ok' };
}

async function findCallForDeal(dealId, opts = {}) {
  const deal = opts.deal || null;
  // FILES не возвращается через select: ['*'] в Bitrix REST — нужно запрашивать явно.
  const acts = await bitrixRestList('crm.activity.list', {
    filter: { OWNER_ID: dealId, OWNER_TYPE_ID: 2 },
    order: { ID: 'DESC' },
    select: ['*', 'FILES'],
  }, 80);

  const callActs = acts.filter((a) => {
    const typeId = String(a.TYPE_ID || '');
    const provider = String(a.PROVIDER_ID || '').toLowerCase();
    const text = String([a.SUBJECT, a.DESCRIPTION, a.PROVIDER_TYPE_ID].join(' ')).toLowerCase();
    return typeId === '2' || provider.includes('call') || provider.includes('voximplant') ||
           provider.includes('asterisk') || provider.includes('zruchna') || provider.includes('telephony') ||
           /звон|call|телеф/.test(text);
  });

  for (const act of callActs) {
    const gate = activityPassesExpertGate(act, deal, opts);
    if (!gate.ok) {
      console.log(`[findCall deal=${dealId} act=${act.ID}] skip: ${gate.reason}`);
      continue;
    }
    const logAct = `[findCall deal=${dealId} act=${act.ID}]`;
    const files = Array.isArray(act.FILES) ? act.FILES : [];
    console.log(`${logAct} FILES count=${files.length}`);
    for (const f of files) {
      const fileId = f && (f.ID || f.id || f.FILE_ID || f.fileId);
      if (!fileId) continue;
      try {
        const file = await bitrixRestCall('disk.file.get', { id: fileId });
        const url = file && (file.DOWNLOAD_URL || file.downloadUrl || file.VIEW_URL);
        console.log(`${logAct} disk.file.get id=${fileId} → url=${url ? 'OK' : 'пусто'}`);
        if (url) return { activityId: act.ID, subject: act.SUBJECT, url, fileName: file.NAME || `call-${dealId}.mp3`, activity: act };
      } catch (e) { console.log(`${logAct} disk.file.get id=${fileId} → ошибка: ${e.message}`); }
      const directUrl = f && (f.DOWNLOAD_URL || f.downloadUrl || f.VIEW_URL || f.url);
      if (directUrl) return { activityId: act.ID, subject: act.SUBJECT, url: directUrl, fileName: `call-${dealId}.mp3`, activity: act };
    }

    const raw = JSON.stringify(act);
    const fileIdMatch = raw.match(/crm_show_file\.php\?fileId=(\d+)/);
    console.log(`${logAct} crm_show_file fileId=${fileIdMatch ? fileIdMatch[1] : 'не найден'}`);
    if (fileIdMatch) {
      try {
        const file = await bitrixRestCall('disk.file.get', { id: fileIdMatch[1] });
        const url = file && (file.DOWNLOAD_URL || file.downloadUrl);
        console.log(`${logAct} disk.file.get id=${fileIdMatch[1]} → url=${url ? 'OK' : 'пусто'}`);
        if (url) return { activityId: act.ID, subject: act.SUBJECT, url, fileName: file.NAME || `call-${dealId}.mp3`, activity: act };
      } catch (e) { console.log(`${logAct} disk.file.get id=${fileIdMatch[1]} → ошибка: ${e.message}`); }
    }

    const candidates = serverCollectActivityAudioCandidates(act);
    console.log(`${logAct} candidates=${candidates.length}`);
    for (const c of candidates) {
      const url = await serverResolveCandidateDownloadUrl(c);
      if (url) return { activityId: act.ID, subject: act.SUBJECT, url, fileName: `call-${dealId}.mp3`, activity: act };
    }
  }

  return null;
}

function getDocumentListForService(serviceText) {
  // Определяем тип услуги и возвращаем конкретный перечень документов из реальных перечней копий.
  // Данные взяты напрямую из официальных перечней MAVIS GROUP (загружены 2026-06).
  const s = String(serviceText || '').toLowerCase();

  const commonAtt = [
    'Копии диплома и всех страниц трудовой на директора (если по совместительству — также приказ о назначении / решение участников / контракт)',
    'Копии диплома и трудовой на РУКОВОДИТЕЛЯ ОРГАНИЗАЦИИ (высшее образование + стаж в строительстве ≥5 лет; это директор, замдиректора, или замдиректора—главный инженер)',
    'Копии диплома, аттестата и трудовой (все страницы) на ГЛАВНОГО ИНЖЕНЕРА — аттестованного по любому направлению',
    'Копии диплома, аттестата и трудовой на каждого ПРОРАБА / МАСТЕРА по каждому виду работ',
    'Если у директора нет нужного образования/стажа — руководителя закрывает аттестованный ГИ в должности "замдиректора — главный инженер" при стаже ≥5 лет',
    'Все копии заверяются директором: "копия верна" / подпись / расшифровка / печать',
  ];

  if (/(спк|стк)/.test(s) && /(аттест|атт)/.test(s)) return {
    title: 'Аттестация СМР + СПК',
    docs: [
      'Копия свидетельства о регистрации — 1 экз.',
      'Копия устава (1-я и 2-я страницы) — 1 экз.',
      'Копия документа на помещение по юрадресу (аренда/купля-продажа) — 1 экз.',
      'Копии дипломов и трудовой на заместителя директора/директора — 1 экз.',
      'Копии дипломов, аттестатов и трудовых (все страницы) на ГИ/прораб/мастер; при совместительстве — приказ о назначении — 1 экз.',
      'Средства измерений: договоры аренды, акты приема-передачи, накладные, документы о поверке — 1 экз.',
      'Счёт и платёжка по ИПС «Стройдокумент» — 1 экз.',
      'Счёт и платёжка на технологические карты — 1 экз.',
      ...commonAtt,
    ],
  };

  if (/(спк|стк)/.test(s)) return {
    title: 'СПК (Свидетельство технической компетентности)',
    docs: [
      'Копия свидетельства о регистрации — 1 экз.',
      'Копия устава (1-я и 2-я страницы) — 1 экз.',
      'Копия документа на помещение по юрадресу — 1 экз.',
      'Копии дипломов и трудовой на заместителя директора/директора — 1 экз.',
      'Копии дипломов, аттестатов и трудовых на аттестованных сотрудников (ГИ/прораб/мастер) — 1 экз.',
      'Средства измерений (рулетка, линейка, теодолит, нивелир, уровень, штангенциркуль, щупы, угольник, влагомер, гигрометр, плотномер, рейка 2000/3000 мм, динамометрический ключ, 2 манометра): договоры/накладные/поверки — 1 экз.',
      'Счёт и платёжка по ИПС «Стройдокумент» — 1 экз.',
      'Счёт и платёжка на технологические карты — 1 экз.',
      'Копия книги учёта проверок (1-я страница + 2-я пустая) — 1 экз.',
    ],
  };

  if (/(технадзор|техническ.*надзор|комплексн.*управл)/.test(s)) return {
    title: 'Аттестация — технадзор / комплексное управление',
    docs: [
      ...commonAtt,
      'Руководитель (управляющий) проекта — стаж ≥8 лет по специализации, основное место работы: диплом и трудовая',
      'Специалист по закупкам: диплом и трудовая',
      'Инженер-сметчик: диплом и трудовая',
      'Инженеры по техническому надзору (общестрой, ВК, ОВ, дороги, трубопроводы): дипломы и трудовые',
      'ОБЪЕКТЫ: 2 договора + акты выполненных работ + акты ввода + подтверждение класса сложности ≥4, за последние 5 лет',
    ],
  };

  if (/(функц.*заказчик|заказчик.*к3)/.test(s)) return {
    title: 'Аттестация — функции заказчика К3',
    docs: [
      ...commonAtt.slice(0, 3),
      'Специалист с аттестатом — руководитель (управляющий) проекта: диплом и трудовая',
      'Инженер-сметчик: диплом и трудовая',
      'Специалист по закупкам: диплом и трудовая',
      'ОБЪЕКТЫ: 2 договора на выполнение функций заказчика + акты выполненных работ + акты ввода + класс сложности ≥4, за последние 5 лет',
    ],
  };

  if (/(ген.*проект|проектиров.*к3)/.test(s)) return {
    title: 'Аттестация — ген проектирование К3',
    docs: [
      ...commonAtt.slice(0, 3),
      'ГИП (аттестованный, стаж ≥2 лет за последние 10): диплом и трудовая',
      'Главные специалисты (по разделам проектной документации): дипломы и трудовые',
      'ОБЪЕКТЫ: 2 договора с заказчиком + 2 договора с субподрядчиком (вы — генпроектировщик) + акты + класс сложности ≥4, за последние 5 лет',
    ],
  };

  if (/(генподряд|ген.*подряд|ген.*2|2.*кат)/.test(s)) return {
    title: 'Аттестация — ген подряд К3',
    docs: [
      ...commonAtt,
      'Инженер по сметной работе: диплом и трудовая',
      'ОБЪЕКТЫ: 2 договора с заказчиком + 2 договора с субподрядчиком (вы — генподрядчик) + акты + класс сложности ≥4, за последние 5 лет',
    ],
  };

  if (/(сертиф.*метал|серт.*метал|осп|сварочн.*произво)/.test(s)) return {
    title: 'Сертификация производства (металлоконструкции)',
    docs: [
      'Свидетельство о регистрации + устав (1-я и 2-я страницы) + документ на помещение — 1 экз.',
      'Диплом и трудовая директора/замдиректора — 1 экз.',
      'Специалист по визуальному контролю: диплом + трудовая (1-я и последняя) + сертификат 2-го уровня по визуальному неразрушающему контролю',
      'Мастер по сварке: диплом + трудовая + сертификат сертифицированного мастера по сварке',
      '2 аттестованных сварщика: аттестаты + протоколы + дипломы + трудовые',
      'Средства измерений: гигрометр, рулетка, линейка, рейка, уровень, штангенциркуль, угольник, щупы, лупа, адгезиметр, шаблоны УШС-2/УШС-3, толщиномер, угломер',
      'Журналы (заполненные): входного контроля, приёмо-сдаточных испытаний, операционного контроля',
      'Технологический регламент (титульные страницы), штатное расписание, типовой договор',
      'Перечень материалов с поставщиком (Word) + сертификаты качества + ТТН',
      'Оплата ИПС «Стройдокумент» (счёт запросим)',
    ],
  };

  if (/мвд/.test(s)) return {
    title: 'Лицензия МВД',
    docs: [
      'Свидетельство о регистрации + устав (1-я и последняя) + оригинал платёжки с печатью банка (госпошлина 10 б.в.) + приказ о назначении директора',
      'Документы на помещение + накладные на оборудование/СИ/средства защиты + документы о поверке + ОСВ',
      'На 3 электромонтёров ОПС: паспорт + трудовая + диплом + медсправка + справки о наркоучёте и психучёте + справка о судимости + справка из ОВД о профучёте + справка суда о дееспособности + приказ о назначении + документ о 3-й группе по электробезопасности',
      'Директор: трудовая + контракт + диплом + приказ о вступлении',
    ],
  };

  if (/мчс/.test(s)) return {
    title: 'Лицензия МЧС',
    docs: [
      'Свидетельство о регистрации + устав + оригинал платёжки с печатью банка + приказ о назначении директора',
      'Документы на помещение + накладные и поверки на оборудование/СИ + ОСВ',
      'Директор: трудовая + контракт + диплом + приказ о вступлении',
      'ИТР (прораб, мастер, ГИ): трудовая + диплом + приказ',
      '2 электромонтёра ОПС (3-7 разряда): трудовые + дипломы + приказы + свидетельства о повышении квалификации (обучение в МЧС)',
    ],
  };

  // По умолчанию — базовый перечень для аттестации СМР
  return {
    title: 'Аттестация СМР (базовый перечень)',
    docs: commonAtt,
  };
}

// ✅ НОВАЯ ФУНКЦИЯ: Очистка Markdown для мессенджеров
function stripClientGreeting(text) {
  return String(text || '')
    .replace(/^\s*(?:[А-ЯЁA-Z][а-яёa-z]+|Клиент|Анна|Надежда|Нина|Ольга|Мария|Елена|Кристина)\s*,?\s*(?:добрый день|здравствуйте)[!.,—-]*\s*/i, 'Добрый день! ')
    .replace(/^\s*(добрый день|здравствуйте)[!.,—-]*/i, 'Добрый день!')
    .trim();
}

function cleanMarkdownForMessenger(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')      // **жирный** → жирный
    .replace(/__(.+?)__/g, '$1')          // __подчеркнутый__ → подчеркнутый
    .replace(/~~(.+?)~~/g, '$1')          // ~~зачеркнутый~~ → зачеркнутый
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1') // [ссылка](url) → ссылка
    .replace(/^#{1,6}\s+/gm, '')          // # Заголовок → Заголовок
    .trim();
}

// ✅ НОВАЯ ФУНКЦИЯ: Шаблоны хода работы для каждой услуги (из регламентов)
function getClientMessageTemplate(service) {
  const s = String(service || '').toLowerCase();
  
  if (/спк|свидетельств.*техн|техн.*компетент/.test(s)) {
    return `[Имя], фиксирую порядок работы по свидетельству технической компетентности.

Что есть сейчас:
- специалисты: [ФИО / должности / актуальность];
- средства измерений: [есть / частично есть / нужно сверить];
- орган: [БИСП / Стройкомплекс / определит руководитель];
- город: [ / другой город];
- крайний срок: [дата].

От вас:
1. До [дата] - подтвердить специалистов и средства измерений
2. Оплатить счета и техкарты
3. Прислать свидетельства о средствах измерений

От нас:
1. Проверяем специалистов и средства измерений
2. Готовим техкарту и документы для подачи
3. Подаем в БИСП/Стройкомплекс
4. Контролируем статус`;
  }
  
  if (/атт|аттестац/.test(s) && !/специалист/.test(s)) {
    return `[Имя], фиксирую порядок работы по аттестации организации.

Что у нас есть сейчас:
- виды работ: [перечень из КП];
- специалисты: [ФИО / должности / кто закрывает какие виды работ];
- кого подбираем: [если требуется];
- крайний срок аттестации: [дата].

От вас:
1. До [дата] - прислать недостающие документы специалистов
2. До [дата] - подготовить акты выполненных работ за 5 лет
3. Оплатить счета и пошлины

От нас:
1. Проверяем документы специалистов
2. Готовим аттестационное дело
3. Подаем в Белстройцентр
4. Контролируем замечания и статус`;
  }
  
  if (/исо|iso|суот|45001/.test(s)) {
    return `[Имя], фиксирую порядок работы по [ISO 9001 / сертификату по охране труда / ISO 45001].

Что есть сейчас:
- сертификаты: [какие именно];
- формат: [получение / периодическая оценка];
- сотрудники: [список есть / нужно прислать];
- комиссия по охране труда: [есть / нужно дать 3 ФИО];
- ориентировочная дата выезда: [период];
- крайний срок оплаты пошлины: [дата].

От вас:
1. До [дата] - прислать актуальный список сотрудников
2. До [дата] - подтвердить комиссию по охране труда
3. Оплатить пошлину и счета

От нас:
1. Подготавливаем документы
2. Согласуем дату выезда
3. Проводим аудит и проверку
4. Выписываем сертификат`;
  }
  
  if (/специалист/.test(s)) {
    return `[Имя], фиксирую порядок работы по аттестации специалиста [ФИО].

Что есть сейчас:
- диплом: [есть / нужно прислать];
- трудовая: [есть / нужно прислать];
- специализация: [указать];
- продукт, который закрывает: [аттестация / свидетельство / другое];
- дата экзамена: [дата].

От вас:
1. До [дата] - прислать 2 фото 3x4 см
2. До [дата] - подтвердить документы
3. Оплатить счет на экзамен

От нас:
1. Проверяем документы
2. Готовим заявку и письмо
3. Записываем на экзамен
4. Контролируем результат`;
  }
  
  if (/подбор/.test(s)) {
    return `[Имя], фиксирую порядок по подбору специалиста.

Что есть сейчас:
- кого подбираем: [должность / специализация];
- под какой продукт: [аттестация / свидетельство / комплекс];
- срок подбора: [дата];
- кого закрываете вы: [если есть];
- кого переводим/аттестуем: [если требуется].

От вас:
1. До [дата] - согласуйте кандидата
2. До [дата] - оформите специалиста на должность
3. До [дата] - пришлите копию приказа и трудовой

От нас:
1. Подбираем специалистов из базы
2. Согласуем кандидата с вами
3. Готовим документы для оформления
4. Если нужно - записываем на аттестацию`;
  }
  
  // Дефолт для неизвестной услуги
  return `[Имя], фиксирую порядок работы по [услуга].

Из звонка выяснили:
- [основная информация из звонка];
- [согласованные сроки];
- [что нужно от клиента].

От вас:
1. До [дата] - прислать [документы];
2. Оплатить счета;
3. [другие действия].

От нас:
1. Проверяем документы;
2. Готовим документы;
3. Подаем в нужный орган;
4. Контролируем статус.`;
}

// ✅ НОВАЯ ФУНКЦИЯ: Обёртка для создания любой задачи с защитой от частого дублирования (4 часа)
async function createTaskWithDelay(fields, delayHours = 4) {
  if (!fields.TITLE || !fields.UF_CRM_TASK) {
    return await bitrixRestCall('tasks.task.add', { fields });
  }
  
  const dealId = fields.UF_CRM_TASK[0].replace('D_', '');
  const titlePattern = fields.TITLE.slice(0, 40);
  
  // Проверяем когда была создана последняя похожая задача
  const lastTime = await getLastTaskCreatedTime(dealId, titlePattern);
  if (lastTime) {
    const now = new Date();
    const hoursPassed = (now - lastTime) / (1000 * 60 * 60);
    
    if (hoursPassed < delayHours) {
      console.log(`[tasks deal=${dealId}] Похожая задача была ${hoursPassed.toFixed(1)} ч назад (нужно ${delayHours}ч), пропускаю.`);
      return null;
    }
  }
  
  // Создаём задачу
  return await bitrixRestCall('tasks.task.add', { fields });
}

// ✅ НОВАЯ ФУНКЦИЯ: Проверить когда в последний раз создавалась задача
async function getLastTaskCreatedTime(dealId, titlePattern) {
  try {
    const tasks = await bitrixRestList('tasks.task.list', {
      filter: { 'UF_CRM_TASK': `D_${dealId}` },
      select: ['ID', 'TITLE', 'CREATED'],
      order: { CREATED: 'DESC' },
    }, 10);
    
    const lastTask = tasks.find((t) => t.TITLE && t.TITLE.includes(titlePattern.slice(0, 30)));
    if (!lastTask) return null;
    
    // Парсим дату создания
    const createdStr = lastTask.CREATED || '';
    if (!createdStr) return null;
    
    return new Date(createdStr);
  } catch (_) {
    return null;
  }
}

// ✅ НОВАЯ ФУНКЦИЯ: Создавать задачу только если прошло 4+ часа
async function shouldCreateTaskAgain(dealId, titlePattern, hoursDelay = 4) {
  const lastTime = await getLastTaskCreatedTime(dealId, titlePattern);
  if (!lastTime) {
    // Нет предыдущей задачи - создаём
    return true;
  }
  
  const now = new Date();
  const hoursPassed = (now - lastTime) / (1000 * 60 * 60);
  
  if (hoursPassed >= hoursDelay) {
    // Прошло достаточно времени - создаём новую
    console.log(`[tasks] ${hoursPassed.toFixed(1)} часов с последней задачи для сделки ${dealId} — создаю новую.`);
    return true;
  } else {
    // Слишком мало времени - пропускаем
    console.log(`[tasks] Последняя задача для сделки ${dealId} была ${hoursPassed.toFixed(1)} часов назад (нужно 4 часа), пропускаю.`);
    return false;
  }
}

function detectServiceFromDeal(deal) {
  const serviceField = process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071';
  return String(deal[serviceField] || deal.UF_CRM_1765113071 || '').trim();
}

function getShortServiceName(serviceRaw) {
  const s = String(serviceRaw || '').toLowerCase();
  if (/спк|свидетельств.*техн|техн.*компетент/.test(s)) return 'СПК';
  if (/атт|аттестац/.test(s)) return 'аттестации';
  if (/исо|iso/.test(s)) return 'ИСО';
  if (/суот/.test(s)) return 'СУОТ';
  if (/мчс/.test(s)) return 'МЧС';
  if (/мвд/.test(s)) return 'МВД';
  if (/серт/.test(s)) return 'сертификации';
  if (/консульт/.test(s)) return 'консультации';
  return serviceRaw ? serviceRaw.trim().split(/\s+/).slice(0, 2).join(' ') : 'услуги';
}

function detectPreferredChannel(deal) {
  // v44: строгая ориентация на поле "Предпочитаемый способ связи".
  // Если поле пустое или там не Telegram/Viber/Email — клиенту НЕ отправляем ничего.
  const candidates = [];
  const configured = config.preferredContactFieldCode || process.env.PREFERRED_CONTACT_FIELD_CODE || '';
  if (configured) candidates.push(configured);
  candidates.push('UF_CRM_1781189436900', 'UF_CRM_1781874759140');

  let raw = '';
  for (const code of [...new Set(candidates.filter(Boolean))]) {
    if (deal && Object.prototype.hasOwnProperty.call(deal, code) && deal[code] !== undefined && deal[code] !== null && String(deal[code]).trim() !== '') {
      raw = deal[code];
      break;
    }
  }

  const val = normalizeControlValue(raw);
  if (/\b(телеграм|telegram|tg)\b/i.test(val)) return 'telegram';
  if (/\b(вайбер|viber)\b/i.test(val)) return 'viber';
  if (/\b(email|e-mail|почта|mail)\b/i.test(val)) return 'email';
  return null;
}

function preferredChannelLabel(channel) {
  return { telegram: 'Telegram', viber: 'Viber', email: 'Email' }[channel] || 'не определён';
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
  if (!deal.COMPANY_ID) return [];
  try {
    const all = await bitrixRestList('crm.deal.list', {
      filter: { COMPANY_ID: deal.COMPANY_ID, CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: stageId },
      select: ['ID', 'TITLE', 'STAGE_ID', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'COMPANY_ID',
        'OPPORTUNITY', 'CURRENCY_ID',
        process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071',
        process.env.PREFERRED_CONTACT_FIELD_CODE || 'UF_CRM_1781189436900',
      ],
    }, 20);
    // Дедупликация по ID — bitrixRestList может вернуть одну сделку несколько раз
    // из-за особенностей пагинации Bitrix при небольшом числе записей.
    const seen = new Set();
    const unique = all.filter((s) => {
      if (seen.has(String(s.ID))) return false;
      seen.add(String(s.ID));
      return true;
    });
    return unique.filter((s) => String(s.ID) !== String(deal.ID));
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

function getDiminutiveName(fullName) {
  // Превращает "Елизавета Горбатова" → "Лизочка", "Мария Баженова" → "Машенька" и т.д.
  const name = String(fullName || '').trim().split(' ')[0]; // берём только имя
  const diminutives = {
    'Елизавета': 'Лизочка', 'Елена': 'Леночка', 'Александра': 'Сашенька',
    'Александр': 'Сашенька', 'Мария': 'Машенька', 'Анна': 'Анечка',
    'Екатерина': 'Катюша', 'Татьяна': 'Танюша', 'Наталья': 'Наташенька',
    'Ольга': 'Оленька', 'Ирина': 'Иришка', 'Светлана': 'Светочка',
    'Юлия': 'Юлечка', 'Надежда': 'Наденька', 'Виктория': 'Викуля',
    'Дарья': 'Дашенька', 'Валентина': 'Валечка', 'Галина': 'Галочка',
    'Людмила': 'Людочка', 'Нина': 'Ниночка', 'Вера': 'Верочка',
    'Алина': 'Алиночка', 'Кристина': 'Кристиночка', 'Диана': 'Дианочка',
    'Марина': 'Мариночка', 'Ксения': 'Ксюша', 'Полина': 'Полиночка',
    'Евгения': 'Женечка', 'Евгений': 'Женечка', 'Андрей': 'Андрюша',
    'Дмитрий': 'Димочка', 'Сергей': 'Серёженька', 'Алексей': 'Лёшенька',
    'Михаил': 'Мишенька', 'Роман': 'Ромочка', 'Артём': 'Тёмочка',
    'Николай': 'Колечка', 'Владимир': 'Вовочка', 'Антон': 'Антоша',
    'Максим': 'Максик', 'Павел': 'Павлик', 'Игорь': 'Игорёк',
  };
  return diminutives[name] || `${name}` ; // если не нашли — просто имя
}

async function createExpertFollowUpTask(dealId, expertId, expertName, clientMessage, docMessage, otherDealIds = []) {
  // ✅ ИСПРАВЛЕНО: Создаём задачу только если прошло 4+ часа с последней
  const taskCheckPattern = `отправил ход работы`;
  const shouldCreate = await shouldCreateTaskAgain(dealId, taskCheckPattern, 4);  // 4 часа
  if (!shouldCreate) {
    console.log(`[autopilot deal=${dealId}] Задача по отправке хода работы создавалась недавно, пропускаю.`);
    return;
  }

  // Создаём задачу эксперту на следующий день до 18:00.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(18, 0, 0, 0);
  const deadline = tomorrow.toISOString().slice(0, 19) + '+03:00';

  const petName = getDiminutiveName(expertName);
  const taskTitle = `${petName}, я отправил ход работы клиенту 📋`;
  const siblingsLine = otherDealIds && otherDealIds.length
    ? `\n\nПо этой компании сразу несколько сделок (${[dealId, ...otherDealIds].join(', ')}) — клиенту отправлено одно общее сообщение по всем услугам, но в каждой сделке свой комментарий и своя задача.`
    : '';
  // ✅ ИСПРАВЛЕНО: Упоминаем ТОЛЬКО эксперта, убираем менеджера
  const taskDesc = `${petName}, я отправил ход работы клиенту со всеми перечнями и прописал всё в комментарии к сделке 😊

Что сделал:
— Отправил первое сообщение клиенту с кратким ходом работы
— Отправил второй список с перечнем документов${docMessage ? ' ✅' : ''}
— Написал краткую выжимку в комментарий к сделке
— Перевёл сделку на стадию «Сбор информации»${siblingsLine}

Твой следующий шаг — дождаться ответа/документов от клиента и проверить что всё приложено по перечню 🙌`;

  await bitrixRestCall('tasks.task.add', {
    fields: {
      TITLE: taskTitle,
      DESCRIPTION: taskDesc,
      RESPONSIBLE_ID: expertId,
      DEADLINE: deadline,
      UF_CRM_TASK: [`D_${dealId}`],
      PRIORITY: 1,
    },
  });
}

async function buildDealContext(deal, transcript) {
  const service = detectServiceFromDeal(deal);
  const docList = getDocumentListForService(service);
  let commentsText = '';
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal' },
      select: ['ID', 'COMMENT', 'DATE_CREATE'],
      order: { ID: 'DESC' },
    }, 30);
    commentsText = comments.map((c) => `${c.DATE_CREATE || c.CREATED || ''}: ${c.COMMENT || ''}`).join('\n');
  } catch (_) { commentsText = ''; }

  // ✅ ИСПРАВЛЕНО: Получаем только ИМЯ контакта (без компании)
  let contactName = '';
  let contactPhone = '';
  let contactEmail = '';
  try {
    if (deal.CONTACT_ID) {
      const contact = await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID });
      if (contact) {
        // Берем только имя, не "имя + компания"
        contactName = String(contact.NAME || contact.FIRST_NAME || '').trim();
        contactPhone = contact.PHONE && contact.PHONE[0] ? contact.PHONE[0].VALUE : '';
        contactEmail = contact.EMAIL && contact.EMAIL[0] ? contact.EMAIL[0].VALUE : '';
      }
    }
  } catch (_) { }

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
    contact: {
      name: contactName,  // ✅ только имя
      phone: contactPhone,
      email: contactEmail,
    },
    product: { label: service, key: 'auto' },
    service,
    document_list: docList,
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
    deal = await loadFreshDeal(deal);
    if (isDealAiDisabled(deal)) {
      console.log(`${logPrefix} Поле ИИ=Нет — ничего не делаю: без сообщений, комментариев, задач и движения стадии.`);
      autopilotProcessed.add(String(dealId));
      return;
    }

    // 1. Проверяем тип услуги — консультации не обрабатываем.
    // Стадии "Возврат" и "Работа с возвратом" — Игорь категорически не работает.
    if (deal.STAGE_ID === STAGE_IDS.return || deal.STAGE_ID === STAGE_IDS.refund) {
      console.log(`${logPrefix} Стадия "${deal.STAGE_ID}" — возврат, автопилот заблокирован.`);
      autopilotProcessed.add(String(dealId));
      return;
    }

    const serviceRaw = detectServiceFromDeal(deal);
    if (/консультац/i.test(serviceRaw)) {
      console.log(`${logPrefix} Услуга "${serviceRaw}" — консультация, пропускаю.`);
      autopilotProcessed.add(String(dealId)); // помечаем чтобы не проверять снова
      return;
    }

    // 2. Ищем запись звонка.
    const callRecord = await findCallForDeal(dealId, { deal, assignedById: deal.ASSIGNED_BY_ID, minDate: deal.MOVED_TIME });
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

    const systemPrompt = [
      'Ты ИИ-ассистент Игорь, помощник эксперта производства MAVIS GROUP.',
      'Твоя задача — ЗАПОЛНИТЬ шаблон хода работы для услуги на основе звонка и карточки сделки.',
      'Шаблон уже задан в контексте (template). Ты просто ЗАПОЛНЯЕШЬ [ФИО], [дата], [что нужно] из информации звонка.',
      'client_message: это заполненный шаблон (с конкретными ФИО, датами, документами). НЕ переписывай шаблон, просто заполни поля.',
      'comment: краткая выжимка для эксперта (3-5 строк) — ключевые факты из звонка и договорённости.',
      'Верни только валидный JSON без markdown.',
    ].join('\n');
    
    const template = getClientMessageTemplate(detectServiceFromDeal(deal));
    
    const userPrompt = `Ты получил звонок от клиента ${context.contact.name || 'клиента'}. Заполни шаблон хода работы.

ШАБЛОН (заполни все плейсхолдеры):
${template}

ИНФОРМАЦИЯ ИЗ ЗВОНКА И СДЕЛКИ:
${JSON.stringify(context, null, 2).slice(0, 20000)}

СЕГОДНЯ: ${new Date().toISOString().slice(0, 10)}

ИНСТРУКЦИИ ПО ЗАПОЛНЕНИЮ:

1. ИМЕНА:
   - Замени [Имя] на "${context.contact.name || 'клиента'}" (только имя, без компании)
   - Если имени нет — убери обращение, оставь просто текст

2. ДАТЫ (КРИТИЧНО!):
   - Замени [дата] на конкретные даты из звонка
   - Если в звонке назван срок (например "завтра", "в понедельник") — переведи в формат ДАТА
   - Если срок в звонке не назван — добавь +2-3 дня от СЕГОДНЯ
   - ВСЕГДА используй формат: "21 июля" или "22.07.2026" (2026 год, не 2024!)
   - Примеры: "до 23 июля", "до 24 июля", "к 25 июля"

3. ДОКУМЕНТЫ И ДЕЙСТВИЯ:
   - Замени [что нужно] / [документы] на КОНКРЕТНЫЕ из звонка:
     * "копию аттестата"
     * "скан трудовой"
     * "фото 3х4"
     * "приказ о назначении"
   - НЕ оставляй [что нужно] - это ошибка!

4. ДАННЫЕ ИЗ СДЕЛКИ:
   - Замени [услуга] на: "${context.service}"
   - Замени [орган] / [компания] если есть в звонке

5. ФИНАЛЬНАЯ ПРОВЕРКА:
   - client_message НЕ должен содержать [ или ]
   - Все даты в 2026 году
   - Все ФИО и названия конкретные
   - Текст читается как готовое сообщение клиенту (можно копировать в Telegram/Viber)

6. comment: 3-5 строк выжимки главных фактов из звонка + согласованные сроки

ВЕРНИ ТОЛЬКО JSON (без markdown, без \`\`\`):
{"client_message":"готовое сообщение БЕЗ плейсхолдеров","comment":"выжимка"}`;

    const rawText = await callAiChatCompletion({
      model: config.aiModel,
      temperature: 0.1,  // ниже temperature для точного заполнения
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    });
    let aiResult = {};
    try { aiResult = JSON.parse(rawText); } catch (_) {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (match) try { aiResult = JSON.parse(match[0]); } catch (_2) { aiResult = {}; }
    }

    const clientMessage = String(aiResult.client_message || '').trim();
    // ✅ ИСПРАВЛЕНО: Очищаем Markdown перед отправкой
    const clientMessageCleaned = cleanMarkdownForMessenger(stripClientGreeting(clientMessage));
    const EMAIL_REMINDER = '\n\nВсе документы отправляйте нам на почту: mavis.group@mail.ru';
    const clientMessageWithEmail = clientMessageCleaned ? clientMessageCleaned + EMAIL_REMINDER : '';
    const documentMessage = ''; // объединено в client_message
    const dealComment = String(aiResult.comment || 'Автопилот выполнен').trim();
    const siblingNote = formatSiblingServicesNote(siblings);

    // 5. Отправляем сообщение клиенту: предпочитаемый → Viber → Telegram → Email.
    let sent = false;
    let sentChannel = '';
    if (clientMessageWithEmail) {
      const phone = await getContactPhone(deal);
      const email = await getContactEmail(deal);
      const preferredChannel = detectPreferredChannel(deal);
      if (!preferredChannel) {
        console.warn(`${logPrefix} Сообщение подготовлено, но не отправлено: поле предпочитаемого способа связи не распознано.`);
      } else if (preferredChannel === 'email') {
        if (email) {
          try {
            await sendEmailThroughBitrix(dealId, deal.ASSIGNED_BY_ID, email, deal.TITLE, clientMessageWithEmail);
            console.log(`${logPrefix} Сообщение отправлено через Email: ${email}.`);
            sent = true;
            sentChannel = 'email';
          } catch (emailErr) {
            console.error(`${logPrefix} Email не сработал: ${emailErr.message}`);
          }
        } else {
          console.warn(`${logPrefix} Email выбран как предпочитаемый канал, но email клиента не найден.`);
        }
      } else if (phone) {
        const ch = getConfiguredWazzupChannel(preferredChannel);
        if (!ch || !ch.channelId) {
          console.warn(`${logPrefix} Канал ${preferredChannel} выбран в сделке, но не настроен в Render.`);
        } else {
          try {
            await sendWazzupMessageInternal({ channelKey: preferredChannel, text: clientMessageWithEmail, phone, dealId });
            console.log(`${logPrefix} Сообщение отправлено через ${preferredChannel}.`);
            sent = true;
            sentChannel = preferredChannel;
          } catch (sendErr) {
            console.warn(`${logPrefix} ${preferredChannel} не сработал: ${sendErr.message}. Запасные каналы не используем.`);
          }
        }
      } else {
        console.warn(`${logPrefix} ${preferredChannel} выбран, но телефон клиента не найден.`);
      }

      // ✅ ИСПРАВЛЕНО: Дублируем сообщение для КАЖДОЙ сопутствующей сделки
      if (sent && clientMessageWithEmail && phone && siblings.length > 0) {
        console.log(`${logPrefix} Отправляю дублирующие сообщения для ${siblings.length} сопутствующих сделок...`);
        for (const sibling of siblings) {
          try {
            const siblingAlreadyDone = await dealAlreadyProcessed(sibling.ID);
            if (siblingAlreadyDone) continue;
            
            await sendWazzupMessageInternal({ 
              channelKey: sentChannel, 
              text: clientMessageWithEmail, 
              phone, 
              dealId: sibling.ID  
            });
            console.log(`${logPrefix} sibling=${sibling.ID} Сообщение отправлено через ${sentChannel}`);
          } catch (siblingErr) {
            console.warn(`${logPrefix} sibling=${sibling.ID} Ошибка: ${siblingErr.message}`);
          }
        }
      }

      // Отправляем docx файл перечня документов вторым сообщением.
      if (sent && sentChannel !== 'email') {
        try {
          const docxBuffer = await generateDocListDocx(deal);
          if (docxBuffer) {
            await new Promise((r) => setTimeout(r, 1500));
            const safeTitle = String(deal.TITLE || 'Перечень').replace(/[^а-яёА-ЯЁa-zA-Z0-9\s]/g, '').trim().slice(0, 50);
            const fileName = `Перечень_${safeTitle}.docx`;
            // Загружаем на Диск и отправляем ссылку текстом (Wazzup не умеет прикреплять файлы напрямую).
            const fileUrl = await uploadDocxToDisk(docxBuffer, fileName);
            if (fileUrl) {
              await sendWazzupMessageInternal({ channelKey: sentChannel, text: `📎 Перечень документов: ${fileUrl}`, phone: await getContactPhone(deal), dealId });
              console.log(`${logPrefix} Docx перечня отправлен через ${sentChannel}.`);
            }
          }
        } catch (docxErr) {
          console.warn(`${logPrefix} Не удалось отправить docx перечня: ${docxErr.message}`);
        }
      }
    }

    // 6. Комментарий в текущую сделку.
    const channelLabel = { telegram: 'Telegram', viber: 'Viber', email: 'Email', default: 'мессенджер' };
    const sendStatus = clientMessageWithEmail
      ? (sent
        ? `✅ Сообщение клиенту отправлено через ${channelLabel[sentChannel] || sentChannel}.`
        : `⚠️ Сообщение подготовлено, но не удалось отправить. Эксперту: отправь вручную.`)
      : `ℹ️ Сообщение клиенту не сформировано.`;

    // Если не смогли отправить — задача эксперту.
    if (clientMessageWithEmail && !sent) {
      try {
        await bitrixRestCall('tasks.task.add', {
          fields: {
            TITLE: `Игорь не смог отправить ход работы клиенту — ${deal.TITLE}`,
            DESCRIPTION: `Игорь подготовил сообщение, но не смог отправить.\n\nТекст:\n${clientMessageWithEmail}${documentMessage ? '\n\n' + documentMessage : ''}`,
            RESPONSIBLE_ID: deal.ASSIGNED_BY_ID || config.executorExpertId,
            UF_CRM_TASK: [`D_${dealId}`],
            PRIORITY: 1,
          },
        });
      } catch (_) {}
    }

    // Сообщение клиенту тоже пишем в комментарий.
    const clientMsgForComment = clientMessageWithEmail
      ? `\n\n📨 Отправлено клиенту:\n${clientMessageWithEmail}${documentMessage ? '\n\n' + documentMessage : ''}`
      : '';
    const commentText = `${AUTOPILOT_MARKER}${siblingNote}\n\n${sendStatus}\n\n${dealComment}${clientMsgForComment}`;
    await bitrixRestCall('crm.timeline.comment.add', {
      fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: commentText },
    });
    autopilotProcessed.add(String(dealId));

    // 7. Переводим ОСНОВНУЮ сделку на "Сбор информации".
    const prepStageId = getPreparationStageId();
    // ЗАЩИТА: если ID стадии не задан явно через PREPARATION_STAGE_ID или не найден динамически — не двигаем.
    const prepStageIdSafe = process.env.PREPARATION_STAGE_ID || getAutopilotStageIds._prepStageId || null;
    if (!prepStageIdSafe) {
      console.warn(`${logPrefix} PREPARATION_STAGE_ID не задан — пропускаю перевод стадии. Добавь переменную в Render.`);
    } else if (prepStageIdSafe && deal.STAGE_ID !== prepStageIdSafe) {
      try {
        await bitrixRestCall('crm.deal.update', { id: dealId, fields: { STAGE_ID: prepStageIdSafe } });
        console.log(`${logPrefix} Стадия → "${prepStageIdSafe}".`);
      } catch (stageErr) {
        console.warn(`${logPrefix} Не удалось перевести стадию: ${stageErr.message}`);
      }
    }

    // 8. Задача эксперту по основной сделке — отчёт Игоря с ласковым именем.
    let mainExpertName = '';
    if (deal.ASSIGNED_BY_ID && sent) {
      try {
        const expertUsers = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
        const expertUser = Array.isArray(expertUsers) ? expertUsers[0] : expertUsers;
        mainExpertName = expertUser ? `${expertUser.NAME || ''} ${expertUser.LAST_NAME || ''}`.trim() : '';
        await createExpertFollowUpTask(dealId, deal.ASSIGNED_BY_ID, mainExpertName, clientMessage, documentMessage, []);
        console.log(`${logPrefix} Задача эксперту создана (${mainExpertName}).`);
      } catch (taskErr) {
        console.warn(`${logPrefix} Задача эксперту не создалась: ${taskErr.message}`);
      }
    }

    // 9. То же самое (комментарий + стадия + задача) делаем для КАЖДОЙ сопутствующей сделки —
    // это важно: клиент один, но в каждой сделке-услуге эксперт должен видеть ход работы и
    // получить свою задачу, а не только ссылку "смотри в другой сделке".
    const allSiblingIds = siblings.map((s) => s.ID);
    for (const sibling of siblings) {
      try {
        const siblingAlreadyDone = await dealAlreadyProcessed(sibling.ID);
        if (siblingAlreadyDone) continue;

        const otherIds = [dealId, ...allSiblingIds.filter((id) => String(id) !== String(sibling.ID))];
        const crossNote = `\n\nЭта сделка обработана вместе со сделками компании: ${otherIds.join(', ')}. Полный контекст и переписка с клиентом — там же.`;
        const siblingComment = `${AUTOPILOT_MARKER}\n\n${sendStatus}\n\n${dealComment}${crossNote}`;
        await bitrixRestCall('crm.timeline.comment.add', {
          fields: { ENTITY_ID: sibling.ID, ENTITY_TYPE: 'deal', COMMENT: siblingComment },
        });
        autopilotProcessed.add(String(sibling.ID));

        // Стадия сопутствующей сделки — только если ID задан явно.
        if (prepStageIdSafe && sibling.STAGE_ID !== prepStageIdSafe) {
          try {
            await bitrixRestCall('crm.deal.update', { id: sibling.ID, fields: { STAGE_ID: prepStageIdSafe } });
          } catch (_) {}
        }

        // Задача эксперту сопутствующей сделки (может быть другой человек, чем в основной).
        if (sibling.ASSIGNED_BY_ID && sent) {
          let siblingExpertName = mainExpertName;
          if (String(sibling.ASSIGNED_BY_ID) !== String(deal.ASSIGNED_BY_ID)) {
            try {
              const su = await bitrixRestCall('user.get', { ID: sibling.ASSIGNED_BY_ID });
              const suUser = Array.isArray(su) ? su[0] : su;
              siblingExpertName = suUser ? `${suUser.NAME || ''} ${suUser.LAST_NAME || ''}`.trim() : '';
            } catch (_) { siblingExpertName = ''; }
          }
          try {
            await createExpertFollowUpTask(sibling.ID, sibling.ASSIGNED_BY_ID, siblingExpertName, clientMessage, documentMessage, otherIds);
          } catch (_) {}
        }
      } catch (_) {}
    }

    console.log(`${logPrefix} Готово.${hasMultipleDeals ? ` Сопутствующие (комментарий+стадия+задача): ${siblings.map((s) => s.ID).join(', ')}.` : ''}`)

    // Регистрируем сделку для контроля документов (Этап 5).
    // Только если сообщение реально отправлено клиенту.
    if (sent) {
      const companyName = await getCompanyName(deal.COMPANY_ID) || deal.TITLE;
      pendingDocsCheck.set(String(dealId), {
        sentAt: new Date(),
        companyName,
        service: detectServiceFromDeal(deal),
      });
      console.log(`${logPrefix} Сделка добавлена в контроль документов (через 2 раб. дня).`);
    }

    // ЭТАП 4: Уточнение ЛК Белстройцентра — только для сделок с аттестацией.
    const service = detectServiceFromDeal(deal);
    if (isAttestationService(service)) {
      const hasNonAttSiblings = hasSiblingNonAttService(siblings);
      if (hasNonAttSiblings) {
        // Есть сопутствующие услуги (СПК, ИСО и т.п.) — ставим задачу-триггер,
        // ждём пока эксперт закроет её, и только потом запускаем Этап 4.
        await createAttStage4WaitTask(deal, siblings);
      } else {
        // Только аттестация — запускаем Этап 4 сразу.
        await runAttStage4(deal, siblings);
      }
    }
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



// ============================================================================
// ЭТАП 4: Уточнение ЛК Белстройцентра (только для Аттестации СМР и её разновидностей)
// Запускается либо сразу после хода работы (если АТТ единственная услуга),
// либо после того как эксперт закрыл задачу-триггер (если есть сопутствующие услуги).
// ============================================================================

const ATT_STAGE4_MARKER = '[MAVIS_ATT_STAGE4_DONE]';
const ATT_STAGE4_TASK_MARKER = '[MAVIS_ATT_STAGE4_TASK]'; // в описании задачи-триггера

function isAttestationService(serviceText) {
  return /атт|аттест/i.test(String(serviceText || ''));
}

function hasSiblingNonAttService(siblings) {
  // Проверяем есть ли среди сопутствующих сделок услуги СПК, ИСО и т.п. (не аттестация).
  return siblings.some((s) => !isAttestationService(detectServiceFromDeal(s)));
}

async function checkLkMentionInComments(dealId, allSiblingIds = []) {
  // Ищем упоминание ЛК Белстройцентра во всех комментариях всех сделок компании.
  const allDealIds = [dealId, ...allSiblingIds];
  for (const id of allDealIds) {
    try {
      const comments = await bitrixRestList('crm.timeline.comment.list', {
        filter: { ENTITY_ID: id, ENTITY_TYPE: 'deal' },
        select: ['ID', 'COMMENT', 'DATE_CREATE'],
        order: { ID: 'DESC' },
      }, 30);
      for (const c of comments) {
        const text = String(c.COMMENT || '').toLowerCase();
        if (/лк|личн.*каб|белстройцентр|att\.bsc|логин|пароль.*белст|есть.*кабинет|нет.*кабинет|забыл.*пароль|нет.*лк|есть.*лк/i.test(text)) {
          return { found: true, comment: c.COMMENT, dealId: id };
        }
      }
    } catch (_) {}
  }
  return { found: false };
}

async function runAttStage4(deal, siblings = []) {
  const dealId = deal.ID;
  const logPrefix = `[stage4 deal=${dealId}]`;

  // Проверяем не был ли этап уже выполнен.
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID', 'COMMENT'],
      order: { ID: 'DESC' },
    }, 20);
    if (comments.some((c) => String(c.COMMENT || '').includes(ATT_STAGE4_MARKER))) {
      console.log(`${logPrefix} Этап 4 уже выполнен — пропускаю.`);
      return;
    }
  } catch (_) {}

  // Анализируем все комментарии по всем сделкам компании — вдруг про ЛК уже спрашивали.
  const siblingIds = siblings.map((s) => s.ID);
  const lkCheck = await checkLkMentionInComments(dealId, siblingIds);

  if (lkCheck.found) {
    console.log(`${logPrefix} Информация про ЛК уже есть в комментариях — не задаю вопрос повторно.`);
    await bitrixRestCall('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId, ENTITY_TYPE: 'deal',
        COMMENT: `${ATT_STAGE4_MARKER}\nИгорь: информация про ЛК Белстройцентра уже зафиксирована в комментариях — продолжаем работу.`,
      },
    });
    return;
  }

  // Отправляем клиенту вопрос про ЛК.
  const phone = await getContactPhone(deal);
  const lkQuestion = `Здравствуйте! Для подачи заявки на аттестацию нам понадобится личный кабинет на сайте Белстройцентра (att.bsc.by).\n\nПодскажите — есть ли у вас доступ к нему?\n— Если есть — пришлите мне логин и пароль\n— Если нет — мы зарегистрируем вас сами\n— Если есть, но забыли данные — напишите, поможем восстановить`;

  if (phone) {
    const preferredChannel = detectPreferredChannel(deal);
    let sent = false;
    if (preferredChannel && preferredChannel !== 'email') {
      const chCfg = getConfiguredWazzupChannel(preferredChannel);
      if (chCfg && chCfg.channelId) {
        try {
          await sendWazzupMessageInternal({ channelKey: preferredChannel, text: lkQuestion, phone, dealId });
          sent = true;
          console.log(`${logPrefix} Вопрос про ЛК отправлен клиенту через ${preferredChannel}.`);
        } catch (e) { console.warn(`${logPrefix} Не удалось отправить вопрос про ЛК через ${preferredChannel}: ${e.message}`); }
      }
    }
    if (!sent) console.warn(`${logPrefix} Вопрос про ЛК подготовлен, но не отправлен: канал связи не распознан/не настроен.`);
  }

  // Получаем имя эксперта для задачи.
  let expertName = '';
  try {
    const u = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
    const user = Array.isArray(u) ? u[0] : u;
    expertName = user ? `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim() : '';
  } catch (_) {}
  const petName = getDiminutiveName(expertName);

  // Ставим задачу эксперту — ждать ответа клиента и записать в комментарий.
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 2);
  tomorrow.setHours(18, 0, 0, 0);
  try {
    await bitrixRestCall('tasks.task.add', {
      fields: {
        TITLE: `${petName}, жду ответа клиента про ЛК Белстройцентра`,
        DESCRIPTION: `${petName}, я отправил клиенту вопрос про личный кабинет на att.bsc.by.\n\nКак клиент ответит — запиши в комментарий к сделке одно из:\n— "Есть ЛК, логин: ... пароль: ..."\n— "Нет ЛК, регистрируем сами"\n— "Забыл доступ, восстанавливаем"\n\nПосле этого я продолжу работу по аттестации автоматически 🙌`,
        RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
        DEADLINE: tomorrow.toISOString().slice(0, 19) + '+03:00',
        UF_CRM_TASK: [`D_${dealId}`],
        PRIORITY: 1,
      },
    });
  } catch (_) {}

  // Комментарий в сделку.
  await bitrixRestCall('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId, ENTITY_TYPE: 'deal',
      COMMENT: `${ATT_STAGE4_MARKER}\n📋 Этап 4: отправил клиенту вопрос про ЛК Белстройцентра. Жду ответа — ${petName} запишет его в комментарий к сделке.`,
    },
  });
  console.log(`${logPrefix} Этап 4 запущен, задача эксперту создана.`);
}

// Маркер задачи-триггера — записывается в description задачи чтобы найти её при polling.
const pendingAttStage4Tasks = new Map(); // dealId → taskId

async function createAttStage4WaitTask(deal, siblings = []) {
  // Создаём задачу-триггер для случая когда у компании есть сопутствующие услуги (СПК и т.п.).
  // Эксперт закрывает эту задачу когда готов начать работу по аттестации.
  const dealId = deal.ID;
  let expertName = '';
  try {
    const u = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
    const user = Array.isArray(u) ? u[0] : u;
    expertName = user ? `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim() : '';
  } catch (_) {}
  const petName = getDiminutiveName(expertName);
  const siblingServices = siblings.map((s) => detectServiceFromDeal(s) || s.TITLE).join(', ');

  const task = await bitrixRestCall('tasks.task.add', {
    fields: {
      TITLE: `${petName}, начни работу по Аттестации когда будешь готова`,
      DESCRIPTION: `${ATT_STAGE4_TASK_MARKER}\n${petName}, сейчас в работе несколько услуг по этой компании (${siblingServices}).\n\nКак будешь готова приступить к аттестации — поставь галочку на этой задаче, и я продолжу работу по сделке автоматически 🙌`,
      RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
      UF_CRM_TASK: [`D_${dealId}`],
      PRIORITY: 0,
    },
  });
  if (task && task.task && task.task.id) {
    pendingAttStage4Tasks.set(String(dealId), String(task.task.id));
    console.log(`[stage4] Задача-триггер создана для сделки ${dealId}, taskId=${task.task.id}`);
  }
}

async function checkPendingAttStage4Tasks() {
  // Polling: проверяем все ожидающие задачи-триггеры — не закрыл ли эксперт галочку.
  for (const [dealId, taskId] of pendingAttStage4Tasks.entries()) {
    try {
      const taskData = await bitrixRestCall('tasks.task.get', { taskId });
      const status = taskData && taskData.task && String(taskData.task.status || '');
      // Статус 5 = завершена в Bitrix.
      if (status === '5' || String(taskData?.task?.realStatus || '') === '5') {
        console.log(`[stage4] Задача-триггер ${taskId} закрыта! Запускаю Этап 4 для сделки ${dealId}.`);
        pendingAttStage4Tasks.delete(dealId);
        const deal = await bitrixRestCall('crm.deal.get', { id: dealId });
        if (deal) {
          const siblings = await findSiblingDeals(deal, deal.STAGE_ID);
          await runAttStage4(deal, siblings);
        }
      }
    } catch (e) {
      console.warn(`[stage4] Ошибка проверки задачи ${taskId}: ${e.message}`);
    }
  }
}


// ============================================================================
// ЭТАП 5: Контроль документов + напоминания
// После отправки хода работы через 2 рабочих дня проверяем:
// - пришли ли документы (по папке на Диске)
// - если нет — ИИ анализирует контекст и решает что делать
// ============================================================================

const DOCS_REMINDER_MARKER = '[MAVIS_DOCS_REMINDER_DONE]';
const DOCS_SPECIALIST_TASK_MARKER = '[MAVIS_SPECIALIST_CHECK_DONE]';

// Трекинг сделок ожидающих проверки документов.
// dealId → { sentAt: Date, companyName: string, service: string, reminderSent: bool, specialistTaskSent: bool }
const pendingDocsCheck = new Map();

function addWorkingDays(date, days) {
  const result = new Date(date);
  let added = 0;
  while (added < days) {
    result.setDate(result.getDate() + 1);
    const dow = result.getDay();
    if (dow !== 0 && dow !== 6) added++; // пропускаем выходные
  }
  return result;
}

function isWorkingDaysPassed(fromDate, days) {
  const threshold = addWorkingDays(new Date(fromDate), days);
  return new Date() >= threshold;
}

async function analyzeContextForDocsReminder(deal, siblings = []) {
  // ИИ анализирует весь контекст сделки перед действием — думает, а не просто выполняет.
  const allDealIds = [deal.ID, ...siblings.map((s) => s.ID)];
  let allComments = [];
  for (const id of allDealIds) {
    try {
      const comments = await bitrixRestList('crm.timeline.comment.list', {
        filter: { ENTITY_ID: id, ENTITY_TYPE: 'deal' },
        select: ['ID', 'COMMENT', 'DATE_CREATE'],
        order: { ID: 'DESC' },
      }, 30);
      allComments.push(...comments.map((c) => `[Сделка ${id}] ${c.DATE_CREATE || ''}: ${c.COMMENT || ''}`));
    } catch (_) {}
  }

  const service = detectServiceFromDeal(deal);
  const docList = getDocumentListForService(service);
  const context = {
    deal: { id: deal.ID, title: deal.TITLE, service, stage: deal.STAGE_ID },
    siblings: siblings.map((s) => ({ id: s.ID, service: detectServiceFromDeal(s) })),
    document_list: docList,
    comments: allComments.slice(0, 50).join('\n'),
    today: new Date().toLocaleDateString('ru-RU'),
  };

  const systemPrompt = `Ты — Игорь, умный ИИ-ассистент MAVIS GROUP. Анализируй контекст сделки и принимай взвешенное решение.
Перед любым действием читай ВСЕ комментарии и поля — возможно ситуация уже изменилась.
Возвращай только валидный JSON без markdown.`;

  const userPrompt = `Проанализируй контекст сделки и реши что делать с контролем документов.

Контекст:
${JSON.stringify(context, null, 2).slice(0, 15000)}

Ответь JSON:
{
  "situation": "краткое описание текущей ситуации по сделке (1-2 предложения)",
  "has_staff": true/false/null,
  "staff_searching": "client"/"us"/"both"/null,
  "staff_found_in_comments": true/false,
  "docs_likely_sent": true/false,
  "action": "send_reminder"/"send_specialist_task"/"send_comment"/"do_nothing",
  "reason": "почему принял именно это решение",
  "client_message": "текст напоминания клиенту (только если action=send_reminder, иначе пустая строка)",
  "expert_task_title": "название задачи эксперту (только если action=send_specialist_task или send_reminder, иначе пустая строка)",
  "expert_task_body": "описание задачи эксперту (только если нужна задача, иначе пустая строка)",
  "comment": "комментарий в сделку если нужен (только если action=send_comment, иначе пустая строка)"
}

Правила принятия решения:
- Если специалисты ЕСТЬ и документы не пришли → action=send_reminder (напомни клиенту)
- Если специалистов НЕТ и их ищет КЛИЕНТ → action=send_specialist_task (спроси эксперта нашли ли людей)
- Если специалистов ищем МЫ → action=do_nothing (наша зона ответственности, не беспокоим)
- Если в комментариях уже есть ответ про документы/людей → action=do_nothing или send_comment
- Если что-то смущает или непонятно → action=send_comment с вопросом эксперту`;

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
    console.warn(`[docsReminder] ИИ-анализ не удался: ${e.message}`);
    return null;
  }
}

async function checkFolderForNewFiles(companyName, afterDate) {
  // Проверяем появились ли новые файлы в папке компании на Диске после указанной даты.
  try {
    const rootId = await getCommonDriveRootId();
    const children = await bitrixRestList('disk.folder.getchildren', { id: rootId }, 1000);
    const targetNorm = normalizeCompanyNameForMatch(companyName);
    const folder = children.find((c) =>
      c.TYPE === 'folder' && (c.NAME === companyName || normalizeCompanyNameForMatch(c.NAME) === targetNorm)
    );
    if (!folder) return false;
    const files = await bitrixRestList('disk.folder.getchildren', { id: folder.ID }, 500);
    const afterTs = new Date(afterDate).getTime();
    return files.some((f) => f.TYPE === 'file' && new Date(f.CREATE_TIME || f.CREATED || 0).getTime() > afterTs);
  } catch (_) { return false; }
}

async function runDocsReminderForDeal(dealId, trackInfo) {
  const logPrefix = `[docsReminder deal=${dealId}]`;
  console.log(`${logPrefix} Запускаю проверку документов...`);

  try {
    const deal = await bitrixRestCall('crm.deal.get', { id: dealId });
    if (!deal) { pendingDocsCheck.delete(String(dealId)); return; }

    const siblings = await findSiblingDeals(deal, deal.STAGE_ID);

    // Сначала смотрим на Диске — может документы уже пришли по почте.
    const companyName = trackInfo.companyName || deal.TITLE;
    const docsArrived = await checkFolderForNewFiles(companyName, trackInfo.sentAt);
    if (docsArrived) {
      console.log(`${logPrefix} Документы уже пришли на почту — напоминание не нужно.`);
      pendingDocsCheck.delete(String(dealId));
      return;
    }

    // ИИ анализирует контекст и решает что делать.
    const analysis = await analyzeContextForDocsReminder(deal, siblings);
    if (!analysis) { pendingDocsCheck.delete(String(dealId)); return; }

    console.log(`${logPrefix} ИИ решение: ${analysis.action} — ${analysis.reason}`);

    const expertUsers = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
    const expertUser = Array.isArray(expertUsers) ? expertUsers[0] : expertUsers;
    const expertName = expertUser ? `${expertUser.NAME || ''} ${expertUser.LAST_NAME || ''}`.trim() : '';
    const petName = getDiminutiveName(expertName);

    if (analysis.action === 'send_reminder' && analysis.client_message) {
      // Отправляем напоминание клиенту.
      const phone = await getContactPhone(deal);
      const preferredChannel = detectPreferredChannel(deal);
      const channels = [];
      if (preferredChannel !== 'email') {
        channels.push(preferredChannel);
        if (preferredChannel !== 'viber') channels.push('viber');
        if (preferredChannel !== 'telegram') channels.push('telegram');
      }
      let sent = false;
      if (phone) {
        for (const ch of channels) {
          const chCfg = getConfiguredWazzupChannel(ch);
          if (!chCfg || !chCfg.channelId) continue;
          try {
            await sendWazzupMessageInternal({ channelKey: ch, text: analysis.client_message, phone, dealId });
            sent = true;
            console.log(`${logPrefix} Напоминание отправлено клиенту через ${ch}.`);
            break;
          } catch (_) {}
        }
      }

      // Задача эксперту.
      if (analysis.expert_task_title) {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 2);
        tomorrow.setHours(18, 0, 0, 0);
        await bitrixRestCall('tasks.task.add', {
          fields: {
            TITLE: analysis.expert_task_title,
            DESCRIPTION: analysis.expert_task_body || `${petName}, клиент не прислал документы. Отправил напоминание${sent ? '' : ' (не удалось отправить — проверь канал связи)'}. Если не ответит — стоит позвонить.`,
            RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
            DEADLINE: tomorrow.toISOString().slice(0, 19) + '+03:00',
            UF_CRM_TASK: [`D_${dealId}`],
            PRIORITY: 1,
          },
        });
      }

      await bitrixRestCall('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId, ENTITY_TYPE: 'deal',
          COMMENT: `${DOCS_REMINDER_MARKER}\nИгорь: ${sent ? 'отправил напоминание клиенту про документы' : 'не удалось отправить напоминание клиенту'} (${analysis.situation})`,
        },
      });

    } else if (analysis.action === 'send_specialist_task' && analysis.expert_task_title) {
      // Задача эксперту уточнить нашли ли специалистов.
      const in3days = addWorkingDays(new Date(), 3);
      in3days.setHours(18, 0, 0, 0);
      await bitrixRestCall('tasks.task.add', {
        fields: {
          TITLE: analysis.expert_task_title || `${petName}, уточни нашли ли специалистов — ${deal.TITLE}`,
          DESCRIPTION: analysis.expert_task_body || `${petName}, клиент искал специалистов. Прошло 2 рабочих дня — уточни есть ли прогресс и можно ли запрашивать документы 🙌`,
          RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
          DEADLINE: in3days.toISOString().slice(0, 19) + '+03:00',
          UF_CRM_TASK: [`D_${dealId}`],
          PRIORITY: 1,
        },
      });
      await bitrixRestCall('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId, ENTITY_TYPE: 'deal',
          COMMENT: `${DOCS_SPECIALIST_TASK_MARKER}\nИгорь: поставил задачу эксперту уточнить статус поиска специалистов (${analysis.situation})`,
        },
      });

    } else if (analysis.action === 'send_comment' && analysis.comment) {
      await bitrixRestCall('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId, ENTITY_TYPE: 'deal',
          COMMENT: `Игорь: ${analysis.comment}`,
        },
      });

    } else {
      console.log(`${logPrefix} Действие не требуется: ${analysis.reason}`);
    }

    // Удаляем из трекинга — проверка выполнена.
    pendingDocsCheck.delete(String(dealId));

  } catch (err) {
    console.error(`${logPrefix} Ошибка: ${err.message}`);
    pendingDocsCheck.delete(String(dealId));
  }
}

async function checkPendingDocsReminders() {
  for (const [dealId, trackInfo] of pendingDocsCheck.entries()) {
    // Проверяем уже установленные маркеры (защита от повторного запуска).
    try {
      const comments = await bitrixRestList('crm.timeline.comment.list', {
        filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
        select: ['ID', 'COMMENT'],
        order: { ID: 'DESC' },
      }, 20);
      const alreadyDone = comments.some((c) =>
        String(c.COMMENT || '').includes(DOCS_REMINDER_MARKER) ||
        String(c.COMMENT || '').includes(DOCS_SPECIALIST_TASK_MARKER)
      );
      if (alreadyDone) { pendingDocsCheck.delete(dealId); continue; }
    } catch (_) {}

    if (isWorkingDaysPassed(trackInfo.sentAt, 2)) {
      await runDocsReminderForDeal(dealId, trackInfo);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}


// ============================================================================
// МОНИТОРИНГ СТАДИЙ ВОРОНКИ — реагирует на смену стадий и контролирует дедлайны
// ============================================================================

// ID стадий воронки 28 (из crm.dealcategory.stage.list)
const STAGE_IDS = {
  unassigned:    'C28:UC_01240N', // Не распределённые
  expertAssigned:'C28:NEW',       // 1. Эксперт назначен
  collection:    process.env.PREPARATION_STAGE_ID || 'C28:PREPARATION', // 2. Сбор информации
  submitted:     'C28:PREPAYMENT_INVOIC', // 3. Заявка подана
  selection:     'C28:EXECUTING', // 4. Подбор
  training:      'C28:FINAL_INVOICE', // 5. Обучение
  transferred:   'C28:UC_PCXQ6C', // 6. Передан оформителю
  docsReady:     'C28:UC_MIFXBB', // 7. Документы готовы
  filed:         'C28:UC_TSEDBH', // 8. Выезд/Подача
  checking:      'C28:UC_VW80J0', // 9. Проверка органом
  remarks:       'C28:UC_LUP9ON', // 10. Устранение замечаний
  refund:        'C28:UC_E11R5S', // 11. Работа с возвратом
  won:           'C28:WON',       // 12. Успешно закрыта
  stuck:         'C28:LOSE',      // 13. Сделка зависла
  return:        'C28:APOLOGY',   // 14. Возврат
};

// Трекинг обработанных событий по стадиям
const stageEventProcessed = new Map(); // dealId_stageId → true

function stageEventKey(dealId, stageId) { return `${dealId}_${stageId}`; }

async function isStageEventProcessed(dealId, stageId, markerText) {
  const key = stageEventKey(dealId, stageId);
  if (stageEventProcessed.has(key)) return true;
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID', 'COMMENT'], order: { ID: 'DESC' },
    }, 20);
    const found = comments.some((c) => String(c.COMMENT || '').includes(markerText));
    if (found) stageEventProcessed.set(key, true);
    return found;
  } catch (_) { return false; }
}

// ---- Пункт 1: напоминание эксперту если нет первого звонка 4+ рабочих часа ----
async function checkExpertFirstCallReminder() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: STAGE_IDS.expertAssigned },
      select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'MOVED_TIME', 'COMPANY_ID'],
      order: { MOVED_TIME: 'ASC' },
    }, 100);
    const now = new Date();
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю без задач/комментариев/сообщений.`);
        continue;
      }

      const movedAt = new Date(deal.MOVED_TIME || deal.DATE_CREATE);
      if (workingHoursBetween(movedAt, now) < 4) continue;
      const marker = '[MAVIS_FIRST_CALL_REMINDER]';
      const already = await isStageEventProcessed(deal.ID, 'first_call', marker);
      if (already) continue;
      if (!isWorkingHour(now)) continue;
      // Проверяем был ли уже звонок в сделке.
      const acts = await bitrixRestList('crm.activity.list', {
        filter: { OWNER_ID: deal.ID, OWNER_TYPE_ID: 2 },
        select: ['ID', 'TYPE_ID', 'PROVIDER_ID'],
        order: { ID: 'DESC' },
      }, 10);
      const hasCall = acts.some((a) => String(a.TYPE_ID) === '2' || /voximplant|call|телеф/i.test(String(a.PROVIDER_ID || '')));
      if (hasCall) { stageEventProcessed.set(stageEventKey(deal.ID, 'first_call'), true); continue; }
      // Ставим задачу эксперту.
      const u = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
      const user = Array.isArray(u) ? u[0] : u;
      const expertName = user ? `${user.NAME || ''}`.trim() : '';
      const petName = getDiminutiveName(expertName);
      const deadline = addWorkingDays(now, 0);
      deadline.setHours(18, 0, 0, 0);
      await bitrixRestCall('tasks.task.add', {
        fields: {
          TITLE: `${petName}, позвони клиенту — сделка ждёт 4+ часа без первого касания`,
          DESCRIPTION: `${petName}, сделка "${deal.TITLE}" уже 4+ рабочих часа на стадии "Эксперт назначен", но первого звонка ещё не было.\n\nПозвони клиенту сегодня — первое касание критично для впечатления.`,
          RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
          DEADLINE: deadline.toISOString().slice(0, 19) + '+03:00',
          UF_CRM_TASK: [`D_${deal.ID}`],
          PRIORITY: 2,
        },
      });
      await bitrixRestCall('crm.timeline.comment.add', {
        fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${marker}\nИгорь: поставил задачу эксперту — нет первого звонка 4+ рабочих часа.` },
      });
      stageEventProcessed.set(stageEventKey(deal.ID, 'first_call'), true);
      console.log(`[stageMonitor] Напоминание о первом звонке → сделка ${deal.ID}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) { console.error('[stageMonitor] checkExpertFirstCallReminder:', e.message); }
}

// ---- Пункт 3: 5 и 10 дней без документов на стадии "Сбор информации" ----
async function checkCollectionStageStuck() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;
  const prepStageId = getPreparationStageId();
  if (!prepStageId) return;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: prepStageId },
      select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'MOVED_TIME', 'COMPANY_ID'],
    }, 100);
    const now = new Date();
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю без задач/комментариев/сообщений.`);
        continue;
      }

      const movedAt = new Date(deal.MOVED_TIME);
      const workDays = workingHoursBetween(movedAt, now) / 9; // ~9 рабочих часов в дне
      if (!isWorkingHour(now)) continue;
      if (workDays >= 10) {
        const marker = '[MAVIS_STUCK_10DAYS]';
        const already = await isStageEventProcessed(deal.ID, 'stuck10', marker);
        if (!already) {
          await bitrixRestCall('im.message.add', { DIALOG_ID: TANYA_USER_ID, MESSAGE: `⚠️ Риск: сделка зависла!\n"${deal.TITLE}" (ID ${deal.ID}) на стадии "Сбор информации" уже 10+ рабочих дней без документов от клиента.\nhttps://mavisgroup.bitrix24.by/crm/deal/details/${deal.ID}/` }).catch(() => {});
          await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${marker}\nИгорь: 10+ дней без документов — уведомил руководителя о риске зависания.` } });
          stageEventProcessed.set(stageEventKey(deal.ID, 'stuck10'), true);
          console.log(`[stageMonitor] 10 дней без документов → сделка ${deal.ID}, уведомил Таню`);
        }
      } else if (workDays >= 5) {
        const marker = '[MAVIS_STUCK_5DAYS]';
        const already = await isStageEventProcessed(deal.ID, 'stuck5', marker);
        if (!already) {
          const u = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
          const user = Array.isArray(u) ? u[0] : u;
          const petName = getDiminutiveName(user ? `${user.NAME || ''}`.trim() : '');
          const dl = addWorkingDays(now, 1); dl.setHours(18, 0, 0, 0);
          await bitrixRestCall('tasks.task.add', {
            fields: {
              TITLE: `${petName}, позвони клиенту — 5 дней без документов`,
              DESCRIPTION: `${petName}, сделка "${deal.TITLE}" на стадии "Сбор информации" уже 5+ рабочих дней, а документов от клиента не поступало.\n\nПозвони клиенту и уточни статус.`,
              RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
              DEADLINE: dl.toISOString().slice(0, 19) + '+03:00',
              UF_CRM_TASK: [`D_${deal.ID}`], PRIORITY: 1,
            },
          });
          await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${marker}\nИгорь: 5 дней без документов — поставил задачу эксперту позвонить клиенту.` } });
          stageEventProcessed.set(stageEventKey(deal.ID, 'stuck5'), true);
          console.log(`[stageMonitor] 5 дней без документов → сделка ${deal.ID}`);
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) { console.error('[stageMonitor] checkCollectionStageStuck:', e.message); }
}

// ---- Пункт 7: "Документы готовы" — сообщение клиенту с правилами заверения ----
async function checkDocsReadyStage() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: STAGE_IDS.docsReady, '>=MOVED_TIME': AUTOPILOT_START_DATE.toISOString().slice(0, 19) },
      select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'COMPANY_ID', process.env.PREFERRED_CONTACT_FIELD_CODE || 'UF_CRM_1781874759140', 'UF_CRM_1781189436900'],
    }, 50);
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю без задач/комментариев/сообщений.`);
        continue;
      }

      const marker = '[MAVIS_DOCS_READY_MSG]';
      const already = await isStageEventProcessed(deal.ID, 'docs_ready', marker);
      if (already) continue;
      const phone = await getContactPhone(deal);
      if (!phone) { stageEventProcessed.set(stageEventKey(deal.ID, 'docs_ready'), true); continue; }
      const u = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
      const user = Array.isArray(u) ? u[0] : u;
      const expertFirstName = user ? (user.NAME || '').trim() : 'эксперт';
      const contactData = deal.CONTACT_ID ? await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID }) : null;
      const clientName = contactData ? (contactData.NAME || '').trim() : '';
      const msg = `${clientName ? clientName + ', д' : 'Д'}обрый день!\n\nДокументы по вашей услуге готовы 🎉\n\nМы свяжемся с вами для согласования формата подписания.\n\nРаспечатайте а** — можете приехать к нам для подписания: г. , ул. Домбровская, 9, офис 12.2.2, Башня 2, этаж 12.\n\n**Если вы не из а** — распечатайте документы, заверьте и подпишите, затем отправьте курьером или почтой по адресу: г. , ул. Домбровская, 9, офис 12.2.2, Башня 2, этаж 12.\n\nПравила заверения:\n— Каждый лист заверяется подписью директора и печатью\n— На последней странице: "Верно. Директор [подпись] [расшифровка] [дата]"\n\nВопросы — всегда на связи!`;
      const channel = detectPreferredChannel(deal);
      const channels = channel !== 'email' ? [channel, channel !== 'viber' ? 'viber' : null, channel !== 'telegram' ? 'telegram' : null].filter(Boolean) : [];
      let sent = false;
      for (const ch of channels) {
        const chCfg = getConfiguredWazzupChannel(ch);
        if (!chCfg || !chCfg.channelId) continue;
        try { await sendWazzupMessageInternal({ channelKey: ch, text: msg, phone, dealId: deal.ID }); sent = true; break; } catch (_) {}
      }
      await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${marker}\nИгорь: ${sent ? 'отправил клиенту правила заверения документов' : 'не удалось отправить — нет канала связи'}.` } });
      stageEventProcessed.set(stageEventKey(deal.ID, 'docs_ready'), true);
      console.log(`[stageMonitor] Документы готовы → сделка ${deal.ID}, сообщение ${sent ? 'отправлено' : 'не отправлено'}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) { console.error('[stageMonitor] checkDocsReadyStage:', e.message); }
}

// ---- Пункт 8: "Успешно закрыты" — поздравление + запрос акта ----
const wonAckSent = new Map(); // dealId → lastRemindAt
async function checkWonStage() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: STAGE_IDS.won, '>=MOVED_TIME': AUTOPILOT_START_DATE.toISOString().slice(0, 19) },
      select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'CONTACT_ID', 'MOVED_TIME', process.env.PREFERRED_CONTACT_FIELD_CODE || 'UF_CRM_1781874759140', 'UF_CRM_1781189436900'],
    }, 50);
    const now = new Date();
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю без задач/комментариев/сообщений.`);
        continue;
      }

      const phone = await getContactPhone(deal);
      if (!phone) continue;
      const contactData = deal.CONTACT_ID ? await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID }).catch(() => null) : null;
      const clientName = contactData ? (contactData.NAME || '').trim() : '';
      // Первое поздравление.
      const congMarker = '[MAVIS_WON_CONGRATS]';
      const alreadyCongrats = await isStageEventProcessed(deal.ID, 'won_congrats', congMarker);
      if (!alreadyCongrats) {
        const serviceNames = companyDeals.map((d) => getShortServiceName(detectServiceFromDeal(d))).filter(Boolean);
        const serviceLabel = [...new Set(serviceNames)].join(' и ') || 'услуги';
        const msg = `${clientName ? clientName + ', п' : 'П'}оздравляем с успешным получением ${serviceLabel}! 🎉\n\nРады, что смогли помочь. Для закрытия с нашей стороны нам нужен скан подписанного акта выполненных работ.\n\nПришлите, пожалуйста, на почту: mavis.group@mail.ru`;
        const channel = detectPreferredChannel(deal);
        const channels = channel !== 'email' ? [channel, channel !== 'viber' ? 'viber' : null, channel !== 'telegram' ? 'telegram' : null].filter(Boolean) : [];
        let sent = false;
        for (const ch of channels) {
          const chCfg = getConfiguredWazzupChannel(ch);
          if (!chCfg || !chCfg.channelId) continue;
          try { await sendWazzupMessageInternal({ channelKey: ch, text: msg, phone, dealId: deal.ID }); sent = true; break; } catch (_) {}
        }
        await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${congMarker}\nИгорь: ${sent ? 'поздравил клиента и запросил скан акта' : 'не удалось отправить поздравление'}.` } });
        wonAckSent.set(String(deal.ID), now);
        stageEventProcessed.set(stageEventKey(deal.ID, 'won_congrats'), true);
        console.log(`[stageMonitor] Успешно закрыта → поздравление сделка ${deal.ID}`);
        continue;
      }
      // Напоминание каждые 2 рабочих дня если нет акта.
      const remMarker = '[MAVIS_WON_ACT_REMIND]';
      const comments = await bitrixRestList('crm.timeline.comment.list', {
        filter: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal' }, select: ['ID', 'COMMENT', 'DATE_CREATE'], order: { ID: 'DESC' },
      }, 30).catch(() => []);
      const remComments = comments.filter((c) => String(c.COMMENT || '').includes(remMarker));
      const reminderCount = remComments.length;
      // Читаем время последнего напоминания из Bitrix — защита от повтора после рестарта.
      const lastRemindBitrix = remComments.length ? new Date(remComments[0].DATE_CREATE) : null;
      const lastRemind = lastRemindBitrix || wonAckSent.get(String(deal.ID));
      if (lastRemind && workingHoursBetween(lastRemind, now) < 18) continue; // 2 рабочих дня = 18 раб. часов
      if (reminderCount >= 3) {
        // После 3 напоминаний — задача эксперту позвонить.
        const taskMarker = '[MAVIS_WON_CALL_TASK]';
        const alreadyTask = comments.some((c) => String(c.COMMENT || '').includes(taskMarker));
        if (!alreadyTask) {
          const u = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
          const user = Array.isArray(u) ? u[0] : u;
          const petName = getDiminutiveName(user ? (user.NAME || '').trim() : '');
          const dl = addWorkingDays(now, 1); dl.setHours(18, 0, 0, 0);
          // ✅ ИСПРАВЛЕНО: Используем createTaskWithDelay чтобы не создавать каждые 20 минут
          await createTaskWithDelay({ TITLE: `${petName}, запроси акт у клиента — 3 напоминания без ответа`, DESCRIPTION: `${petName}, клиент по сделке "${deal.TITLE}" не прислал скан акта уже неделю. Позвони и уточни.`, RESPONSIBLE_ID: deal.ASSIGNED_BY_ID, DEADLINE: dl.toISOString().slice(0, 19) + '+03:00', UF_CRM_TASK: [`D_${deal.ID}`], PRIORITY: 1 }, 4);
          await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${taskMarker}\nИгорь: поставил задачу эксперту позвонить клиенту — 3 напоминания про акт без ответа.` } });
        }
        continue;
      }
      // Шлём напоминание про акт.
      const remVariants = [
        `${clientName ? clientName + ', д' : 'Д'}обрый день! Напоминаем — ещё не получили от вас скан подписанного акта. Пришлите, пожалуйста, на почту: mavis.group@mail.ru`,
        `${clientName ? clientName + ', х' : 'Х'}отели уточнить — акт ещё не получили. Как только будет готов, пришлите скан на mavis.group@mail.ru`,
        `${clientName ? clientName + ', н' : 'Н'}ам нужен скан подписанного акта для закрытия с нашей стороны. Пришлите на почту: mavis.group@mail.ru`,
      ];
      const remMsg = remVariants[Math.min(reminderCount, remVariants.length - 1)];
      const channel = detectPreferredChannel(deal);
      const channels = channel !== 'email' ? [channel, channel !== 'viber' ? 'viber' : null, channel !== 'telegram' ? 'telegram' : null].filter(Boolean) : [];
      let sent = false;
      for (const ch of channels) {
        const chCfg = getConfiguredWazzupChannel(ch);
        if (!chCfg || !chCfg.channelId) continue;
        try { await sendWazzupMessageInternal({ channelKey: ch, text: remMsg, phone, dealId: deal.ID }); sent = true; break; } catch (_) {}
      }
      if (sent) {
        await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${remMarker}\nИгорь: напоминание #${reminderCount + 1} про скан акта.` } });
        wonAckSent.set(String(deal.ID), now);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) { console.error('[stageMonitor] checkWonStage:', e.message); }
}

// ---- Пункт 9: "Работа с возвратом" — уведомление Тане с анализом звонков ----
async function checkRefundStage() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: STAGE_IDS.refund, '>=MOVED_TIME': AUTOPILOT_START_DATE.toISOString().slice(0, 19) },
      select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'MOVED_TIME'],
    }, 20);
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю без задач/комментариев/сообщений.`);
        continue;
      }

      const marker = '[MAVIS_REFUND_NOTIFIED]';
      const already = await isStageEventProcessed(deal.ID, 'refund', marker);
      if (already) continue;
      // Пытаемся найти последний звонок и выжать проблему через ИИ.
      let problemSummary = 'причина не определена — проверь последние звонки вручную';
      try {
        const callRecord = await findCallForDeal(deal.ID, { deal, assignedById: deal.ASSIGNED_BY_ID, minDate: deal.MOVED_TIME });
        if (callRecord) {
          const transcript = await transcribeAudioUrl(callRecord.url, callRecord.fileName);
          if (transcript && transcript.length > 50) {
            const raw = await callAiChatCompletion({
              model: config.aiModel,
              temperature: 0.1,
              messages: [{ role: 'user', content: `Из расшифровки звонка определи главную причину недовольства клиента в 1-2 предложениях. Расшифровка: "${transcript.slice(0, 3000)}". Ответь только фразой с причиной.` }],
            });
            if (raw && raw.trim().length > 10) problemSummary = raw.trim();
          }
        }
      } catch (_) {}
      const msg = `⚠️ Риск возврата!\n\nСделка: "${deal.TITLE}" (ID ${deal.ID})\nПереведена на стадию "Работа с возвратом".\n\nВыжимка из звонков: ${problemSummary}\n\nhttps://mavisgroup.bitrix24.by/crm/deal/details/${deal.ID}/`;
      try { await bitrixRestCall('im.message.add', { DIALOG_ID: TANYA_USER_ID, MESSAGE: msg }); } catch (_) {}
      await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${marker}\nИгорь: уведомил руководителя о риске возврата. Причина: ${problemSummary}` } });
      stageEventProcessed.set(stageEventKey(deal.ID, 'refund'), true);
      console.log(`[stageMonitor] Работа с возвратом → сделка ${deal.ID}, Таня уведомлена`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } catch (e) { console.error('[stageMonitor] checkRefundStage:', e.message); }
}

// ---- Пункт 5: "Подбор" — мониторинг этапа ----
const FIELD_NEEDS_SELECTION    = 'UF_CRM_1781103233'; // "Нужен подбор" Да/Нет
const FIELD_WHO_WE_SEARCH      = 'UF_CRM_1781875347'; // "Кого ищем (специальность)"
const FIELD_MAVIS_SELECTION    = 'UF_CRM_1781875776'; // "Подбор наш (Mavis)" Да/Нет

async function checkSelectionStage() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: STAGE_IDS.selection },
      select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'MOVED_TIME',
        FIELD_NEEDS_SELECTION, FIELD_WHO_WE_SEARCH, FIELD_MAVIS_SELECTION],
    }, 50);
    const now = new Date();
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю без задач/комментариев/сообщений.`);
        continue;
      }

      const movedAt = new Date(deal.MOVED_TIME);
      const workDays = workingHoursBetween(movedAt, now) / 9;
      if (!isWorkingHour(now)) continue;
      const needsSelection = String(deal[FIELD_NEEDS_SELECTION] || '').toLowerCase();
      const isMavisSearch = String(deal[FIELD_MAVIS_SELECTION] || '').toLowerCase() === 'да' || deal[FIELD_MAVIS_SELECTION] === true || deal[FIELD_MAVIS_SELECTION] === '1';
      const whoWeSearch = String(deal[FIELD_WHO_WE_SEARCH] || 'специалист');
      if (!needsSelection || needsSelection === 'нет' || needsSelection === 'false' || needsSelection === '0') continue;
      const u = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
      const user = Array.isArray(u) ? u[0] : u;
      const petName = getDiminutiveName(user ? (user.NAME || '').trim() : '');

      if (isMavisSearch) {
        // Подбор наш — каждую неделю отчёт эксперту, при 14+ днях — Тане.
        const weekKey = `sel_mavis_w${Math.floor(workDays / 7)}_${deal.ID}`;
        if (!stageEventProcessed.has(weekKey)) {
          const dl = addWorkingDays(now, 1); dl.setHours(18, 0, 0, 0);
          await bitrixRestCall('tasks.task.add', {
            fields: {
              TITLE: `${petName}, статус по подбору специалиста — ${whoWeSearch}`,
              DESCRIPTION: `${petName}, сделка "${deal.TITLE}" на этапе подбора уже ${Math.round(workDays)} рабочих дней.\n\nПодбираем: ${whoWeSearch}\n\nПроверь базу прорабов и обнови статус по сделке.`,
              RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
              DEADLINE: dl.toISOString().slice(0, 19) + '+03:00',
              UF_CRM_TASK: [`D_${deal.ID}`], PRIORITY: 1,
            },
          });
          await bitrixRestCall('crm.timeline.comment.add', {
            fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `[MAVIS_SEL_MAVIS_W${Math.floor(workDays / 7)}]\nИгорь: еженедельный отчёт по подбору (${Math.round(workDays)} раб. дней), ищем: ${whoWeSearch}` },
          });
          stageEventProcessed.set(weekKey, true);
          console.log(`[stageMonitor] Подбор Mavis → еженедельная задача сделка ${deal.ID}`);
        }
        if (workDays >= 14) {
          const key14 = `sel_mavis_14_${deal.ID}`;
          if (!stageEventProcessed.has(key14)) {
            await bitrixRestCall('im.message.add', {
              DIALOG_ID: TANYA_USER_ID,
              MESSAGE: `📋 Отчёт по подбору специалиста\n\nСделка: "${deal.TITLE}" (ID ${deal.ID})\nИщем: ${whoWeSearch}\nНа этапе подбора уже ${Math.round(workDays)} рабочих дней.\n\nhttps://mavisgroup.bitrix24.by/crm/deal/details/${deal.ID}/`,
            }).catch(() => {});
            stageEventProcessed.set(key14, true);
            console.log(`[stageMonitor] Подбор Mavis 14+ дней → уведомили Таню, сделка ${deal.ID}`);
          }
        }
      } else {
        // Подбор самостоятельно — напоминаем эксперту каждые 7 дней.
        const weekKey = `sel_self_w${Math.floor(workDays / 7)}_${deal.ID}`;
        if (!stageEventProcessed.has(weekKey) && workDays >= 7) {
          const dl = addWorkingDays(now, 1); dl.setHours(18, 0, 0, 0);
          await bitrixRestCall('tasks.task.add', {
            fields: {
              TITLE: `${petName}, уточни нашли ли людей — ${whoWeSearch}`,
              DESCRIPTION: `${petName}, клиент по сделке "${deal.TITLE}" искал специалиста самостоятельно: ${whoWeSearch}.\n\nПрошло ${Math.round(workDays)} рабочих дней — уточни у клиента есть ли прогресс и можно ли двигаться дальше.`,
              RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
              DEADLINE: dl.toISOString().slice(0, 19) + '+03:00',
              UF_CRM_TASK: [`D_${deal.ID}`], PRIORITY: 1,
            },
          });
          await bitrixRestCall('crm.timeline.comment.add', {
            fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `[MAVIS_SEL_SELF_W${Math.floor(workDays / 7)}]\nИгорь: напоминание эксперту уточнить статус самостоятельного подбора (${Math.round(workDays)} раб. дней), ищут: ${whoWeSearch}` },
          });
          stageEventProcessed.set(weekKey, true);
          console.log(`[stageMonitor] Подбор self → задача эксперту сделка ${deal.ID}`);
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) { console.error('[stageMonitor] checkSelectionStage:', e.message); }
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

    // ✅ ИСПРАВЛЕНО: Динамический лукбэк вместо даты старта сервера
    const lookbackHours = Number(process.env.AUTOPILOT_LOOKBACK_HOURS || 24);
    const lookbackDate = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);
    const startDateStr = lookbackDate.toISOString().slice(0, 19);
    console.log(`[autopilot] Ищу сделки за последние ${lookbackHours} часов, начиная с ${startDateStr}`);
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
          config.aiControlFieldCode, 'UF_CRM_1784898776915',
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

    // v44: мониторинг стадий с автонапоминаниями/задачами выключен по умолчанию.
    // Иначе ассистент начинает писать/ставить задачи по факту движения стадии без звонка эксперта.
    if (config.stageMonitoringEnabled) await runStageMonitoring();

    // Проверяем нераспределённые сделки — уведомляем Таню если висят 4+ рабочих часа.
    await checkUnassignedDeals();
  } catch (err) {
    console.error('[autopilot] Ошибка polling-цикла:', err.message || err);
  }
}



// v47: ИИгорь — автоматический диспетчер прорабов.
// Работает на сервере через BITRIX_WEBHOOK_URL: читает поле "Специалист" в производственной сделке,
// переводит прораба в "Занят", возвращает в "Свободен" после успешного закрытия сделки, и один раз
// предлагает кандидатов эксперту, если в сделке выявлена потребность в подборе с нашей стороны.
const FOREMAN_BUSY_MARKER = '[MAVIS_FOREMAN_BUSY]';
const FOREMAN_FREE_MARKER = '[MAVIS_FOREMAN_FREE]';
const FOREMAN_SUGGEST_MARKER = '[MAVIS_FOREMAN_SUGGEST]';
let foremanAutomationRunning = false;

function fgText(value) {
  if (value === null || value === undefined || value === false) return '';
  if (Array.isArray(value)) return value.map(fgText).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    const keys = ['VALUE', 'value', 'ID', 'id', 'TITLE', 'title', 'NAME', 'name', 'URL', 'url'];
    return keys.map((k) => fgText(value[k])).filter(Boolean).join(' ') || JSON.stringify(value);
  }
  return String(value || '').trim();
}

function fgNormalize(value) {
  return fgText(value).toLowerCase().replace(/ё/g, 'е').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function fgExtractDealIds(value) {
  const ids = new Set();
  const walk = (v) => {
    if (v === null || v === undefined || v === false) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') {
      ['VALUE','value','ID','id','dealId','DEAL_ID','ENTITY_ID','entityId','url','URL'].forEach((k) => walk(v[k]));
      return;
    }
    const text = String(v || '');
    // Привязка может прийти как "37394" или как ссылка /crm/deal/details/37394/.
    const dealLink = text.match(/deal\/details\/(\d+)/i);
    if (dealLink) ids.add(dealLink[1]);
    const pure = text.trim().match(/^\d{3,}$/);
    if (pure) ids.add(pure[0]);
  };
  walk(value);
  return [...ids];
}

function fgDate(value) {
  const text = fgText(value);
  if (!text) return null;
  const d = new Date(text);
  if (!Number.isNaN(d.getTime())) return d;
  const m = text.match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})/);
  if (m) {
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const d2 = new Date(year, Number(m[2]) - 1, Number(m[1]));
    if (!Number.isNaN(d2.getTime())) return d2;
  }
  return null;
}

function fgDaysUntil(date) {
  if (!date) return null;
  const start = new Date(); start.setHours(0,0,0,0);
  const end = new Date(date); end.setHours(0,0,0,0);
  return Math.ceil((end - start) / 86400000);
}

function fgDateRu(date) {
  if (!date) return 'не указана';
  return date.toLocaleDateString('ru-RU');
}

function fgForemanCfg() {
  return {
    foremanCategoryId: Number(config.foremanCategoryId || 32),
    productionCategoryId: Number(config.productionCategoryId || 28),
    stageFree: config.foremanStageFree || 'C32:PREPARATION',
    stageBusy: config.foremanStageBusy || 'C32:PREPAYMENT_INVOIC',
    stageExpiring: config.foremanStageCertExpiring || 'C32:EXECUTING',
    stageAfterClose: config.foremanStageAfterClose || '',
    fieldWorkType: config.foremanFieldWorkType || 'UF_CRM_1784269813234',
    fieldPhone: config.foremanFieldPhone || 'UF_CRM_1784212767689',
    fieldCertExpires: config.foremanFieldCertExpires || 'CLOSEDATE',
    fieldProductionSpecialist: config.foremanProductionSpecialistField || 'UF_CRM_1784528226',
  };
}

function fgForemanCertDate(foreman, cfg) {
  return fgDate(foreman && (foreman[cfg.fieldCertExpires] || foreman.CLOSEDATE));
}

function fgForemanIsExpiring(foreman, cfg) {
  const left = fgDaysUntil(fgForemanCertDate(foreman, cfg));
  return left !== null && left <= 62;
}

function fgNormWorkType(value) {
  const t = fgNormalize(value);
  if (/фасад/.test(t)) return 'фасады';
  if (/общестрой|общестро|смр|строительн/.test(t)) return 'общестрой';
  if (/электр|электромонтаж/.test(t)) return 'электрика';
  if (/автоматизац/.test(t)) return 'автоматизация';
  if (/слабот|связ|сигнализац/.test(t)) return 'слаботочные сети';
  if (/водоснаб|канализац|\bвк\b/.test(t)) return 'водоснабжение/канализация';
  if (/отопл|вентиляц|\bов\b/.test(t)) return 'отопление/вентиляция';
  if (/благоустрой/.test(t)) return 'благоустройство';
  if (/дорог/.test(t)) return 'дороги';
  if (/геодез/.test(t)) return 'геодезия';
  return t;
}

function fgDealText(deal, comments = '') {
  const parts = [];
  for (const [key, value] of Object.entries(deal || {})) {
    if (key === 'COMMENTS' || key === 'TITLE' || key === 'STAGE_ID' || key.startsWith('UF_CRM_')) {
      const text = fgText(value);
      if (text) parts.push(text);
    }
  }
  if (comments) parts.push(comments);
  return fgNormalize(parts.join(' '));
}

function fgDetectNeed(text) {
  const need = /нужен.*(прораб|мастер|специалист|человек|подбор)|требуется.*(прораб|мастер|специалист|человек|подбор)|подобрать.*(прораб|мастер|специалист|человек)|подбор.*(с нашей|мавис|mavis|наш[еёи])|нет.*(прораб|мастер|специалист)|ищем.*(прораб|мастер|специалист)|с нашей стороны|наша помощь|понадобится.*помощ/.test(text);
  const clientDoes = /самостоятельно|сам[аиы]? ищ|будут искать.*сами|клиент.*сам|силами клиента|без подбор/.test(text);
  if (clientDoes && !/с нашей стороны|мавис|mavis|наш[еёи]|наша помощь|понадобится.*помощ/.test(text)) return { need: false, reason: 'по свежим данным клиент ищет специалиста самостоятельно / без подбора MAVIS' };
  if (need) return { need: true, reason: 'по полям/комментариям есть потребность в подборе специалиста с нашей стороны' };
  return { need: false, reason: 'явной потребности в подборе прораба с нашей стороны нет' };
}

function fgDetectWorks(text) {
  const works = [];
  const add = (x) => { if (!works.includes(x)) works.push(x); };
  if (/общестрой|общестро|общестроительн|\bсмр\b/.test(text)) add('общестрой');
  if (/фасад/.test(text)) add('фасады');
  if (/электр|электромонтаж/.test(text)) add('электрика');
  if (/автоматизац/.test(text)) add('автоматизация');
  if (/слабот|связ|сигнализац/.test(text)) add('слаботочные сети');
  if (/водоснаб|канализац|\bвк\b/.test(text)) add('водоснабжение/канализация');
  if (/отопл|вентиляц|\bов\b/.test(text)) add('отопление/вентиляция');
  if (/благоустрой/.test(text)) add('благоустройство');
  if (/дорог/.test(text)) add('дороги');
  if (/геодез/.test(text)) add('геодезия');
  return works;
}

async function fgLoadForemen(cfg) {
  const rows = await bitrixRestList('crm.deal.list', {
    filter: { CATEGORY_ID: cfg.foremanCategoryId, CLOSED: 'N' },
    order: { TITLE: 'ASC' },
    select: ['ID','TITLE','STAGE_ID','STAGE_SEMANTIC_ID','CLOSED','CLOSEDATE','DATE_MODIFY', cfg.fieldWorkType, cfg.fieldPhone, cfg.fieldCertExpires],
  }, 1000);
  const map = new Map(rows.map((d) => [String(d.ID), d]));
  return { rows, map };
}

async function fgLoadProductionDeals(cfg) {
  const select = ['ID','TITLE','STAGE_ID','STAGE_SEMANTIC_ID','CLOSED','CATEGORY_ID','ASSIGNED_BY_ID','COMPANY_ID','CONTACT_ID','COMMENTS','DATE_MODIFY','MOVED_TIME', cfg.fieldProductionSpecialist, config.serviceFieldCode || 'UF_CRM_1765113071'];
  const active = await bitrixRestList('crm.deal.list', {
    filter: { CATEGORY_ID: cfg.productionCategoryId, CLOSED: 'N' },
    order: { DATE_MODIFY: 'DESC' },
    select,
  }, config.foremanMaxProductionDeals || 300);
  const since = new Date(Date.now() - (config.foremanLookbackDays || 45) * 86400000).toISOString().slice(0, 19);
  const closedWon = await bitrixRestList('crm.deal.list', {
    filter: { CATEGORY_ID: cfg.productionCategoryId, CLOSED: 'Y', STAGE_SEMANTIC_ID: 'S', '>=DATE_MODIFY': since },
    order: { DATE_MODIFY: 'DESC' },
    select,
  }, config.foremanMaxProductionDeals || 300);
  return { active, closedWon };
}

async function fgLoadDealComments(dealId, limit = 20) {
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      order: { ID: 'DESC' },
      select: ['ID','COMMENT','CREATED'],
    }, limit);
    return comments.map((c) => fgText(c.COMMENT)).filter(Boolean).join('\n');
  } catch (_) {
    return '';
  }
}

async function fgTimelineHasMarker(dealId, marker, limit = 50) {
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      order: { ID: 'DESC' },
      select: ['ID','COMMENT'],
    }, limit);
    return comments.some((c) => String(c.COMMENT || '').includes(marker));
  } catch (_) {
    return false;
  }
}

async function fgAddCommentOnce(dealId, marker, comment) {
  if (await fgTimelineHasMarker(dealId, marker)) return false;
  await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: `${marker}\n${comment}` } });
  return true;
}

async function fgSetDealStageIfNeeded(deal, targetStage) {
  if (!deal || !targetStage || String(deal.STAGE_ID) === String(targetStage)) return false;
  await bitrixRestCall('crm.deal.update', { id: deal.ID, fields: { STAGE_ID: targetStage } });
  deal.STAGE_ID = targetStage;
  return true;
}

async function fgFindForemanStageByName(cfg, patterns) {
  try {
    const stages = await bitrixRestCall('crm.dealcategory.stage.list', { id: cfg.foremanCategoryId });
    const list = Array.isArray(stages) ? stages : (stages && Array.isArray(stages.result) ? stages.result : []);
    const found = list.find((s) => patterns.some((rx) => rx.test(fgNormalize(s.NAME || s.name || s.TITLE || s.title || ''))));
    return found ? (found.STATUS_ID || found.statusId || found.ID || found.id || '') : '';
  } catch (e) {
    console.warn(`[foreman] не удалось получить стадии воронки прорабов: ${e.message || e}`);
    return '';
  }
}

async function fgResolveForemanAfterCloseStage(foreman, cfg) {
  // После закрытия производства теперь прораб уходит на контроль увольнения, а не в 'Свободен'.
  // Переменная приоритетнее авто-поиска, чтобы не зависеть от названия стадии.
  if (cfg.stageAfterClose) return cfg.stageAfterClose;
  const byName = await fgFindForemanStageByName(cfg, [/контроль.*увольнен/, /увольнен/]);
  if (byName) return byName;
  // Без стадии 'Контроль увольнения' сохраняем старую безопасную логику, но пишем предупреждение.
  console.warn('[foreman] FOREMAN_STAGE_AFTER_CLOSE не задана и стадия Контроль увольнения не найдена — fallback на старую логику.');
  return fgForemanIsExpiring(foreman, cfg) ? cfg.stageExpiring : cfg.stageFree;
}

function fgForemanCandidateText(f, cfg) {
  const date = fgForemanCertDate(f, cfg);
  const left = fgDaysUntil(date);
  return `${f.TITLE || `Прораб ${f.ID}`} — ${fgText(f[cfg.fieldWorkType]) || 'вид работ не указан'}, тел. ${fgText(f[cfg.fieldPhone]) || 'не указан'}, аттестат до ${fgDateRu(date)}${left !== null ? ` (${left} дн.)` : ''}, сделка прораба: https://mavisgroup.bitrix24.by/crm/deal/details/${f.ID}/`;
}

async function fgExistingSuggestionTask(dealId) {
  try {
    const raw = await bitrixRestCall('tasks.task.list', {
      filter: { UF_CRM_TASK: `D_${dealId}`, '%TITLE': 'ИИгорь' },
      select: ['ID','TITLE','STATUS','UF_CRM_TASK'],
    });
    const tasks = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tasks) ? raw.tasks : []);
    return tasks.find((t) => !['5','6'].includes(String(t.status || t.STATUS || '')) && /прораб/i.test(t.title || t.TITLE || '')) || null;
  } catch (_) {
    return null;
  }
}

async function fgCreateSuggestionTask(deal, candidateList, works) {
  if (!config.foremanCreateSuggestionTasks || !config.foremanTasksEnabled) return null;
  const existing = await fgExistingSuggestionTask(deal.ID);
  if (existing) return { existing: true, task: existing };
  const deadline = new Date(); deadline.setDate(deadline.getDate() + 1); deadline.setHours(12, 0, 0, 0);
  const result = await bitrixRestCall('tasks.task.add', {
    fields: {
      TITLE: `ИИгорь: предложены прорабы — ${works.join(', ')}`,
      DESCRIPTION: `По сделке ${deal.TITLE || deal.ID} выявлена потребность в подборе прораба с нашей стороны.\n\n${candidateList}\n\nВыберите подходящего кандидата и зафиксируйте его в поле “Специалист”. После этого ИИгорь сам переведёт прораба в статус “Занят”.`,
      RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
      DEADLINE: deadline.toISOString(),
      UF_CRM_TASK: [`D_${deal.ID}`],
    },
  });
  return { existing: false, task: result };
}

async function runForemanAutomationCycle(source = 'manual') {
  if (foremanAutomationRunning) return { ok: false, skipped: true, message: 'Цикл ИИгоря уже выполняется' };
  foremanAutomationRunning = true;
  const cfg = fgForemanCfg();
  const summary = {
    ok: true,
    source,
    cfg,
    activeProductionDeals: 0,
    closedWonDealsChecked: 0,
    occupiedLinks: 0,
    movedBusy: 0,
    busyCommentsAdded: 0,
    released: 0,
    movedExpiring: 0,
    movedFree: 0,
    suggestionsCreated: 0,
    suggestionsSkipped: 0,
    log: [],
  };
  try {
    if (!config.bitrixWebhookUrl) throw new Error('BITRIX_WEBHOOK_URL не задан — серверный автомат ИИгоря не может обращаться к Bitrix.');
    const { rows: foremen, map: foremanMap } = await fgLoadForemen(cfg);
    const { active, closedWon } = await fgLoadProductionDeals(cfg);
    summary.activeProductionDeals = active.length;
    summary.closedWonDealsChecked = closedWon.length;

    const occupiedByForeman = new Map();
    for (const deal of active) {
      const ids = fgExtractDealIds(deal[cfg.fieldProductionSpecialist]);
      for (const foremanId of ids) {
        if (!occupiedByForeman.has(foremanId)) occupiedByForeman.set(foremanId, []);
        occupiedByForeman.get(foremanId).push(deal);
      }
    }
    summary.occupiedLinks = [...occupiedByForeman.values()].reduce((acc, arr) => acc + arr.length, 0);

    // 1) Активные производственные сделки с заполненным полем “Специалист” занимают прораба.
    for (const [foremanId, deals] of occupiedByForeman.entries()) {
      const f = foremanMap.get(String(foremanId));
      if (!f) {
        summary.log.push(`Прораб ${foremanId} указан в производстве, но не найден в воронке ${cfg.foremanCategoryId}`);
        continue;
      }
      const firstDeal = deals[0];
      const moved = await fgSetDealStageIfNeeded(f, cfg.stageBusy);
      if (moved) summary.movedBusy++;
      const marker = `${FOREMAN_BUSY_MARKER} foreman=${foremanId}`;
      const links = deals.map((d) => `— ${d.TITLE || 'без названия'}: https://mavisgroup.bitrix24.by/crm/deal/details/${d.ID}/`).join('\n');
      const added = await fgAddCommentOnce(foremanId, marker,
        `ИИгорь: прораб занят в производственной сделке.\n\n${links}\n\nПоле производства: ${cfg.fieldProductionSpecialist}.`);
      if (added) summary.busyCommentsAdded++;
      summary.log.push(`${foremanId} | ${f.TITLE || '-'} | занят в ${deals.length} производственной сделке(ах)${moved ? ' → перевёл в Занят' : ''}`);
    }

    // 2) Успешно закрытые производственные сделки освобождают прораба, если он больше нигде активно не занят.
    for (const deal of closedWon) {
      const ids = fgExtractDealIds(deal[cfg.fieldProductionSpecialist]);
      for (const foremanId of ids) {
        if (occupiedByForeman.has(String(foremanId))) continue;
        const f = foremanMap.get(String(foremanId));
        if (!f) continue;
        if (String(f.STAGE_ID) !== String(cfg.stageBusy)) continue;
        const target = fgForemanIsExpiring(f, cfg) ? cfg.stageExpiring : cfg.stageFree;
        await fgSetDealStageIfNeeded(f, target);
        const marker = `${FOREMAN_FREE_MARKER} foreman=${foremanId} prod=${deal.ID}`;
        await fgAddCommentOnce(foremanId, marker,
          `ИИгорь: производственная сделка успешно завершена, прораб больше не найден в активных производственных сделках.\n\nОсвобождён после сделки: ${deal.TITLE || deal.ID}\nСсылка: https://mavisgroup.bitrix24.by/crm/deal/details/${deal.ID}/\nНовый статус: ${target === cfg.stageExpiring ? 'Аттестация истекает' : 'Свободен'}.`);
        summary.released++;
        summary.log.push(`${foremanId} | ${f.TITLE || '-'} | производство ${deal.ID} закрыто успешно → ${target}`);
      }
    }

    // 3) Все НЕ занятые актуализируем по дате аттестата.
    for (const f of foremen) {
      if (occupiedByForeman.has(String(f.ID))) continue;
      if (String(f.STAGE_ID) === String(cfg.stageBusy)) continue; // не трогаем ручной “Занят”, если нет подтверждённого закрытия
      const target = fgForemanIsExpiring(f, cfg) ? cfg.stageExpiring : cfg.stageFree;
      const moved = await fgSetDealStageIfNeeded(f, target);
      if (moved && target === cfg.stageExpiring) summary.movedExpiring++;
      if (moved && target === cfg.stageFree) summary.movedFree++;
    }

    // 4) По активным производственным сделкам без привязанного специалиста — одна задача с кандидатами.
    if (config.foremanSuggestionScanEnabled) {
      const freeCandidates = foremen.filter((f) => String(f.STAGE_ID) === String(cfg.stageFree) && !fgForemanIsExpiring(f, cfg));
      for (const deal of active) {
        const alreadyLinked = fgExtractDealIds(deal[cfg.fieldProductionSpecialist]).length > 0;
        if (alreadyLinked) continue;
        const comments = await fgLoadDealComments(deal.ID, 15);
        const text = fgDealText(deal, comments);
        const need = fgDetectNeed(text);
        if (!need.need) continue;
        const works = fgDetectWorks(text);
        if (!works.length) {
          summary.suggestionsSkipped++;
          continue;
        }
        const candidates = freeCandidates.filter((f) => {
          const w = fgNormWorkType(f[cfg.fieldWorkType]);
          return works.some((rw) => w.includes(rw) || rw.includes(w));
        }).slice(0, 5);
        if (!candidates.length) {
          const marker = `${FOREMAN_SUGGEST_MARKER} no-candidate prod=${deal.ID}`;
          await fgAddCommentOnce(deal.ID, marker, `ИИгорь: потребность в подборе прораба есть (${need.reason}), но свободных подходящих кандидатов по виду работ ${works.join(', ')} не найдено.`);
          summary.suggestionsSkipped++;
          continue;
        }
        const candidateList = candidates.map((f, i) => `${i + 1}. ${fgForemanCandidateText(f, cfg)}`).join('\n');
        const marker = `${FOREMAN_SUGGEST_MARKER} prod=${deal.ID}`;
        const added = await fgAddCommentOnce(deal.ID, marker, `ИИгорь: обнаружил потребность в подборе прораба с нашей стороны.\nПричина: ${need.reason}.\nВид работ: ${works.join(', ')}.\n\nПодходящие свободные кандидаты:\n${candidateList}`);
        const taskRes = await fgCreateSuggestionTask(deal, candidateList, works);
        if (added && taskRes && !taskRes.existing) summary.suggestionsCreated++;
        else summary.suggestionsSkipped++;
      }
    }

    return summary;
  } catch (err) {
    summary.ok = false;
    summary.error = err.message || String(err);
    console.error('[foreman-auto] ошибка:', summary.error);
    return summary;
  } finally {
    foremanAutomationRunning = false;
  }
}


// v51: точечные обработчики для роботов Bitrix.
// Робот передаёт только deal_id, сервер сам подтягивает сделку, прораба и соседние активные сделки компании.
const FOREMAN_LINK_MARKER = '[MAVIS_FOREMAN_ROBOT_LINK]';
const FOREMAN_RELEASE_MARKER = '[MAVIS_FOREMAN_ROBOT_RELEASE]';
const FOREMAN_PROPAGATE_MARKER = '[MAVIS_FOREMAN_ROBOT_PROPAGATE]';
// v53: временная память, чтобы webhook, который Bitrix запускает из-за нашего же crm.deal.update
// по соседней сделке, не создавал новые комментарии и не распространял прораба по кругу.
const foremanRobotPropagatedSkip = new Map();

function fgPropSkipKey(dealId, foremanId) {
  return `${dealId}:${foremanId}`;
}

function fgRememberPropagatedDeal(dealId, foremanId) {
  const ttlMin = Number(config.foremanSkipPropagatedWebhookMinutes || 20);
  foremanRobotPropagatedSkip.set(fgPropSkipKey(dealId, foremanId), Date.now() + Math.max(1, ttlMin) * 60000);
}

function fgIsRecentlyPropagatedDeal(dealId, foremanId) {
  const key = fgPropSkipKey(dealId, foremanId);
  const until = foremanRobotPropagatedSkip.get(key);
  if (!until) return false;
  if (until < Date.now()) {
    foremanRobotPropagatedSkip.delete(key);
    return false;
  }
  return true;
}

function fgReqDealId(req) {
  const src = Object.assign({}, req.query || {}, req.body || {});
  const keys = ['deal_id', 'dealId', 'DEAL_ID', 'id', 'ID', 'entityId', 'ENTITY_ID'];
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && String(v).trim()) {
      const m = String(v).match(/\d+/);
      if (m) return m[0];
    }
  }
  // На случай если Bitrix пришлёт ссылку или текстом.
  const raw = JSON.stringify(src);
  const m = raw.match(/deal\/details\/(\d+)/i) || raw.match(/"(?:deal_id|dealId|DEAL_ID|ID)"\s*:\s*"?(\d+)/i);
  return m ? m[1] : '';
}

function fgCheckRobotToken(req) {
  if (!config.foremanRobotToken) return true;
  const token = String((req.query && req.query.token) || (req.body && req.body.token) || '').trim();
  return token && token === config.foremanRobotToken;
}

function fgDealUrl(dealId) {
  return `https://mavisgroup.bitrix24.by/crm/deal/details/${dealId}/`;
}

async function fgGetDealById(dealId, cfg) {
  const select = [
    'ID','TITLE','STAGE_ID','STAGE_SEMANTIC_ID','CLOSED','CATEGORY_ID','ASSIGNED_BY_ID',
    'COMPANY_ID','CONTACT_ID','COMMENTS','DATE_MODIFY','MOVED_TIME','OPPORTUNITY',
    cfg.fieldProductionSpecialist,
    config.serviceFieldCode || 'UF_CRM_1765113071',
  ];
  const d = await bitrixRestCall('crm.deal.get', { id: dealId });
  // crm.deal.get возвращает все поля, но ниже оставляем совместимость с select-логикой.
  return d;
}

async function fgGetCompanyName(companyId) {
  if (!companyId) return '';
  try {
    const c = await bitrixRestCall('crm.company.get', { id: companyId });
    return fgText(c && (c.TITLE || c.COMPANY_TITLE || c.NAME));
  } catch (_) { return ''; }
}

async function fgGetUserLabel(userId) {
  if (!userId) return '';
  try {
    const res = await bitrixRestCall('user.get', { ID: userId });
    const u = Array.isArray(res) ? res[0] : res;
    if (!u) return String(userId);
    return [u.NAME, u.LAST_NAME].map(fgText).filter(Boolean).join(' ') || fgText(u.EMAIL) || String(userId);
  } catch (_) { return String(userId); }
}

function fgProductionService(deal) {
  const raw = fgText(deal && deal[config.serviceFieldCode || 'UF_CRM_1765113071']);
  if (raw) return raw;
  const title = fgText(deal && deal.TITLE);
  const parts = title.split(/\s+[—-]\s+/);
  return parts.length > 1 ? parts.slice(1).join(' — ') : '';
}

async function fgFindActiveCompanyDeals(companyId, cfg, excludeDealId = '') {
  if (!companyId) return [];
  return await bitrixRestList('crm.deal.list', {
    filter: { CATEGORY_ID: cfg.productionCategoryId, COMPANY_ID: companyId, CLOSED: 'N' },
    order: { DATE_MODIFY: 'DESC' },
    select: [
      'ID','TITLE','STAGE_ID','STAGE_SEMANTIC_ID','CLOSED','CATEGORY_ID','ASSIGNED_BY_ID','COMPANY_ID',
      cfg.fieldProductionSpecialist,
      config.serviceFieldCode || 'UF_CRM_1765113071',
    ],
  }, 500).then(rows => rows.filter(d => String(d.ID) !== String(excludeDealId)));
}

async function fgFindActiveDealsWithForeman(foremanId, cfg, excludeDealId = '') {
  const rows = await bitrixRestList('crm.deal.list', {
    filter: { CATEGORY_ID: cfg.productionCategoryId, CLOSED: 'N' },
    order: { DATE_MODIFY: 'DESC' },
    select: ['ID','TITLE','STAGE_ID','CLOSED','CATEGORY_ID','ASSIGNED_BY_ID','COMPANY_ID', cfg.fieldProductionSpecialist],
  }, config.foremanMaxProductionDeals || 500);
  return rows.filter((d) => String(d.ID) !== String(excludeDealId) && fgExtractDealIds(d[cfg.fieldProductionSpecialist]).map(String).includes(String(foremanId)));
}

function fgFormatSpecialistFieldValue(ids, cfg) {
  const clean = [...new Set((Array.isArray(ids) ? ids : [ids]).map((x) => String(x || '').match(/\d+/)?.[0]).filter(Boolean))];
  // Для старого одиночного поля оставляем старое поведение: одно значение.
  if (!config.foremanProductionSpecialistFieldMultiple) return clean[0] || '';
  // Для нового множественного CRM-поля Bitrix обычно принимает массив значений.
  // Если поле настроено как 'Привязка к элементам CRM' и только сделки, числовых ID достаточно.
  return clean;
}

async function fgUpdateDealSpecialist(dealOrId, foremanId, cfg) {
  const deal = (typeof dealOrId === 'object' && dealOrId) ? dealOrId : await fgGetDealById(dealOrId, cfg);
  const existing = fgExtractDealIds(deal && deal[cfg.fieldProductionSpecialist]);
  const merged = [...new Set([...existing.map(String), String(foremanId)].filter(Boolean))];
  const value = fgFormatSpecialistFieldValue(merged, cfg);
  await bitrixRestCall('crm.deal.update', { id: deal.ID || dealOrId, fields: { [cfg.fieldProductionSpecialist]: value } });
  return merged;
}

async function fgHandleForemanLinked(dealId, source = 'robot') {
  const cfg = fgForemanCfg();
  const summary = { ok: true, event: 'foreman_linked', source, dealId: String(dealId), foremen: [], propagated: [], skipped: [], comments: [] };
  const deal = await fgGetDealById(dealId, cfg);
  if (!deal || String(deal.CATEGORY_ID) !== String(cfg.productionCategoryId)) {
    throw new Error(`Сделка ${dealId} не найдена или не из воронки производства ${cfg.productionCategoryId}`);
  }
  const foremanIds = fgExtractDealIds(deal[cfg.fieldProductionSpecialist]);
  if (!foremanIds.length) {
    summary.ok = false;
    summary.message = `В сделке ${dealId} поле ${cfg.fieldProductionSpecialist} пустое — прораб не привязан.`;
    return summary;
  }

  const companyName = await fgGetCompanyName(deal.COMPANY_ID);
  const expertName = await fgGetUserLabel(deal.ASSIGNED_BY_ID);
  const service = fgProductionService(deal);
  const siblingDeals = config.foremanPropagateToCompanyDeals ? await fgFindActiveCompanyDeals(deal.COMPANY_ID, cfg, deal.ID) : [];

  for (const foremanId of foremanIds) {
    let foreman = null;
    try { foreman = await bitrixRestCall('crm.deal.get', { id: foremanId }); } catch (_) {}
    if (!foreman || String(foreman.CATEGORY_ID) !== String(cfg.foremanCategoryId)) {
      summary.skipped.push(`Прораб ${foremanId} не найден в воронке ${cfg.foremanCategoryId}`);
      continue;
    }

    // v53: если этот webhook запустился из-за того, что сам ИИгорь проставил прораба
    // в соседнюю активную сделку компании, не создаём новый комментарий и не запускаем
    // распространение по кругу.
    const propagatedMarker = `${FOREMAN_PROPAGATE_MARKER} prod=${deal.ID} foreman=${foremanId}`;
    const isAutoPropagatedCall = fgIsRecentlyPropagatedDeal(deal.ID, foremanId) || await fgTimelineHasMarker(deal.ID, propagatedMarker, 20);
    if (isAutoPropagatedCall) {
      summary.skipped.push(`Сделка ${deal.ID}: webhook пропущен, потому что прораб уже был автопроставлен ИИгорем из другой сделки компании.`);
      continue;
    }

    const moved = await fgSetDealStageIfNeeded(foreman, cfg.stageBusy);
    const marker = `${FOREMAN_LINK_MARKER} foreman=${foremanId} prod=${deal.ID}`;
    const comment = `ИИгорь: прораб привязан к производственной сделке.\n\nКомпания: ${companyName || deal.COMPANY_ID || 'не указана'}\nСделка производства: ${deal.TITLE || deal.ID}\nУслуга: ${service || 'не указана'}\nОтветственный эксперт: ${expertName || deal.ASSIGNED_BY_ID || 'не указан'}\nСсылка на производство: ${fgDealUrl(deal.ID)}\n\nНовый статус прораба: Занят.`;
    const added = await fgAddCommentOnce(foremanId, marker, comment);
    summary.foremen.push({ foremanId: String(foremanId), title: foreman.TITLE, movedBusy: moved, commentAdded: added });

    // Проставляем этого же прораба во все активные сделки этой же компании.
    // v54: если поле множественное — ДОБАВЛЯЕМ прораба к уже выбранным, а не заменяем.
    // Если поле старое одиночное — не трогаем сделки, где специалист уже заполнен, чтобы не стереть выбранного прораба.
    for (const s of siblingDeals) {
      const existing = fgExtractDealIds(s[cfg.fieldProductionSpecialist]).map(String);
      if (existing.includes(String(foremanId))) {
        summary.skipped.push(`Сделка ${s.ID}: этот прораб уже указан (${foremanId})`);
        continue;
      }
      if (existing.length && !config.foremanProductionSpecialistFieldMultiple) {
        summary.skipped.push(`Сделка ${s.ID}: старое одиночное поле специалист уже заполнено (${existing.join(',')})`);
        continue;
      }
      fgRememberPropagatedDeal(s.ID, foremanId);
      const mergedIds = await fgUpdateDealSpecialist(s, foremanId, cfg);
      summary.propagated.push({ dealId: String(s.ID), title: s.TITLE, foremanId: String(foremanId), fieldValues: mergedIds, silent: !config.foremanAddPropagationComments });
      const siblingMarker = `${FOREMAN_PROPAGATE_MARKER} prod=${s.ID} foreman=${foremanId}`;
      if (config.foremanAddPropagationComments) {
        await fgAddCommentOnce(s.ID, siblingMarker, `ИИгорь: автоматически проставил прораба из другой активной сделки этой компании.\n\nПрораб: ${foreman.TITLE || foremanId}\nИсточник: ${deal.TITLE || deal.ID}\nСсылка на источник: ${fgDealUrl(deal.ID)}`);
      }
    }
  }

  return summary;
}

async function fgHandleProductionClosed(dealId, source = 'robot') {
  const cfg = fgForemanCfg();
  const summary = { ok: true, event: 'production_deal_closed', source, dealId: String(dealId), released: [], stillBusy: [], skipped: [] };
  const deal = await fgGetDealById(dealId, cfg);
  if (!deal || String(deal.CATEGORY_ID) !== String(cfg.productionCategoryId)) {
    throw new Error(`Сделка ${dealId} не найдена или не из воронки производства ${cfg.productionCategoryId}`);
  }
  const foremanIds = fgExtractDealIds(deal[cfg.fieldProductionSpecialist]);
  if (!foremanIds.length) {
    summary.skipped.push(`В сделке ${dealId} поле ${cfg.fieldProductionSpecialist} пустое.`);
    return summary;
  }

  for (const foremanId of foremanIds) {
    let foreman = null;
    try { foreman = await bitrixRestCall('crm.deal.get', { id: foremanId }); } catch (_) {}
    if (!foreman || String(foreman.CATEGORY_ID) !== String(cfg.foremanCategoryId)) {
      summary.skipped.push(`Прораб ${foremanId} не найден в воронке ${cfg.foremanCategoryId}`);
      continue;
    }

    const activeLinks = await fgFindActiveDealsWithForeman(foremanId, cfg, deal.ID);
    if (activeLinks.length) {
      summary.stillBusy.push({ foremanId: String(foremanId), title: foreman.TITLE, activeDeals: activeLinks.map(d => ({ id: d.ID, title: d.TITLE })) });
      const marker = `${FOREMAN_RELEASE_MARKER} still-busy foreman=${foremanId} prod=${deal.ID}`;
      await fgAddCommentOnce(foremanId, marker, `ИИгорь: производственная сделка закрыта, но прораб НЕ освобождён, потому что ещё привязан к активным сделкам.\n\nЗакрытая сделка: ${deal.TITLE || deal.ID}\nАктивные сделки:\n${activeLinks.map(d => `— ${d.TITLE || d.ID}: ${fgDealUrl(d.ID)}`).join('\n')}`);
      continue;
    }

    const target = await fgResolveForemanAfterCloseStage(foreman, cfg);
    await fgSetDealStageIfNeeded(foreman, target);
    const marker = `${FOREMAN_RELEASE_MARKER} foreman=${foremanId} prod=${deal.ID}`;
    await fgAddCommentOnce(foremanId, marker, `ИИгорь: производственная сделка успешно завершена, активных сделок с этим прорабом больше нет.\n\nОсвобождён после сделки: ${deal.TITLE || deal.ID}\nСсылка: ${fgDealUrl(deal.ID)}\nНовый статус: ${target === cfg.stageAfterClose ? 'Контроль увольнения' : (target === cfg.stageExpiring ? 'Аттестат заканчивается' : 'Свободен')}.`);
    summary.released.push({ foremanId: String(foremanId), title: foreman.TITLE, targetStage: target });
  }

  return summary;
}


// v55: пушинг актов — задача на сбор оригинала акта после закрытия производства.
const ACTS_ORIGINAL_MARKER = '[MAVIS_ACTS_ORIGINAL]';

function actsCleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function actsMoney(value) {
  const n = Number(String(value || '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${Math.round(n * 100) / 100}`.replace('.', ',');
}

function actsDealUrl(dealId) {
  return `https://mavisgroup.bitrix24.by/crm/deal/details/${dealId}/`;
}

async function actsFindExistingTask(dealId) {
  const crmRef = `D_${dealId}`;
  const marker = `${ACTS_ORIGINAL_MARKER} deal=${dealId}`;

  // Сначала ищем по CRM-привязке. Это самый точный вариант.
  try {
    const linked = await bitrixRestList('tasks.task.list', {
      filter: { GROUP_ID: config.actsProjectId, UF_CRM_TASK: crmRef },
      select: ['ID','TITLE','DESCRIPTION','STATUS','REAL_STATUS','GROUP_ID','UF_CRM_TASK','CREATED_DATE'],
      order: { ID: 'DESC' },
    }, 50);
    const found = linked.find((t) => String(t.description || t.DESCRIPTION || '').includes(ACTS_ORIGINAL_MARKER) || String(t.title || t.TITLE || '').includes(config.actsTaskTitlePrefix));
    if (found) return found;
  } catch (e) {
    console.warn(`[acts] поиск дубля по UF_CRM_TASK не сработал: ${e.message}`);
  }

  // Фолбэк: ищем по маркеру в свежих задачах проекта.
  try {
    const tasks = await bitrixRestList('tasks.task.list', {
      filter: { GROUP_ID: config.actsProjectId },
      select: ['ID','TITLE','DESCRIPTION','STATUS','REAL_STATUS','GROUP_ID','UF_CRM_TASK','CREATED_DATE'],
      order: { ID: 'DESC' },
    }, 1000);
    return tasks.find((t) => String(t.description || t.DESCRIPTION || '').includes(marker)) || null;
  } catch (e) {
    console.warn(`[acts] поиск дубля в проекте не сработал: ${e.message}`);
    return null;
  }
}

async function actsCreateCollectionTaskForDeal(dealId, source = 'robot') {
  if (!config.actsTasksEnabled) return { ok: false, skipped: true, message: 'ACTS_TASKS_ENABLED=false' };
  if (!config.actsProjectId) throw new Error('ACTS_PROJECT_ID не задан');
  if (!config.actsResponsibleId) throw new Error('ACTS_RESPONSIBLE_ID/TANYA_USER_ID не задан');

  const deal = await bitrixRestCall('crm.deal.get', { id: dealId });
  if (!deal || String(deal.CATEGORY_ID) !== String(config.productionCategoryId || 28)) {
    throw new Error(`Сделка ${dealId} не найдена или не из воронки производства ${config.productionCategoryId || 28}`);
  }

  // Не создаём задачу на открытую сделку. Бизнес-процесс должен запускаться при закрытии.
  if (String(deal.CLOSED || '').toUpperCase() !== 'Y' && String(deal.STAGE_SEMANTIC_ID || '').toUpperCase() !== 'S') {
    return { ok: false, skipped: true, dealId: String(dealId), message: 'Сделка ещё не закрыта успешно — задачу на акт не создаю.' };
  }

  const existing = await actsFindExistingTask(dealId);
  if (existing) {
    return { ok: true, duplicate: true, dealId: String(dealId), taskId: String(existing.id || existing.ID), message: 'Задача на сбор акта уже есть, дубль не создаю.' };
  }

  const companyName = await fgGetCompanyName(deal.COMPANY_ID);
  const expertName = await fgGetUserLabel(deal.ASSIGNED_BY_ID);
  const service = fgProductionService(deal) || 'услуга не указана';
  const amount = actsMoney(deal.OPPORTUNITY);

  const titleParts = [
    config.actsTaskTitlePrefix,
    companyName || actsCleanText(deal.TITLE) || `сделка ${dealId}`,
    service,
    amount ? `${amount} руб` : '',
  ].filter(Boolean);

  const title = `${titleParts.join(' — ')} [MAVIS_ACTS_ORIGINAL]`;
  const description = `${ACTS_ORIGINAL_MARKER} deal=${dealId}\n\nНужно получить физический оригинал акта по закрытой работе.\n\nКомпания: ${companyName || deal.COMPANY_ID || 'не указана'}\nЗакрытая сделка производства: ${deal.TITLE || dealId}\nУслуга: ${service}\nСумма: ${amount || 'не указана'}\nОтветственный эксперт: ${expertName || deal.ASSIGNED_BY_ID || 'не указан'}\nСсылка на сделку: ${actsDealUrl(dealId)}\n\nВажно: акт считается вернувшимся только когда эта задача будет переведена в стадию «Архив».`;

  const fields = {
    TITLE: title,
    DESCRIPTION: description,
    RESPONSIBLE_ID: String(config.actsResponsibleId),
    GROUP_ID: Number(config.actsProjectId),
    UF_CRM_TASK: [`D_${dealId}`],
  };
  if (config.actsAuditorIds.length) fields.AUDITORS = config.actsAuditorIds;
  if (config.actsCollectionStageId) fields.STAGE_ID = config.actsCollectionStageId;

  const created = await bitrixRestCall('tasks.task.add', { fields });
  const taskId = created && created.task && (created.task.id || created.task.ID);

  try {
    await bitrixRestCall('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId,
        ENTITY_TYPE: 'deal',
        COMMENT: `${ACTS_ORIGINAL_MARKER}\nСоздана задача на сбор оригинала акта: ${taskId ? `#${taskId}` : 'ID не вернулся'}\nОтветственный за сбор: ${config.actsResponsibleId}\nПроект: Акты счета #${config.actsProjectId}`,
      },
    });
  } catch (e) {
    console.warn(`[acts] комментарий в сделку не добавлен: ${e.message}`);
  }

  return { ok: true, event: 'acts_collection_task_created', source, dealId: String(dealId), taskId: taskId ? String(taskId) : null, title };
}

app.post('/api/acts/robot-closed', async (req, res) => {
  try {
    const dealId = fgReqDealId(req);
    if (!dealId) return res.status(400).json({ ok: false, error: 'deal_id не передан' });
    const result = await actsCreateCollectionTaskForDeal(dealId, 'robot-closed');
    res.status(result.ok ? 200 : 422).json(result);
  } catch (e) {
    console.error('[acts-robot-closed]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/api/acts/robot-closed', async (req, res) => {
  try {
    const dealId = fgReqDealId(req);
    if (!dealId) return res.status(400).json({ ok: false, error: 'deal_id не передан' });
    const result = await actsCreateCollectionTaskForDeal(dealId, 'robot-closed-get');
    res.status(result.ok ? 200 : 422).json(result);
  } catch (e) {
    console.error('[acts-robot-closed-get]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});


// v56: акт обработан в проекте "Акты счета" — задача перешла на стадию "Сделано".
const ACTS_TASK_DONE_MARKER = '[MAVIS_ACTS_TASK_DONE]';

function actsReqTaskId(req) {
  const src = Object.assign({}, req.query || {}, req.body || {});
  const keys = ['task_id', 'taskId', 'TASK_ID', 'id', 'ID', 'entityId', 'ENTITY_ID'];
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && String(v).trim()) {
      const m = String(v).match(/\d+/);
      if (m) return m[0];
    }
  }
  const raw = JSON.stringify(src);
  const m = raw.match(/tasks\/task\/view\/(\d+)/i) || raw.match(/"(?:task_id|taskId|TASK_ID|ID)"\s*:\s*"?(\d+)/i);
  return m ? m[1] : '';
}

function actsTaskField(task, names) {
  if (!task) return undefined;
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(task, name)) return task[name];
  }
  const lowerMap = {};
  for (const k of Object.keys(task)) lowerMap[k.toLowerCase()] = k;
  for (const name of names) {
    const real = lowerMap[String(name).toLowerCase()];
    if (real) return task[real];
  }
  return undefined;
}

function actsExtractDealIdsFromTask(task) {
  const ids = new Set();
  const addFromText = (value) => {
    const text = String(value || '');
    if (!text) return;
    for (const m of text.matchAll(/\bD_(\d+)\b/gi)) ids.add(m[1]);
    for (const m of text.matchAll(/deal=(\d+)/gi)) ids.add(m[1]);
    for (const m of text.matchAll(/deal\/details\/(\d+)/gi)) ids.add(m[1]);
    for (const m of text.matchAll(/ID сделки производства:\s*(\d+)/gi)) ids.add(m[1]);
  };
  const crm = actsTaskField(task, ['ufCrmTask','UF_CRM_TASK','UF_CRM_TASKS','crm','CRM']);
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') return Object.values(v).forEach(walk);
    addFromText(v);
  };
  walk(crm);
  addFromText(actsTaskField(task, ['description','DESCRIPTION']));
  addFromText(actsTaskField(task, ['title','TITLE']));
  return [...ids];
}

function actsTaskUrl(taskId) {
  return `https://mavisgroup.bitrix24.by/workgroups/group/${config.actsProjectId}/tasks/task/view/${taskId}/`;
}

function actsCollectRawFileRefs(task) {
  const refs = [];
  const seen = new Set();
  const add = (value, path = '') => {
    if (value === null || value === undefined || value === false) return;
    const key = `${path}:${JSON.stringify(value).slice(0, 200)}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ value, path });
  };
  const walk = (v, path = '') => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
    if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        if (/file|files|webdav|attached|attachment|disk/i.test(k)) add(val, p);
        walk(val, p);
      }
      return;
    }
  };
  walk(task);
  return refs;
}

async function actsResolveTaskFiles(task) {
  const rawFields = [
    actsTaskField(task, ['ufTaskWebdavFiles','UF_TASK_WEBDAV_FILES','files','FILES','attachments','ATTACHMENTS']),
    ...actsCollectRawFileRefs(task).map((x) => x.value),
  ];
  const ids = new Set();
  const names = new Set();
  const walk = (v) => {
    if (v === null || v === undefined || v === false) return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v === 'object') {
      const name = v.NAME || v.name || v.TITLE || v.title || v.fileName || v.filename;
      if (name) names.add(String(name));
      ['ID','id','OBJECT_ID','objectId','attachedObjectId','ATTACHED_OBJECT_ID','fileId','FILE_ID'].forEach((k) => walk(v[k]));
      return;
    }
    const text = String(v || '').trim();
    if (!text) return;
    const n = text.match(/^n?(\d{2,})$/i);
    if (n) ids.add(n[1]);
    if (/\.(pdf|docx?|xlsx?|jpg|jpeg|png)$/i.test(text) || /акт/i.test(text)) names.add(text);
  };
  rawFields.forEach(walk);

  const files = [];
  const seenFile = new Set();
  for (const id of [...ids].slice(0, 20)) {
    // В задачах Bitrix файлы часто приходят как webdav/attached object: n123456.
    // Поэтому сначала пробуем disk.attachedObject.get, затем disk.file.get.
    try {
      const attached = await bitrixRestCall('disk.attachedObject.get', { id });
      const obj = attached && (attached.object || attached.OBJECT || attached);
      const fileId = obj && (obj.ID || obj.id || obj.OBJECT_ID || obj.objectId);
      const name = actsCleanText(obj && (obj.NAME || obj.name || obj.TITLE || obj.title));
      const url = obj && (obj.DOWNLOAD_URL || obj.downloadUrl || obj.URL || obj.url || obj.DETAIL_URL || obj.detailUrl);
      const key = `${fileId || id}:${name}`;
      if (!seenFile.has(key)) {
        seenFile.add(key);
        files.push({ id: String(fileId || id), attachedId: String(id), name: name || `файл ${id}`, url: url || '' });
      }
      continue;
    } catch (_) {}
    try {
      const f = await bitrixRestCall('disk.file.get', { id });
      const name = actsCleanText(f && (f.NAME || f.name || f.TITLE || f.title));
      const url = f && (f.DOWNLOAD_URL || f.downloadUrl || f.URL || f.url || f.DETAIL_URL || f.detailUrl);
      const key = `${id}:${name}`;
      if (!seenFile.has(key)) {
        seenFile.add(key);
        files.push({ id: String(id), attachedId: '', name: name || `файл ${id}`, url: url || '' });
      }
    } catch (_) {}
  }

  // Если API не раскрыл файлы, хотя имена в задаче видны — вернём хотя бы названия.
  for (const name of names) {
    const clean = actsCleanText(name);
    if (clean && !files.some((f) => f.name === clean)) files.push({ id: '', attachedId: '', name: clean, url: '' });
  }
  return files;
}


function actsPickBestFileForClient(files) {
  const usable = (files || []).filter((f) => f && f.url);
  if (!usable.length) return null;
  const actLike = usable.find((f) => /акт|act/i.test(String(f.name || '')));
  return actLike || usable[0];
}

function actsBuildClientMessage(deal, task, file) {
  const service = detectServiceFromDeal(deal) || 'закрытой услуге';
  const company = actsCleanText(deal.COMPANY_TITLE || deal.COMPANY_NAME || deal.TITLE || '');
  const custom = String(config.actsClientMessage || '').trim();
  if (custom) {
    return custom
      .replace(/\{company\}/g, company || 'вашей компании')
      .replace(/\{service\}/g, service)
      .replace(/\{deal_id\}/g, String(deal.ID || ''))
      .replace(/\{file\}/g, String(file && file.name || 'акт'));
  }
  return `Добрый день!\n\nНаправляем акт по услуге «${service}».\nПожалуйста, проверьте, подпишите и верните оригинал акта в MAVIS GROUP.\n\nЕсли по акту будут вопросы — напишите, пожалуйста, в ответном сообщении.`;
}

function maskEmailForLog(email) {
  const e = String(email || '').trim();
  const parts = e.split('@');
  if (parts.length !== 2) return e ? '***' : '';
  const name = parts[0];
  const domain = parts[1];
  return `${name.slice(0, 2)}***@${domain}`;
}

function actsBuildEmailStorageElementIds(file) {
  // Для письма из Bitrix стараемся приложить тот же Disk-файл, который был прикреплён к задаче.
  // В задачах Bitrix webdav-вложения часто приходят как attached object: n123456.
  // crm.activity.add обычно принимает STORAGE_TYPE_ID=3 и STORAGE_ELEMENT_IDS=["n123456"].
  const ids = [];
  const attachedId = String(file && file.attachedId || '').replace(/^n/i, '').trim();
  const fileId = String(file && file.id || '').replace(/^n/i, '').trim();
  if (/^\d+$/.test(attachedId)) ids.push(`n${attachedId}`);
  if (/^\d+$/.test(fileId) && !ids.includes(`n${fileId}`)) ids.push(`n${fileId}`);
  return ids;
}

async function sendActEmailThroughBitrix(dealId, responsibleId, toEmail, dealTitle, text, file) {
  const fields = {
    TYPE_ID: 4,
    SUBJECT: `Акт по сделке: ${dealTitle || dealId}`,
    DESCRIPTION: text + (file && file.url ? `

Ссылка на файл акта: ${file.url}` : ''),
    DESCRIPTION_TYPE: 1,
    DIRECTION: 2,
    OWNER_TYPE_ID: 2,
    OWNER_ID: dealId,
    RESPONSIBLE_ID: responsibleId || 1,
    COMPLETED: 'N',
    COMMUNICATIONS: [{ VALUE: toEmail, ENTITY_ID: 0, ENTITY_TYPE_ID: 3, TYPE: 'EMAIL' }],
  };

  const storageIds = actsBuildEmailStorageElementIds(file);
  if (storageIds.length) {
    fields.STORAGE_TYPE_ID = 3; // Disk
    fields.STORAGE_ELEMENT_IDS = storageIds;
  }

  return await bitrixRestCall('crm.activity.add', { fields });
}

async function actsSendActToClientByPreferredChannel({ deal, task, file }) {
  if (!config.actsSendToClientEnabled) {
    return { skipped: true, message: 'ACTS_SEND_TO_CLIENT_ENABLED=false' };
  }
  if (!file || !file.url) {
    return { ok: false, skipped: true, message: 'В задаче нет файла с прямой ссылкой для отправки клиенту.' };
  }

  const preferredChannel = detectPreferredChannel(deal);
  if (!preferredChannel) {
    return { ok: false, skipped: true, message: 'В сделке не распознано поле «Предпочитаемый способ связи». Нужно выбрать Email / Telegram / Viber.' };
  }

  const text = actsBuildClientMessage(deal, task, file);

  if (preferredChannel === 'email') {
    const email = await getContactEmail(deal);
    if (!email) {
      return { ok: false, skipped: true, channel: 'Email', message: 'В сделке выбран Email, но у основного контакта не найден email.' };
    }
    await sendActEmailThroughBitrix(deal.ID, deal.ASSIGNED_BY_ID, email, deal.TITLE, text, file);
    return {
      ok: true,
      channel: 'Email',
      email: maskEmailForLog(email),
      file: { name: file.name, id: file.id || '', attachedId: file.attachedId || '' },
      note: 'Письмо создано через Bitrix. Если Bitrix не приложил файл как вложение, в тексте письма есть ссылка на файл акта.',
    };
  }

  const phone = await getContactPhone(deal);
  if (!phone) {
    return { ok: false, skipped: true, channel: preferredChannelLabel(preferredChannel), message: `В сделке выбран ${preferredChannelLabel(preferredChannel)}, но у основного контакта не найден телефон.` };
  }

  const ch = getConfiguredWazzupChannel(preferredChannel);
  if (!ch || !ch.channelId) {
    return { ok: false, skipped: true, channel: preferredChannelLabel(preferredChannel), message: `В сделке выбран ${preferredChannelLabel(preferredChannel)}, но этот Wazzup-канал не настроен в Render.` };
  }

  const textResult = await sendWazzupMessageInternal({
    channelKey: preferredChannel,
    text,
    phone,
    dealId: deal.ID,
    ignoreStrictPreferredChannel: false,
  });
  const fileResult = await sendWazzupFileInternal({
    channelKey: preferredChannel,
    contentUri: file.url,
    phone,
    dealId: deal.ID,
    fileName: file.name,
  });
  return {
    ok: true,
    channel: (fileResult.channel && fileResult.channel.label) || (textResult.channel && textResult.channel.label) || preferredChannelLabel(preferredChannel),
    phone: phone.replace(/(\d{3})\d+(\d{3})$/, '$1***$2'),
    file: { name: file.name, id: file.id || '', attachedId: file.attachedId || '' },
  };
}

// legacy-name wrapper, чтобы старые ручные вызовы/логи не ломались
async function actsSendActToClientViaWazzup(args) {
  return actsSendActToClientByPreferredChannel(args);
}

async function actsHandleTaskDone(taskId, source = 'task-done-robot') {
  if (!config.actsTasksEnabled) return { ok: false, skipped: true, message: 'ACTS_TASKS_ENABLED=false' };
  if (!config.actsProjectId) throw new Error('ACTS_PROJECT_ID не задан');

  const raw = await bitrixRestCall('tasks.task.get', { taskId });
  const task = raw && (raw.task || raw.TASK || raw);
  if (!task) throw new Error(`Задача ${taskId} не найдена`);

  const groupId = actsTaskField(task, ['groupId','GROUP_ID','group_id']);
  if (String(groupId) !== String(config.actsProjectId)) {
    return { ok: false, skipped: true, taskId: String(taskId), groupId: String(groupId || ''), message: `Задача не из проекта Акты счета #${config.actsProjectId}` };
  }

  const taskStageId = actsTaskField(task, ['stageId','STAGE_ID','stage_id']);
  if (config.actsDoneStageId && String(taskStageId || '') !== String(config.actsDoneStageId)) {
    return { ok: false, skipped: true, taskId: String(taskId), stageId: String(taskStageId || ''), message: `Задача не на стадии Сделано (${config.actsDoneStageId})` };
  }

  const dealIds = actsExtractDealIdsFromTask(task);
  const files = await actsResolveTaskFiles(task);
  const fileForClient = actsPickBestFileForClient(files);
  const title = actsTaskField(task, ['title','TITLE']) || '';
  const marker = `${ACTS_TASK_DONE_MARKER} task=${taskId}`;

  if (!dealIds.length) {
    return { ok: false, skipped: true, taskId: String(taskId), title, files, message: 'Не нашёл ID сделки производства в задаче. Проверь, что задача создана ИИгорем или в описании есть ссылка/ID сделки.' };
  }

  const results = [];
  for (const dealId of dealIds) {
    const already = await fgTimelineHasMarker(dealId, marker, 50);
    if (already) {
      results.push({ dealId: String(dealId), duplicate: true, message: 'Эта задача уже была обработана ранее, повторно клиенту не отправляю.' });
      continue;
    }

    let deal = null;
    try {
      deal = await bitrixRestCall('crm.deal.get', { id: dealId });
    } catch (e) {
      results.push({ dealId: String(dealId), ok: false, error: `Не смог получить сделку: ${e.message}` });
      continue;
    }

    let sendResult = null;
    try {
      sendResult = await actsSendActToClientByPreferredChannel({ deal, task, file: fileForClient });
    } catch (e) {
      sendResult = { ok: false, error: e.message || String(e), possiblyDelivered: Boolean(e.possiblyDelivered) };
    }

    const fileLines = files.length
      ? files.map((f) => `— ${f.name || f.id}${f.url ? `\n  ${f.url}` : ''}`).join('\n')
      : 'Файлы в задаче через API не увидел. Проверь вложения в задаче вручную.';
    const sendLines = sendResult && sendResult.ok
      ? `✅ Клиенту отправлено через ${sendResult.channel || 'предпочитаемый канал'}: сообщение + файл акта.\nФайл: ${sendResult.file && sendResult.file.name ? sendResult.file.name : (fileForClient && fileForClient.name || 'акт')}\nКонтакт: ${sendResult.phone || sendResult.email || 'скрыт'}${sendResult.note ? `\nПримечание: ${sendResult.note}` : ''}`
      : `⚠️ Клиенту НЕ отправлено автоматически.\nПричина: ${(sendResult && (sendResult.message || sendResult.error)) || 'неизвестная ошибка'}\nЧто проверить: поле «Предпочитаемый способ связи», телефон/email основного контакта, настройки Wazzup Telegram/Viber и прямую ссылку на файл в задаче.`;

    await bitrixRestCall('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId,
        ENTITY_TYPE: 'deal',
        COMMENT: `${marker}\nЗадача по акту в проекте «Акты счета» перешла на стадию «Сделано».\n\nЗадача: ${title || taskId}\nСсылка на задачу: ${actsTaskUrl(taskId)}\n\nФайлы, которые нашёл в задаче:\n${fileLines}\n\n${sendLines}`,
      },
    });
    results.push({ dealId: String(dealId), commentAdded: true, sent: sendResult });
  }

  return { ok: true, event: 'acts_task_done_processed_and_sent_by_preferred_channel', source, taskId: String(taskId), title, dealIds: dealIds.map(String), files, fileForClient, results };
}

app.post('/api/acts/task-done', async (req, res) => {
  try {
    const taskId = actsReqTaskId(req);
    if (!taskId) return res.status(400).json({ ok: false, error: 'task_id не передан' });
    const result = await actsHandleTaskDone(taskId, 'task-done-post');
    res.status(result.ok ? 200 : 422).json(result);
  } catch (e) {
    console.error('[acts-task-done]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/api/acts/task-done', async (req, res) => {
  try {
    const taskId = actsReqTaskId(req);
    if (!taskId) return res.status(400).json({ ok: false, error: 'task_id не передан' });
    const result = await actsHandleTaskDone(taskId, 'task-done-get');
    res.status(result.ok ? 200 : 422).json(result);
  } catch (e) {
    console.error('[acts-task-done-get]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post('/api/foreman/robot-linked', async (req, res) => {
  try {
    if (!fgCheckRobotToken(req)) return res.status(403).json({ ok: false, error: 'bad token' });
    const dealId = fgReqDealId(req);
    if (!dealId) return res.status(400).json({ ok: false, error: 'deal_id не передан' });
    const result = await fgHandleForemanLinked(dealId, 'robot-linked');
    res.status(result.ok ? 200 : 422).json(result);
  } catch (e) {
    console.error('[foreman-robot-linked]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/api/foreman/robot-linked', async (req, res) => {
  try {
    if (!fgCheckRobotToken(req)) return res.status(403).json({ ok: false, error: 'bad token' });
    const dealId = fgReqDealId(req);
    if (!dealId) return res.status(400).json({ ok: false, error: 'deal_id не передан' });
    const result = await fgHandleForemanLinked(dealId, 'robot-linked-get');
    res.status(result.ok ? 200 : 422).json(result);
  } catch (e) {
    console.error('[foreman-robot-linked-get]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post('/api/foreman/robot-closed', async (req, res) => {
  try {
    if (!fgCheckRobotToken(req)) return res.status(403).json({ ok: false, error: 'bad token' });
    const dealId = fgReqDealId(req);
    if (!dealId) return res.status(400).json({ ok: false, error: 'deal_id не передан' });
    const result = await fgHandleProductionClosed(dealId, 'robot-closed');
    res.json(result);
  } catch (e) {
    console.error('[foreman-robot-closed]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/api/foreman/robot-closed', async (req, res) => {
  try {
    if (!fgCheckRobotToken(req)) return res.status(403).json({ ok: false, error: 'bad token' });
    const dealId = fgReqDealId(req);
    if (!dealId) return res.status(400).json({ ok: false, error: 'deal_id не передан' });
    const result = await fgHandleProductionClosed(dealId, 'robot-closed-get');
    res.json(result);
  } catch (e) {
    console.error('[foreman-robot-closed-get]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post('/api/foreman/auto-sync', async (_req, res) => {
  const result = await runForemanAutomationCycle('manual-api');
  res.status(result.ok ? 200 : 500).json(result);
});

app.get('/api/foreman/auto-sync', async (_req, res) => {
  const result = await runForemanAutomationCycle('manual-api');
  res.status(result.ok ? 200 : 500).json(result);
});

// Запуск polling после старта сервера.

// ✅ ЭНДПОИНТ: Получить все поля сделки
app.get('/api/get-deal-fields', async (req, res) => {
  try {
    const dealId = req.query.dealId;
    if (!dealId) return res.status(400).json({ error: 'dealId не указан' });
    
    const deals = await bitrixRestList('crm.deal.get', { ID: dealId }, 1, ['*', 'UF_*']);
    if (!deals || !deals.length) return res.status(404).json({ error: 'Сделка не найдена' });
    
    const deal = deals[0];
    const fields = {};
    for (const [key, value] of Object.entries(deal)) {
      if (key.startsWith('UF_CRM_')) fields[key] = value;
    }
    
    res.json({ dealId: deal.ID, title: deal.TITLE, fields });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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

  if (config.foremanAutomationEnabled && config.bitrixWebhookUrl) {
    const intervalMs = Math.max(15, config.foremanPollIntervalMinutes || 60) * 60 * 1000;
    console.log(`[foreman-auto] ИИгорь включён: поле специалиста ${config.foremanProductionSpecialistField}, интервал ${intervalMs / 60000} мин.`);
    setTimeout(() => {
      runForemanAutomationCycle('startup').catch((e) => console.error('[foreman-auto] startup:', e.message || e));
      setInterval(() => runForemanAutomationCycle('interval').catch((e) => console.error('[foreman-auto] interval:', e.message || e)), intervalMs);
    }, 4 * 60 * 1000);
  } else {
    console.log('[foreman-auto] ИИгорь выключен. Для включения задай FOREMAN_AUTOMATION_ENABLED=true и BITRIX_WEBHOOK_URL.');
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
