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
  executorExpertId: process.env.EXECUTOR_EXPERT_ID || '',
  executorLeaderId: process.env.EXECUTOR_LEADER_ID || process.env.EXECUTOR_EXPERT_ID || '',
  executorProduct: process.env.EXECUTOR_PRODUCT || 'attestation',
  preferredContactFieldCode: process.env.PREFERRED_CONTACT_FIELD_CODE || '',
  callTranscriptionEnabled: String(process.env.CALL_TRANSCRIPTION_ENABLED || 'false').toLowerCase() === 'true',
  transcribeProvider: process.env.TRANSCRIBE_PROVIDER || process.env.AI_PROVIDER || 'vibe',
  transcribeModel: process.env.TRANSCRIBE_MODEL || 'bitrix/deepdml/faster-whisper-large-v3-turbo-ct2',
  transcribeSendModel: String(process.env.TRANSCRIBE_SEND_MODEL || 'true').toLowerCase() !== 'false',
  transcribeBaseUrl: process.env.TRANSCRIBE_BASE_URL || process.env.AI_BASE_URL || '',
};

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
    }
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

app.post('/api/wazzup/send', async (req, res) => {
  try {
    const apiKey = process.env.WAZZUP_API_KEY || '';
    const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
    if (!apiKey) {
      res.status(400).json({ ok: false, error: 'WAZZUP_API_KEY не задан в Render Environment.' });
      return;
    }

    const body = req.body || {};
    const channelKey = body.channelKey || body.channel || '';
    const configured = getConfiguredWazzupChannel(channelKey);
    if (!configured || !configured.channelId) {
      res.status(400).json({ ok: false, error: `Wazzup-канал ${channelKey || 'по умолчанию'} не задан в Render Environment.` });
      return;
    }

    const text = String(body.text || '').trim();
    const phone = normalizeWazzupPhone(body.phone || '');
    const chatId = normalizeWazzupPhone(body.chatId || '');
    const username = normalizeWazzupUsername(body.telegramUsername || body.username || '');
    if (!text) {
      res.status(400).json({ ok: false, error: 'Текст сообщения пустой.' });
      return;
    }

    const payload = {
      channelId: configured.channelId,
      chatType: configured.chatType,
      text,
      crmMessageId: `mavis-executor-${configured.key}-${body.dealId || 'deal'}-${Date.now()}`,
      clearUnanswered: false,
    };

    // Wazzup v3, официальная документация (Sending messages): для Telegram Personal
    // chatId известен ТОЛЬКО из вебхука входящего сообщения или из ответа Wazzup на предыдущую
    // отправку. Его нельзя просто подставить как "номер телефона цифрами" — это ломает запрос
    // (отсюда HTTP 500 в v45). Для исходящего сообщения, когда chatId неизвестен, нужно передавать
    // phone или username — это специальные поля именно для Telegram Personal.
    if (configured.chatType === 'telegram') {
      if (chatId) {
        payload.chatId = chatId;
      } else if (phone) {
        payload.phone = phone;
      } else if (username) {
        payload.username = username;
      } else {
        res.status(400).json({ ok: false, error: 'Для Telegram Wazzup не найден телефон/chatId/username клиента. Проверь телефон контакта в Bitrix или наличие Telegram-чата.' });
        return;
      }
    } else {
      const recipientId = chatId || phone;
      if (!recipientId) {
        res.status(400).json({ ok: false, error: `Для ${configured.label} не найден chatId/телефон клиента. Проверь телефон контакта в Bitrix.` });
        return;
      }
      payload.chatId = recipientId;
    }
    if (body.crmUserId) payload.crmUserId = String(body.crmUserId);

    // Диагностика: строим альтернативный МИНИМАЛЬНЫЙ payload только с обязательными полями
    // (channelId, chatType, phone/chatId, text) — без crmMessageId, clearUnanswered, crmUserId.
    // Если полный payload даёт 500, а минимальный проходит — значит причина в одном из
    // дополнительных полей именно для Telegram. Это последняя непротестированная гипотеза
    // в рамках самого Telegram-канала, без выхода на Viber/WhatsApp и без обращения в поддержку.
    const minimalPayload = { channelId: payload.channelId, chatType: payload.chatType, text: payload.text };
    if (payload.chatId) minimalPayload.chatId = payload.chatId;
    if (payload.phone) minimalPayload.phone = payload.phone;
    if (payload.username) minimalPayload.username = payload.username;

    // Wazzup документирует MESSAGES_CAN_NOT_ADD ("непредвиденная ошибка сервера") как известную
    // транзиентную ошибку 500 на их стороне. Делаем одну повторную попытку с уникальным
    // crmMessageId перед тем, как считать отправку окончательно неудачной.
    const attemptSend = async (attemptPayload) => {
      const resp = await fetch(`${baseUrl}/message`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(attemptPayload),
      });
      const text = await resp.text();
      const json = (() => { try { return JSON.parse(text); } catch (_) { return {}; } })();
      return { resp, text, json };
    };

    let { resp: response, text: responseText, json: data } = await attemptSend(payload);
    let usedMinimal = false;
    if (!response.ok && response.status >= 500) {
      await new Promise((r) => setTimeout(r, 1000));
      ({ resp: response, text: responseText, json: data } = await attemptSend(minimalPayload));
      usedMinimal = true;
      // Если минимальный payload прошёл — значит при полном payload что-то в дополнительных
      // полях (crmMessageId/clearUnanswered/crmUserId) вызывало 500 именно для этого канала/диалога.
      // Логируем это явно, чтобы было видно в Render logs при следующей проверке.
      if (response.ok) {
        console.log('[wazzup] Полный payload дал 500, минимальный (без crmMessageId/clearUnanswered/crmUserId) прошёл успешно. Канал:', configured.key);
      }
    }
    if (!response.ok) {
      const message = compactWazzupError(data, responseText ? responseText.slice(0, 300) : `HTTP ${response.status} без тела ответа`);
      res.status(response.status).json({
        ok: false,
        error: `Wazzup ${configured.label}: ${message}${usedMinimal ? ' (испробован и минимальный payload — тот же результат)' : ''}`,
        data,
        safePayload: { ...payload, text: '[hidden]' },
      });
      return;
    }
    res.json({ ok: true, channel: { key: configured.key, label: configured.label, chatType: configured.chatType }, data, usedMinimalPayload: usedMinimal });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || String(error) });
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

app.listen(PORT, () => {
  console.log(`MAVIS Bitrix Expert Assistant is running on port ${PORT}`);
});
