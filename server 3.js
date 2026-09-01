const express = require('express');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const AdmZip = require('adm-zip');

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

// v125: hard catch-all for the Bitrix local-app placement.
// Bitrix may open the placement with POST and may include a trailing slash.
// `app.use` catches GET/POST/HEAD/etc. before any later router can return Cannot POST.
const DOC_RETURN_REPORT_BUILD = 'v125-POST-HARD-CATCH';
app.use(['/doc-return-report', '/doc-return-report/'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Mavis-Doc-Return-Build', DOC_RETURN_REPORT_BUILD);
  res.sendFile(path.join(__dirname, 'public', 'doc-return-report.html'));
});
app.get('/api/doc-return-report/build', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, build: DOC_RETURN_REPORT_BUILD });
});


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
  // v80: автопилот работает по всем подходящим сделкам Производства.
  // Ограничение одной тестовой сделкой полностью снято. EXECUTOR_TEST_DEAL_ID больше не ограничивает polling.
  executorAllDeals: true,
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
  // v79: anti-spam / resilient first-call processing.
  autopilotPollIntervalMinutes: Number(process.env.AUTOPILOT_POLL_INTERVAL_MINUTES || 10),
  autopilotTimelineDiagnostics: String(process.env.AUTOPILOT_TIMELINE_DIAGNOSTICS || 'false').toLowerCase() === 'true',
  autopilotTranscribeRetries: Math.max(1, Number(process.env.AUTOPILOT_TRANSCRIBE_RETRIES || 2)),
  // v77: блок 1 CJM — контроль стадии «На распределении».
  // Явный ID надёжнее названия; fallback соответствует текущей воронке Производства.
  unassignedStageId: process.env.UNASSIGNED_STAGE_ID || 'C28:UC_01240N',
  // Только для короткого теста блока 1. Например UNASSIGNED_TEST_MINUTES=2.
  // В бою удалить переменную: вернётся правило 4 рабочих часа по Минску.
  unassignedTestMinutes: Number(process.env.UNASSIGNED_TEST_MINUTES || 0),
  // Опционально: точный список экспертов, между которыми ИИгорь сравнивает текущую загрузку
  // при рекомендации распределения новой сделки. Пример: 2052,1960,2192,2198
  distributionExpertIds: parseIdList(process.env.DISTRIBUTION_EXPERT_IDS),
  // v85: если явный список не задан, кандидатов на распределение определяем только
  // по отделу Производства. Опорные эксперты нужны лишь чтобы автоматически найти ID отдела.
  distributionExpertSeedIds: parseIdList(process.env.DISTRIBUTION_EXPERT_SEED_IDS || '2052,1960,2192,2198'),
  // v85: CJM блоки 5–6 запускаются отдельно от старого STAGE_MONITORING_ENABLED.
  collectionControlEnabled: String(process.env.COLLECTION_CONTROL_ENABLED || 'true').toLowerCase() !== 'false',
  selectionControlEnabled: String(process.env.SELECTION_CONTROL_ENABLED || 'true').toLowerCase() !== 'false',
  collectionReminderDays: Number(process.env.COLLECTION_REMINDER_DAYS || 3),
  collectionLeaderDays: Number(process.env.COLLECTION_LEADER_DAYS || 7),
  selectionExpertEveryDays: Number(process.env.SELECTION_EXPERT_EVERY_DAYS || 7),
  selectionLeaderDays: Number(process.env.SELECTION_LEADER_DAYS || 14),
  collectionTestMinutes: Number(process.env.COLLECTION_TEST_MINUTES || 0),
  selectionTestMinutes: Number(process.env.SELECTION_TEST_MINUTES || 0),
  // v86: временный ускоренный тестовый контур только для ООО «Бобик» (deal 38072).
  // Позволяет прогнать CJM 1–6 с минимумом ручных действий, не ускоряя реальные сделки.
  cjmTestMode: String(process.env.CJM_TEST_MODE || 'true').toLowerCase() !== 'false',
  cjmTestDealId: String(process.env.CJM_TEST_DEAL_ID || '38072'),
  // v87: только в тестовом CJM-контуре Бобика разрешаем сформировать Ход работы без звонка.
  // Боевые сделки по-прежнему требуют содержательный звонок >=60 сек.
  cjmTestAllowNoCall: String(process.env.CJM_TEST_ALLOW_NO_CALL || 'true').toLowerCase() !== 'false',

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
  // v79: old Render flags are not enough for mass actions anymore.
  foremanAllowGlobalScan: String(process.env.FOREMAN_ALLOW_GLOBAL_SCAN || 'false').toLowerCase() === 'true',
  foremanAllowPropagation: String(process.env.FOREMAN_ALLOW_PROPAGATION || 'false').toLowerCase() === 'true',
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
  // v58: канал отправки акта больше НЕ задаём жёстко. Берём из поля "Предпочитаемый канал связи":
  // Email -> письмо, Telegram -> Wazzup Telegram, Viber -> Wazzup Viber.
  // ACTS_SEND_CHANNEL оставлен только как legacy/fallback для старых ручных тестов, в основной логике не используется.
  actsSendChannel: process.env.ACTS_SEND_CHANNEL || '',
  actsDoneStageId: process.env.ACTS_DONE_STAGE_ID || '',
  actsClientMessage: process.env.ACTS_CLIENT_MESSAGE || '',
  // v60: резервный polling стадии «Сделано/Сделаны», чтобы отправка акта не зависела
  // только от срабатывания робота Bitrix. В пилоте обрабатываем только EXECUTOR_TEST_DEAL_ID.
  actsDonePollEnabled: String(process.env.ACTS_DONE_POLL_ENABLED || 'true').toLowerCase() !== 'false',
  actsDonePollIntervalSeconds: Number(process.env.ACTS_DONE_POLL_INTERVAL_SECONDS || 60),
  // v70: автоотправка актов переведена в боевой режим по всей воронке.
  // При необходимости аварийно ограничить отправку одной сделкой — задай ACTS_ALL_DEALS=false.
  actsTestDealId: process.env.ACTS_TEST_DEAL_ID || '38072',
  actsAllDeals: String(process.env.ACTS_ALL_DEALS || 'true').toLowerCase() !== 'false',
  actsRetrySeconds: Number(process.env.ACTS_RETRY_SECONDS || 120),
  // v70: автопуши по подписанному скану. Первый/следующий пуш — через 2 календарных дня
  // после последнего сообщения; если расчётная дата приходится на Сб/Вс, она пропускается
  // и следующая попытка остаётся ещё через 2 календарных дня.
  actsPushEnabled: String(process.env.ACTS_PUSH_ENABLED || 'true').toLowerCase() !== 'false',
  actsPushIntervalMinutes: Number(process.env.ACTS_PUSH_INTERVAL_MINUTES || 60),
  actsPushEveryDays: Number(process.env.ACTS_PUSH_EVERY_DAYS || 2),
  actsCallAfterDays: Number(process.env.ACTS_CALL_AFTER_DAYS || 7),
  // Только для короткого теста. Если >0, минуты временно заменяют 2 дня / 7 дней.
  // После теста ОБЯЗАТЕЛЬНО удалить эти переменные из Render.
  actsPushTestMinutes: Number(process.env.ACTS_PUSH_TEST_MINUTES || 0),
  actsCallTestMinutes: Number(process.env.ACTS_CALL_TEST_MINUTES || 0),
  actsPushRecoveryDays: Number(process.env.ACTS_PUSH_RECOVERY_DAYS || 30),
  // v81: если клиент прислал PDF/изображение, но ИИ не смог уверенно классифицировать файл,
  // не шлём напоминание сразу: даём окну ручной/повторной проверки.
  actsIncomingUncertainHoldHours: Number(process.env.ACTS_INCOMING_UNCERTAIN_HOLD_HOURS || 24),
  actsPushStateRefreshMinutes: Number(process.env.ACTS_PUSH_STATE_REFRESH_MINUTES || 10),
  // Не обрабатываем исторические задачи «Сделано» до запуска боевого режима актов.
  actsProductionStartIso: process.env.ACTS_PRODUCTION_START_ISO || '2026-08-18T14:56:00+03:00',
  // v71: входящие подписанные сканы актов из Wazzup (Viber/Telegram) и почты.
  // Включено независимо от LIVE_CHAT_ENABLED: документы клиента должны обрабатываться даже если живой чат-бот выключен.
  actsIncomingEnabled: String(process.env.ACTS_INCOMING_ENABLED || 'true').toLowerCase() !== 'false',
  actsIncomingWazzupEnabled: String(process.env.ACTS_INCOMING_WAZZUP_ENABLED || 'true').toLowerCase() !== 'false',
  actsIncomingEmailEnabled: String(process.env.ACTS_INCOMING_EMAIL_ENABLED || 'true').toLowerCase() !== 'false',
  actsIncomingLeaderId: process.env.ACTS_INCOMING_LEADER_ID || process.env.TANYA_USER_ID || '2182',

  // v78: CJM блоки 3–4 — контроль первого касания/дедлайна документов
  // и автоматический сбор входящих документов по Аттестации + СПК.
  firstCallTestMinutes: Number(process.env.FIRST_CALL_TEST_MINUTES || 0),
  docsReminderTestMinutes: Number(process.env.DOCS_REMINDER_TEST_MINUTES || 0),
  clientDocsIncomingEnabled: String(process.env.CLIENT_DOCS_INCOMING_ENABLED || 'true').toLowerCase() !== 'false',
  clientDocsWazzupEnabled: String(process.env.CLIENT_DOCS_WAZZUP_ENABLED || 'true').toLowerCase() !== 'false',
  clientDocsEmailEnabled: String(process.env.CLIENT_DOCS_EMAIL_ENABLED || 'true').toLowerCase() !== 'false',
  // v80: входящие документы Аттестации/СПК обрабатываем по всем активным подходящим сделкам.
  clientDocsAllDeals: true,
  clientDocsTestDealId: process.env.CLIENT_DOCS_TEST_DEAL_ID || process.env.EXECUTOR_TEST_DEAL_ID || process.env.LIVE_CHAT_TEST_DEAL_ID || '',
  clientDocsLeaderId: process.env.CLIENT_DOCS_LEADER_ID || process.env.TANYA_USER_ID || '2182',

  // v67: Wazzup принимает файл только по публичному contentUri. Поэтому реальный бинарный файл
  // сначала скачиваем с Bitrix и на короткое время отдаём через наш Render без редиректов.
  actsPublicBaseUrl: String(process.env.ACTS_PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://mavis-bitrix-expert-assistant.onrender.com').replace(/\/+$/, ''),

  // v76: ежемесячная сверка оригиналов актов.
  // Месяц определяется ТОЛЬКО по CLOSEDATE успешной сделки Производства.
  // Автоотчёт уходит Тане в последний рабочий день месяца (Пн–Пт) после 18:00 по Минску.
  actsReconToken: process.env.ACTS_RECON_TOKEN || '',
  actsReconLeaderId: process.env.ACTS_RECON_LEADER_ID || process.env.TANYA_USER_ID || '2182',
  actsReconAutoEnabled: String(process.env.ACTS_RECON_AUTO_ENABLED || 'true').toLowerCase() !== 'false',
  actsReconCheckMinutes: Number(process.env.ACTS_RECON_CHECK_MINUTES || 30),
  actsReconSendHourMinsk: Number(process.env.ACTS_RECON_SEND_HOUR_MINSK || 18),
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
    const isActsTask = (title.includes('[MAVIS_ACTS_ORIGINAL]') || /^СОБРАТЬ АКТ/i.test(title) || /^АКТ/i.test(title) || /^ПОЗВОНИТЬ ПО АКТУ/i.test(title)) && config.actsTasksEnabled;
    // v77: эти задачи являются частью утверждённого CJM ИИ-ассистента и должны
    // создаваться независимо от общего SERVER_TASKS_ENABLED, иначе блоки 1–3 молча не работают.
    const isCoreAssistantTask = /^Распредели сделку:/i.test(title)
      || /позвони клиенту.*4\+.*час/i.test(title)
      || /я отправил ход работы клиенту/i.test(title)
      || /не смог отправить ход работы клиенту/i.test(title);
    if (!isForemanTask && !isActsTask && !isCoreAssistantTask) {
      console.log(`[tasks] blocked by SERVER_TASKS_ENABLED=false: ${title || 'без названия'}`);
      return { task: { id: null, blocked: true } };
    }
    const kind = isActsTask ? 'acts' : (isForemanTask ? 'foreman' : 'core-assistant');
    console.log(`[tasks] allowed as ${kind} task: ${title || 'без названия'}`);
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
    // CRM-методы обычно возвращают массив, а tasks.task.list возвращает { tasks: [...] }.
    // v60: поддерживаем оба формата, иначе задачи проекта выглядели как пустой список.
    const items = Array.isArray(page)
      ? page
      : (page && Array.isArray(page.items))
        ? page.items
        : (page && Array.isArray(page.tasks))
          ? page.tasks
          : [];
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
    // В Bitrix tasks.task.list и CRM-списках размер страницы — 50.
    if (newItems === 0 || items.length < 50 || out.length >= limit) break;
    start += items.length;
  }
  return out.slice(0, limit);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'mavis-bitrix-expert-assistant' });
});

app.get('/config.js', (_req, res) => {
  // v65 security: NEVER expose BITRIX_WEBHOOK_URL / WAZZUP_CRM_KEY or any server secret to the browser.
  const publicConfig = {
    adminUserIds: config.adminUserIds,
    aiControlFieldCode: config.aiControlFieldCode,
    aiEnabled: config.aiEnabled,
    aiModel: config.aiModel,
    allowRopViewAll: config.allowRopViewAll,
    autoLoadMeta: config.autoLoadMeta,
    emailFrom: config.emailFrom,
    emailSenderName: config.emailSenderName,
    escalationAuditorIds: config.escalationAuditorIds,
    escalationResponsibleId: config.escalationResponsibleId,
    excludeClosedDeals: config.excludeClosedDeals,
    executorAllDeals: config.executorAllDeals,
    executorExpertId: config.executorExpertId,
    executorMode: config.executorMode,
    executorTestDealId: config.executorTestDealId,
    foremanCategoryId: config.foremanCategoryId,
    foremanFieldCertExpires: config.foremanFieldCertExpires,
    foremanFieldCertNumber: config.foremanFieldCertNumber,
    foremanFieldPhone: config.foremanFieldPhone,
    foremanFieldProductionDeal: config.foremanFieldProductionDeal,
    foremanFieldWorkType: config.foremanFieldWorkType,
    foremanStageBusy: config.foremanStageBusy,
    foremanStageCertExpiring: config.foremanStageCertExpiring,
    foremanStageFree: config.foremanStageFree,
    leaderUserIds: config.leaderUserIds,
    managerAiLimit: config.managerAiLimit,
    maxDeals: config.maxDeals,
    metaConcurrency: config.metaConcurrency,
    preferredContactFieldCode: config.preferredContactFieldCode,
    productionCategoryId: config.productionCategoryId,
    ropUserIds: config.ropUserIds,
    salesManagerConcurrency: config.salesManagerConcurrency,
    serviceFieldCode: config.serviceFieldCode,
    stageMap: config.stageMap,
    wazzupApiConfigured: config.wazzupApiConfigured,
    wazzupChannels: config.wazzupChannels,
  };
  res.type('application/javascript');
  res.send(`window.APP_CONFIG = ${JSON.stringify(publicConfig)};`);
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
      '5. Строка: "**Документы, пожалуйста, направляйте на нашу почту: mavis.group@mail.ru**" (жирный шрифт, без точки в конце)',
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
  // v90: если вызывающий код явно попросил конкретный канал, НИКОГДА не подменяем его другим.
  // Раньше при channelKey='viber' и проблеме с Viber-конфигом функция могла вернуть Telegram,
  // что ломало строгий режим и потенциально могло отправить не туда.
  if (key && Object.prototype.hasOwnProperty.call(channels, key)) {
    return channels[key].channelId ? channels[key] : null;
  }
  // Без явного канала допускается только общий/default выбор для служебных сценариев.
  if (channels.default.channelId) return channels.default;
  if (channels.telegram.channelId) return channels.telegram;
  if (channels.viber.channelId) return channels.viber;
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
async function sendWazzupMessageInternal({ channelKey, text, phone, chatId, username, dealId, ignoreStrictPreferredChannel = false, crmMessageId = '' }) {
  const apiKey = process.env.WAZZUP_API_KEY || '';
  const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
  if (!apiKey) throw new Error('WAZZUP_API_KEY не задан в Render Environment.');

  const configured = getConfiguredWazzupChannel(channelKey);
  if (!configured || !configured.channelId) throw new Error(`Wazzup-канал ${channelKey || 'по умолчанию'} не задан в Render Environment.`);

  if (dealId) {
    const deal = await loadFreshDeal(dealId);
    if (isDealAiDisabled(deal)) throw new Error('Поле ИИ=Нет — отправка клиенту заблокирована.');
    if (config.strictPreferredChannel && !ignoreStrictPreferredChannel) {
      // v90: пользовательское поле канала в Bitrix — enum. Сырой detectPreferredChannel()
      // видит только текст и на enum-ID возвращает null. Из-за этого внешний код уже правильно
      // распознавал Viber через detectPreferredChannelResolved(), но sendWazzupMessageInternal
      // тут же повторно блокировал ту же отправку как «канал не распознан».
      const preferred = await detectPreferredChannelResolved(deal);
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
    crmMessageId: crmMessageId || `mavis-executor-${configured.key}-${dealId || 'deal'}-${Date.now()}`,
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

  const minimalPayload = { channelId: payload.channelId, chatType: payload.chatType, text: payload.text, crmMessageId: payload.crmMessageId, clearUnanswered: false };
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


async function sendWazzupFileInternal({ channelKey, contentUri, phone, chatId, username, dealId, fileName, crmMessageId = '' }) {
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
    crmMessageId: crmMessageId || `mavis-acts-file-${configured.key}-${dealId || 'deal'}-${Date.now()}`,
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

function wazzupWebhookContentHostAllowed(contentUri) {
  if (!contentUri) return false;
  try {
    const host = new URL(String(contentUri)).hostname.toLowerCase();
    return host === 'wazzup24.com' || host.endsWith('.wazzup24.com');
  } catch (_) {
    return false;
  }
}

function wazzupWebhookKnownChannel(msg) {
  if (!msg || !msg.channelId) return false;
  return !!findChannelKeyByChannelId(msg.channelId);
}

function wazzupWebhookSafeInboundFile(msg) {
  if (!msg || msg.isEcho || String(msg.status || '').toLowerCase() !== 'inbound') return false;
  const type = String(msg.type || '').toLowerCase();
  if (!['image', 'document'].includes(type)) return false;
  if (!msg.contentUri || !wazzupWebhookContentHostAllowed(msg.contentUri)) return false;
  return wazzupWebhookKnownChannel(msg);
}

function wazzupWebhookMessageLogSummary(msg) {
  if (!msg) return { empty: true };
  const phone = normalizePhoneDigits((msg.contact && msg.contact.phone) || msg.chatId || '');
  return {
    id: msg.messageId || '',
    status: msg.status || '',
    type: msg.type || '',
    chatType: msg.chatType || '',
    channelKnown: wazzupWebhookKnownChannel(msg),
    echo: !!msg.isEcho,
    hasContent: !!msg.contentUri,
    contentHostOk: !!(msg.contentUri && wazzupWebhookContentHostAllowed(msg.contentUri)),
    phone: phone ? `***${phone.slice(-4)}` : '',
  };
}

app.post('/api/wazzup/webhook', async (req, res) => {
  // Wazzup при регистрации вебхука шлёт тестовый POST {test: true} и ждёт 200 немедленно.
  if (req.body && req.body.test) {
    console.log('[wazzup-webhook] test POST получен → 200 OK.');
    res.status(200).json({ ok: true });
    return;
  }
  try {
    const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
    const auth = String(req.headers.authorization || '');
    const authRequired = !!config.wazzupCrmKey;
    const authMatches = !authRequired || auth === `Bearer ${config.wazzupCrmKey}`;
    console.log(`[wazzup-webhook] POST получен: messages=${messages.length}; auth=${auth ? 'present' : 'none'}; authMatches=${authMatches}; summaries=${JSON.stringify(messages.slice(0, 5).map(wazzupWebhookMessageLogSummary))}`);

    if (!authMatches) {
      // Некоторые Wazzup-подключения не присылают crmKey в webhook, даже если старый WAZZUP_CRM_KEY
      // остался в Render. Не теряем настоящий входящий файл молча: разрешаем ТОЛЬКО строго
      // проверенный inbound-файл с нашего известного channelId и contentUri на домене Wazzup.
      const safe = messages.filter(wazzupWebhookSafeInboundFile);
      if (!safe.length) {
        console.warn('[wazzup-webhook] Authorization не совпал; безопасных входящих файлов нашего канала нет → webhook проигнорирован.');
        res.status(200).json({ ok: true });
        return;
      }
      console.warn(`[wazzup-webhook] Authorization не совпал, но найдено безопасных inbound-файлов нашего Wazzup-канала: ${safe.length}. Обрабатываю только их.`);
      req.body = { ...req.body, messages: safe };
    }

    const acceptedMessages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];

    // v71: входящие документы/изображения обрабатываем независимо от LIVE_CHAT_ENABLED.
    // Wazzup ждёт 200 максимум 30 секунд, поэтому тяжёлую работу (скачивание, ИИ, Bitrix Disk)
    // запускаем асинхронно и не держим webhook-ответ.
    if (config.actsIncomingEnabled && config.actsIncomingWazzupEnabled) {
      for (const msg of acceptedMessages) {
        if (!msg || msg.isEcho || msg.status !== 'inbound') continue;
        if (!msg.contentUri || !['image','document'].includes(String(msg.type || '').toLowerCase())) continue;
        setImmediate(() => actsProcessIncomingWazzupMessage(msg).catch((e) =>
          console.error(`[acts-incoming] Wazzup message=${msg.messageId || '?'}: ${e.message || e}`)
        ));
      }
    }

    // v78: тот же входящий файл используем для сбора документов по Аттестации/СПК.
    if (config.clientDocsIncomingEnabled && config.clientDocsWazzupEnabled) {
      for (const msg of acceptedMessages) {
        if (!msg || msg.isEcho || msg.status !== 'inbound') continue;
        if (!msg.contentUri || !['image','document'].includes(String(msg.type || '').toLowerCase())) continue;
        setImmediate(() => clientDocsProcessIncomingWazzupMessage(msg).catch((e) =>
          console.error(`[client-docs] Wazzup message=${msg.messageId || '?'}: ${e.message || e}`)
        ));
      }
    }

    if (!config.liveChatEnabled) {
      res.status(200).json({ ok: true });
      return;
    }

    for (const msg of acceptedMessages) {
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

          // v71: сначала отдельно проверяем — не вернулся ли подписанный акт по активному контролю.
          // Общую почтовую обработку ниже НЕ прерываем: она по-прежнему сохранит письмо в папку компании.
          if (config.actsIncomingEnabled && config.actsIncomingEmailEnabled && attachments.length) {
            try {
              await actsProcessIncomingAttachments({
                source: 'email',
                commType: 'EMAIL',
                commValue: senderEmail,
                messageText: `${subject}\n${parsed.text || ''}`.slice(0, 2000),
                attachments: attachments.map((a) => ({
                  fileName: a.filename || 'attachment',
                  contentType: a.contentType || '',
                  buffer: a.content,
                })),
                skipCompanyFolder: true,
              });
            } catch (actErr) {
              console.warn(`[acts-incoming] email ${maskEmailForLog(senderEmail)}: ${actErr.message || actErr}`);
            }
          }

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

          // v78: единый сбор документов Аттестации/СПК.
          if (config.clientDocsIncomingEnabled && config.clientDocsEmailEnabled) {
            try {
              const clientDocsResult = await clientDocsProcessIncomingAttachments({
                source: 'Email',
                commType: 'EMAIL',
                commValue: senderEmail,
                messageText: `${subject}\n${parsed.text || ''}`.slice(0, 3000),
                attachments: attachments.map((a) => ({
                  fileName: a.filename || 'attachment',
                  contentType: a.contentType || '',
                  buffer: a.content,
                })),
              });
              if (clientDocsResult && Number(clientDocsResult.processed || 0) > 0) {
                await client.messageFlagsAdd(uid, ['\\Seen']);
                console.log(`[client-docs] Email ${maskEmailForLog(senderEmail)} обработан новой логикой; старую ветку пропускаю.`);
                continue;
              }
            } catch (docErr) {
              console.warn(`[client-docs] email ${maskEmailForLog(senderEmail)}: ${docErr.message || docErr}`);
            }
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

function isCjmTestDeal(dealId) {
  return Boolean(config.cjmTestMode) && String(dealId || '') === String(config.cjmTestDealId || '');
}


const MINSK_PARTS_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Minsk',
  weekday: 'short',
  hour: '2-digit',
  hour12: false,
});

function minskWeekdayHour(date = new Date()) {
  const parts = MINSK_PARTS_FORMATTER.formatToParts(date);
  const weekday = (parts.find((p) => p.type === 'weekday') || {}).value || '';
  const hour = Number((parts.find((p) => p.type === 'hour') || {}).value || 0);
  const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };
  return { day: dayMap[weekday], hour };
}

function isWorkingHour(date = new Date()) {
  // v77: Render обычно работает в UTC, поэтому рабочие часы считаем явно по Минску.
  const { day, hour } = minskWeekdayHour(date);
  return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
}

function toMinskLocalIso(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}+03:00`;
}

function workingHoursBetween(from, to) {
  // Считаем рабочие часы 09:00–18:00 Пн–Пт именно по Europe/Minsk.
  let count = 0;
  const cur = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime()) || cur >= end) return 0;
  while (cur < end) {
    if (isWorkingHour(cur)) count++;
    cur.setTime(cur.getTime() + 60 * 60 * 1000);
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
      new Paragraph({ children: [new TextRun({ text: 'Документы, пожалуйста, направляйте на нашу почту: mavis.group@mail.ru', bold: true, size: 22, font: 'Arial', color: '1a5276' })] }),
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

const distributionUserCache = new Map();

async function getDistributionUserName(userId) {
  const key = String(userId || '').trim();
  if (!key) return '';
  if (distributionUserCache.has(key)) return distributionUserCache.get(key);
  try {
    const u = await bitrixRestCall('user.get', { ID: key });
    const user = Array.isArray(u) ? u[0] : u;
    const full = user ? `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim() : '';
    distributionUserCache.set(key, full);
    return full;
  } catch (_) {
    return '';
  }
}


const distributionUserProfileCache = new Map();
let distributionExpertDepartmentCache = null;

async function getDistributionUserProfile(userId) {
  const key = String(userId || '').trim();
  if (!key) return null;
  if (distributionUserProfileCache.has(key)) return distributionUserProfileCache.get(key);
  try {
    const raw = await bitrixRestCall('user.get', { ID: key });
    const user = Array.isArray(raw) ? raw[0] : raw;
    distributionUserProfileCache.set(key, user || null);
    return user || null;
  } catch (_) {
    distributionUserProfileCache.set(key, null);
    return null;
  }
}

function userDepartmentIds(user) {
  const raw = user && (user.UF_DEPARTMENT || user.ufDepartment);
  return (Array.isArray(raw) ? raw : [raw]).map((x) => String(x || '').trim()).filter(Boolean);
}

async function getProductionExpertDepartmentIds() {
  if (distributionExpertDepartmentCache) return distributionExpertDepartmentCache;
  const ids = new Set();
  for (const expertId of (config.distributionExpertSeedIds || [])) {
    const user = await getDistributionUserProfile(expertId);
    for (const dep of userDepartmentIds(user)) ids.add(dep);
  }
  distributionExpertDepartmentCache = ids;
  console.log(`[unassigned] Отдел(ы) экспертов Производства: ${[...ids].join(',') || 'не определены'}.`);
  return ids;
}

async function isProductionDistributionExpert(userId) {
  const id = String(userId || '').trim();
  if (!id || id === String(TANYA_USER_ID)) return false;
  const explicit = new Set((config.distributionExpertIds || []).map(String));
  if (explicit.size) return explicit.has(id);
  if ((config.distributionExpertSeedIds || []).map(String).includes(id)) return true;
  const expertDeps = await getProductionExpertDepartmentIds();
  if (!expertDeps.size) return false;
  const user = await getDistributionUserProfile(id);
  return userDepartmentIds(user).some((dep) => expertDeps.has(dep));
}

async function getPreviousExpert(companyId, currentDealId) {
  // v77: предыдущий эксперт = ответственный по последней УСПЕШНО закрытой
  // производственной сделке компании, а не просто по последней изменённой сделке CRM.
  if (!companyId) return null;
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: {
        COMPANY_ID: companyId,
        CATEGORY_ID: config.autopilotCategoryId || 28,
        STAGE_SEMANTIC_ID: 'S',
      },
      select: ['ID', 'TITLE', 'ASSIGNED_BY_ID', 'CLOSEDATE', process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071'],
      order: { CLOSEDATE: 'DESC' },
    }, 10);
    const prev = deals.find((d) => String(d.ID) !== String(currentDealId || ''));
    if (!prev || !prev.ASSIGNED_BY_ID) return null;
    if (!(await isProductionDistributionExpert(prev.ASSIGNED_BY_ID))) return null;
    const expertName = await getDistributionUserName(prev.ASSIGNED_BY_ID);
    return {
      dealId: prev.ID,
      title: prev.TITLE || '',
      service: detectServiceFromDeal(prev),
      closeDate: prev.CLOSEDATE || '',
      expertId: String(prev.ASSIGNED_BY_ID),
      expertName,
    };
  } catch (_) {
    return null;
  }
}

async function getActiveProductionDealsForCompany(companyId, currentDealId) {
  if (!companyId) return [];
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: {
        COMPANY_ID: companyId,
        CATEGORY_ID: config.autopilotCategoryId || 28,
        CLOSED: 'N',
      },
      select: ['ID', 'TITLE', 'STAGE_ID', 'ASSIGNED_BY_ID', 'MOVED_TIME', process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071'],
      order: { MOVED_TIME: 'DESC' },
    }, 30);
    const out = [];
    for (const d of deals) {
      if (String(d.ID) === String(currentDealId || '')) continue;
      if (!d.ASSIGNED_BY_ID) continue;
      if (!(await isProductionDistributionExpert(d.ASSIGNED_BY_ID))) continue;
      const expertName = await getDistributionUserName(d.ASSIGNED_BY_ID);
      out.push({
        dealId: d.ID,
        title: d.TITLE || '',
        service: detectServiceFromDeal(d),
        stageId: d.STAGE_ID || '',
        expertId: String(d.ASSIGNED_BY_ID),
        expertName,
      });
    }
    return out;
  } catch (e) {
    console.warn(`[unassigned] Не удалось получить активные сделки компании ${companyId}: ${e.message}`);
    return [];
  }
}

async function getDistributionTeamLoad() {
  // v85: в рекомендациях только эксперты отдела Производства.
  try {
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, CLOSED: 'N' },
      select: ['ID', 'ASSIGNED_BY_ID', 'STAGE_ID'],
      order: { ID: 'DESC' },
    }, 1000);

    const counts = new Map();
    const candidateIds = new Set();
    for (const d of deals) {
      const id = String(d.ASSIGNED_BY_ID || '').trim();
      if (!id || !(await isProductionDistributionExpert(id))) continue;
      candidateIds.add(id);
      counts.set(id, (counts.get(id) || 0) + 1);
    }

    const explicit = (config.distributionExpertIds || []).map(String);
    for (const id of (explicit.length ? explicit : (config.distributionExpertSeedIds || []).map(String))) {
      if (await isProductionDistributionExpert(id)) {
        candidateIds.add(id);
        if (!counts.has(id)) counts.set(id, 0);
      }
    }

    if (!explicit.length) {
      try {
        const deptIds = await getProductionExpertDepartmentIds();
        if (deptIds.size) {
          const users = await bitrixRestList('user.get', { filter: { ACTIVE: 'Y' } }, 500);
          for (const user of users) {
            const id = String(user.ID || '').trim();
            if (!id || id === String(TANYA_USER_ID)) continue;
            if (!userDepartmentIds(user).some((dep) => deptIds.has(dep))) continue;
            candidateIds.add(id);
            if (!counts.has(id)) counts.set(id, 0);
            distributionUserProfileCache.set(id, user);
          }
        }
      } catch (e) {
        console.warn(`[unassigned] Не удалось добавить экспертов с нулевой загрузкой: ${e.message || e}`);
      }
    }

    const rows = [];
    for (const expertId of candidateIds) {
      if (!(await isProductionDistributionExpert(expertId))) continue;
      const expertName = await getDistributionUserName(expertId);
      rows.push({ expertId, expertName: expertName || `ID ${expertId}`, activeCount: counts.get(expertId) || 0 });
    }
    rows.sort((a, b) => a.activeCount - b.activeCount || a.expertName.localeCompare(b.expertName, 'ru'));
    return rows;
  } catch (e) {
    console.warn(`[unassigned] Не удалось посчитать загрузку экспертов: ${e.message}`);
    return [];
  }
}

function leastLoadedRecommendation(teamLoad) {
  const rows = Array.isArray(teamLoad) ? teamLoad : [];
  if (!rows.length) return null;
  const min = rows[0].activeCount;
  const leaders = rows.filter((x) => x.activeCount === min);
  if (leaders.length === 1) {
    return `Рекомендация: передать ${leaders[0].expertName} — сейчас у него/неё минимальная загрузка (${min} активных сделок).`;
  }
  return `Рекомендация: минимальная загрузка сейчас у ${leaders.map((x) => x.expertName).join(', ')} — по ${min} активных сделок. Можно распределить между ними.`;
}

function formatRoutingRecommendation({ isNew, activeDeals, previous, nps, teamLoad }) {
  const activeExperts = new Map();
  for (const d of activeDeals || []) {
    const key = String(d.expertId || '');
    if (!key) continue;
    if (!activeExperts.has(key)) activeExperts.set(key, { name: d.expertName || `ID ${key}`, deals: [] });
    activeExperts.get(key).deals.push(d);
  }

  if (activeExperts.size === 1) {
    const only = [...activeExperts.values()][0];
    const services = only.deals.map((d) => d.service || d.title || `сделка ${d.dealId}`).filter(Boolean).join(', ');
    return `Рекомендация: передать ${only.name}. У этого эксперта уже есть активная работа с компанией${services ? `: ${services}` : ''}.`;
  }
  if (activeExperts.size > 1) {
    const names = [...activeExperts.values()].map((x) => x.name).join(', ');
    return `Рекомендация: распределить вручную — у компании одновременно есть активные сделки у нескольких экспертов (${names}).`;
  }

  const lowNps = nps && nps.score !== null && nps.score <= 6;
  if (previous && previous.expertName) {
    if (lowNps) {
      return `Рекомендация: не возвращать автоматически прежнему эксперту. Ранее компанию вёл ${previous.expertName}, но NPS низкий (${nps.score}/10) — решение лучше принять вручную.`;
    }
    return `Рекомендация: передать ${previous.expertName} — это последний эксперт, успешно работавший с компанией.`;
  }

  const loadRecommendation = leastLoadedRecommendation(teamLoad);
  if (isNew) return loadRecommendation || 'Рекомендация: новый клиент, истории работы нет — распределить по текущей загрузке команды.';
  return loadRecommendation || 'Рекомендация: история клиента найдена не полностью — распределить вручную.';
}

async function notifyTanyaAboutUnassignedDeal(deal) {
  const dealId = deal.ID;
  const companyId = deal.COMPANY_ID;
  const companyName = deal.TITLE || `Сделка ${dealId}`;

  const isNew = await isNewClient(companyId, companyName);
  const activeDeals = await getActiveProductionDealsForCompany(companyId, dealId);
  const previous = await getPreviousExpert(companyId, dealId);
  const nps = isNew ? null : await findNpsForCompany(companyName, companyId);
  const teamLoad = await getDistributionTeamLoad();
  const recommendation = formatRoutingRecommendation({ isNew, activeDeals, previous, nps, teamLoad });

  const lines = [
    'Таня, распредели новую сделку!',
    '',
    `Клиент: ${isNew ? 'новый 🆕' : 'действующий'}`,
    `Компания: ${companyName}`,
  ];

  if (activeDeals.length) {
    lines.push('', 'Сейчас в работе у компании:');
    for (const d of activeDeals.slice(0, 5)) {
      lines.push(`— ${d.service || d.title || `сделка ${d.dealId}`} — ${d.expertName || `эксперт ID ${d.expertId}`}`);
    }
  }

  if (previous) {
    lines.push('', `Последняя успешная работа: ${previous.service || previous.title || `сделка ${previous.dealId}`} — ${previous.expertName || `эксперт ID ${previous.expertId}`}${previous.closeDate ? `, закрыта ${String(previous.closeDate).slice(0, 10)}` : ''}.`);
  }

  if (nps) {
    if (nps.score !== null) {
      lines.push(`NPS: ${nps.score}/10${nps.reason && nps.reason !== 'причина не указана' ? ` — ${nps.reason}` : ''}.`);
    } else {
      lines.push('NPS: запись найдена, числовая оценка не распознана.');
    }
  } else if (!isNew) {
    lines.push('NPS: не найден.');
  }

  if (teamLoad.length) {
    lines.push('', 'Текущая загрузка экспертов:');
    for (const row of teamLoad.slice(0, 10)) {
      lines.push(`— ${row.expertName}: ${row.activeCount} активных сделок`);
    }
  }

  lines.push('', recommendation, '', `Сделка: https://mavisgroup.bitrix24.by/crm/deal/details/${dealId}/`);
  const msgBody = lines.join('\n');

  // Задача Тане — часть CJM блока 1. В v77 она разрешена даже при SERVER_TASKS_ENABLED=false.
  const deadline = new Date(Date.now() + 2 * 60 * 60 * 1000);
  try {
    await bitrixRestCall('tasks.task.add', {
      fields: {
        TITLE: `Распредели сделку: ${companyName}`,
        DESCRIPTION: msgBody,
        RESPONSIBLE_ID: TANYA_USER_ID,
        DEADLINE: toMinskLocalIso(deadline),
        UF_CRM_TASK: [`D_${dealId}`],
        PRIORITY: 2,
      },
    });
  } catch (e) {
    console.warn(`[unassigned] Не удалось создать задачу Тане: ${e.message}`);
  }

  let notified = false;
  try {
    await bitrixRestCall('im.notify.system.add', {
      USER_ID: TANYA_USER_ID,
      MESSAGE: msgBody,
    });
    notified = true;
  } catch (_) {
    try {
      await bitrixRestCall('im.message.add', {
        DIALOG_ID: TANYA_USER_ID,
        MESSAGE: msgBody,
      });
      notified = true;
    } catch (e2) {
      console.warn(`[unassigned] Не удалось отправить уведомление Тане: ${e2.message}`);
    }
  }

  // Постоянный антидубль переживает рестарт Render.
  try {
    await bitrixRestCall('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId,
        ENTITY_TYPE: 'deal',
        COMMENT: `ИИгорь — контроль распределения.\n${recommendation}`,
      },
    });
  } catch (_) {}

  console.log(`[unassigned] ${notified ? 'Таня уведомлена' : 'уведомление не доставлено'} о сделке ${dealId} (${companyName}). ${recommendation}`);
}

async function getLastUnassignedNotificationAt(dealId) {
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID', 'COMMENT', 'CREATED'],
      order: { ID: 'DESC' },
    }, 30);
    for (const c of comments) {
      const text = String(c.COMMENT || '');
      const isLegacy = text.includes('[MAVIS_UNASSIGNED_NOTIFY]');
      const isClean = text.includes('ИИгорь — контроль распределения.');
      if (!isLegacy && !isClean) continue;
      const m = text.match(/at=([^\s]+)/);
      const d = new Date(m ? m[1] : c.CREATED || c.DATE_CREATE || '');
      if (!Number.isNaN(d.getTime())) return d;
    }
  } catch (_) {}
  return null;
}

async function checkUnassignedDeals() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;

  try {
    const stages = await bitrixRestCall('crm.dealcategory.stage.list', { id: config.autopilotCategoryId || 28 });
    const allStages = Array.isArray(stages) ? stages : [];

    // v77: сначала берём явно заданный ID, затем ищем именно «На/Не распределении».
    // C28:NEW больше НИКОГДА не используется как fallback — это «Эксперт назначен».
    let unassignedStage = allStages.find((s) => String(s.STATUS_ID) === String(config.unassignedStageId || ''));
    // Даже если старый ID существует, не доверяем ему, если название уже не про распределение.
    if (unassignedStage && !/(?:^|\s)(?:на|не)\s+распредел/i.test(String(unassignedStage.NAME || ''))) {
      console.warn(`[unassigned] UNASSIGNED_STAGE_ID=${config.unassignedStageId} сейчас называется «${unassignedStage.NAME}» — это не стадия распределения, ищу по названию.`);
      unassignedStage = null;
    }
    if (!unassignedStage) {
      unassignedStage = allStages.find((s) => /(?:^|\s)(?:на|не)\s+распредел/i.test(String(s.NAME || '')));
    }
    if (!unassignedStage) {
      console.warn(`[unassigned] Не нашёл стадию «На распределении». Проверь UNASSIGNED_STAGE_ID. Известные стадии: ${allStages.map((s) => `${s.NAME}=${s.STATUS_ID}`).join('; ')}`);
      return;
    }
    if (checkUnassignedDeals._lastStageLog !== String(unassignedStage.STATUS_ID)) {
      console.log(`[unassigned] Контролирую стадию «${unassignedStage.NAME}» → ${unassignedStage.STATUS_ID}.`);
      checkUnassignedDeals._lastStageLog = String(unassignedStage.STATUS_ID);
    }

    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: unassignedStage.STATUS_ID },
      select: ['ID', 'TITLE', 'COMPANY_ID', 'DATE_CREATE', 'MOVED_TIME', 'STAGE_ID'],
      order: { MOVED_TIME: 'ASC' },
    }, 100);

    const now = new Date();
    const globalTestMinutes = Math.max(0, Number(config.unassignedTestMinutes || 0));
    for (const deal of deals) {
      const testMinutes = isCjmTestDeal(deal.ID) ? 2 : globalTestMinutes;
      if (await isDealAiDisabledAsync(deal)) {
        console.log(`[AI] Сделка ${deal.ID} помечена "ИИ=Нет" — пропускаю распределение.`);
        continue;
      }

      // Отсчёт только от входа на стадию, а не от создания сделки в продажах.
      const movedAt = new Date(deal.MOVED_TIME || deal.DATE_CREATE);
      if (Number.isNaN(movedAt.getTime())) continue;

      let due = false;
      let elapsedLabel = '';
      if (testMinutes > 0) {
        const elapsedMinutes = (now.getTime() - movedAt.getTime()) / 60000;
        due = elapsedMinutes >= testMinutes;
        elapsedLabel = `${elapsedMinutes.toFixed(1)} мин`;
      } else {
        const workedHours = workingHoursBetween(movedAt, now);
        due = workedHours >= 4;
        elapsedLabel = `${workedHours} раб. ч`;
      }
      if (!due) continue;

      // В бою клиентскую/внутреннюю коммуникацию делаем только в рабочее время Минска.
      // В коротком тесте разрешаем срабатывание сразу.
      if (!testMinutes && !isWorkingHour(now)) continue;

      const memoryLast = UNASSIGNED_NOTIFIED.get(String(deal.ID));
      const persistedLast = memoryLast || await getLastUnassignedNotificationAt(deal.ID);
      if (persistedLast) {
        const repeatDue = testMinutes > 0
          ? ((now.getTime() - persistedLast.getTime()) / 60000 >= testMinutes)
          : (workingHoursBetween(persistedLast, now) >= 4);
        if (!repeatDue) continue;
      }

      console.log(`[unassigned] Сделка ${deal.ID} «${deal.TITLE}» ждёт распределения ${elapsedLabel} — готовлю уведомление и рекомендацию.`);
      await notifyTanyaAboutUnassignedDeal(deal);
      UNASSIGNED_NOTIFIED.set(String(deal.ID), now);
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (e) {
    console.error('[unassigned] Ошибка проверки стадии «На распределении»:', e.message);
  }
}

const AUTOPILOT_MARKER = '[MAVIS_AUTOPILOT_DONE]';
const AUTOPILOT_ERROR_MARKER = '[MAVIS_AUTOPILOT_ERROR]';
const AUTOPILOT_SEND_PENDING_MARKER = '[MAVIS_AUTOPILOT_SEND_PENDING]';
const AUTOPILOT_CALL_REJECTED_MARKER = '[MAVIS_AUTOPILOT_CALL_REJECTED]';
const AUTOPILOT_CALL_DONE_MARKER = '[MAVIS_AUTOPILOT_CALL_DONE]';
const AUTOPILOT_POLL_INTERVAL_MS = Math.max(1, Number(config.autopilotPollIntervalMinutes || 10)) * 60 * 1000;
let autopilotCycleRunning = false;

// Дата запуска сервера — сделки созданные раньше этой даты не трогаем.
// Это гарантирует, что текущие 14 сделок на стадии "Эксперт назначен"
// не будут обработаны при первом запуске.
const AUTOPILOT_START_DATE = new Date();

// Кэш обработанных сделок (dealId → true), чтобы не перечитывать
// таймлайн каждые 10 минут для уже обработанных сделок.
const autopilotProcessed = new Set();
// v77: короткие/служебные звонки, уже проверенные в текущем процессе Render.
const autopilotRejectedCallIds = new Set(); // `${dealId}:${activityId}`

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
  // v86: для тестового Бобика старые DONE-маркеры прошлых прогонов не блокируют новый тестовый цикл.
  // Повтор того же звонка блокируется отдельным marker activity=... внутри runServerAutopilotForDeal.
  if (isCjmTestDeal(dealId)) return false;
  // Проверяем таймлайн сделки на наличие маркера выполненного автопилота.
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID', 'COMMENT'],
      order: { ID: 'DESC' },
    }, 30);
    // v77: только успешный DONE блокирует повторную обработку; ERROR не должен навсегда выключать сделку.
    const done = comments.some((c) => String(c.COMMENT || '').includes(AUTOPILOT_MARKER));
    if (done) autopilotProcessed.add(String(dealId));
    return done;
  } catch (_) {
    return false; // если не удалось прочитать таймлайн — не блокируем, попробуем обработать
  }
}

async function autopilotTimelineHasMarker(dealId, marker, limit = 80) {
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      order: { ID: 'DESC' },
      select: ['ID', 'COMMENT'],
    }, limit);
    return comments.some((c) => String(c.COMMENT || '').includes(marker));
  } catch (_) { return false; }
}

async function addAutopilotCommentOnce(dealId, marker, body) {
  if (await autopilotTimelineHasMarker(dealId, marker, 100)) return false;
  await bitrixRestCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal', COMMENT: `${marker}\n${body}` },
  });
  return true;
}

function normalizeTranscriptQuality(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function transcriptLooksLikePlaceholder(text) {
  const t = normalizeTranscriptQuality(text).toLowerCase().replace(/ё/g, 'е');
  if (!t || t.length < 30) return true;
  if (/^(продолжение следует|спасибо за просмотр|субтитры|конец записи)[.!…\s-]*$/i.test(t)) return true;
  if (/продолжение следует/i.test(t) && t.length < 120) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 6 && new Set(words).size <= 2) return true;
  return false;
}

function embeddedTranscriptCandidates(activity) {
  const out = []; const seen = new Set();
  const push = (v, path) => {
    if (typeof v !== 'string') return;
    const text = normalizeTranscriptQuality(v.replace(/<[^>]+>/g, ' '));
    if (text.length < 30 || /https?:\/\//i.test(text)) return;
    const key = text.slice(0, 500); if (seen.has(key)) return;
    seen.add(key); out.push({ text, path });
  };
  const walk = (value, path = '') => {
    if (!value || typeof value !== 'object') return;
    for (const [k, v] of Object.entries(value)) {
      const next = path ? `${path}.${k}` : k;
      if (typeof v === 'string' && /(transcript|speech|recogn|description|comment|text)/i.test(k)) push(v, next);
      else if (v && typeof v === 'object') walk(v, next);
    }
  };
  walk(activity || {}); return out;
}

async function resolveAllAudioUrlsForActivity(activity, primaryUrl = '') {
  const urls = []; const seen = new Set();
  const add = (u) => { u = String(u || '').trim(); if (!u || seen.has(u)) return; seen.add(u); urls.push(u); };
  add(primaryUrl);
  const files = Array.isArray(activity && activity.FILES) ? activity.FILES : [];
  for (const f of files) {
    add(f && (f.DOWNLOAD_URL || f.downloadUrl || f.VIEW_URL || f.url));
    const fileId = f && (f.ID || f.id || f.FILE_ID || f.fileId);
    if (fileId) {
      try { const file = await bitrixRestCall('disk.file.get', { id: fileId }); add(file && (file.DOWNLOAD_URL || file.downloadUrl || file.VIEW_URL || file.url)); } catch (_) {}
    }
  }
  for (const c of serverCollectActivityAudioCandidates(activity || {})) {
    try { add(await serverResolveCandidateDownloadUrl(c)); } catch (_) {}
  }
  return urls;
}

async function transcribeCallBestEffort(callRecord, logPrefix = '[autopilot]') {
  for (const c of embeddedTranscriptCandidates(callRecord && callRecord.activity)) {
    if (!transcriptLooksLikePlaceholder(c.text)) {
      console.log(`${logPrefix} Использую встроенный текст звонка из ${c.path}, ${c.text.length} символов.`);
      return { text: c.text, source: `activity:${c.path}`, ready: true };
    }
  }
  const urls = await resolveAllAudioUrlsForActivity(callRecord && callRecord.activity, callRecord && callRecord.url);
  let lastText = ''; let lastError = null;
  const retries = Math.max(1, Number(config.autopilotTranscribeRetries || 2));
  for (const url of urls) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const text = await transcribeAudioUrl(url, callRecord && callRecord.fileName);
        lastText = text;
        if (!transcriptLooksLikePlaceholder(text)) return { text, source: `audio:${attempt}`, ready: true };
        console.warn(`${logPrefix} STT вернул служебную/пустую расшифровку (попытка ${attempt}/${retries}): "${normalizeTranscriptQuality(text).slice(0, 120)}"`);
      } catch (e) { lastError = e; console.warn(`${logPrefix} STT попытка ${attempt}/${retries} не удалась: ${e.message || e}`); }
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return { text: lastText, source: '', ready: false, error: lastError };
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

function activityCallDurationSeconds(act) {
  const candidates = [
    act && act.DURATION,
    act && act.CALL_DURATION,
    act && act.SETTINGS && (act.SETTINGS.DURATION || act.SETTINGS.CALL_DURATION),
    act && act.PROVIDER_PARAMS && (act.PROVIDER_PARAMS.DURATION || act.PROVIDER_PARAMS.CALL_DURATION),
  ];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const text = String([act && act.SUBJECT, act && act.DESCRIPTION].filter(Boolean).join(' '));
  let m = text.match(/(?:длительн(?:ость)?|duration)\D{0,10}(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
  if (m) {
    if (m[3] !== undefined) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    return Number(m[1]) * 60 + Number(m[2]);
  }
  m = text.match(/(?:длительн(?:ость)?|duration)\D{0,10}(\d+)\s*(?:сек|sec)/i);
  if (m) return Number(m[1]);
  return null;
}

function looksLikeCallbackOnlyTranscript(text) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  const callbackPhrases = [
    /перезвон(ите|ю|им|ить)/,
    /не могу говорить/,
    /неудобно говорить/,
    /давайте позже/,
    /позвоните позже/,
    /я занят/,
    /я занята/,
    /сейчас неудобно/,
    /ошиблись номером/,
    /не тот номер/,
  ];
  const phraseHit = callbackPhrases.some((re) => re.test(t));
  // Если разговор короткий по содержанию и состоит в основном из просьбы перезвонить — не запускаем ход работы.
  return phraseHit && t.length < 450;
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
  const durationSec = activityCallDurationSeconds(act);
  if (durationSec !== null && durationSec < 60) {
    return { ok: false, reason: `звонок короче 60 секунд (${durationSec} сек)` };
  }
  return { ok: true, reason: 'ok', durationSec };
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
    if (autopilotRejectedCallIds.has(`${dealId}:${act.ID}`)) {
      console.log(`[findCall deal=${dealId} act=${act.ID}] skip: звонок ранее признан не первым содержательным касанием`);
      continue;
    }
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
        if (url) return { activityId: act.ID, subject: act.SUBJECT, url, fileName: file.NAME || `call-${dealId}.mp3`, activity: act, durationSec: gate.durationSec ?? activityCallDurationSeconds(act) };
      } catch (e) { console.log(`${logAct} disk.file.get id=${fileId} → ошибка: ${e.message}`); }
      const directUrl = f && (f.DOWNLOAD_URL || f.downloadUrl || f.VIEW_URL || f.url);
      if (directUrl) return { activityId: act.ID, subject: act.SUBJECT, url: directUrl, fileName: `call-${dealId}.mp3`, activity: act, durationSec: gate.durationSec ?? activityCallDurationSeconds(act) };
    }

    const raw = JSON.stringify(act);
    const fileIdMatch = raw.match(/crm_show_file\.php\?fileId=(\d+)/);
    console.log(`${logAct} crm_show_file fileId=${fileIdMatch ? fileIdMatch[1] : 'не найден'}`);
    if (fileIdMatch) {
      try {
        const file = await bitrixRestCall('disk.file.get', { id: fileIdMatch[1] });
        const url = file && (file.DOWNLOAD_URL || file.downloadUrl);
        console.log(`${logAct} disk.file.get id=${fileIdMatch[1]} → url=${url ? 'OK' : 'пусто'}`);
        if (url) return { activityId: act.ID, subject: act.SUBJECT, url, fileName: file.NAME || `call-${dealId}.mp3`, activity: act, durationSec: gate.durationSec ?? activityCallDurationSeconds(act) };
      } catch (e) { console.log(`${logAct} disk.file.get id=${fileIdMatch[1]} → ошибка: ${e.message}`); }
    }

    const candidates = serverCollectActivityAudioCandidates(act);
    console.log(`${logAct} candidates=${candidates.length}`);
    for (const c of candidates) {
      const url = await serverResolveCandidateDownloadUrl(c);
      if (url) return { activityId: act.ID, subject: act.SUBJECT, url, fileName: `call-${dealId}.mp3`, activity: act, durationSec: gate.durationSec ?? activityCallDurationSeconds(act) };
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
  const greeting = (typeof actsMinskGreeting === 'function' ? actsMinskGreeting() : 'Добрый день!');
  return String(text || '')
    .replace(/^\s*(?:[А-ЯЁA-Z][а-яёa-z]+|Клиент|Анна|Надежда|Нина|Ольга|Мария|Елена|Кристина)\s*,?\s*(?:доброе утро|добрый день|добрый вечер|здравствуйте)[!.,—-]*\s*/i, `${greeting} `)
    .replace(/^\s*(доброе утро|добрый день|добрый вечер|здравствуйте)[!.,—-]*/i, greeting)
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
function removeForbiddenClientPhrases(text) {
  return String(text || '')
    // Клиенту не отправляем размытые формулировки вместо конкретного перечня.
    .replace(/^\s*[-•]?\s*иные документы из обязательного перечня[^\n]*\n?/gim, '')
    .replace(/^\s*[-•]?\s*остальные необходимые документы[^\n]*\n?/gim, '')
    .replace(/^\s*[-•]?\s*прочие необходимые документы[^\n]*\n?/gim, '')
    // Старые версии разрешали «ответным сообщением» — теперь документы просим только на почту.
    .replace(/\n*\s*Документы\s+(?:можете|можно|пожалуйста,?\s*)?(?:направить|отправить|прислать)[^\n]*(?:ответным сообщением|сюда)[^\n]*/gim, '')
    .trim();
}

function buildClientDocumentSection(docList) {
  const docs = Array.isArray(docList && docList.docs) ? docList.docs.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!docs.length) return '';
  const title = String((docList && docList.title) || '').trim();
  const lines = [title ? `Что необходимо предоставить (${title}):` : 'Что необходимо предоставить:'];
  docs.forEach((doc, i) => lines.push(`${i + 1}. ${doc}`));
  lines.push('', 'Если какой-то документ уже направляли ранее, повторно присылать его не нужно.');
  return lines.join('\n');
}

function finalizeClientWorkMessage(aiMessage, docList) {
  const base = removeForbiddenClientPhrases(cleanMarkdownForMessenger(stripClientGreeting(aiMessage)));
  const docsSection = buildClientDocumentSection(docList);
  const emailNote = 'Документы, пожалуйста, направляйте на нашу почту: mavis.group@mail.ru';
  return [base, docsSection, emailNote].filter(Boolean).join('\n\n').trim();
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
    return `[Имя], фиксирую дальнейший ход работы по аттестации организации.

Что у нас есть сейчас:
- виды работ: [перечень из КП];
- специалисты: [ФИО / должности / кто закрывает какие виды работ];
- кого подбираем: [если требуется];
- по каждому специалисту: [что уже получено / что нужно сделать / чего не хватает].

Что необходимо сделать с вашей стороны до [дата]:
- [конкретные действия по каждому специалисту и организации из звонка; без общих фраз «остальные/иные документы»].

Что делаем мы:
1. Проверяем организацию и специалистов по требованиям аттестации
2. Проверяем образование, стаж, должности и аттестаты специалистов
3. Определяем, что нужно перевести/совместить/дооформить, если это требуется
4. После получения полного комплекта готовим аттестационное дело и документы для подачи
5. Контролируем замечания и статус в Белстройцентре

Срок предоставления документов: до [дата].`;
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

function preferredContactFieldCandidates() {
  const configured = config.preferredContactFieldCode || process.env.PREFERRED_CONTACT_FIELD_CODE || process.env.PREFERRED_CHANNEL_FIELD_CODE || '';
  return [...new Set([configured, 'UF_CRM_1781189436900', 'UF_CRM_1781874759140'].filter(Boolean))];
}

function preferredRawValue(deal, extraCodes = []) {
  for (const code of [...new Set([...preferredContactFieldCandidates(), ...extraCodes].filter(Boolean))]) {
    if (deal && Object.prototype.hasOwnProperty.call(deal, code) && deal[code] !== undefined && deal[code] !== null && String(deal[code]).trim() !== '') {
      return { code, raw: deal[code] };
    }
  }
  return { code: '', raw: '' };
}

let preferredFieldDiscoveryCache = null;
async function discoverPreferredChannelFields() {
  if (preferredFieldDiscoveryCache) return preferredFieldDiscoveryCache;
  try {
    const fields = await bitrixRestList('crm.deal.userfield.list', {}, 500);
    const matches = fields.filter((f) => {
      const labels = [
        f.EDIT_FORM_LABEL, f.editFormLabel,
        f.LIST_COLUMN_LABEL, f.listColumnLabel,
        f.LIST_FILTER_LABEL, f.listFilterLabel,
      ].filter(Boolean).join(' ');
      const n = normalizeControlValue(labels);
      return /предпочитаем/.test(n) && /(канал|способ)/.test(n) && /связ/.test(n);
    }).map((f) => ({
      code: String(f.FIELD_NAME || f.fieldName || ''),
      label: String(f.EDIT_FORM_LABEL || f.editFormLabel || f.LIST_COLUMN_LABEL || f.listColumnLabel || f.LIST_FILTER_LABEL || f.listFilterLabel || ''),
      list: Array.isArray(f.LIST || f.list) ? (f.LIST || f.list) : [],
    })).filter((x) => x.code);
    preferredFieldDiscoveryCache = matches;
    if (matches.length) {
      console.log(`[acts-channel] Автонашёл поле канала связи: ${matches.map((x) => `${x.code} «${x.label}»`).join('; ')}`);
    } else {
      console.warn('[acts-channel] Не нашёл пользовательское поле сделки по названию «Предпочитаемый канал/способ связи».');
    }
    return matches;
  } catch (e) {
    console.warn(`[acts-channel] Не смог получить список пользовательских полей сделки: ${e.message || e}`);
    preferredFieldDiscoveryCache = [];
    return [];
  }
}

function channelFromText(value) {
  const val = normalizeControlValue(value);
  if (/\b(телеграм|telegram|tg)\b/i.test(val)) return 'telegram';
  if (/\b(вайбер|viber)\b/i.test(val)) return 'viber';
  if (/\b(email|e-mail|почта|mail)\b/i.test(val)) return 'email';
  return null;
}

function detectPreferredChannel(deal) {
  return channelFromText(preferredRawValue(deal).raw);
}

const preferredEnumCache = new Map();
async function detectPreferredChannelResolved(deal) {
  const discovered = await discoverPreferredChannelFields();
  const discoveredCodes = discovered.map((x) => x.code);
  const codes = [...new Set([...preferredContactFieldCandidates(), ...discoveredCodes].filter(Boolean))];

  for (const code of codes) {
    if (!deal || !Object.prototype.hasOwnProperty.call(deal, code)) continue;
    const raw = deal[code];
    if (raw === '' || raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) continue;

    const direct = channelFromText(raw);
    if (direct) {
      const meta = discovered.find((x) => x.code === code);
      console.log(`[acts-channel] ${meta && meta.label ? `«${meta.label}» ` : ''}${code}: значение=${JSON.stringify(raw)} → ${direct}.`);
      return direct;
    }

    const ids = (Array.isArray(raw) ? raw : [raw]).map((v) => String(v)).filter((v) => /^\d+$/.test(v));
    if (!ids.length) continue;

    try {
      let enumMap = preferredEnumCache.get(code);
      if (!enumMap) {
        enumMap = new Map();
        const discoveredField = discovered.find((x) => x.code === code);
        let list = discoveredField && discoveredField.list;
        if (!Array.isArray(list) || !list.length) {
          const fields = await bitrixRestList('crm.deal.userfield.list', { filter: { FIELD_NAME: code } }, 10);
          const field = fields.find((f) => String(f.FIELD_NAME || f.fieldName || '') === code) || fields[0];
          list = field && (field.LIST || field.list);
        }
        if (Array.isArray(list)) {
          for (const item of list) {
            const id = String(item.ID || item.id || '');
            const value = String(item.VALUE || item.value || '');
            if (id) enumMap.set(id, value);
          }
        }
        preferredEnumCache.set(code, enumMap);
      }
      const labels = ids.map((id) => enumMap.get(id)).filter(Boolean).join(' ');
      const resolved = channelFromText(labels);
      if (resolved) {
        const meta = discovered.find((x) => x.code === code);
        console.log(`[acts-channel] ${meta && meta.label ? `«${meta.label}» ` : ''}${code}: enum ${ids.join(',')} → ${labels} → ${resolved}.`);
        return resolved;
      }
    } catch (e) {
      console.warn(`[acts-channel] Не смог расшифровать enum поля ${code}: ${e.message || e}`);
    }
  }

  console.warn(`[acts-channel] Канал не распознан. Проверены поля: ${codes.join(', ') || 'нет кандидатов'}.`);
  return null;
}

function preferredChannelLabel(channel) {
  return { telegram: 'Telegram', viber: 'Viber', email: 'Email' }[channel] || 'не определён';
}

// v84: для актов при нескольких контактах НЕ используем CONTACT_ID наугад/по умолчанию.
// Выбираем контакт, с которым в этой сделке была последняя переписка (email/чат/мессенджер).
// Если контактов несколько, а переписку однозначно определить не удалось — автоотправку блокируем.
async function actsGetDealContactIds(deal) {
  const ids = [];
  const add = (v) => {
    const m = String(v || '').match(/\d+/);
    if (m && !ids.includes(m[0])) ids.push(m[0]);
  };
  add(deal && deal.CONTACT_ID);
  if (deal && deal.ID) {
    try {
      const raw = await bitrixRestCall('crm.deal.contact.items.get', { id: deal.ID });
      const rows = Array.isArray(raw) ? raw : (raw && (raw.items || raw.ITEMS || raw.result)) || [];
      for (const row of Array.isArray(rows) ? rows : []) add(row && (row.CONTACT_ID || row.contactId || row.ID || row.id));
    } catch (e) {
      console.warn(`[acts-recipient] deal=${deal && deal.ID}: не смог получить список контактов сделки: ${e.message || e}`);
    }
  }
  return ids;
}

async function actsGetContactProfile(contactId) {
  if (!contactId) return null;
  try {
    return await bitrixRestCall('crm.contact.get', { id: contactId });
  } catch (e) {
    console.warn(`[acts-recipient] contact=${contactId}: не смог получить контакт: ${e.message || e}`);
    return null;
  }
}

function actsContactLabel(contact, contactId = '') {
  const name = [contact && contact.NAME, contact && contact.SECOND_NAME, contact && contact.LAST_NAME]
    .map((x) => actsCleanText(x || '')).filter(Boolean).join(' ');
  return name || `контакт ${contactId || (contact && contact.ID) || '?'}`;
}

function actsContactPhone(contact) {
  const phones = Array.isArray(contact && contact.PHONE) ? contact.PHONE : [];
  const raw = phones.find((x) => x && x.VALUE) || null;
  return raw ? normalizePhoneDigits(raw.VALUE) : '';
}

function actsContactEmail(contact) {
  const emails = Array.isArray(contact && contact.EMAIL) ? contact.EMAIL : [];
  const raw = emails.find((x) => x && x.VALUE) || null;
  return raw ? String(raw.VALUE).trim() : '';
}

function actsActivityTimeMs(a) {
  const candidates = [a && a.LAST_UPDATED, a && a.END_TIME, a && a.START_TIME, a && a.CREATED, a && a.ID];
  for (const v of candidates) {
    const n = Date.parse(String(v || ''));
    if (Number.isFinite(n)) return n;
  }
  const id = Number(a && a.ID || 0);
  return Number.isFinite(id) ? id : 0;
}

function actsActivityIsCall(a) {
  const typeId = String(a && a.TYPE_ID || '');
  const text = [a && a.PROVIDER_ID, a && a.PROVIDER_TYPE_ID, a && a.SUBJECT, a && a.DESCRIPTION]
    .map((x) => String(x || '').toLowerCase()).join(' ');
  return typeId === '2' || /call|voximplant|asterisk|zruchna|telephon|звон|телеф/.test(text);
}

function actsActivityLooksLikeCorrespondence(a) {
  if (!a || actsActivityIsCall(a)) return false;
  const typeId = String(a.TYPE_ID || '');
  const text = [a.PROVIDER_ID, a.PROVIDER_TYPE_ID, a.SUBJECT, a.DESCRIPTION]
    .map((x) => String(x || '').toLowerCase()).join(' ');
  if (typeId === '4') return true; // Email
  if (/wazzup|openline|imopen|telegram|viber|whatsapp|chat|message|messenger|email|mail|письм|сообщен|чат/.test(text)) return true;
  const comm = Array.isArray(a.COMMUNICATIONS) ? a.COMMUNICATIONS : [];
  return comm.some((c) => {
    const t = String(c && (c.TYPE || c.TYPE_ID || '')).toLowerCase();
    return t === 'email' || t === 'im' || t === 'chat' || t === 'telegram' || t === 'viber' || t === 'whatsapp';
  });
}

function actsActivityContactIds(a, allowedIds) {
  const allowed = new Set((allowedIds || []).map(String));
  const out = [];
  const comm = Array.isArray(a && a.COMMUNICATIONS) ? a.COMMUNICATIONS : [];
  for (const c of comm) {
    const entityType = String(c && (c.ENTITY_TYPE_ID || c.entityTypeId || '') || '');
    const id = String(c && (c.ENTITY_ID || c.entityId || '') || '').match(/\d+/)?.[0] || '';
    if (!id || !allowed.has(id)) continue;
    // ENTITY_TYPE_ID=3 — контакт. Если поле отсутствует, всё равно допускаем ID из списка контактов сделки.
    if (entityType && entityType !== '3') continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

async function actsResolveRecipientContact(deal, preferredContactId = '') {
  const contactIds = await actsGetDealContactIds(deal);
  if (!contactIds.length) {
    return { ok: false, reason: 'В сделке не найден ни один контакт.' };
  }

  // Для повторного пуша используем тот же контакт, которому отправили сам акт.
  if (preferredContactId && contactIds.includes(String(preferredContactId))) {
    const contact = await actsGetContactProfile(preferredContactId);
    if (contact) return { ok: true, contactId: String(preferredContactId), contact, source: 'stored', label: actsContactLabel(contact, preferredContactId) };
  }

  if (contactIds.length === 1) {
    const contact = await actsGetContactProfile(contactIds[0]);
    if (!contact) return { ok: false, reason: `Не удалось открыть единственный контакт ${contactIds[0]}.` };
    return { ok: true, contactId: contactIds[0], contact, source: 'single', label: actsContactLabel(contact, contactIds[0]) };
  }

  let activities = [];
  try {
    activities = await bitrixRestList('crm.activity.list', {
      filter: { OWNER_TYPE_ID: 2, OWNER_ID: deal.ID },
      order: { LAST_UPDATED: 'DESC', ID: 'DESC' },
      select: ['ID','TYPE_ID','PROVIDER_ID','PROVIDER_TYPE_ID','SUBJECT','DESCRIPTION','DIRECTION','START_TIME','END_TIME','LAST_UPDATED','COMMUNICATIONS'],
    }, 200);
  } catch (e) {
    console.warn(`[acts-recipient] deal=${deal.ID}: не смог получить активности: ${e.message || e}`);
  }

  activities = (activities || []).slice().sort((a,b) => actsActivityTimeMs(b) - actsActivityTimeMs(a));
  for (const activity of activities) {
    if (!actsActivityLooksLikeCorrespondence(activity)) continue;
    const ids = actsActivityContactIds(activity, contactIds);
    if (!ids.length) continue;
    const contact = await actsGetContactProfile(ids[0]);
    if (!contact) continue;
    console.log(`[acts-recipient] deal=${deal.ID}: из ${contactIds.length} контактов выбран ${actsContactLabel(contact, ids[0])} (#${ids[0]}) — последняя переписка activity=${activity.ID}.`);
    return { ok: true, contactId: ids[0], contact, source: 'last-correspondence', activityId: String(activity.ID || ''), label: actsContactLabel(contact, ids[0]) };
  }

  // ВАЖНО: при нескольких контактах не берём основной CONTACT_ID как случайный fallback.
  return {
    ok: false,
    reason: `В сделке ${contactIds.length} контакта(ов), но не удалось однозначно определить контакт по последней переписке. Автоотправка акта заблокирована, чтобы не написать неактуальному человеку.`,
    contactIds,
  };
}

async function getContactPhone(deal) {
  if (deal && deal.CONTACT_ID) {
    try {
      const contact = await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID });
      const phones = Array.isArray(contact && contact.PHONE) ? contact.PHONE : [];
      const phone = phones[0] && phones[0].VALUE ? String(phones[0].VALUE).replace(/\D/g, '') : null;
      if (phone) return phone;
    } catch (_) {}
  }
  if (deal && deal.COMPANY_ID) {
    try {
      const company = await bitrixRestCall('crm.company.get', { id: deal.COMPANY_ID });
      const phones = Array.isArray(company && company.PHONE) ? company.PHONE : [];
      const phone = phones[0] && phones[0].VALUE ? String(phones[0].VALUE).replace(/\D/g, '') : null;
      if (phone) return phone;
    } catch (_) {}
  }
  return null;
}

async function getContactEmail(deal) {
  if (deal && deal.CONTACT_ID) {
    try {
      const contact = await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID });
      const emails = Array.isArray(contact && contact.EMAIL) ? contact.EMAIL : [];
      const email = emails[0] && emails[0].VALUE ? String(emails[0].VALUE).trim() : null;
      if (email) return email;
    } catch (_) {}
  }
  if (deal && deal.COMPANY_ID) {
    try {
      const company = await bitrixRestCall('crm.company.get', { id: deal.COMPANY_ID });
      const emails = Array.isArray(company && company.EMAIL) ? company.EMAIL : [];
      const email = emails[0] && emails[0].VALUE ? String(emails[0].VALUE).trim() : null;
      if (email) return email;
    } catch (_) {}
  }
  return null;
}

async function sendEmailThroughBitrix(dealId, responsibleId, contactId, toEmail, dealTitle, text) {
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
      COMPLETED: 'Y',
      COMMUNICATIONS: [{ VALUE: toEmail, ENTITY_ID: Number(contactId || 0), ENTITY_TYPE_ID: 3, TYPE: 'EMAIL' }],
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

async function createExpertFollowUpTask(dealId, expertId, expertName, clientMessage, docMessage, otherDealIds = [], reportComment = '') {
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
  const deadline = toMinskLocalIso(tomorrow);

  const petName = getDiminutiveName(expertName);
  const taskTitle = `${petName}, я отправил ход работы клиенту 📋`;
  const siblingsLine = otherDealIds && otherDealIds.length
    ? `\n\nПо этой компании сразу несколько сделок (${[dealId, ...otherDealIds].join(', ')}) — клиенту отправлено одно общее сообщение по всем услугам, но в каждой сделке свой комментарий и своя задача.`
    : '';
  // ✅ ИСПРАВЛЕНО: Упоминаем ТОЛЬКО эксперта, убираем менеджера
  const reportBlock = String(reportComment || '').trim()
    ? `

Мой отчёт по звонку и ходу работы:
${String(reportComment).trim()}`
    : '';
  const taskDesc = `${petName}, я отправил клиенту ход работы и перечень документов и записал всё в сделку.

Что сделал:
— проанализировал первый содержательный звонок;
— сформировал и отправил клиенту ход работы;
— зафиксировал недостающие документы и сроки;
— перевёл сделку на «Сбор информации».
${siblingsLine}${reportBlock}

Твой следующий шаг — проверить мой отчёт и дождаться документов клиента.`;

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


function buildNoCallTestWorkResult(deal, context, defaultDocDeadline) {
  const service = String((context && context.service) || detectServiceFromDeal(deal) || 'услуге').trim();
  const isAtt = /атт|аттестац/i.test(service);
  const isSpk = /спк|стк|свидетельств.*техн/i.test(service);
  const greeting = typeof actsMinskGreeting === 'function' ? actsMinskGreeting() : 'Добрый день!';
  let base;
  if (isAtt) {
    base = `${greeting}\n\nФиксируем дальнейший ход работы по ${service}.\n\nЧто делаем мы:\n1. Проверяем организацию и специалистов по требованиям аттестации.\n2. Проверяем образование, стаж, должности и действующие аттестаты специалистов.\n3. После получения полного комплекта документов определяем, чего не хватает и что необходимо дооформить.\n4. Готовим аттестационное дело и документы для подачи.\n5. Контролируем замечания и статус рассмотрения.\n\nСрок предоставления документов: до ${defaultDocDeadline}.`;
  } else if (isSpk) {
    base = `${greeting}\n\nФиксируем дальнейший ход работы по ${service}.\n\nЧто делаем мы:\n1. Проверяем специалистов и средства измерений.\n2. Проверяем комплектность документов.\n3. После получения полного комплекта готовим документы для подачи.\n4. Контролируем статус рассмотрения.\n\nСрок предоставления документов: до ${defaultDocDeadline}.`;
  } else {
    base = `${greeting}\n\nФиксируем дальнейший ход работы по ${service}.\n\nПосле получения полного комплекта документов мы их проверим, сообщим, чего не хватает, и подготовим дальнейшие действия.\n\nСрок предоставления документов: до ${defaultDocDeadline}.`;
  }
  return {
    call_qualified: true,
    call_reason: 'тестовый ход работы без звонка',
    deadline_mentioned: false,
    documents_due_date: null,
    client_message: base,
    comment: `Тестовый Ход работы сформирован без звонка, только по данным сделки.\nУслуга: ${service}.\nСрок предоставления документов: до ${defaultDocDeadline}.\nСледующий шаг: получить документы от клиента, проверить комплектность и продолжить работу по CJM.`,
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
    // v87: для тестового Бобика можно прогнать CJM без звонка вообще. Это ТОЛЬКО тестовый fallback.
    // Все остальные сделки по-прежнему требуют содержательный звонок >=60 сек.
    const testDeal = isCjmTestDeal(dealId);
    let callRecord = await findCallForDeal(dealId, {
      deal,
      assignedById: testDeal ? '' : deal.ASSIGNED_BY_ID,
      minDate: testDeal ? '' : deal.MOVED_TIME,
    });
    let noCallTestMode = false;
    if (!callRecord && testDeal && config.cjmTestAllowNoCall) {
      const stageStamp = String(deal.MOVED_TIME || deal.STAGE_ID || 'stage')
        .replace(/[^0-9A-Za-zА-Яа-я_-]+/g, '_')
        .slice(0, 80);
      callRecord = {
        activityId: `NO_CALL_${stageStamp || 'TEST'}`,
        durationSec: null,
        subject: 'CJM тест без звонка',
        url: '',
      };
      noCallTestMode = true;
      console.log(`${logPrefix} v87 TEST: звонка нет — для Бобика формирую стартовый Ход работы только из данных сделки и стандартного перечня документов.`);
    }
    if (!callRecord) {
      console.log(`${logPrefix} Запись звонка не найдена — пропускаю, попробую в следующем цикле.`);
      return;
    }
    if (testDeal && await autopilotTimelineHasMarker(dealId, `${AUTOPILOT_CALL_DONE_MARKER} activity=${callRecord.activityId}`, 500)) {
      console.log(`${logPrefix} Тестовый цикл activity=${callRecord.activityId} уже успешно использован — повторно не отправляю.`);
      autopilotProcessed.add(String(dealId));
      return;
    }

    // 2. Расшифровываем, если звонок есть. В no-call тесте ничего не выдумываем из несуществующего разговора.
    let transcript = '';
    if (!noCallTestMode) {
      console.log(`${logPrefix} Расшифровываю звонок: ${callRecord.subject || callRecord.url}`);
      const transcription = await transcribeCallBestEffort(callRecord, logPrefix);
      transcript = String(transcription.text || '').trim();
      if (!transcription.ready || transcriptLooksLikePlaceholder(transcript)) {
        console.warn(`${logPrefix} Запись звонка есть (${callRecord.durationSec ?? 'неизвестно'} сек), но качественная расшифровка ещё не получена. Повторю позже БЕЗ комментариев в CRM.`);
        return;
      }
      if (looksLikeCallbackOnlyTranscript(transcript)) {
        autopilotRejectedCallIds.add(`${dealId}:${callRecord.activityId}`);
        console.log(`${logPrefix} Звонок ${callRecord.activityId} похож на короткое служебное касание/просьбу перезвонить — ход работы не запускаю.`);
        return;
      }
      console.log(`${logPrefix} Первый звонок-кандидат: activity=${callRecord.activityId}, duration=${callRecord.durationSec ?? 'не определена'} сек, transcript=${transcript.length} символов.`);
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

    const nowForPrompt = new Date();
    const minskTodayIso = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(nowForPrompt);
    const defaultDeadlineDate = new Date(nowForPrompt.getTime() + 2 * 24 * 60 * 60 * 1000);
    const defaultDocDeadline = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Minsk', day: 'numeric', month: 'long'
    }).format(defaultDeadlineDate).replace(/\s*г\.?$/i, '');

    const systemPrompt = [
      'Ты ИИ-ассистент Игорь, помощник эксперта производства MAVIS GROUP.',
      noCallTestMode
        ? 'Это тестовый сценарий БЕЗ звонка. Сформируй стартовый ход работы только из полей сделки, комментариев и стандартного перечня документов. НЕ придумывай договорённости, ФИО, сроки или факты, которых нет в данных.'
        : 'Твоя задача — проверить, был ли это полноценный первый рабочий звонок, и только затем заполнить шаблон хода работы.',
      noCallTestMode
        ? 'В клиентском сообщении не пиши «по итогам разговора», «как договорились», «вы говорили» и другие ссылки на несуществующий звонок. Начинай нейтрально: «Фиксируем дальнейший ход работы...».'
        : 'call_qualified=false, если это только просьба перезвонить, автоответчик, ошибочный номер, разговор без обсуждения услуги/документов/следующих шагов.',
      noCallTestMode
        ? 'Для этого теста call_qualified=true. В comment явно отметь: «Тестовый Ход работы сформирован без звонка, только по данным сделки». '
        : 'Если длительность звонка известна и меньше 60 секунд — call_qualified=false.',
      'Шаблон уже задан в контексте. client_message — готовый ход работы для клиента с конкретными данными, без плейсхолдеров.',
      'comment — ПОЛНЫЙ отчёт эксперту: что известно, специалисты/роли, что уже есть, чего не хватает, сроки, риски и следующий шаг. Не ограничивайся 3-5 строками.',
      noCallTestMode
        ? 'Так как срока из звонка нет, используй ровно стандартный срок +2 календарных дня, который передан в prompt.'
        : 'Если эксперт не назвал срок предоставления документов, используй ровно стандартный срок +2 календарных дня, который передан в prompt.',
      'Верни только валидный JSON без markdown.',
    ].join('\n');
    
    const template = getClientMessageTemplate(detectServiceFromDeal(deal));
    
    const userPrompt = `${noCallTestMode ? `Звонка с клиентом нет. Это тестовый прогон сделки ${deal.TITLE}. Сформируй стартовый Ход работы по данным сделки.` : `Ты получил звонок от клиента ${context.contact.name || 'клиента'}. Заполни шаблон хода работы.`}

ШАБЛОН (заполни все плейсхолдеры):
${template}

ИНФОРМАЦИЯ ИЗ ЗВОНКА И СДЕЛКИ:
${JSON.stringify(context, null, 2).slice(0, 20000)}

СЕГОДНЯ ПО МИНСКУ: ${minskTodayIso}\nСТАНДАРТНЫЙ ДЕДЛАЙН ЕСЛИ ЭКСПЕРТ ЕГО НЕ НАЗВАЛ: ${defaultDocDeadline}

ИНСТРУКЦИИ ПО ЗАПОЛНЕНИЮ:

1. ИМЕНА:
   - Замени [Имя] на "${context.contact.name || 'клиента'}" (только имя, без компании)
   - Если имени нет — убери обращение, оставь просто текст

2. ДАТЫ (КРИТИЧНО!):
   - Если эксперт назвал конкретный срок — используй именно его
   - Если эксперт сказал "завтра", "в понедельник" и т.п. — переведи в конкретную дату
   - Если эксперт НЕ назвал срок документов — используй РОВНО стандартный дедлайн: ${defaultDocDeadline}
   - Не ставь диапазон 2-3 дня и не придумывай другой срок
   - Используй понятный формат: "до 23 августа" или "до 23.08.2026"

3. ДОКУМЕНТЫ И ДЕЙСТВИЯ:
   - Пиши только КОНКРЕТНЫЕ действия и документы по фактической ситуации клиента.
   - По каждому специалисту, если он обсуждался, укажи: что уже есть / что нужно сделать / какой документ нужен.
   - НЕ пиши фразы «иные документы из обязательного перечня», «остальные необходимые документы», «прочие документы».
   - Полный стандартный перечень документов система добавит в сообщение автоматически после твоего текста — не заменяй его общей фразой.
   - НЕ оставляй [что нужно] или другие плейсхолдеры — это ошибка!

4. ДАННЫЕ ИЗ СДЕЛКИ:
   - Замени [услуга] на: "${context.service}"
   - Замени [орган] / [компания] если есть в звонке

5. ФИНАЛЬНАЯ ПРОВЕРКА:
   - client_message НЕ должен содержать [ или ]
   - Все даты в 2026 году
   - Все ФИО и названия конкретные
   - Текст читается как готовое сообщение клиенту (можно копировать в Telegram/Viber)

6. КВАЛИФИКАЦИЯ:
   - Режим: ${noCallTestMode ? 'ТЕСТ БЕЗ ЗВОНКА' : 'звонок'}
   - Известная длительность: ${callRecord.durationSec ?? 'не определена'} сек
   - ${noCallTestMode ? 'Для теста поставь call_qualified=true и call_reason="тест без звонка"' : 'call_qualified=true только если это содержательный первый разговор по услуге, а не просьба перезвонить'}
   - call_reason — коротко объясни решение

7. comment: полный рабочий отчёт эксперту. Обязательно перечисли:
   - ${noCallTestMode ? 'что известно из сделки; НЕ пиши, что с клиентом о чём-то договорились' : 'что договорились с клиентом'};
   - специалисты/должности и кто кого закрывает, если обсуждалось;
   - какие документы уже есть и каких не хватает;
   - дедлайны;
   - следующий шаг и риск, если есть.

ВЕРНИ ТОЛЬКО JSON (без markdown, без \`\`\`):
{"call_qualified":true,"call_reason":"содержательный разговор","deadline_mentioned":true,"documents_due_date":"2026-08-23","client_message":"готовое сообщение БЕЗ плейсхолдеров","comment":"полный отчёт эксперту"}

documents_due_date — ОБЯЗАТЕЛЬНО дата в формате YYYY-MM-DD.
Если эксперт назвал срок — переведи его в конкретную дату.
Если срок не назван — укажи стандартный дедлайн +2 календарных дня, который дан выше.`;

    let aiResult = {};
    if (noCallTestMode) {
      // v88: тест Бобика БЕЗ звонка больше не зависит от ИИ-ответа.
      // Это делает тест детерминированным: сообщение строится из услуги + стандартного перечня документов.
      aiResult = buildNoCallTestWorkResult(deal, context, defaultDocDeadline);
      const deadlineDate = new Date(nowForPrompt.getTime() + 2 * 24 * 60 * 60 * 1000);
      aiResult.documents_due_date = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(deadlineDate);
      console.log(`${logPrefix} v88 TEST: Ход работы без звонка сформирован детерминированно, без вызова ИИ.`);
    } else {
      const rawText = await callAiChatCompletion({
        model: config.aiModel,
        temperature: 0.1,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      });
      try { aiResult = JSON.parse(rawText); } catch (_) {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) try { aiResult = JSON.parse(match[0]); } catch (_2) { aiResult = {}; }
      }
    }

    const callQualifiedRaw = aiResult.call_qualified;
    const callQualified = noCallTestMode || callQualifiedRaw === true
      || String(callQualifiedRaw || '').toLowerCase() === 'true'
      || (callQualifiedRaw === undefined && callRecord.durationSec !== null && Number(callRecord.durationSec) >= 60 && !looksLikeCallbackOnlyTranscript(transcript));
    if (!callQualified) {
      autopilotRejectedCallIds.add(`${dealId}:${callRecord.activityId}`);
      const reason = String(aiResult.call_reason || 'ИИ не подтвердил содержательный первый звонок').trim();
      console.log(`${logPrefix} Звонок ${callRecord.activityId} не подходит для запуска хода работы: ${reason}`);
      try {
        await addAutopilotCommentOnce(
          dealId,
          `${AUTOPILOT_CALL_REJECTED_MARKER} activity=${callRecord.activityId}`,
          `Игорь не запускал ход работы: ${reason}`
        );
      } catch (_) {}
      return;
    }

    const clientMessage = String(aiResult.client_message || '').trim();
    // v77: клиент ВСЕГДА получает конкретный стандартный перечень по продукту.
    // Размытые «иные/остальные документы» удаляем, а документы просим присылать только на почту MAVIS.
    const clientMessageWithEmail = clientMessage
      ? finalizeClientWorkMessage(clientMessage, context.document_list)
      : '';
    const documentMessage = ''; // объединено в client_message
    const dealComment = String(aiResult.comment || 'Автопилот выполнен').trim();
    const siblingNote = formatSiblingServicesNote(siblings);

    // 5. Отправляем ОДНО сообщение клиенту по предпочтительному каналу.
    // v77: при нескольких сделках одной компании клиент не должен получать один и тот же текст несколько раз.
    let sent = false;
    let sentChannel = '';
    if (clientMessageWithEmail) {
      const phone = await getContactPhone(deal);
      const email = await getContactEmail(deal);
      const preferredChannel = await detectPreferredChannelResolved(deal);
      if (!preferredChannel) {
        console.warn(`${logPrefix} Сообщение подготовлено, но не отправлено: поле «Предпочитаемый канал связи» не распознано.`);
      } else if (preferredChannel === 'email') {
        if (email) {
          try {
            await sendEmailThroughBitrix(dealId, deal.ASSIGNED_BY_ID, deal.CONTACT_ID, email, deal.TITLE, clientMessageWithEmail);
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

    // 6. Комментарий в текущую сделку.
    const channelLabel = { telegram: 'Telegram', viber: 'Viber', email: 'Email', default: 'мессенджер' };
    const sendStatus = clientMessageWithEmail
      ? (sent
        ? `✅ Сообщение клиенту отправлено через ${channelLabel[sentChannel] || sentChannel}.`
        : `⚠️ Сообщение подготовлено, но не удалось отправить. Сделку не двигаю, попробую повторно.`)
      : `⚠️ ИИ не сформировал готовое сообщение клиенту. Сделку не двигаю.`;

    // v77: «Эксперт назначен» → «Сбор информации» только после фактической успешной отправки.
    // Ошибка канала/контакта не должна считаться выполненным автопилотом.
    if (!clientMessageWithEmail || !sent) {
      if (clientMessageWithEmail) {
        try {
          const shouldCreate = await shouldCreateTaskAgain(dealId, 'не смог отправить ход работы клиенту', 4);
          if (shouldCreate) {
            await bitrixRestCall('tasks.task.add', {
              fields: {
                TITLE: `Игорь не смог отправить ход работы клиенту — ${deal.TITLE}`,
                DESCRIPTION: `Игорь подготовил ход работы, но не смог отправить его по выбранному каналу. Сделка оставлена на текущей стадии.\n\nТекст клиенту:\n${clientMessageWithEmail}\n\nОтчёт:\n${dealComment}`,
                RESPONSIBLE_ID: deal.ASSIGNED_BY_ID || config.executorExpertId,
                UF_CRM_TASK: [`D_${dealId}`],
                PRIORITY: 1,
              },
            });
          }
        } catch (_) {}
      }
      try {
        await addAutopilotCommentOnce(
          dealId,
          AUTOPILOT_SEND_PENDING_MARKER,
          `${sendStatus}\n\n${dealComment}${clientMessageWithEmail ? `\n\nПодготовлено клиенту:\n${clientMessageWithEmail}` : ''}`
        );
      } catch (_) {}
      console.warn(`${logPrefix} ${sendStatus}`);
      return;
    }

    const clientMsgForComment = `\n\n📨 Отправлено клиенту:\n${clientMessageWithEmail}${documentMessage ? '\n\n' + documentMessage : ''}`;
    const callDoneSuffix = testDeal ? `\n${AUTOPILOT_CALL_DONE_MARKER} activity=${callRecord.activityId}` : '';
    const commentText = `${AUTOPILOT_MARKER}${callDoneSuffix}${siblingNote}\n\n${sendStatus}\n\n📋 Ход работы / отчёт эксперту:\n${dealComment}${clientMsgForComment}`;
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
        await createExpertFollowUpTask(dealId, deal.ASSIGNED_BY_ID, mainExpertName, clientMessage, documentMessage, [], dealComment);
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
            await createExpertFollowUpTask(sibling.ID, sibling.ASSIGNED_BY_ID, siblingExpertName, clientMessage, documentMessage, otherIds, dealComment);
          } catch (_) {}
        }
      } catch (_) {}
    }

    console.log(`${logPrefix} Готово.${hasMultipleDeals ? ` Сопутствующие (комментарий+стадия+задача): ${siblings.map((s) => s.ID).join(', ')}.` : ''}`)

    // v78 / блок 3: регистрируем сделку для контроля документов.
    if (sent) {
      const companyName = await getCompanyName(deal.COMPANY_ID) || deal.TITLE;
      const sentAt = new Date();
      const dueAt = resolveDocumentsDueAt(aiResult.documents_due_date, sentAt);
      const serviceResolved = await resolveDealServiceName(deal);
      const preferredForTrack = await detectPreferredChannelResolved(deal);
      const trackInfo = {
        sentAt,
        dueAt,
        companyName,
        service: serviceResolved || detectServiceFromDeal(deal),
        preferredChannel: preferredForTrack || '',
      };
      pendingDocsCheck.set(String(dealId), trackInfo);
      await persistDocsWaitStart(dealId, trackInfo).catch((e) =>
        console.warn(`${logPrefix} Не записал маркер ожидания документов: ${e.message || e}`)
      );
      console.log(`${logPrefix} Сделка добавлена в контроль документов: due=${toMinskLocalIso(dueAt)}, channel=${trackInfo.preferredChannel || 'не распознан'}.`);
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
    if (config.autopilotTimelineDiagnostics) {
      try {
        const fingerprint = String(err && err.message || 'unknown').toLowerCase().replace(/[^a-zа-я0-9]+/gi, '-').slice(0, 60);
        await addAutopilotCommentOnce(
          dealId,
          `${AUTOPILOT_ERROR_MARKER} code=${fingerprint}`,
          `Автопилот Игорь столкнулся с ошибкой: ${err.message}`
        );
      } catch (_) {}
    }
    // v79: retry later, but never spam CRM.
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
const DOCS_REMINDER_ERROR_MARKER = '[MAVIS_DOCS_REMINDER_ERROR]';
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

    // v78: входящие Email/Viber/Telegram отмечаются устойчивым маркером в таймлайне.
    const companyName = trackInfo.companyName || deal.TITLE;
    const docsArrived = await hasClientDocsReceivedAfter(dealId, trackInfo.sentAt);
    if (docsArrived) {
      console.log(`${logPrefix} После старта ожидания уже пришли документы — первый пуш не нужен.`);
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

    if (analysis.action === 'send_reminder') {
      // v78: строго выбранный клиентом канал, без fallback на другой мессенджер.
      const serviceResolved = await resolveDealServiceName(deal);
      const reminderText = finalizeDocsReminderMessage(
        analysis.client_message,
        getDocumentListForService(serviceResolved || detectServiceFromDeal(deal))
      );
      const sentResult = await sendClientTextByPreferredChannel(deal, reminderText, `Напоминание по документам: ${deal.TITLE}`);
      const sent = !!sentResult.ok;
      if (sent) console.log(`${logPrefix} Напоминание отправлено через ${sentResult.channel}.`);
      else console.warn(`${logPrefix} Напоминание не отправлено: ${sentResult.error || 'неизвестная ошибка'}.`);

      // Эскалация эксперту/руководителю относится к следующему блоку CJM.
      await bitrixRestCall('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId, ENTITY_TYPE: 'deal',
          COMMENT: `${sent ? DOCS_REMINDER_MARKER : DOCS_REMINDER_ERROR_MARKER}\nat=${new Date().toISOString()}\ndue=${new Date(trackInfo.dueAt || Date.now()).toISOString()}\nИгорь: ${sent ? 'отправил первое напоминание клиенту про документы' : `не удалось отправить первое напоминание клиенту: ${sentResult.error || 'ошибка канала'}`} (${analysis.situation})`,
        },
      });
      // Если канал временно не сработал — оставляем сделку в pending и повторим в следующем цикле.
      if (!sent) return;

    } else if (analysis.action === 'send_specialist_task') {
      // Если ИИ видит, что вопрос не в документах, а в отсутствии специалистов,
      // в блоке 3 не создаём параллельную задачу: этим занимается отдельный блок «Подбор».
      await bitrixRestCall('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId,
          ENTITY_TYPE: 'deal',
          COMMENT: `${DOCS_REMINDER_MARKER}\nat=${new Date().toISOString()}\nИгорь: первый пуш по документам не отправлял — по контексту сначала нужно закрыть вопрос со специалистами. Контроль подбора идёт отдельным сценарием.`,
        },
      });

    } else if (analysis.action === 'send_comment' && analysis.comment) {
      await bitrixRestCall('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId, ENTITY_TYPE: 'deal',
          COMMENT: `${DOCS_REMINDER_MARKER}\nat=${new Date().toISOString()}\nИгорь: первый пуш не отправлял после анализа контекста. ${analysis.comment}`,
        },
      });

    } else {
      console.log(`${logPrefix} Действие не требуется: ${analysis.reason}`);
      await bitrixRestCall('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: dealId, ENTITY_TYPE: 'deal',
          COMMENT: `${DOCS_REMINDER_MARKER}\nat=${new Date().toISOString()}\nИгорь: первый контроль дедлайна выполнен, клиентский пуш не требуется. Причина: ${analysis.reason || 'по контексту сделки'}.`,
        },
      }).catch(() => {});
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

    const now = new Date();
    const testMinutes = isCjmTestDeal(dealId) ? 2 : Math.max(0, Number(config.docsReminderTestMinutes || 0));
    const dueAt = testMinutes > 0
      ? new Date(new Date(trackInfo.sentAt).getTime() + testMinutes * 60000)
      : new Date(trackInfo.dueAt || resolveDocumentsDueAt('', trackInfo.sentAt));
    if (now >= dueAt && (testMinutes > 0 || isWorkingHour(now))) {
      await runDocsReminderForDeal(dealId, { ...trackInfo, dueAt });
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
      const testMinutes = Math.max(0, Number(config.firstCallTestMinutes || 0));
      const due = testMinutes > 0
        ? ((now.getTime() - movedAt.getTime()) / 60000 >= testMinutes)
        : (workingHoursBetween(movedAt, now) >= 4);
      if (!due) continue;
      const marker = '[MAVIS_FIRST_CALL_REMINDER]';
      const already = await isStageEventProcessed(deal.ID, 'first_call', marker);
      if (already) continue;
      if (!testMinutes && !isWorkingHour(now)) continue;

      const hasCall = await hasQualifiedFirstContact(deal);
      if (hasCall) {
        stageEventProcessed.set(stageEventKey(deal.ID, 'first_call'), true);
        continue;
      }
      // Ставим задачу эксперту.
      const u = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
      const user = Array.isArray(u) ? u[0] : u;
      const expertName = user ? `${user.NAME || ''}`.trim() : '';
      const petName = getDiminutiveName(expertName);
      const deadline = addWorkingDays(now, 0);
      deadline.setHours(18, 0, 0, 0);
      await bitrixRestCall('tasks.task.add', {
        fields: {
          TITLE: `${petName}, позвони клиенту — нет первого содержательного касания`,
          DESCRIPTION: `${petName}, по сделке "${deal.TITLE}" ещё нет первого содержательного звонка после назначения эксперта${testMinutes ? ` (тестовый порог ${testMinutes} мин)` : ' за 4+ рабочих часа'}.\n\nКороткий звонок/просьба перезвонить не закрывает контроль. Нужен полноценный разговор по услуге и следующим шагам.`,
          RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
          DEADLINE: toMinskLocalIso(deadline),
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


// ============================================================================
// v85: CJM БЛОК 5 — «Сбор информации»: 3 дня клиенту / 7 дней руководителю
// Новый сценарий работает отдельно от legacy 5/10-дневного мониторинга.
// ============================================================================

const COLLECTION_3D_TEXT = 'ИИгорь — контроль сбора информации: 3 дня.';
const COLLECTION_7D_TEXT = 'ИИгорь — контроль сбора информации: 7 дней.';

async function timelineHasHumanSignature(dealId, signature, limit = 120) {
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID','COMMENT','DATE_CREATE','CREATED'],
      order: { ID: 'DESC' },
    }, limit);
    return comments.some((c) => String(c.COMMENT || '').includes(signature));
  } catch (_) {
    return false;
  }
}

async function clientDocsLatestStateWithTime(dealId) {
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID','COMMENT','DATE_CREATE','CREATED'],
      order: { ID: 'DESC' },
    }, 120);
    for (const c of comments) {
      const text = String(c.COMMENT || '');
      if (!text.includes(CLIENT_DOCS_STATE_MARKER)) continue;
      const obj = clientDocsParseMarkerJson(text, CLIENT_DOCS_STATE_MARKER);
      if (!obj) continue;
      const at = new Date(obj.at || c.DATE_CREATE || c.CREATED || 0);
      return { state: obj, at: Number.isNaN(at.getTime()) ? null : at };
    }
  } catch (_) {}
  return { state: { docs: [], complete: false, missing: [] }, at: null };
}

function elapsedDaysExact(from, to = new Date()) {
  const a = new Date(from || 0).getTime();
  const b = new Date(to || 0).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / 86400000;
}

function buildCollectionClientReminder(service, missing) {
  const docList = getDocumentListForService(service);
  const fallback = clientDocsRequiredDocs(docList);
  const concrete = (Array.isArray(missing) && missing.length ? missing : fallback)
    .map((x) => String(x || '').trim()).filter(Boolean);
  return [
    actsMinskGreeting(),
    '',
    'Напоминаем по документам для продолжения работы.',
    '',
    'Сейчас необходимо предоставить:',
    ...concrete.slice(0, 25).map((x) => `• ${x}`),
    '',
    'Документы, пожалуйста, направляйте на нашу почту: mavis.group@mail.ru',
  ].join('\n').trim();
}

async function checkCollectionCjmBlock5() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled || !config.collectionControlEnabled) return;
  const prepStageId = getPreparationStageId();
  if (!prepStageId || !isWorkingHour(new Date())) return;

  try {
    const fields = await discoverSelectionFieldsV85();
    const select = ['ID','TITLE','ASSIGNED_BY_ID','MOVED_TIME','COMPANY_ID','CONTACT_ID',
      config.serviceFieldCode || process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071',
      ...selectionFieldCodesV85(fields),
      ...preferredContactFieldCandidates(),
    ];
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: prepStageId },
      select: [...new Set(select.filter(Boolean))],
      order: { MOVED_TIME: 'ASC' },
    }, 200);

    const now = new Date();
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) continue;
      const service = await resolveDealServiceName(deal);
      if (!clientDocsTargetService(service)) continue;

      const movedAt = new Date(deal.MOVED_TIME || deal.DATE_MODIFY || 0);
      if (Number.isNaN(movedAt.getTime())) continue;
      const { state, at: lastDocsAt } = await clientDocsLatestStateWithTime(deal.ID);
      if (state && state.complete === true) continue;

      const selection = await getSelectionContextV85(deal, fields);
      const waitingBase = lastDocsAt && lastDocsAt > movedAt ? lastDocsAt : movedAt;
      const stageDays = elapsedDaysExact(movedAt, now);
      const waitDays = elapsedDaysExact(waitingBase, now);
      const testDeal = isCjmTestDeal(deal.ID);
      const testMin = testDeal ? 5 : Math.max(0, Number(config.collectionTestMinutes || 0));
      const waitMinutes = (now - waitingBase) / 60000;
      const stageMinutes = (now - movedAt) / 60000;
      const reminderDue = testMin > 0 ? waitMinutes >= testMin : waitDays >= Number(config.collectionReminderDays || 3);
      const leaderDue = testMin > 0 ? stageMinutes >= (testDeal ? 8 : testMin * 2) : stageDays >= Number(config.collectionLeaderDays || 7);

      if (reminderDue && !(await timelineHasHumanSignature(deal.ID, COLLECTION_3D_TEXT))) {
        if (selection.need && ['mavis','client','contractor'].includes(selection.mode)) {
          const modeText = selection.mode === 'mavis' ? 'подбор выполняет Mavis' : selection.mode === 'client' ? 'специалиста ищет клиент' : 'подбор через подрядчика';
          await bitrixRestCall('crm.timeline.comment.add', { fields: {
            ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal',
            COMMENT: `${COLLECTION_3D_TEXT}\nКлиентский пуш по документам не отправлялся: сейчас работа зависит от подбора специалиста (${modeText}${selection.who ? `; ищем: ${selection.who}` : ''}).`,
          }}).catch(() => {});
        } else {
          const reminder = buildCollectionClientReminder(service, state && state.missing);
          const sent = await sendClientTextByPreferredChannel(deal, reminder, `Напоминание по документам: ${deal.TITLE}`).catch((e) => ({ ok:false, error:e.message || String(e) }));
          if (sent.ok) {
            const missing = Array.isArray(state && state.missing) && state.missing.length
              ? state.missing.map((x) => `— ${x}`).join('\n')
              : clientDocsRequiredDocs(getDocumentListForService(service)).map((x) => `— ${x}`).join('\n');
            await bitrixRestCall('crm.timeline.comment.add', { fields: {
              ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal',
              COMMENT: `${COLLECTION_3D_TEXT}\nКлиенту отправлено напоминание через ${sent.channel}.\n\nНе хватает:\n${missing}`,
            }}).catch(() => {});
          } else {
            console.warn(`[collection-v85] deal=${deal.ID}: 3 дня, но пуш не отправлен: ${sent.error || 'ошибка канала'}`);
          }
        }
      }

      if (leaderDue && !(await timelineHasHumanSignature(deal.ID, COLLECTION_7D_TEXT))) {
        const user = await getDistributionUserProfile(deal.ASSIGNED_BY_ID);
        const expertName = user ? `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim() : `ID ${deal.ASSIGNED_BY_ID || '?'}`;
        const received = Array.isArray(state && state.docs) ? state.docs.map((d) => `${d.documentType || 'документ'}${d.person ? ` — ${d.person}` : ''}`) : [];
        const missing = Array.isArray(state && state.missing) && state.missing.length ? state.missing : clientDocsRequiredDocs(getDocumentListForService(service));
        const reason = selection.need
          ? `подбор специалиста: ${selection.mode === 'mavis' ? 'Mavis' : selection.mode === 'client' ? 'клиент самостоятельно' : selection.mode || 'не определено'}${selection.who ? `; ищем ${selection.who}` : ''}`
          : (missing.length ? 'не собран полный комплект документов' : 'причина требует проверки экспертом');
        const msg = [
          'Сделка зависла на «Сбор информации» 7 дней.',
          '',
          `Компания: ${deal.TITLE}`,
          `Эксперт: ${expertName}`,
          `Услуга: ${service}`,
          `Причина: ${reason}`,
          '',
          'Получено:',
          ...(received.length ? received.slice(0,20).map((x) => `— ${x}`) : ['— пока ничего не зафиксировано']),
          '',
          'Не хватает:',
          ...(missing.length ? missing.slice(0,25).map((x) => `— ${x}`) : ['— требуется ручная проверка']),
          '',
          `Сделка: https://mavisgroup.bitrix24.by/crm/deal/details/${deal.ID}/`,
        ].join('\n');
        await bitrixRestCall('im.message.add', { DIALOG_ID: config.clientDocsLeaderId || TANYA_USER_ID, MESSAGE: msg }).catch(() => {});
        await bitrixRestCall('crm.timeline.comment.add', { fields: {
          ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal',
          COMMENT: `${COLLECTION_7D_TEXT}\nРуководитель уведомлён. Причина: ${reason}.`,
        }}).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[collection-v85] Ошибка блока 5:', e.message || e);
  }
}

// ============================================================================
// v85: CJM БЛОК 6 — «Подбор»: кто ищет + актуальная воронка Прорабы
// ============================================================================

let selectionFieldsV85Cache = null;

function selectionFieldLabelV85(f) {
  return [f && f.EDIT_FORM_LABEL, f && f.LIST_COLUMN_LABEL, f && f.LIST_FILTER_LABEL, f && f.FIELD_NAME]
    .filter(Boolean).join(' ');
}

async function discoverSelectionFieldsV85() {
  if (selectionFieldsV85Cache) return selectionFieldsV85Cache;
  let all = [];
  try { all = await bitrixRestList('crm.deal.userfield.list', {}, 500); } catch (_) {}
  const by = (rx, fallback) => {
    const f = all.find((x) => rx.test(normalizeControlValue(selectionFieldLabelV85(x))));
    if (f) return f;
    return all.find((x) => String(x.FIELD_NAME || '') === fallback) || { FIELD_NAME: fallback, LIST: [] };
  };
  selectionFieldsV85Cache = {
    need: by(/нужен.*подбор|подбор.*нужен/, FIELD_NEEDS_SELECTION),
    mode: by(/способ.*подбор|силами.*кого|кто.*ищет|подбор.*(mavis|мавис|самостоятель)/, FIELD_MAVIS_SELECTION),
    who: by(/кого.*(ищ|подбира)|специалист.*подбор/, FIELD_WHO_WE_SEARCH),
  };
  console.log(`[selection-v85] Поля: нужен=${selectionFieldsV85Cache.need.FIELD_NAME}; способ=${selectionFieldsV85Cache.mode.FIELD_NAME}; кого=${selectionFieldsV85Cache.who.FIELD_NAME}.`);
  return selectionFieldsV85Cache;
}

function selectionFieldCodesV85(fields) {
  return [
    fields && fields.need && fields.need.FIELD_NAME,
    fields && fields.mode && fields.mode.FIELD_NAME,
    fields && fields.who && fields.who.FIELD_NAME,
    FIELD_NEEDS_SELECTION, FIELD_MAVIS_SELECTION, FIELD_WHO_WE_SEARCH,
  ].filter(Boolean);
}

function decodeSelectionFieldV85(meta, raw) {
  const values = Array.isArray(raw) ? raw : [raw];
  const list = Array.isArray(meta && (meta.LIST || meta.list)) ? (meta.LIST || meta.list) : [];
  const map = new Map(list.map((x) => [String(x.ID || x.id || ''), String(x.VALUE || x.value || '')]));
  return values.map((v) => map.get(String(v)) || String(v || '')).filter(Boolean).join(' ').trim();
}

async function getSelectionContextV85(deal, fields = null) {
  fields = fields || await discoverSelectionFieldsV85();
  const needRaw = deal[fields.need.FIELD_NAME] ?? deal[FIELD_NEEDS_SELECTION];
  const modeRaw = deal[fields.mode.FIELD_NAME] ?? deal[FIELD_MAVIS_SELECTION];
  const whoRaw = deal[fields.who.FIELD_NAME] ?? deal[FIELD_WHO_WE_SEARCH];
  const needText = normalizeControlValue(decodeSelectionFieldV85(fields.need, needRaw));
  const modeText = normalizeControlValue(decodeSelectionFieldV85(fields.mode, modeRaw));
  const who = decodeSelectionFieldV85(fields.who, whoRaw) || String(whoRaw || '').trim();
  const need = !!needText && !/(^|\s)(нет|no|false|0)(\s|$)/.test(needText) && /(да|yes|true|1|нуж|подбор)/.test(needText);
  let mode = null;
  if (/(mavis|мавис|наш|силами компании|мы ищ)/.test(modeText)) mode = 'mavis';
  else if (/(самостоятель|клиент|сами|своими силами)/.test(modeText)) mode = 'client';
  else if (/(подрядчик|виалми)/.test(modeText)) mode = 'contractor';
  // fallback старого boolean «Подбор наш (Mavis)».
  if (!mode && (String(modeRaw).toLowerCase() === 'да' || modeRaw === true || String(modeRaw) === '1')) mode = 'mavis';
  return { need, mode, who, needText, modeText };
}

async function resolveSelectionStageV85() {
  try {
    const stages = await bitrixRestCall('crm.dealcategory.stage.list', { id: config.autopilotCategoryId || 28 });
    const list = Array.isArray(stages) ? stages : [];
    const found = list.find((x) => /(^|\s)подбор(\s|$)/i.test(String(x.NAME || x.TITLE || '')));
    if (found) return String(found.STATUS_ID || found.ID || '');
  } catch (_) {}
  return STAGE_IDS.selection;
}

async function findForemanCandidatesV85(request, limit = 5) {
  const cfg = fgForemanCfg();
  const { rows } = await fgLoadForemen(cfg);
  const free = rows.filter((f) => String(f.STAGE_ID) === String(cfg.stageFree) && !fgForemanIsExpiring(f, cfg));
  const normalized = fgNormalize(request || '');
  const works = fgDetectWorks(normalized);
  let matched = free.filter((f) => {
    const field = fgNormWorkType(f[cfg.fieldWorkType]);
    if (works.length) return works.some((w) => field.includes(w) || w.includes(field));
    if (!normalized || !field) return false;
    const tokens = normalized.split(/\s+/).filter((x) => x.length >= 4);
    return tokens.some((t) => field.includes(t));
  });
  return matched.slice(0, limit);
}

async function createSelectionExpertTaskV85(deal, title, description) {
  const dl = addWorkingDays(new Date(), 1); dl.setHours(18,0,0,0);
  return bitrixRestCall('tasks.task.add', { fields: {
    TITLE: title,
    DESCRIPTION: description,
    RESPONSIBLE_ID: deal.ASSIGNED_BY_ID,
    DEADLINE: toMinskLocalIso(dl),
    UF_CRM_TASK: [`D_${deal.ID}`],
    PRIORITY: 1,
  }});
}

async function checkSelectionCjmBlock6() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled || !config.selectionControlEnabled) return;
  if (!isWorkingHour(new Date())) return;
  const stageId = await resolveSelectionStageV85();
  if (!stageId) return;
  try {
    const fields = await discoverSelectionFieldsV85();
    const deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: stageId },
      select: [...new Set(['ID','TITLE','ASSIGNED_BY_ID','MOVED_TIME','COMPANY_ID', ...selectionFieldCodesV85(fields)])],
      order: { MOVED_TIME: 'ASC' },
    }, 200);
    const now = new Date();
    for (const deal of deals) {
      if (await isDealAiDisabledAsync(deal)) continue;
      const ctx = await getSelectionContextV85(deal, fields);
      if (!ctx.need || !ctx.mode) continue;
      const movedAt = new Date(deal.MOVED_TIME || 0);
      if (Number.isNaN(movedAt.getTime())) continue;
      const elapsedDays = elapsedDaysExact(movedAt, now);
      const testDeal = isCjmTestDeal(deal.ID);
      const testMin = testDeal ? 2 : Math.max(0, Number(config.selectionTestMinutes || 0));
      const elapsedMinutes = (now - movedAt) / 60000;
      const everyDays = Math.max(1, Number(config.selectionExpertEveryDays || 7));
      const cycle = testMin > 0 ? Math.floor(elapsedMinutes / testMin) : Math.floor(elapsedDays / everyDays);
      const dueExpert = testMin > 0 ? elapsedMinutes >= testMin : elapsedDays >= everyDays;
      const dueLeader = testMin > 0 ? elapsedMinutes >= (testDeal ? 4 : testMin * 2) : elapsedDays >= Number(config.selectionLeaderDays || 14);
      const humanCycle = Math.max(1, cycle);
      const signature = `ИИгорь — контроль подбора: период ${humanCycle}.`;

      if (dueExpert && !(await timelineHasHumanSignature(deal.ID, signature))) {
        const user = await getDistributionUserProfile(deal.ASSIGNED_BY_ID);
        const expertName = user ? (user.NAME || '').trim() : 'Эксперт';
        if (ctx.mode === 'client') {
          await createSelectionExpertTaskV85(
            deal,
            `${expertName}, уточни нашли ли людей — ${ctx.who || 'специалист'}`,
            `Клиент по сделке «${deal.TITLE}» ищет специалиста самостоятельно.\n\nКого ищут: ${ctx.who || 'не указано'}.\n\nУточни у клиента, нашли ли человека и можем ли двигаться дальше по аттестации.\n\nСделка: https://mavisgroup.bitrix24.by/crm/deal/details/${deal.ID}/`
          );
          await bitrixRestCall('crm.timeline.comment.add', { fields: {
            ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal',
            COMMENT: `${signature}\nЭксперту поставлена задача уточнить статус самостоятельного подбора: ${ctx.who || 'специалист'}.`,
          }}).catch(() => {});
        } else if (ctx.mode === 'mavis') {
          const candidates = await findForemanCandidatesV85(ctx.who, 5);
          const candidateText = candidates.length
            ? candidates.map((f,i) => `${i+1}. ${fgForemanCandidateText(f, fgForemanCfg())}`).join('\n')
            : 'Сейчас в воронке «Прорабы» подходящих свободных кандидатов не найдено.';
          await createSelectionExpertTaskV85(
            deal,
            `${expertName}, актуальные кандидаты по подбору — ${ctx.who || 'специалист'}`,
            `По сделке «${deal.TITLE}» подбор выполняет Mavis.\n\nКого ищем: ${ctx.who || 'не указано'}.\n\n${candidateText}\n\nПроверь кандидатов и обнови статус подбора в сделке.\n\nСделка: https://mavisgroup.bitrix24.by/crm/deal/details/${deal.ID}/`
          );
          await bitrixRestCall('crm.timeline.comment.add', { fields: {
            ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal',
            COMMENT: `${signature}\nЭксперту отправлена актуальная подборка по запросу «${ctx.who || 'специалист'}». Найдено кандидатов: ${candidates.length}.`,
          }}).catch(() => {});
        } else {
          await createSelectionExpertTaskV85(
            deal,
            `${expertName}, проверь статус подбора — ${ctx.who || 'специалист'}`,
            `По сделке «${deal.TITLE}» способ подбора указан как «подрядчик».\nКого ищем: ${ctx.who || 'не указано'}.\nПроверь текущий статус и зафиксируй результат в сделке.`
          );
          await bitrixRestCall('crm.timeline.comment.add', { fields: {
            ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${signature}\nЭксперту поставлена задача проверить статус подбора через подрядчика.`,
          }}).catch(() => {});
        }
      }

      const leaderSignature = 'ИИгорь — контроль подбора: 14 дней.';
      if (dueLeader && !(await timelineHasHumanSignature(deal.ID, leaderSignature))) {
        let candidateSummary = '';
        if (ctx.mode === 'mavis') {
          const candidates = await findForemanCandidatesV85(ctx.who, 5);
          candidateSummary = candidates.length
            ? `\n\nСейчас в базе есть кандидаты:\n${candidates.map((f) => `— ${fgForemanCandidateText(f, fgForemanCfg())}`).join('\n')}`
            : '\n\nСейчас подходящих свободных кандидатов в воронке «Прорабы» не найдено.';
        }
        const user = await getDistributionUserProfile(deal.ASSIGNED_BY_ID);
        const expertName = user ? `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim() : `ID ${deal.ASSIGNED_BY_ID || '?'}`;
        const modeText = ctx.mode === 'mavis' ? 'подбор Mavis' : ctx.mode === 'client' ? 'клиент ищет самостоятельно' : 'подрядчик';
        const msg = `Подбор длится 14 дней.\n\nКомпания: ${deal.TITLE}\nЭксперт: ${expertName}\nКого ищем: ${ctx.who || 'не указано'}\nСпособ: ${modeText}${candidateSummary}\n\nСделка: https://mavisgroup.bitrix24.by/crm/deal/details/${deal.ID}/`;
        await bitrixRestCall('im.message.add', { DIALOG_ID: TANYA_USER_ID, MESSAGE: msg }).catch(() => {});
        await bitrixRestCall('crm.timeline.comment.add', { fields: {
          ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${leaderSignature}\nРуководитель уведомлён о затянувшемся подборе: ${ctx.who || 'специалист'}.`,
        }}).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[selection-v85] Ошибка блока 6:', e.message || e);
  }
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
  if (!config.collectionControlEnabled) await checkCollectionStageStuck();
  if (!config.selectionControlEnabled) await checkSelectionStage();
  await checkDocsReadyStage();
  await checkWonStage();
  await checkRefundStage();
}


async function runAutopilotPollingCycle() {
  if (autopilotCycleRunning) {
    console.log('[autopilot] Предыдущий polling ещё выполняется — новый цикл пропускаю (anti-overlap).');
    return;
  }
  if (!config.bitrixWebhookUrl) {
    console.log('[autopilot] BITRIX_WEBHOOK_URL не задан — фоновый автопилот не запускается.');
    return;
  }
  if (!config.autopilotEnabled) {
    return; // AUTOPILOT_ENABLED=false — выключен
  }

  autopilotCycleRunning = true;
  try {
    const stageIds = await getAutopilotStageIds();
    if (!stageIds.length) {
      console.warn('[autopilot] Стадии не найдены в воронке — проверь AUTOPILOT_CATEGORY_ID.');
      return;
    }

    // v89: тестовую сделку CJM обрабатываем ПЕРВОЙ и напрямую по ID,
    // ДО обхода всей очереди. Ранее она могла вообще не попасть в первые 50
    // сделок стадии или ждать, пока STT на других сделках отработает все retry.
    const preprocessedIds = new Set();
    if (config.cjmTestMode && config.cjmTestDealId) {
      try {
        const testDealRaw = await bitrixRestCall('crm.deal.get', { id: config.cjmTestDealId });
        const testDeal = testDealRaw && (testDealRaw.result || testDealRaw);
        if (!testDeal || !testDeal.ID) {
          console.warn(`[autopilot-test] Сделка ${config.cjmTestDealId} не найдена через crm.deal.get.`);
        } else if (Number(testDeal.CATEGORY_ID || 0) !== Number(config.autopilotCategoryId || 28)) {
          console.warn(`[autopilot-test] Сделка ${testDeal.ID} не в Производстве: CATEGORY_ID=${testDeal.CATEGORY_ID}.`);
        } else if (!stageIds.includes(String(testDeal.STAGE_ID || ''))) {
          console.warn(`[autopilot-test] Сделка ${testDeal.ID} сейчас на стадии ${testDeal.STAGE_ID}, а Ход работы запускается на [${stageIds.join(', ')}].`);
        } else {
          console.log(`[autopilot-test] ПРИОРИТЕТ: напрямую запускаю CJM для сделки ${testDeal.ID} "${testDeal.TITLE || ''}", stage=${testDeal.STAGE_ID}.`);
          // Для тестовой сделки старые in-memory DONE не блокируют новый прогон.
          autopilotProcessed.delete(String(testDeal.ID));
          await runServerAutopilotForDeal(testDeal, testDeal.STAGE_ID);
          preprocessedIds.add(String(testDeal.ID));
        }
      } catch (testErr) {
        console.error(`[autopilot-test] Не удалось приоритетно обработать сделку ${config.cjmTestDealId}: ${testErr.message || testErr}`);
      }
    }

    // v80: работаем по ВСЕМ подходящим сделкам Производства.
    // EXECUTOR_TEST_DEAL_ID / LIVE_CHAT_TEST_DEAL_ID больше не ограничивают фоновый автопилот.
    // Единственный общий аварийный выключатель — AUTOPILOT_ENABLED=false.
    console.log('[autopilot] v89: массовый режим — после приоритетного CJM-теста обхожу все сделки на целевых стадиях.');

    // Собираем сделки по каждой стадии отдельно (Bitrix не поддерживает массив в STAGE_ID фильтре).
    const allDeals = [];
    const seenIds = new Set();
    for (const stageId of stageIds) {
      const filter = {
        CATEGORY_ID: config.autopilotCategoryId || 28,
        STAGE_ID: stageId,
      };

      const deals = await bitrixRestList('crm.deal.list', {
        filter,
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

    // v88: тестовую сделку ставим первой, чтобы она не ждала обработки десятков боевых сделок.
    if (config.cjmTestMode && config.cjmTestDealId) {
      allDeals.sort((a, b) => {
        const aa = String(a.ID) === String(config.cjmTestDealId) ? 0 : 1;
        const bb = String(b.ID) === String(config.cjmTestDealId) ? 0 : 1;
        return aa - bb;
      });
    }
    console.log(`[autopilot] Цикл: найдено ${allDeals.length} сделок на стадиях [${stageIds.join(', ')}] по всей воронке Производства; testFirst=${config.cjmTestDealId || 'none'}.`);

    for (const deal of allDeals) {
      if (preprocessedIds.has(String(deal.ID))) continue;
      if (autopilotProcessed.has(String(deal.ID))) continue;
      const alreadyDone = await dealAlreadyProcessed(deal.ID);
      if (alreadyDone) continue;
      // Передаём первую стадию (Эксперт назначен) как эталон для поиска сопутствующих сделок.
      await runServerAutopilotForDeal(deal, deal.STAGE_ID);
      await new Promise((r) => setTimeout(r, 800));
    }

    // Проверяем ожидающие задачи-триггеры Этапа 4 (эксперт поставил галочку).
    if (pendingAttStage4Tasks.size > 0) {
      await checkPendingAttStage4Tasks();
    }

    // Проверяем сделки ожидающие контроля документов (Этап 5).
    if (pendingDocsCheck.size > 0) {
      await checkPendingDocsReminders();
    }

    // v85: согласованные CJM блоки 5–6 работают отдельно от старого общего мониторинга.
    if (config.collectionControlEnabled) await checkCollectionCjmBlock5();
    if (config.selectionControlEnabled) await checkSelectionCjmBlock6();

    // v44: остальные старые сценарии стадий пока только по отдельному флагу.
    if (config.stageMonitoringEnabled) await runStageMonitoring();

    // Проверяем нераспределённые сделки — уведомляем Таню если висят 4+ рабочих часа.
    await checkUnassignedDeals();
  } catch (err) {
    console.error('[autopilot] Ошибка polling-цикла:', err.message || err);
  } finally {
    autopilotCycleRunning = false;
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
  const siblingDeals = (config.foremanPropagateToCompanyDeals && config.foremanAllowPropagation)
    ? await fgFindActiveCompanyDeals(deal.COMPANY_ID, cfg, deal.ID)
    : [];
  if (config.foremanPropagateToCompanyDeals && !config.foremanAllowPropagation) {
    summary.skipped.push('Массовое распространение прораба по соседним сделкам отключено защитой v79.');
  }

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
const ACTS_TASK_SENT_MARKER = '[MAVIS_ACTS_SENT]';
const ACTS_TASK_SEND_FAILED_MARKER = '[MAVIS_ACTS_SEND_FAILED]';

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
  const taskId = String(actsTaskField(task, ['id','ID']) || '').trim();
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
  const addFile = (file) => {
    if (!file) return;
    const name = actsCleanText(file.name || '');
    const id = String(file.id || '');
    const url = String(file.url || '');
    const key = `${id}:${name}:${url}`;
    if (seenFile.has(key)) return;
    seenFile.add(key);
    files.push({ ...file, id, name: name || (id ? `файл ${id}` : 'файл'), url });
  };

  const diskErrors = [];
  async function resolveDiskFile(id, source, date = '') {
    let firstError = '';
    try {
      const attached = await bitrixRestCall('disk.attachedObject.get', { id });
      const obj = attached && (attached.object || attached.OBJECT || attached);
      const fileId = obj && (obj.ID || obj.id || obj.OBJECT_ID || obj.objectId);
      const name = actsCleanText(obj && (obj.NAME || obj.name || obj.TITLE || obj.title));
      const url = obj && (obj.DOWNLOAD_URL || obj.downloadUrl || obj.URL || obj.url || obj.DETAIL_URL || obj.detailUrl);
      addFile({ id: String(fileId || id), attachedId: String(id), name: name || `файл ${id}`, url: url || '', date, source });
      return true;
    } catch (e) { firstError = e.message || String(e); }
    try {
      const f = await bitrixRestCall('disk.file.get', { id });
      const name = actsCleanText(f && (f.NAME || f.name || f.TITLE || f.title));
      const url = f && (f.DOWNLOAD_URL || f.downloadUrl || f.URL || f.url || f.DETAIL_URL || f.detailUrl);
      addFile({ id: String(id), attachedId: '', name: name || `файл ${id}`, url: url || '', date, source });
      return true;
    } catch (e) {
      const secondError = e.message || String(e);
      const msg = [firstError, secondError].filter(Boolean).join(' | ');
      if (msg) diskErrors.push(`file=${id}: ${msg}`);
    }
    return false;
  }

  // 1) Классические вложения задачи.
  for (const id of [...ids].slice(0, 20)) await resolveDiskFile(id, 'task-webdav');

  // 2) v65: результат задачи. Метод работает в task scope и может вернуть files[] даже когда
  // UF_TASK_WEBDAV_FILES пуст, а чат недоступен вебхуку.
  let taskResultError = '';
  if (taskId) {
    try {
      const resultsRaw = await bitrixRestCall('tasks.task.result.list', { taskId: Number(taskId) });
      const results = Array.isArray(resultsRaw) ? resultsRaw : (resultsRaw && Array.isArray(resultsRaw.items) ? resultsRaw.items : []);
      let resultFileCount = 0;
      for (const result of results) {
        const date = result && (result.updatedAt || result.UPDATED_AT || result.createdAt || result.CREATED_AT || '');
        const resultFiles = result && (result.files || result.FILES);
        if (!Array.isArray(resultFiles)) continue;
        for (const id of resultFiles) {
          if (!/^\d+$/.test(String(id))) continue;
          resultFileCount++;
          await resolveDiskFile(String(id), 'task-result', date);
        }
      }
      console.log(`[acts-files] task=${taskId}: task results=${results.length}; result file refs=${resultFileCount}`);
    } catch (e) {
      taskResultError = e.message || String(e);
      console.warn(`[acts-files] task=${taskId}: не смог прочитать результат задачи: ${taskResultError}`);
    }
  }

  // 3) Новая карточка Bitrix24: файлы комментариев/результатов могут быть только в task chat.
  const chatId = String(actsTaskField(task, ['chatId','CHAT_ID','chat_id']) || '').trim();
  let chatError = '';
  if (chatId) {
    try {
      const dialog = await bitrixRestCall('im.dialog.messages.get', { DIALOG_ID: `chat${chatId}`, LIMIT: 50 });
      const chatFiles = dialog && (dialog.files || dialog.FILES);
      if (Array.isArray(chatFiles)) {
        for (const f of chatFiles) {
          const id = String(f && (f.id || f.ID || f.diskId || f.DISK_ID) || '');
          const name = actsCleanText(f && (f.name || f.NAME || f.title || f.TITLE));
          const url = f && (f.urlDownload || f.URL_DOWNLOAD || f.downloadUrl || f.DOWNLOAD_URL || f.url || f.URL);
          const date = f && (f.date || f.DATE || f.createTime || f.CREATE_TIME || '');
          addFile({ id, attachedId: '', name: name || (id ? `файл ${id}` : 'файл из чата'), url: url || '', date: date || '', source: 'task-chat' });
        }
        console.log(`[acts-files] task=${taskId || '?'}: chatId=${chatId}; chat files=${chatFiles.length}`);
      } else {
        console.log(`[acts-files] task=${taskId || '?'}: chatId=${chatId}; chat files=0`);
      }
    } catch (e) {
      chatError = e.message || String(e);
      console.warn(`[acts-files] task=${taskId || '?'}: не смог прочитать чат ${chatId}: ${chatError}`);
    }
  } else {
    console.log(`[acts-files] task=${taskId || '?'}: CHAT_ID не получен`);
  }

  for (const name of names) {
    const clean = actsCleanText(name);
    if (clean && !files.some((f) => f.name === clean)) addFile({ id: '', attachedId: '', name: clean, url: '', source: 'task-name-only' });
  }
  return { files, chatId, chatError, taskResultError, diskErrors };
}


function actsPickBestFileForClient(files) {
  const usable = (files || []).filter((f) => f && f.url);
  if (!usable.length) return null;

  // В чате задачи могут быть старые документы. Сначала берём АКТ, затем PDF/DOC,
  // и внутри группы предпочитаем самый свежий файл.
  const ts = (f) => {
    const n = Date.parse(String(f && f.date || ''));
    return Number.isFinite(n) ? n : 0;
  };
  const newest = (arr) => [...arr].sort((a, b) => ts(b) - ts(a))[0] || null;
  const actLike = usable.filter((f) => /акт|act/i.test(String(f.name || '')));
  if (actLike.length) return newest(actLike);
  const docs = usable.filter((f) => /\.(pdf|docx?)$/i.test(String(f.name || '')));
  return newest(docs.length ? docs : usable);
}

function actsMinskGreeting(date = new Date()) {
  // Приветствие всегда определяется по времени Минска, независимо от TZ сервера Render.
  // Правило: до 12:00 — утро (рабочий диапазон пользователя 09–11),
  // 12:00–16:59 — день, с 17:00 — вечер.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Minsk',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value || 0);
  if (hour >= 17) return 'Добрый вечер!';
  if (hour >= 12) return 'Добрый день!';
  return 'Доброе утро!';
}

function actsExtractActNumber(task) {
  const title = actsCleanText(actsTaskField(task, ['title', 'TITLE']) || '');
  if (!title) return '';

  // Предпочитаем явную запись: «АКТ №4», «Акт выполненных работ № 4», «АКТ N4».
  let m = title.match(/(?:^|\s)акт(?:\s+выполненных\s+работ)?\s*(?:№|n\.?|no\.?)\s*(\d+)(?=\s|$|[.,;:()\-])/iu);
  if (m) return m[1];

  // В проекте также встречается формат «АКТ 1 1000р Компания ...» без знака №.
  // Берём только полностью цифровой токен сразу после слова АКТ, поэтому «АКТ 3Д КЛИМАТ»
  // номером 3 ошибочно не станет.
  m = title.match(/(?:^|\s)акт\s+(\d+)(?=\s|$|[.,;:()\-])/iu);
  return m ? m[1] : '';
}

function actsActLabel(task) {
  const number = actsExtractActNumber(task);
  return number ? `акт выполненных работ №${number}` : 'акт выполненных работ';
}

function actsBuildClientMessage(deal, task, file) {
  const company = actsCleanText(deal.COMPANY_TITLE || deal.COMPANY_NAME || deal.TITLE || '');
  const greeting = actsMinskGreeting();
  const actNumber = actsExtractActNumber(task);
  const actLabel = actsActLabel(task);
  const custom = String(config.actsClientMessage || '').trim();
  if (custom) {
    let rendered = custom
      .replace(/\{greeting\}/g, greeting)
      .replace(/\{company\}/g, company || 'вашей компании')
      .replace(/\{act_number\}/g, actNumber)
      .replace(/\{act_label\}/g, actLabel)
      .replace(/\{deal_id\}/g, String(deal.ID || ''))
      .replace(/\{file\}/g, String(file && file.name || 'акт'));

    // Совместимость со старым стандартным шаблоном: если он был сохранён в ACTS_CLIENT_MESSAGE,
    // убираем из него название услуги и заменяем строку на новый формат акта.
    rendered = rendered
      .replace(/Направляем\s+акт\s+по\s+услуге\s+[«"“][^»"”]+[»"”]\.?/giu, `Направляем ${actLabel}.`)
      .replace(/Направляем\s+акт\s+по\s+услуге\s*:\s*[^\n.]+\.?/giu, `Направляем ${actLabel}.`);

    // Старый плейсхолдер {service} больше не раскрываем названием услуги в актовом сообщении.
    rendered = rendered.replace(/\{service\}/g, actLabel);

    // Даже старый кастомный шаблон с фиксированным приветствием автоматически
    // переводим на актуальное приветствие по минскому времени.
    if (/^(?:Доброе утро|Добрый день|Добрый вечер)!?/i.test(rendered)) {
      rendered = rendered.replace(/^(?:Доброе утро|Добрый день|Добрый вечер)!?/i, greeting);
    } else if (!custom.includes('{greeting}')) {
      rendered = `${greeting}\n\n${rendered}`;
    }
    return rendered;
  }
  return `${greeting}\n\nНаправляем ${actLabel}.\nПожалуйста, проверьте и подпишите акт. В течение 2 рабочих дней пришлите, пожалуйста, скан подписанного акта ответным сообщением.\n\nОригинал акта в 2 экземплярах направим вам почтой.\n\nЕсли по акту будут вопросы — напишите, пожалуйста, в ответном сообщении.`;
}


// ========================= v70: АВТОПУШИ ПО АКТУ =========================
const ACTS_PUSH_SENT_MARKER = '[MAVIS_ACTS_PUSH_SENT]';
const ACTS_SCAN_RECEIVED_MARKER = '[MAVIS_ACTS_SCAN_RECEIVED]';
const ACTS_CALL_TASK_MARKER = '[MAVIS_ACTS_CALL_TASK_CREATED]';
const ACTS_PUSH_STATE_MARKER = '[MAVIS_ACTS_PUSH_STATE]';
const ACTS_FILE_PENDING_MARKER = '[MAVIS_ACTS_FILE_PENDING]';
const actsPushStates = new Map(); // taskId -> durable state rebuilt from Bitrix timeline
let actsPushCycleRunning = false;

function actsNormalizeChannelKey(value) {
  const x = actsCleanText(value).toLowerCase();
  if (x.includes('viber') || x.includes('вайбер')) return 'viber';
  if (x.includes('telegram') || x.includes('телеграм') || x === 'tg') return 'telegram';
  if (x.includes('email') || x.includes('e-mail') || x.includes('почт')) return 'email';
  return '';
}

function actsMinskCalendarParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '';
  return {
    y: Number(get('year')), m: Number(get('month')), d: Number(get('day')),
    hour: Number(get('hour')), minute: Number(get('minute')), second: Number(get('second')),
    weekday: get('weekday'),
    ymd: `${get('year')}-${get('month')}-${get('day')}`,
  };
}

function actsIsMinskWeekend(date = new Date()) {
  const wd = actsMinskCalendarParts(date).weekday.toLowerCase();
  return wd.startsWith('sat') || wd.startsWith('sun');
}

function actsNextPushDueFrom(lastSentAtMs) {
  const testMinutes = Number(config.actsPushTestMinutes || 0);
  const stepMs = testMinutes > 0
    ? Math.max(1, testMinutes) * 60 * 1000
    : Math.max(1, Number(config.actsPushEveryDays || 2)) * 24 * 60 * 60 * 1000;
  let due = Number(lastSentAtMs || 0) + stepMs;
  // Не пишем клиенту в субботу/воскресенье. Пропускаем такой слот полностью,
  // следующий слот остаётся ещё через 2 календарных дня.
  for (let i = 0; i < 4 && actsIsMinskWeekend(new Date(due)); i++) due += stepMs;
  return due;
}

function actsParseTimelineCreated(comment) {
  return actsParseDateMs(comment && (comment.CREATED || comment.DATE_CREATE || comment.created || comment.dateCreate));
}

function actsExtractChannelFromSentComment(commentText) {
  const text = String(commentText || '');
  const explicit = text.match(/channel=(email|telegram|viber)/i);
  if (explicit) return explicit[1].toLowerCase();
  const human = text.match(/отправлено\s+через\s+(Email|Telegram|Viber|Вайбер|Телеграм)/i);
  return human ? actsNormalizeChannelKey(human[1]) : '';
}

async function actsLoadTimelineComments(dealId, limit = 300) {
  return bitrixRestList('crm.timeline.comment.list', {
    filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
    order: { CREATED: 'DESC' },
    select: ['ID','CREATED','COMMENT','FILES'],
  }, limit);
}

function actsTimelineFiles(comment) {
  const raw = comment && (comment.FILES || comment.files);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'object') return Object.values(raw);
  return [];
}

function actsCommentIsAfterSend(comment, sentAtMs, toleranceMs = 60 * 1000) {
  const createdMs = actsParseTimelineCreated(comment);
  if (!createdMs) return false;
  return createdMs >= Number(sentAtMs || 0) - Math.max(0, Number(toleranceMs || 0));
}

function actsFindLatestMarkerAfterSend(comments, marker, sentAtMs) {
  return (comments || [])
    .filter((c) => String(c && c.COMMENT || '').includes(marker) && actsCommentIsAfterSend(c, sentAtMs))
    .sort((a,b) => actsParseTimelineCreated(b) - actsParseTimelineCreated(a))[0] || null;
}

function actsTrustedScanMarker(comment, sentAtMs) {
  if (!comment || !actsCommentIsAfterSend(comment, sentAtMs)) return false;
  const text = String(comment.COMMENT || '');
  if (!text.includes(ACTS_SCAN_RECEIVED_MARKER)) return false;
  // v82: старые ложные маркеры могли создаваться просто из-за любого нового файла в задаче/таймлайне.
  // Доверяем только входящему акту, который был сохранён обработчиком, либо бумажному оригиналу в Архиве.
  return /сохранено/i.test(text) || /архив/i.test(text);
}

async function actsMarkFilePending(state, source, fileName = '') {
  const marker = `${ACTS_FILE_PENDING_MARKER} task=${state.taskId}`;
  const cleanName = actsCleanText(fileName || '');
  const comments = await actsLoadTimelineComments(state.dealId, 600).catch(() => []);
  const afterSend = comments.filter((c) => String(c && c.COMMENT || '').includes(marker) && actsCommentIsAfterSend(c, state.sentAtMs));
  const sameFileAlreadyMarked = cleanName
    ? afterSend.some((c) => String(c.COMMENT || '').toLowerCase().includes(cleanName.toLowerCase()))
    : afterSend.length > 0;
  // v83: один и тот же нераспознанный файл даёт только одну паузу. Иначе старый файл
  // каждые 24 часа мог заново ставить pending и блокировать пуш бесконечно.
  if (sameFileAlreadyMarked) return;
  await bitrixRestCall('crm.timeline.comment.add', { fields: {
    ENTITY_ID: state.dealId, ENTITY_TYPE: 'deal',
    COMMENT: `${marker}\nПосле отправки акта появился новый файл${cleanName ? ` «${cleanName}»` : ''} (${source}). Пока не считаю его подписанным актом автоматически; автопуш временно приостановлен на ${config.actsIncomingUncertainHoldHours || 24} ч.`
  }}).catch(() => {});
}

async function actsMarkScanReceived(state, source, fileName = '') {
  const marker = `${ACTS_SCAN_RECEIVED_MARKER} task=${state.taskId}`;
  if (!(await fgTimelineHasMarker(state.dealId, marker, 100))) {
    await bitrixRestCall('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: state.dealId,
        ENTITY_TYPE: 'deal',
        COMMENT: `${marker}\nПодписанный акт считаю полученным: ${source}${fileName ? ` — ${fileName}` : ''}. Автопуши по этому акту остановлены.`,
      },
    });
  }
  actsPushStates.delete(String(state.taskId));
  console.log(`[acts-push] task=${state.taskId}: скан/оригинал найден (${source}${fileName ? `, ${fileName}` : ''}) — пуши остановлены.`);
  return true;
}

async function actsResolveArchiveStageId() {
  if (actsResolveArchiveStageId.cache) return actsResolveArchiveStageId.cache;
  try {
    const raw = await bitrixRestCall('task.stages.get', { entityId: config.actsProjectId });
    const stages = raw && typeof raw === 'object' ? Object.values(raw) : [];
    const found = stages.find((st) => /архив/i.test(actsCleanText(st && (st.TITLE || st.title))));
    actsResolveArchiveStageId.cache = found ? String(found.ID || found.id) : '';
  } catch (e) {
    console.warn(`[acts-push] Не смог определить стадию «Архив»: ${e.message || e}`);
    actsResolveArchiveStageId.cache = '';
  }
  return actsResolveArchiveStageId.cache;
}
actsResolveArchiveStageId.cache = '';

async function actsCheckScanReceived(state, task = null, dealComments = null) {
  const scanMarker = `${ACTS_SCAN_RECEIVED_MARKER} task=${state.taskId}`;
  const comments = dealComments || await actsLoadTimelineComments(state.dealId, 100);
  // v81: старые тестовые маркеры по той же задаче не должны навсегда глушить новый цикл.
  // Учитываем только маркер, появившийся после текущей отправки акта.
  if (comments.some((c) => String(c.COMMENT || '').includes(scanMarker) && actsTrustedScanMarker(c, state.sentAtMs))) return true;

  // Если задача уже в «Архиве», бумажный оригинал вернулся — пушить точно больше не нужно.
  try {
    if (!task) {
      const raw = await bitrixRestCall('tasks.task.get', {
        taskId: Number(state.taskId),
        select: ['ID','TITLE','STAGE_ID','CHAT_ID','UF_CRM_TASK','UF_TASK_WEBDAV_FILES'],
      });
      task = raw && (raw.task || raw.TASK || raw);
    }
    const archiveStageId = await actsResolveArchiveStageId();
    const stage = String(actsTaskField(task, ['stageId','STAGE_ID','stage_id']) || '');
    if (archiveStageId && stage === archiveStageId) {
      await actsMarkScanReceived(state, 'задача находится в «Архиве»');
      return true;
    }

    // v82: любой новый файл в задаче больше НЕ означает автоматически «подписанный акт».
    // Это мог быть исходный файл, договор, счёт или техническая копия — из-за этого часть клиентов ошибочно выпадала из пушей.
    const resolved = await actsResolveTaskFiles(task);
    const originalName = actsCleanText(state.originalFileName || '').toLowerCase();
    const candidates = (resolved.files || []).filter((f) => {
      const fileMs = actsParseDateMs(f && f.date);
      if (!fileMs || fileMs <= Number(state.sentAtMs || 0) + 30 * 1000) return false;
      const name = actsCleanText(f && f.name || '');
      if (!name) return false;
      if (originalName && name.toLowerCase() === originalName) return false;
      return /\.(pdf|docx?|jpg|jpeg|png|heic|tiff?|bmp)$/i.test(name) || /акт|скан|подпис/i.test(name);
    });
    if (candidates.length) {
      const newest = [...candidates].sort((a,b) => actsParseDateMs(b.date) - actsParseDateMs(a.date))[0];
      await actsMarkFilePending(state, 'файл в задаче после отправки', newest.name || 'файл');
    }
  } catch (e) {
    console.warn(`[acts-push] task=${state.taskId}: не смог проверить файлы задачи: ${e.message || e}`);
  }

  // Файл в таймлайне сделки тоже не считаем подписанным актом без проверки.
  for (const c of comments) {
    const createdMs = actsParseTimelineCreated(c);
    if (!createdMs || createdMs <= Number(state.sentAtMs || 0) + 30 * 1000) continue;
    const files = actsTimelineFiles(c);
    if (!files.length) continue;
    const f = files[0] || {};
    await actsMarkFilePending(state, 'файл в таймлайне сделки', actsCleanText(f.name || f.NAME || 'файл'));
    break;
  }
  return false;
}

function actsPushMessage() {
  return `${actsMinskGreeting()}\n\nРанее направляли вам акт выполненных работ сообщением выше, но пока не получили подписанный скан. Наша бухгалтерия очень просит вернуть подписанный акт. Будем вам очень признательны, если сможете направить его ответным сообщением.`;
}

async function actsSendReminderEmail(deal, contactId, email, text, taskId, sequence) {
  const responsibleId = Number(deal.ASSIGNED_BY_ID || deal.assignedById || 1);
  let staff = null;
  try {
    const u = await bitrixRestCall('user.get', { ID: responsibleId });
    staff = Array.isArray(u) ? u[0] : u;
  } catch (_) {}
  const senderName = (staff && `${staff.NAME || ''} ${staff.LAST_NAME || ''}`.trim()) || config.emailSenderName || 'Mavis Group';
  const entityId = Number(contactId || 0);
  const fields = {
    OWNER_TYPE_ID: 2,
    OWNER_ID: Number(deal.ID),
    RESPONSIBLE_ID: responsibleId,
    TYPE_ID: 4,
    DIRECTION: 2,
    SUBJECT: 'Напоминание: подписанный акт выполненных работ',
    DESCRIPTION: text,
    DESCRIPTION_TYPE: 1,
    COMPLETED: 'Y',
    START_TIME: new Date().toISOString(),
    END_TIME: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    COMMUNICATIONS: [{ VALUE: email, ENTITY_ID: entityId, ENTITY_TYPE_ID: 3, TYPE: 'EMAIL' }],
  };
  if (staff && staff.EMAIL) fields.SETTINGS = { MESSAGE_FROM: `${senderName} <${staff.EMAIL}>` };
  return bitrixRestCall('crm.activity.add', { fields });
}

async function actsSendPush(state, deal, sequence) {
  const channel = actsNormalizeChannelKey(state.channel) || await detectPreferredChannelResolved(deal);
  if (!channel) return { ok: false, error: 'Не удалось определить канал первоначальной отправки акта.' };
  const text = actsPushMessage();

  // v84: пуш обязательно идёт тому же контакту, которому был отправлен сам акт.
  // Для старых состояний без contactId один раз восстанавливаем контакт по последней переписке.
  const recipient = await actsResolveRecipientContact(deal, state.contactId || '');
  if (!recipient.ok) return { ok: false, error: recipient.reason || 'Не удалось определить контакт для пуша.' };
  if (!state.contactId) {
    state.contactId = String(recipient.contactId || '');
    actsPushStates.set(String(state.taskId), state);
  }

  if (channel === 'email') {
    const email = actsContactEmail(recipient.contact);
    if (!email) return { ok: false, error: `У контакта «${recipient.label}» нет email для Email-пуша.` };
    await actsSendReminderEmail(deal, recipient.contactId, email, text, state.taskId, sequence);
    return { ok: true, channel: 'Email', contactId: recipient.contactId, contact: maskEmailForLog(email), contactLabel: recipient.label };
  }
  const phone = actsContactPhone(recipient.contact);
  if (!phone) return { ok: false, error: `У контакта «${recipient.label}» нет телефона для ${preferredChannelLabel(channel)}-пуша.` };
  const ch = getConfiguredWazzupChannel(channel);
  if (!ch || !ch.channelId || ch.key !== channel) return { ok: false, error: `${preferredChannelLabel(channel)} не настроен в Wazzup.` };
  const sent = await sendWazzupMessageInternal({
    channelKey: channel,
    text,
    phone,
    dealId: deal.ID,
    ignoreStrictPreferredChannel: true,
    crmMessageId: `mavis-acts-push-${channel}-${deal.ID}-${state.taskId}-${sequence}`,
  });
  return { ok: true, channel: preferredChannelLabel(channel), contactId: recipient.contactId, contactLabel: recipient.label, contact: phone.replace(/(\d{3})\d+(\d{3})$/, '$1***$2'), raw: sent };
}

function actsNextWorkingDeadlineIso(now = new Date()) {
  // Срок задачи эксперту — ближайший рабочий день (Пн–Пт) 17:00 по Минску.
  // Если задача создаётся в рабочий день до 17:00 — срок сегодня; иначе следующий рабочий день.
  const p = actsMinskCalendarParts(now);
  let base = new Date(Date.UTC(p.y, p.m - 1, p.d, 14, 0, 0)); // 17:00 Minsk = 14:00 UTC
  if (now.getTime() > base.getTime()) base = new Date(base.getTime() + 24 * 60 * 60 * 1000);
  while (actsIsMinskWeekend(base)) base = new Date(base.getTime() + 24 * 60 * 60 * 1000);
  return base.toISOString();
}

async function actsCreateCallTaskIfNeeded(state, deal, comments) {
  const threshold = Number(state.sentAtMs || 0) + (Number(config.actsCallTestMinutes || 0) > 0
    ? Math.max(1, Number(config.actsCallTestMinutes)) * 60 * 1000
    : Math.max(1, Number(config.actsCallAfterDays || 7)) * 24 * 60 * 60 * 1000);
  if (Date.now() < threshold) return false;
  const marker = `${ACTS_CALL_TASK_MARKER} task=${state.taskId}`;
  if ((comments || []).some((c) => String(c.COMMENT || '').includes(marker))) return false;
  const responsibleId = Number(deal.ASSIGNED_BY_ID || deal.assignedById || 0);
  if (!responsibleId) {
    console.warn(`[acts-push] task=${state.taskId}: 7 дней прошло, но у сделки ${state.dealId} нет ASSIGNED_BY_ID — задачу на звонок не создал.`);
    return false;
  }
  const company = actsCleanText(deal.COMPANY_TITLE || deal.COMPANY_NAME || deal.TITLE || `сделка ${state.dealId}`);
  const title = `Позвонить по акту: ${company}`;
  const description = `Подписанный скан акта не получен в течение ${config.actsCallAfterDays || 7} календарных дней после отправки клиенту.\n\nПозвоните клиенту по акту и попросите вернуть подписанный скан.\n\nСделка: https://mavisgroup.bitrix24.by/crm/deal/details/${state.dealId}/\nЗадача по акту: ${actsTaskUrl(state.taskId)}`;
  const added = await bitrixRestCall('tasks.task.add', { fields: {
    TITLE: title,
    DESCRIPTION: description,
    RESPONSIBLE_ID: responsibleId,
    DEADLINE: actsNextWorkingDeadlineIso(),
    UF_CRM_TASK: [`D_${state.dealId}`],
  }});
  const createdTaskId = added && (added.task && (added.task.id || added.task.ID) || added.id || added.ID || '');
  await bitrixRestCall('crm.timeline.comment.add', { fields: {
    ENTITY_ID: state.dealId,
    ENTITY_TYPE: 'deal',
    COMMENT: `${marker}\n7 дней без подписанного скана. Эксперту поставлена задача «${title}»${createdTaskId ? ` (#${createdTaskId})` : ''}.`,
  }});
  console.log(`[acts-push] task=${state.taskId}: прошло 7 дней — задача на звонок создана эксперту ${responsibleId}${createdTaskId ? `, task=${createdTaskId}` : ''}.`);
  return true;
}

async function actsRegisterPushState({ taskId, dealId, channel, contactId = '', sentAtMs = Date.now(), originalFileName = '' }) {
  if (!config.actsPushEnabled || !taskId || !dealId) return;
  actsPushStates.set(String(taskId), {
    taskId: String(taskId), dealId: String(dealId), channel: actsNormalizeChannelKey(channel), contactId: String(contactId || ''),
    sentAtMs: Number(sentAtMs || Date.now()), lastMessageAtMs: Number(sentAtMs || Date.now()),
    pushCount: 0, originalFileName: actsCleanText(originalFileName || ''),
  });
  console.log(`[acts-push] Зарегистрирован контроль task=${taskId}, deal=${dealId}, channel=${actsNormalizeChannelKey(channel) || channel}, contact=${contactId || 'не сохранён'}, следующий пуш после ${new Date(actsNextPushDueFrom(sentAtMs)).toISOString()}.`);
}

async function actsRecoverPushStatesFromBitrix(options = {}) {
  if (!config.actsPushEnabled || !config.bitrixWebhookUrl) return;
  const since = new Date(Date.now() - Math.max(7, Number(config.actsPushRecoveryDays || 30)) * 24 * 60 * 60 * 1000).toISOString();
  let tasks = [];
  try {
    const [changed, created] = await Promise.all([
      bitrixRestList('tasks.task.list', {
        filter: { GROUP_ID: config.actsProjectId, '>=CHANGED_DATE': since },
        order: { CHANGED_DATE: 'DESC' },
        select: ['ID','TITLE','DESCRIPTION','STAGE_ID','CHAT_ID','UF_CRM_TASK','CHANGED_DATE','CREATED_DATE'],
      }, 3000),
      bitrixRestList('tasks.task.list', {
        filter: { GROUP_ID: config.actsProjectId, '>=CREATED_DATE': since },
        order: { CREATED_DATE: 'DESC' },
        select: ['ID','TITLE','DESCRIPTION','STAGE_ID','CHAT_ID','UF_CRM_TASK','CHANGED_DATE','CREATED_DATE'],
      }, 3000),
    ]);
    const byId = new Map();
    for (const t of [...(changed || []), ...(created || [])]) {
      const id = String(actsTaskField(t, ['id','ID']) || '');
      if (id) byId.set(id, t);
    }
    tasks = [...byId.values()];
  } catch (e) {
    console.warn(`[acts-push] Не смог восстановить состояния после старта: ${e.message || e}`);
    return;
  }
  const actTasks = tasks.filter((t) => /^АКТ/i.test(actsCleanText(actsTaskField(t, ['title','TITLE']) || '')) || String(actsTaskField(t, ['description','DESCRIPTION']) || '').includes(ACTS_ORIGINAL_MARKER));
  let restored = 0;
  const stats = { noDeal: 0, noSentMarker: 0, scanReceived: 0, errors: 0, deepScanUsed: 0 };
  for (const task of actTasks) {
    const taskId = String(actsTaskField(task, ['id','ID']) || '');
    const dealIds = actsExtractDealIdsFromTask(task);
    if (!taskId || !dealIds.length) { stats.noDeal++; continue; }
    for (const dealId of dealIds.slice(0,1)) {
      try {
        let comments = await actsLoadTimelineComments(dealId, 300);
        const sentMarker = `${ACTS_TASK_SENT_MARKER} task=${taskId}`;
        let sentComment = comments.find((c) => String(c.COMMENT || '').includes(sentMarker));
        // v83: на сделках с большим количеством автокомментариев маркер отправки мог
        // оказаться глубже последних 300 записей. Тогда старый код терял контроль.
        if (!sentComment) {
          const deep = await actsLoadTimelineComments(dealId, 2000).catch(() => []);
          if (deep.length > comments.length) {
            comments = deep;
            stats.deepScanUsed++;
            sentComment = comments.find((c) => String(c.COMMENT || '').includes(sentMarker));
          }
        }
        if (!sentComment) { stats.noSentMarker++; continue; }
        let sentAtMs = actsParseTimelineCreated(sentComment);
        const explicitSentAt = String(sentComment.COMMENT || '').match(/\[MAVIS_ACTS_PUSH_STATE\][^\n]*sentAt=([^\s]+)/i);
        if (explicitSentAt) {
          const parsed = actsParseDateMs(explicitSentAt[1]);
          if (parsed) sentAtMs = parsed;
        }
        if (!sentAtMs) { stats.noSentMarker++; continue; }
        if (comments.some((c) => String(c.COMMENT || '').includes(`${ACTS_SCAN_RECEIVED_MARKER} task=${taskId}`) && actsTrustedScanMarker(c, sentAtMs))) {
          stats.scanReceived++;
          actsPushStates.delete(taskId);
          continue;
        }
        const pushComments = comments.filter((c) => String(c.COMMENT || '').includes(`${ACTS_PUSH_SENT_MARKER} task=${taskId}`) && actsCommentIsAfterSend(c, sentAtMs));
        const lastPush = [...pushComments].sort((a,b) => actsParseTimelineCreated(b)-actsParseTimelineCreated(a))[0];
        const lastMessageAtMs = lastPush ? actsParseTimelineCreated(lastPush) : sentAtMs;
        const channel = actsExtractChannelFromSentComment(sentComment.COMMENT) || await detectPreferredChannelResolved(await bitrixRestCall('crm.deal.get', { id: dealId }));
        const originalMatch = String(sentComment.COMMENT || '').match(/Файл:\s*([^\n]+)/i);
        const contactMatch = String(sentComment.COMMENT || '').match(/\[MAVIS_ACTS_PUSH_STATE\][^\n]*contactId=(\d+)/i);
        const recoveredContactId = contactMatch ? String(contactMatch[1]) : '';
        actsPushStates.set(taskId, { taskId, dealId: String(dealId), channel, contactId: recoveredContactId, sentAtMs, lastMessageAtMs, pushCount: pushComments.length, originalFileName: originalMatch ? actsCleanText(originalMatch[1]) : '' });
        restored++;
      } catch (e) {
        stats.errors++;
        console.warn(`[acts-push] task=${taskId}: восстановление состояния пропущено: ${e.message || e}`);
      }
    }
  }
  if (!options.silent) console.log(`[acts-push] Восстановлено ${restored} активных контролей из ${actTasks.length} задач на акт (просмотрено ${tasks.length} задач проекта, окно ${config.actsPushRecoveryDays || 30} дней). Причины пропуска: noDeal=${stats.noDeal}, noSentMarker=${stats.noSentMarker}, scanReceived=${stats.scanReceived}, errors=${stats.errors}, deepScan=${stats.deepScanUsed}.`);
  return restored;
}

let actsLastStateRefreshAtMs = 0;

async function actsHasRecentUncertainIncoming(state, comments) {
  const holdMs = Math.max(1, Number(config.actsIncomingUncertainHoldHours || 24)) * 60 * 60 * 1000;
  const marker = `${ACTS_FILE_PENDING_MARKER} task=${state.taskId}`;
  const latest = actsFindLatestMarkerAfterSend(comments, marker, state.sentAtMs);
  if (!latest) return false;
  const createdMs = actsParseTimelineCreated(latest);
  return !!createdMs && Date.now() - createdMs < holdMs;
}

async function runActsPushCycle() {
  if (!config.actsPushEnabled || !config.bitrixWebhookUrl || actsPushCycleRunning) return;
  actsPushCycleRunning = true;
  try {
    // v82: перед КАЖДОЙ проверкой заново сверяемся с Bitrix, чтобы ни один отправленный акт
    // не зависел только от памяти Render и не выпадал после деплоя/рестарта.
    actsLastStateRefreshAtMs = Date.now();
    try { await actsRecoverPushStatesFromBitrix({ silent: true }); } catch (e) { console.warn(`[acts-push] refresh states: ${e.message || e}`); }
    if (!actsPushStates.size) {
      console.log('[acts-push] Активных контролей не найдено.');
      return;
    }
    const now = Date.now();
    const allStates = [...actsPushStates.values()];
    const dueStates = allStates.filter((st) => now >= actsNextPushDueFrom(st.lastMessageAtMs || st.sentAtMs));
    const dueCount = dueStates.length;
    console.log(`[acts-push] Цикл: активных=${allStates.length}, по сроку=${dueCount}${dueCount ? `; due=${dueStates.slice(0,20).map((st) => `${st.dealId}/${st.taskId}`).join(',')}${dueCount > 20 ? ',…' : ''}` : ''}.`);
    for (const state of allStates) {
      try {
        const comments = await actsLoadTimelineComments(state.dealId, 100);
        const deal = await bitrixRestCall('crm.deal.get', { id: state.dealId });
        if (!deal) continue;
        if (await actsCheckScanReceived(state, null, comments)) continue;
        // v81: если клиент уже прислал файл, но ИИ временно не уверен, не отправляем нелепое напоминание.
        if (await actsHasRecentUncertainIncoming(state, comments)) {
          console.log(`[acts-push] task=${state.taskId}: есть свежий входящий файл на проверке — пуш временно приостановлен.`);
          continue;
        }

        await actsCreateCallTaskIfNeeded(state, deal, comments);

        const dueAt = actsNextPushDueFrom(state.lastMessageAtMs || state.sentAtMs);
        if (now < dueAt) continue;
        if (actsIsMinskWeekend(new Date(now))) {
          console.log(`[acts-push] task=${state.taskId}: пуш уже по сроку, но сегодня выходной по Минску — клиенту не пишу.`);
          continue;
        }

        const sequence = Number(state.pushCount || 0) + 1;
        const result = await actsSendPush(state, deal, sequence);
        if (!result.ok) {
          console.warn(`[acts-push] task=${state.taskId}: пуш #${sequence} не отправлен: ${result.error || result.message || 'ошибка'}`);
          continue;
        }
        const marker = `${ACTS_PUSH_SENT_MARKER} task=${state.taskId} n=${sequence} channel=${actsNormalizeChannelKey(state.channel) || actsNormalizeChannelKey(result.channel)}`;
        await bitrixRestCall('crm.timeline.comment.add', { fields: {
          ENTITY_ID: state.dealId,
          ENTITY_TYPE: 'deal',
          COMMENT: `${marker}\nАвтопуш #${sequence} по подписанному скану отправлен клиенту через ${result.channel}.`,
        }});
        state.lastMessageAtMs = Date.now();
        state.pushCount = sequence;
        if (!state.channel) state.channel = actsNormalizeChannelKey(result.channel);
        actsPushStates.set(String(state.taskId), state);
        console.log(`[acts-push] task=${state.taskId}: пуш #${sequence} отправлен через ${result.channel}; следующий после ${new Date(actsNextPushDueFrom(state.lastMessageAtMs)).toISOString()}.`);
      } catch (e) {
        console.error(`[acts-push] task=${state.taskId}: ошибка цикла: ${e.message || e}`);
      }
    }
  } finally {
    actsPushCycleRunning = false;
  }
}
// ========================= v71: ВХОДЯЩИЕ СКАНЫ АКТОВ =========================
const ACTS_EXPERT_FOLDERS = [
  { surname: 'кананович', first: 'иоланта', folder: 'Кананович Иоланта' },
  { surname: 'горбатова', first: 'елизавета', folder: 'Горбатова Елизавета' },
  { surname: 'николаева', first: 'екатерина', folder: 'Николаева Екатерина' },
  { surname: 'баженова', first: 'мария', folder: 'Баженова Мария' },
  { surname: 'панькова', first: 'ольга', folder: 'Панькова Ольга' },
];

const ACTS_RU_MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

function actsMonthFolderFromDeal(deal) {
  // Папка акта относится к месяцу закрытия производственной сделки. Это важно для
  // последующей месячной сверки: августовская сделка остаётся в «Акты_август», даже если скан пришёл в сентябре.
  let d = deal && deal.CLOSEDATE ? new Date(deal.CLOSEDATE) : null;
  if (!d || Number.isNaN(d.getTime())) d = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit' }).formatToParts(d);
  const month = Number(parts.find((p) => p.type === 'month')?.value || (d.getMonth()+1));
  return `Акты_${ACTS_RU_MONTHS[Math.max(0, Math.min(11, month - 1))]}`;
}

function actsResolveExpertFolderName(user) {
  const full = `${user && (user.LAST_NAME || user.lastName) || ''} ${user && (user.NAME || user.name) || ''}`.toLowerCase().replace(/ё/g,'е');
  const hit = ACTS_EXPERT_FOLDERS.find((x) => full.includes(x.surname.replace(/ё/g,'е')) || (full.includes(x.first) && full.includes(x.surname)));
  return hit ? hit.folder : '';
}

async function actsGetOrCreateChildFolder(parentId, name) {
  const children = await bitrixRestList('disk.folder.getchildren', { id: parentId }, 1000);
  let folder = children.find((c) => String(c.TYPE || c.type).toLowerCase() === 'folder' && actsCleanText(c.NAME || c.name) === name);
  if (!folder) folder = await bitrixRestCall('disk.folder.addsubfolder', { id: parentId, data: { NAME: name } });
  return String(folder && (folder.ID || folder.id) || '');
}

async function actsGetExpertActFolder(deal) {
  const userRows = await bitrixRestCall('user.get', { ID: deal.ASSIGNED_BY_ID });
  const user = Array.isArray(userRows) ? userRows[0] : userRows;
  const expertFolder = actsResolveExpertFolderName(user);
  if (!expertFolder) {
    const expertHuman = `${user && user.LAST_NAME || ''} ${user && user.NAME || ''}`.trim() || `ID ${deal.ASSIGNED_BY_ID || '?'}`;
    throw new Error(`Ответственный эксперт «${expertHuman}» не сопоставлен с папками актов.`);
  }
  const rootId = await getCommonDriveRootId();
  const monthFolderName = actsMonthFolderFromDeal(deal);
  const monthFolderId = await actsGetOrCreateChildFolder(rootId, monthFolderName);
  const expertFolderId = await actsGetOrCreateChildFolder(monthFolderId, expertFolder);
  return { expertFolderId, expertFolder, monthFolderName, user };
}

function actsIncomingFileNameFromUrl(urlRaw, fallback = '') {
  try {
    const u = new URL(String(urlRaw || ''));
    const q = u.searchParams.get('filename') || u.searchParams.get('fileName') || '';
    if (q) return decodeURIComponent(q);
    const last = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (last && /\.[a-z0-9]{2,6}$/i.test(last)) return last;
  } catch (_) {}
  return fallback || '';
}

async function actsDownloadIncomingUrl(urlRaw, fallbackName = 'scan') {
  const response = await fetch(String(urlRaw || ''), { redirect: 'follow', headers: { Accept: '*/*', 'User-Agent': 'MAVIS-Acts-Incoming/1.0' } });
  if (!response.ok) throw new Error(`не удалось скачать входящий файл: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('входящий файл пустой');
  const cd = response.headers.get('content-disposition') || '';
  let fileName = '';
  const utf = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const plain = cd.match(/filename="?([^";]+)"?/i);
  if (utf) { try { fileName = decodeURIComponent(utf[1]); } catch (_) { fileName = utf[1]; } }
  if (!fileName && plain) fileName = plain[1];
  if (!fileName) fileName = actsIncomingFileNameFromUrl(response.url || urlRaw, fallbackName);
  fileName = actsSafeFileName(fileName || fallbackName || 'scan');
  return { buffer, fileName, contentType: response.headers.get('content-type') || '' };
}

function actsArrayIds(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'object') return Object.values(value).flatMap(actsArrayIds).map(String);
  return [String(value)];
}

async function actsFindWaitingStatesByComm(commType, commValue) {
  if (!actsPushStates.size) {
    // После рестарта состояния восстанавливаются из Bitrix; если входящий файл пришёл в первые секунды,
    // попробуем восстановить их прямо сейчас, чтобы не потерять скан.
    await actsRecoverPushStatesFromBitrix().catch(() => {});
  }
  if (!actsPushStates.size) return [];
  const type = String(commType || '').toUpperCase() === 'EMAIL' ? 'EMAIL' : 'PHONE';
  const value = type === 'PHONE' ? normalizePhoneDigits(commValue) : String(commValue || '').trim().toLowerCase();
  if (!value) return [];
  let dup = {};
  try {
    dup = await bitrixRestCall('crm.duplicate.findbycomm', { type, values: [value] });
  } catch (e) {
    console.warn(`[acts-incoming] duplicate.findbycomm ${type}: ${e.message || e}`);
  }
  const contactIds = new Set(actsArrayIds(dup && (dup.CONTACT || dup.contact)).map(String));
  const companyIds = new Set(actsArrayIds(dup && (dup.COMPANY || dup.company)).map(String));

  // Иногда PHONE в duplicate.findbycomm чувствителен к формату. Для телефона делаем дополнительный
  // безопасный fallback по последним 9 цифрам непосредственно в контакте/компании активной сделки.
  const phoneTail = type === 'PHONE' ? value.slice(-9) : '';
  const matches = [];
  for (const state of actsPushStates.values()) {
    try {
      const deal = await bitrixRestCall('crm.deal.get', { id: state.dealId });
      if (!deal) continue;
      let matched = (deal.CONTACT_ID && contactIds.has(String(deal.CONTACT_ID))) || (deal.COMPANY_ID && companyIds.has(String(deal.COMPANY_ID)));
      if (!matched && type === 'PHONE' && phoneTail) {
        const entities = [];
        if (deal.CONTACT_ID) entities.push(['crm.contact.get', deal.CONTACT_ID]);
        if (deal.COMPANY_ID) entities.push(['crm.company.get', deal.COMPANY_ID]);
        for (const [method,id] of entities) {
          try {
            const ent = await bitrixRestCall(method, { id });
            const phones = Array.isArray(ent && ent.PHONE) ? ent.PHONE : [];
            if (phones.some((p) => normalizePhoneDigits(p && p.VALUE).slice(-9) === phoneTail)) { matched = true; break; }
          } catch (_) {}
        }
      }
      if (!matched && type === 'EMAIL') {
        const entities = [];
        if (deal.CONTACT_ID) entities.push(['crm.contact.get', deal.CONTACT_ID]);
        if (deal.COMPANY_ID) entities.push(['crm.company.get', deal.COMPANY_ID]);
        for (const [method,id] of entities) {
          try {
            const ent = await bitrixRestCall(method, { id });
            const emails = Array.isArray(ent && ent.EMAIL) ? ent.EMAIL : [];
            if (emails.some((x) => String(x && x.VALUE || '').trim().toLowerCase() === value)) { matched = true; break; }
          } catch (_) {}
        }
      }
      if (matched) matches.push({ state, deal });
    } catch (_) {}
  }
  return matches.sort((a,b) => Number(b.state.sentAtMs || 0) - Number(a.state.sentAtMs || 0));
}

async function actsAiCheckSignedAct(buffer, fileName, contentType, messageText = '') {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  const isImage = ['jpg','jpeg','png','webp'].includes(ext) || /^image\//i.test(contentType || '');
  const isPdf = ext === 'pdf' || /^application\/pdf/i.test(contentType || '') || (buffer && buffer.subarray(0, 4).toString() === '%PDF');
  const ai = resolveAiProvider();
  if (!ai.apiKey) return { isSignedAct: false, confidence: 'low', reason: 'AI key не задан — документ не принимаю автоматически' };

  const prompt = [
    'Определи, является ли присланный клиентом файл именно ПОДПИСАННЫМ актом выполненных работ / актом оказанных услуг.',
    'Важно отличать акт от счета, договора, счета-фактуры, накладной, коммерческого предложения и любых других документов.',
    'Если это акт, но он не подписан клиентом, isSignedAct=false.',
    'Признаки возврата подписанного акта: видимая подпись, рукописное заполнение поля подписи, печать/штамп рядом с реквизитами стороны либо электронная подпись/отметка подписания.',
    'Само слово «акт» или имя файла недостаточно. Для счета или любого другого документа всегда isSignedAct=false.',
    messageText ? `Текст сообщения клиента: ${String(messageText).slice(0, 1000)}` : '',
    'Ответ только JSON: {"isSignedAct":true|false,"confidence":"high|medium|low","documentType":"акт|счет|договор|накладная|другое","company":"название компании если видно или null","actNumber":"номер акта если видно или null","signatureEvidence":"что именно указывает на подпись или null","reason":"коротко"}.',
  ].filter(Boolean).join(' ');

  try {
    let content;
    if (isImage) {
      const dataUrl = `data:${contentType || (ext === 'png' ? 'image/png' : 'image/jpeg')};base64,${buffer.toString('base64')}`;
      content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: dataUrl } },
      ];
    } else if (isPdf) {
      // v73: PDF передаём модели целиком как file input. Это позволяет анализировать как текст PDF,
      // так и изображения страниц (включая скан подписи), вместо эвристики по имени файла.
      const dataUrl = `data:application/pdf;base64,${buffer.toString('base64')}`;
      content = [
        { type: 'file', file: { filename: fileName || 'document.pdf', file_data: dataUrl } },
        { type: 'text', text: prompt },
      ];
    } else {
      return { isSignedAct: false, confidence: 'low', reason: `формат .${ext || '?'} пока не поддерживает надёжную проверку подписи` };
    }

    const response = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST', headers: { ...ai.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.aiModel, temperature: 0.1, response_format: { type: 'json_object' }, messages: [{ role: 'user', content }] }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data && data.error && (data.error.message || data.error_description) || `HTTP ${response.status}`);
    const text = data?.choices?.[0]?.message?.content || '{}';
    const obj = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    const confidence = String(obj.confidence || 'low').toLowerCase();
    const isSignedAct = !!obj.isSignedAct && confidence !== 'low';
    return {
      isSignedAct,
      confidence,
      documentType: obj.documentType || null,
      company: obj.company || null,
      actNumber: obj.actNumber || null,
      signatureEvidence: obj.signatureEvidence || null,
      reason: obj.reason || (isSignedAct ? 'подписанный акт подтверждён ИИ' : 'подписанный акт не подтверждён'),
    };
  } catch (e) {
    // Fail closed: при сбое ИИ НЕ останавливаем пуши и НЕ раскладываем неизвестный документ.
    return { isSignedAct: false, confidence: 'low', reason: `AI-проверка файла не сработала: ${e.message || e}` };
  }
}

async function actsNotifyExpertScanReceived(deal, taskId, source, fileName, storage) {
  const expertId = String(deal && deal.ASSIGNED_BY_ID || '');
  if (!expertId) return;
  const companyName = deal.COMPANY_ID ? await getCompanyName(deal.COMPANY_ID) : null;
  const label = companyName || deal.TITLE || `сделка ${deal.ID}`;
  const message = `ИИгорь: подписанный скан акта по «${label}» получен через ${source}. Сохранил: ${storage.monthFolderName} → ${storage.expertFolder} → ${fileName}. Автопуши клиенту остановлены.`;
  try {
    await bitrixRestCall('im.notify.personal.add', { USER_ID: Number(expertId), MESSAGE: message, MESSAGE_OUT: message });
  } catch (e) {
    console.warn(`[acts-incoming] deal=${deal.ID}: уведомление эксперту не отправлено: ${e.message || e}`);
    // fallback: комментарий всё равно останется в таймлайне через actsMarkScanReceived.
  }
}

async function actsSaveIncomingScanForState({ state, deal, source, fileName, buffer, contentType, skipCompanyFolder = false }) {
  const taskRaw = await bitrixRestCall('tasks.task.get', { taskId: Number(state.taskId), select: ['ID','TITLE','UF_CRM_TASK'] });
  const task = taskRaw && (taskRaw.task || taskRaw.TASK || taskRaw);
  const storage = await actsGetExpertActFolder(deal);
  const savedExpert = await uploadFileToDiskFolder(storage.expertFolderId, fileName, buffer);
  if (!savedExpert) throw new Error('не удалось сохранить скан в папку эксперта');

  if (!skipCompanyFolder) {
    try {
      const companyName = deal.COMPANY_ID ? await getCompanyName(deal.COMPANY_ID) : (deal.TITLE || `Сделка ${deal.ID}`);
      const companyFolderId = await getOrCreateCompanyFolder(companyName || `Сделка ${deal.ID}`);
      await uploadFileToDiskFolder(companyFolderId, fileName, buffer);
    } catch (e) {
      console.warn(`[acts-incoming] deal=${deal.ID}: в папку компании не продублировал: ${e.message || e}`);
    }
  }

  await actsMarkScanReceived(state, `${source}; сохранено ${storage.monthFolderName}/${storage.expertFolder}`, fileName);
  await actsNotifyExpertScanReceived(deal, state.taskId, source, fileName, storage);
  console.log(`[acts-incoming] ✅ task=${state.taskId}, deal=${deal.ID}: ${fileName} → ${storage.monthFolderName}/${storage.expertFolder}; пуши остановлены.`);
  return { ok: true, taskId: state.taskId, dealId: deal.ID, fileName, storage };
}

async function actsProcessIncomingAttachments({ source, commType, commValue, messageText = '', attachments = [], skipCompanyFolder = false }) {
  if (!config.actsIncomingEnabled || !attachments.length) return { ok: true, processed: 0 };
  const waiting = await actsFindWaitingStatesByComm(commType, commValue);
  if (!waiting.length) {
    console.log(`[acts-incoming] ${source}: активный ожидаемый акт по ${commType} не найден — вложение не трогаю.`);
    return { ok: true, processed: 0, reason: 'no-active-act' };
  }
  if (waiting.length > 1) console.warn(`[acts-incoming] ${source}: найдено ${waiting.length} ожидаемых актов у одного клиента; начинаю с самого свежего.`);
  const target = waiting[0];
  for (const att of attachments) {
    const fileName = actsSafeFileName(att.fileName || 'scan');
    const buffer = Buffer.isBuffer(att.buffer) ? att.buffer : Buffer.from(att.buffer || '');
    if (!buffer.length) continue;
    const check = await actsAiCheckSignedAct(buffer, fileName, att.contentType || '', messageText);
    console.log(`[acts-incoming] ${source}: ${fileName}; signed=${check.isSignedAct}; confidence=${check.confidence}; reason=${check.reason || ''}`);
    if (!check.isSignedAct) {
      const uncertain = String(check.confidence || 'low').toLowerCase() === 'low' || /не сработал|не удалось|ошиб|не поддерж/i.test(String(check.reason || ''));
      if (uncertain) {
        const marker = `${ACTS_FILE_PENDING_MARKER} task=${target.state.taskId}`;
        const comments = await actsLoadTimelineComments(target.state.dealId, 100).catch(() => []);
        const already = actsFindLatestMarkerAfterSend(comments, marker, target.state.sentAtMs);
        if (!already) {
          await bitrixRestCall('crm.timeline.comment.add', { fields: {
            ENTITY_ID: target.state.dealId, ENTITY_TYPE: 'deal',
            COMMENT: `${marker}\nКлиент прислал файл «${fileName}», но ИИ не смог уверенно определить, подписанный ли это акт. Автопуш временно приостановлен на ${config.actsIncomingUncertainHoldHours || 24} ч, чтобы не напоминать клиенту ошибочно.`
          }}).catch(() => {});
        }
        console.warn(`[acts-incoming] task=${target.state.taskId}: файл ${fileName} не классифицирован уверенно — пуши поставлены на паузу.`);
      }
      continue;
    }
    return actsSaveIncomingScanForState({ state: target.state, deal: target.deal, source, fileName, buffer, contentType: att.contentType || '', skipCompanyFolder });
  }
  return { ok: true, processed: 0, reason: 'no-signed-act-detected' };
}

async function actsLogWazzupIncomingWebhookStatus() {
  const apiKey = process.env.WAZZUP_SIDECAR_KEY || process.env.WAZZUP_API_KEY || '';
  if (!apiKey || !config.actsIncomingEnabled || !config.actsIncomingWazzupEnabled) return;
  try {
    const baseUrl = (process.env.WAZZUP_BASE_URL || 'https://api.wazzup24.com/v3').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/webhooks`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(compactWazzupError(data, `HTTP ${response.status}`));
    const actual = String(data.webhooksUri || data.webhookUri || data.uri || '').replace(/\/+$/, '');
    const expected = `${config.actsPublicBaseUrl}/api/wazzup/webhook`.replace(/\/+$/, '');
    const subscribed = !!(data.subscriptions && data.subscriptions.messagesAndStatuses);
    if (actual === expected && subscribed) {
      console.log(`[acts-incoming] Wazzup webhook OK: ${expected}; messagesAndStatuses=true.`);
    } else {
      console.warn(`[acts-incoming] ⚠️ Wazzup webhook не готов для входящих актов: сейчас=${actual || 'не задан'}, messagesAndStatuses=${subscribed}; ожидаю=${expected}.`);
    }
  } catch (e) {
    console.warn(`[acts-incoming] Не смог проверить Wazzup webhook: ${e.message || e}`);
  }
}

async function actsProcessIncomingWazzupMessage(msg) {
  const phone = normalizePhoneDigits((msg.contact && msg.contact.phone) || msg.chatId || '');
  const channel = String(msg.chatType || findChannelKeyByChannelId(msg.channelId) || 'messenger').toLowerCase();
  const fallbackExt = String(msg.type || '').toLowerCase() === 'image' ? '.jpg' : '.pdf';
  const fromUrl = actsIncomingFileNameFromUrl(msg.contentUri, '');
  const fallback = fromUrl || `Акт_скан_${phone ? phone.slice(-4) : 'клиент'}_${Date.now()}${fallbackExt}`;
  const downloaded = await actsDownloadIncomingUrl(msg.contentUri, fallback);
  console.log(`[acts-incoming] Wazzup ${channel}: inbound ${downloaded.fileName}, phone=***${phone.slice(-4)}, message=${msg.messageId || '?'}`);
  return actsProcessIncomingAttachments({
    source: channel === 'viber' ? 'Viber' : channel === 'telegram' ? 'Telegram' : 'Wazzup',
    commType: 'PHONE', commValue: phone, messageText: msg.text || '',
    attachments: [downloaded], skipCompanyFolder: false,
  });
}
// ======================= /v71: ВХОДЯЩИЕ СКАНЫ АКТОВ =========================


// ============================================================================
// v78: CJM БЛОКИ 3–4 — ДЕДЛАЙН ДОКУМЕНТОВ + ВХОДЯЩИЕ ДОКУМЕНТЫ АТТЕСТАЦИИ/СПК
// ============================================================================

const DOCS_WAIT_START_MARKER = '[MAVIS_DOCS_WAIT_START]';
const CLIENT_DOCS_RECEIVED_MARKER = '[MAVIS_CLIENT_DOCS_RECEIVED]';
const CLIENT_DOCS_STATE_MARKER = '[MAVIS_CLIENT_DOCS_STATE]';
let clientDocsExtraEmailFieldCache = undefined; // undefined = ещё не искали, '' = не найдено

function clientDocsNormalizeText(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

function clientDocsTargetService(service) {
  const s = clientDocsNormalizeText(service);
  return /аттест/.test(s) || /(?:^|\s)спк(?:\s|$)|свидетельств.*техн|техн.*компетент/.test(s);
}

async function resolveDealServiceName(deal) {
  if (!deal) return '';
  const serviceField = config.serviceFieldCode || process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071';
  try {
    const resolved = await actsReconResolveService(deal, serviceField);
    if (resolved) return String(resolved).trim();
  } catch (_) {}
  return detectServiceFromDeal(deal);
}

function resolveDocumentsDueAt(rawDate, sentAt = new Date()) {
  const raw = String(rawDate || '').trim();
  let datePart = '';
  const m = raw.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (m) datePart = m[1];

  if (!datePart) {
    const baseParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Minsk', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(new Date(sentAt));
    const get = (t) => (baseParts.find((x) => x.type === t) || {}).value;
    const baseUtcNoon = new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')), 12, 0, 0));
    baseUtcNoon.setUTCDate(baseUtcNoon.getUTCDate() + 2);
    datePart = `${baseUtcNoon.getUTCFullYear()}-${String(baseUtcNoon.getUTCMonth()+1).padStart(2,'0')}-${String(baseUtcNoon.getUTCDate()).padStart(2,'0')}`;
  }

  // Срок формулируется как «до <дата> включительно», поэтому пуш не раньше конца рабочего дня.
  const due = new Date(`${datePart}T18:00:00+03:00`);
  if (!Number.isNaN(due.getTime())) return due;
  return new Date(new Date(sentAt).getTime() + 2 * 24 * 60 * 60 * 1000);
}

async function persistDocsWaitStart(dealId, info) {
  const payload = {
    sentAt: new Date(info.sentAt || Date.now()).toISOString(),
    dueAt: new Date(info.dueAt || Date.now()).toISOString(),
    companyName: String(info.companyName || ''),
    service: String(info.service || ''),
    preferredChannel: String(info.preferredChannel || ''),
  };
  await bitrixRestCall('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: `${DOCS_WAIT_START_MARKER}\n${JSON.stringify(payload)}`,
    },
  });
}

function clientDocsParseMarkerJson(text, markerText) {
  const str = String(text || '');
  const idx = str.indexOf(markerText);
  if (idx < 0) return null;
  const tail = str.slice(idx + markerText.length);
  // Маркерный payload всегда пишем одной JSON-строкой. Берём первый JSON после маркера,
  // чтобы следующий JSON-маркер в том же комментарии не склеился с первым.
  const line = tail.split(/\r?\n/).map((x) => x.trim()).find((x) => x.startsWith('{') && x.endsWith('}'));
  if (!line) return null;
  try { return JSON.parse(line); } catch (_) { return null; }
}

async function hasClientDocsReceivedAfter(dealId, afterDate) {
  const afterTs = new Date(afterDate || 0).getTime();
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID','COMMENT','DATE_CREATE','CREATED'],
      order: { ID: 'DESC' },
    }, 80);
    for (const c of comments) {
      const text = String(c.COMMENT || '');
      if (!text.includes(CLIENT_DOCS_RECEIVED_MARKER)) continue;
      const payload = clientDocsParseMarkerJson(text, CLIENT_DOCS_RECEIVED_MARKER);
      const ts = new Date((payload && payload.at) || c.DATE_CREATE || c.CREATED || 0).getTime();
      if (Number.isFinite(ts) && ts >= afterTs) return true;
    }
  } catch (_) {}
  return false;
}

async function recoverPendingDocsChecks() {
  if (!config.bitrixWebhookUrl || !config.autopilotEnabled) return;
  const prepStageId = getPreparationStageId();
  if (!prepStageId) return;

  let deals = [];
  try {
    deals = await bitrixRestList('crm.deal.list', {
      filter: { CATEGORY_ID: config.autopilotCategoryId || 28, STAGE_ID: prepStageId },
      select: ['ID','TITLE','COMPANY_ID','CONTACT_ID','ASSIGNED_BY_ID','STAGE_ID',
        config.serviceFieldCode || process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071'],
      order: { ID: 'DESC' },
    }, 150);
  } catch (e) {
    console.warn(`[docsReminder] Не смог восстановить сделки: ${e.message || e}`);
    return;
  }

  let recovered = 0;
  for (const deal of deals) {
    try {
      const comments = await bitrixRestList('crm.timeline.comment.list', {
        filter: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal' },
        select: ['ID','COMMENT','DATE_CREATE'],
        order: { ID: 'DESC' },
      }, 80);

      let wait = null;
      let reminderAfter = false;
      let receivedAfter = false;
      for (const c of comments) {
        const text = String(c.COMMENT || '');
        if (!wait && text.includes(DOCS_WAIT_START_MARKER)) {
          wait = clientDocsParseMarkerJson(text, DOCS_WAIT_START_MARKER);
          if (wait) continue;
        }
      }
      if (!wait || !wait.sentAt) continue;
      const startTs = new Date(wait.sentAt).getTime();

      for (const c of comments) {
        const text = String(c.COMMENT || '');
        let cTs = new Date(c.DATE_CREATE || c.CREATED || 0).getTime();
        if (text.includes(CLIENT_DOCS_RECEIVED_MARKER)) {
          const payload = clientDocsParseMarkerJson(text, CLIENT_DOCS_RECEIVED_MARKER);
          if (payload && payload.at) cTs = new Date(payload.at).getTime();
        }
        if (text.includes(DOCS_REMINDER_MARKER)) {
          const m = text.match(/\bat=([^\s]+)/);
          if (m) cTs = new Date(m[1]).getTime();
        }
        if (!Number.isFinite(cTs) || cTs < startTs) continue;
        if (text.includes(DOCS_REMINDER_MARKER)) reminderAfter = true;
        if (text.includes(CLIENT_DOCS_RECEIVED_MARKER)) receivedAfter = true;
      }
      if (reminderAfter || receivedAfter) continue;

      pendingDocsCheck.set(String(deal.ID), {
        sentAt: new Date(wait.sentAt),
        dueAt: new Date(wait.dueAt || resolveDocumentsDueAt('', wait.sentAt)),
        companyName: wait.companyName || deal.TITLE,
        service: wait.service || await resolveDealServiceName(deal),
        preferredChannel: wait.preferredChannel || '',
      });
      recovered++;
    } catch (_) {}
  }
  console.log(`[docsReminder] Восстановлено ожиданий документов после рестарта: ${recovered}.`);
}

async function hasQualifiedFirstContact(deal) {
  try {
    const acts = await bitrixRestList('crm.activity.list', {
      filter: { OWNER_ID: deal.ID, OWNER_TYPE_ID: 2 },
      select: ['*','FILES'],
      order: { ID: 'DESC' },
    }, 40);
    for (const a of acts) {
      const typeId = String(a.TYPE_ID || '');
      const provider = String(a.PROVIDER_ID || '').toLowerCase();
      const text = String([a.SUBJECT,a.DESCRIPTION,a.PROVIDER_TYPE_ID].join(' ')).toLowerCase();
      const isCall = typeId === '2' || /call|voximplant|asterisk|zruchna|telephony|звон|телеф/.test(`${provider} ${text}`);
      if (!isCall) continue;
      const gate = activityPassesExpertGate(a, deal, {
        assignedById: deal.ASSIGNED_BY_ID,
        minDate: deal.MOVED_TIME,
      });
      if (!gate.ok) continue;
      return true;
    }
  } catch (e) {
    console.warn(`[firstCall] deal=${deal.ID}: не смог проверить звонки: ${e.message || e}`);
  }
  return false;
}

function clientDocsRequiredDocs(docList) {
  const docs = Array.isArray(docList && docList.docs) ? docList.docs : [];
  return docs.filter((x) => !/все копии заверяются|копия верна|подпись.*расшифровка.*печать/i.test(String(x || '')));
}

function finalizeDocsReminderMessage(_baseText, docList) {
  const docs = clientDocsRequiredDocs(docList);
  const lines = docs.map((d, i) => `${i + 1}. ${String(d).trim()}`);
  return [
    actsMinskGreeting(),
    '',
    `Напоминаем по документам для услуги «${docList && docList.title ? docList.title : 'вашей услуги'}». Пока не получили необходимый комплект.`,
    '',
    'Пожалуйста, направьте:',
    ...lines,
    '',
    'Документы, пожалуйста, направляйте на нашу почту: mavis.group@mail.ru',
  ].join('\n').trim();
}

async function sendEmailTextThroughBitrix(deal, toEmail, subject, text) {
  await bitrixRestCall('crm.activity.add', {
    fields: {
      TYPE_ID: 4,
      SUBJECT: subject || `Документы по сделке: ${deal.TITLE}`,
      DESCRIPTION: text,
      DESCRIPTION_TYPE: 1,
      DIRECTION: 2,
      OWNER_TYPE_ID: 2,
      OWNER_ID: deal.ID,
      RESPONSIBLE_ID: deal.ASSIGNED_BY_ID || 1,
      COMPLETED: 'Y',
      COMMUNICATIONS: [{
        VALUE: toEmail,
        ENTITY_ID: Number(deal.CONTACT_ID || 0),
        ENTITY_TYPE_ID: 3,
        TYPE: 'EMAIL',
      }],
    },
  });
}

async function sendClientTextByPreferredChannel(deal, text, subject = '') {
  const preferred = await detectPreferredChannelResolved(deal);
  if (!preferred) return { ok: false, error: 'не заполнен/не распознан предпочитаемый канал связи' };

  if (preferred === 'email') {
    const email = await getContactEmail(deal);
    if (!email) return { ok: false, channel: 'email', error: 'у клиента не найден email' };
    await sendEmailTextThroughBitrix(deal, email, subject || `Документы: ${deal.TITLE}`, text);
    return { ok: true, channel: 'email' };
  }

  if (!['viber','telegram'].includes(preferred)) {
    return { ok: false, channel: preferred, error: `канал ${preferred} не поддерживается` };
  }
  const phone = await getContactPhone(deal);
  if (!phone) return { ok: false, channel: preferred, error: 'не найден телефон клиента' };
  const cfg = getConfiguredWazzupChannel(preferred);
  if (!cfg || !cfg.channelId) return { ok: false, channel: preferred, error: `Wazzup ${preferred} не настроен` };
  await sendWazzupMessageInternal({ channelKey: preferred, text, phone, dealId: deal.ID });
  return { ok: true, channel: preferred };
}

async function clientDocsFindExtraEmailField() {
  if (clientDocsExtraEmailFieldCache !== undefined) return clientDocsExtraEmailFieldCache;
  try {
    const fields = await bitrixRestList('crm.deal.userfield.list', {}, 500);
    const f = fields.find((x) => {
      const label = [
        x.EDIT_FORM_LABEL, x.LIST_COLUMN_LABEL, x.LIST_FILTER_LABEL,
        x.USER_TYPE_ID, x.FIELD_NAME
      ].filter(Boolean).join(' ');
      return /доп.*(?:email|e-mail|почт)|(?:email|e-mail|почт).*доп/i.test(label);
    });
    clientDocsExtraEmailFieldCache = f ? String(f.FIELD_NAME || '') : '';
    if (clientDocsExtraEmailFieldCache) {
      console.log(`[client-docs] Поле дополнительной почты найдено: ${clientDocsExtraEmailFieldCache}.`);
    }
  } catch (e) {
    clientDocsExtraEmailFieldCache = '';
    console.warn(`[client-docs] Не смог найти поле дополнительной почты: ${e.message || e}`);
  }
  return clientDocsExtraEmailFieldCache;
}

async function clientDocsCommMatchesDeal(deal, commType, commValue) {
  const type = String(commType || '').toUpperCase() === 'EMAIL' ? 'EMAIL' : 'PHONE';
  const target = type === 'PHONE'
    ? normalizePhoneDigits(commValue)
    : String(commValue || '').trim().toLowerCase();
  if (!target || !deal) return false;

  const entities = [];
  if (deal.CONTACT_ID) entities.push(['crm.contact.get', deal.CONTACT_ID]);
  if (deal.COMPANY_ID) entities.push(['crm.company.get', deal.COMPANY_ID]);
  for (const [method,id] of entities) {
    try {
      const ent = await bitrixRestCall(method, { id });
      if (type === 'PHONE') {
        const tail = target.slice(-9);
        const values = Array.isArray(ent && ent.PHONE) ? ent.PHONE : [];
        if (values.some((x) => normalizePhoneDigits(x && x.VALUE).slice(-9) === tail)) return true;
      } else {
        const values = Array.isArray(ent && ent.EMAIL) ? ent.EMAIL : [];
        if (values.some((x) => String(x && x.VALUE || '').trim().toLowerCase() === target)) return true;
      }
    } catch (_) {}
  }

  if (type === 'EMAIL') {
    const extraField = await clientDocsFindExtraEmailField();
    if (extraField && String(deal[extraField] || '').trim().toLowerCase() === target) return true;
  }
  return false;
}

async function clientDocsFindDealsByComm(commType, commValue) {
  const type = String(commType || '').toUpperCase() === 'EMAIL' ? 'EMAIL' : 'PHONE';
  const value = type === 'PHONE'
    ? normalizePhoneDigits(commValue)
    : String(commValue || '').trim().toLowerCase();
  if (!value) return { deals: [], reason: 'empty-comm' };

  // В пилоте не трогаем другие сделки.
  const testId = String(config.clientDocsTestDealId || '').trim();
  if (!config.clientDocsAllDeals && !testId) {
    return { deals: [], reason: 'pilot-no-test-deal' };
  }

  let dup = {};
  try {
    dup = await bitrixRestCall('crm.duplicate.findbycomm', { type, values: [value] });
  } catch (_) {}

  const contactIds = [...new Set(actsArrayIds(dup && (dup.CONTACT || dup.contact)).map(String))];
  const companyIds = [...new Set(actsArrayIds(dup && (dup.COMPANY || dup.company)).map(String))];
  const serviceField = config.serviceFieldCode || process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071';
  const dealSelect = ['ID','TITLE','CATEGORY_ID','STAGE_ID','STAGE_SEMANTIC_ID','CLOSED','ASSIGNED_BY_ID','CONTACT_ID','COMPANY_ID','MOVED_TIME','DATE_MODIFY',serviceField];

  const all = [];
  async function addDeals(filter) {
    try {
      const rows = await bitrixRestList('crm.deal.list', {
        filter: { CATEGORY_ID: config.autopilotCategoryId || 28, ...filter },
        select: dealSelect,
        order: { DATE_MODIFY: 'DESC' },
      }, 80);
      all.push(...rows);
    } catch (_) {}
  }

  for (const id of contactIds.slice(0, 10)) await addDeals({ CONTACT_ID: id });
  for (const id of companyIds.slice(0, 10)) await addDeals({ COMPANY_ID: id });

  // SPK CJM: эксперт может заполнить «доп.email», откуда тоже должны забираться документы.
  if (type === 'EMAIL') {
    const extraEmailField = await clientDocsFindExtraEmailField();
    if (extraEmailField) await addDeals({ [extraEmailField]: value });
  }

  // Если duplicate.findbycomm не сработал, в тесте можно проверить конкретную сделку,
  // но ТОЛЬКО если телефон/email действительно принадлежит её контакту/компании.
  if (!all.length && testId) {
    try {
      const d = await bitrixRestCall('crm.deal.get', { id: testId });
      if (d && await clientDocsCommMatchesDeal(d, type, value)) all.push(d);
    } catch (_) {}
  }

  const seen = new Set();
  const unique = [];
  for (const d of all) {
    if (!d || seen.has(String(d.ID))) continue;
    seen.add(String(d.ID));
    if (String(d.CLOSED || '').toUpperCase() === 'Y' || ['S','F'].includes(String(d.STAGE_SEMANTIC_ID || '').toUpperCase())) continue;
    if (!config.clientDocsAllDeals && testId && String(d.ID) !== testId) continue;
    const service = await resolveDealServiceName(d);
    if (!clientDocsTargetService(service)) continue;
    d.__clientDocsService = service;
    unique.push(d);
  }

  if (!unique.length) return { deals: [], reason: 'no-target-active-deal' };

  // Защита от телефона/email, который привязан к нескольким разным компаниям.
  if (config.clientDocsAllDeals) {
    const companies = new Set(unique.map((d) => String(d.COMPANY_ID || `contact:${d.CONTACT_ID || '?'}`)));
    if (companies.size > 1) {
      console.warn(`[client-docs] ${type} совпал сразу с ${companies.size} компаниями — авторазбор не выполняю.`);
      return { deals: [], reason: 'ambiguous-multiple-companies' };
    }
  }

  const prep = getPreparationStageId();
  const priority = (d) => String(d.STAGE_ID) === String(prep) ? 0
    : String(d.STAGE_ID) === String(STAGE_IDS.expertAssigned) ? 1
    : 2;
  unique.sort((a,b) => priority(a) - priority(b) || new Date(b.DATE_MODIFY || b.MOVED_TIME || 0) - new Date(a.DATE_MODIFY || a.MOVED_TIME || 0));
  return { deals: unique, reason: 'ok' };
}

function clientDocsClassifyByName(fileName) {
  const s = clientDocsNormalizeText(fileName);
  const rules = [
    [/диплом/, 'диплом'],
    [/трудов/, 'трудовая книжка'],
    [/аттестат/, 'аттестат специалиста'],
    [/паспорт/, 'паспорт'],
    [/устав/, 'устав'],
    [/свидетел.*регист|регистрац.*свидетел/, 'свидетельство о регистрации'],
    [/аренд.*помещ|помещ.*аренд|купл.*продаж.*помещ/, 'документ на помещение'],
    [/приказ/, 'приказ о назначении'],
    [/контракт|трудов.*договор/, 'контракт/трудовой договор'],
    [/стройдок.*счет|счет.*стройдок/, 'счёт Стройдокумент'],
    [/стройдок.*плат|плат.*стройдок/, 'платёжка Стройдокумент'],
    [/тех.*карт.*счет|счет.*тех.*карт/, 'счёт технологические карты'],
    [/тех.*карт.*плат|плат.*тех.*карт/, 'платёжка технологические карты'],
    [/тех.*карт/, 'технологическая карта'],
    [/поверк/, 'поверка средства измерений'],
    [/тех.*паспорт|паспорт.*си/, 'техпаспорт средства измерений'],
    [/накладн/, 'накладная'],
    [/книг.*провер/, 'книга учёта проверок'],
    [/заявлен|заявк/, 'заявление/заявка'],
  ];
  for (const [re,label] of rules) if (re.test(s)) return label;
  return 'другое';
}

// Старый почтовый код тоже вызывает classifyFileByName — v78 закрывает этот старый undefined helper.
function classifyFileByName(fileName) {
  return clientDocsClassifyByName(fileName);
}

async function clientDocsAnalyzeAttachment(buffer, fileName, contentType, messageText = '') {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  const isImage = ['jpg','jpeg','png','webp'].includes(ext) || /^image\//i.test(contentType || '');
  const isPdf = ext === 'pdf' || /^application\/pdf/i.test(contentType || '') || (buffer && buffer.subarray(0,4).toString() === '%PDF');

  if (!isImage && !isPdf) {
    return {
      documentType: clientDocsClassifyByName(fileName),
      person: null, organization: null, instrument: null,
      readable: null, confidence: 'low', fileName,
      notes: 'тип определён только по имени файла',
    };
  }

  const ai = resolveAiProvider();
  if (!ai.apiKey) {
    return {
      documentType: clientDocsClassifyByName(fileName),
      person: null, organization: null, instrument: null,
      readable: null, confidence: 'low', fileName,
      notes: 'AI key не задан',
    };
  }

  const prompt = [
    'Ты разбираешь входящие документы клиента MAVIS GROUP для услуг Аттестация организации и СПК.',
    'Определи тип документа максимально конкретно.',
    'Возможные типы: диплом, трудовая книжка, аттестат специалиста, паспорт, свидетельство о регистрации, устав, документ на помещение, приказ о назначении, контракт/трудовой договор, счёт Стройдокумент, платёжка Стройдокумент, счёт технологические карты, платёжка технологические карты, технологическая карта, поверка средства измерений, техпаспорт средства измерений, накладная средства измерений, договор аренды средства измерений, книга учёта проверок, заявление/заявка, другое.',
    'Если документ относится к человеку — извлеки ФИО. Если к средству измерений — название/тип прибора. Если видна организация — название.',
    'Не придумывай данные, которых не видно.',
    messageText ? `Текст сообщения клиента: ${String(messageText).slice(0,1200)}` : '',
    'Ответ ТОЛЬКО JSON: {"documentType":"...","person":"ФИО или null","organization":"название или null","instrument":"название СИ или null","readable":true|false,"confidence":"high|medium|low","notes":"коротко или null"}',
  ].filter(Boolean).join(' ');

  try {
    let content;
    if (isImage) {
      const mime = contentType || (ext === 'png' ? 'image/png' : 'image/jpeg');
      content = [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } },
      ];
    } else {
      content = [
        { type: 'file', file: { filename: fileName || 'document.pdf', file_data: `data:application/pdf;base64,${buffer.toString('base64')}` } },
        { type: 'text', text: prompt },
      ];
    }

    const response = await fetch(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { ...ai.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.aiModel,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content }],
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || `HTTP ${response.status}`);
    const text = data?.choices?.[0]?.message?.content || '{}';
    const obj = JSON.parse((text.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    return {
      documentType: String(obj.documentType || clientDocsClassifyByName(fileName)),
      person: obj.person || null,
      organization: obj.organization || null,
      instrument: obj.instrument || null,
      readable: obj.readable === false ? false : obj.readable === true ? true : null,
      confidence: String(obj.confidence || 'low').toLowerCase(),
      fileName,
      notes: obj.notes || null,
    };
  } catch (e) {
    return {
      documentType: clientDocsClassifyByName(fileName),
      person: null, organization: null, instrument: null,
      readable: null, confidence: 'low', fileName,
      notes: `AI-анализ не сработал: ${e.message || e}`,
    };
  }
}

async function clientDocsLoadState(dealId) {
  try {
    const comments = await bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      select: ['ID','COMMENT','DATE_CREATE'],
      order: { ID: 'DESC' },
    }, 80);
    for (const c of comments) {
      if (!String(c.COMMENT || '').includes(CLIENT_DOCS_STATE_MARKER)) continue;
      const obj = clientDocsParseMarkerJson(c.COMMENT, CLIENT_DOCS_STATE_MARKER);
      if (obj) return obj;
    }
  } catch (_) {}
  return { docs: [] };
}

function clientDocsMergeDocs(oldDocs, newDocs) {
  const result = [];
  const seen = new Set();
  for (const d of [...(Array.isArray(oldDocs) ? oldDocs : []), ...(Array.isArray(newDocs) ? newDocs : [])]) {
    if (!d) continue;
    const key = [
      clientDocsNormalizeText(d.documentType),
      clientDocsNormalizeText(d.person),
      clientDocsNormalizeText(d.instrument),
      clientDocsNormalizeText(d.fileName),
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(d);
  }
  return result.slice(-120);
}

async function clientDocsCheckCompleteness(deal, service, docs) {
  const docList = getDocumentListForService(service);
  const required = clientDocsRequiredDocs(docList);
  const system = 'Ты ИИ-ассистент MAVIS GROUP. Проверяешь комплектность документов по Аттестации/СПК. Отвечай только JSON. Ничего не выдумывай.';
  const user = `Услуга: ${service}
Обязательный перечень:
${JSON.stringify(required, null, 2)}

Ранее и сейчас распознанные документы:
${JSON.stringify(docs, null, 2)}

Правила:
- Если не можешь подтвердить документ по данным — считай, что его ещё не хватает.
- Для документов по специалистам учитывай ФИО: диплом/трудовая/аттестат одного человека не закрывает другого.
- Для СПК средства измерений и поверки оценивай отдельно.
- Не называй комплект полным при низкой уверенности в критичном документе.

Ответ JSON:
{
  "complete": true/false,
  "confidence": "high"|"medium"|"low",
  "received": ["конкретно что подтверждено"],
  "missing": ["КОНКРЕТНО чего не хватает"],
  "actions_per_person": ["ФИО — что уже есть / что ещё нужно"],
  "warnings": ["нечитаемо / неясно / требует ручной проверки"]
}`;
  try {
    const raw = await callAiChatCompletion({
      model: config.aiModel,
      temperature: 0.1,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    });
    let obj = {};
    try { obj = JSON.parse(raw); } catch (_) {
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      if (m) obj = JSON.parse(m[0]);
    }
    const confidence = String(obj.confidence || 'low').toLowerCase();
    return {
      complete: !!obj.complete && confidence !== 'low',
      confidence,
      received: Array.isArray(obj.received) ? obj.received.map(String) : [],
      missing: Array.isArray(obj.missing) ? obj.missing.map(String) : required,
      actions_per_person: Array.isArray(obj.actions_per_person) ? obj.actions_per_person.map(String) : [],
      warnings: Array.isArray(obj.warnings) ? obj.warnings.map(String) : [],
      docList,
    };
  } catch (e) {
    console.warn(`[client-docs] deal=${deal.ID}: комплектность не определена: ${e.message || e}`);
    return null;
  }
}

function clientDocsBuildClientUpdate(results) {
  const greeting = actsMinskGreeting();
  const lines = [greeting, '', 'Документы получили, спасибо. Зафиксировали их в работе.'];

  for (const r of results) {
    lines.push('', `По услуге «${r.service}»:`);
    if (r.completeness && r.completeness.received.length) {
      lines.push('Получено и распознано:');
      r.completeness.received.slice(0, 12).forEach((x) => lines.push(`• ${x}`));
    }
    if (r.completeness && r.completeness.complete) {
      lines.push('Предварительно комплект собран. Передали эксперту на контроль.');
    } else if (r.completeness && r.completeness.missing.length) {
      lines.push('Ещё необходимо предоставить:');
      r.completeness.missing.slice(0, 20).forEach((x) => lines.push(`• ${x}`));
    } else {
      lines.push('Эксперт дополнительно проверит комплект и сообщит, если потребуется что-то дослать.');
    }
  }

  lines.push('', 'Документы, пожалуйста, направляйте на нашу почту: mavis.group@mail.ru');
  return lines.join('\n').trim();
}

async function clientDocsNotifyExpert(deal, source, analyzedDocs, completeness) {
  const expertId = String(deal.ASSIGNED_BY_ID || '');
  if (!expertId) return;
  const files = analyzedDocs.map((d) => `${d.fileName}: ${d.documentType}${d.person ? ` (${d.person})` : ''}`).join('; ');
  const missing = completeness && completeness.missing && completeness.missing.length
    ? completeness.missing.slice(0, 8).join('; ')
    : 'по автоматической проверке критичного недостающего не выявлено';
  const msg = `ИИгорь: по сделке «${deal.TITLE}» пришли документы через ${source}. Сохранил в папку компании. Распознано: ${files}. Не хватает: ${missing}.`;
  try {
    await bitrixRestCall('im.notify.personal.add', {
      USER_ID: Number(expertId),
      MESSAGE: msg,
      MESSAGE_OUT: msg,
    });
  } catch (_) {}
}

async function clientDocsProcessIncomingAttachments({ source, commType, commValue, messageText = '', attachments = [] }) {
  if (!config.clientDocsIncomingEnabled || !attachments.length) return { ok: true, processed: 0 };
  const match = await clientDocsFindDealsByComm(commType, commValue);
  if (!match.deals.length) {
    console.log(`[client-docs] ${source}: подходящая активная Аттестация/СПК не найдена (${match.reason}).`);
    return { ok: true, processed: 0, reason: match.reason };
  }

  const deals = match.deals;
  const primary = deals[0];
  const companyName = primary.COMPANY_ID ? await getCompanyName(primary.COMPANY_ID) : (primary.TITLE || `Сделка ${primary.ID}`);
  const folderId = await getOrCreateCompanyFolder(companyName || `Сделка ${primary.ID}`);

  const analyzedDocs = [];
  const savedNames = [];
  for (const att of attachments) {
    const fileName = actsSafeFileName(att.fileName || `document_${Date.now()}`);
    const buffer = Buffer.isBuffer(att.buffer) ? att.buffer : Buffer.from(att.buffer || '');
    if (!buffer.length) continue;
    try {
      await uploadFileToDiskFolder(folderId, fileName, buffer);
      savedNames.push(fileName);
    } catch (e) {
      console.warn(`[client-docs] ${source}: не сохранил ${fileName}: ${e.message || e}`);
    }
    const analysis = await clientDocsAnalyzeAttachment(buffer, fileName, att.contentType || '', messageText);
    analyzedDocs.push(analysis);
    console.log(`[client-docs] ${source}: ${fileName} → ${analysis.documentType}, person=${analysis.person || '-'}, confidence=${analysis.confidence}`);
  }

  if (!savedNames.length && !analyzedDocs.length) return { ok: true, processed: 0, reason: 'empty-files' };

  const resultPerDeal = [];
  const nowIso = new Date().toISOString();

  for (const deal of deals) {
    try {
      const service = deal.__clientDocsService || await resolveDealServiceName(deal);
      const oldState = await clientDocsLoadState(deal.ID);
      const mergedDocs = clientDocsMergeDocs(oldState.docs, analyzedDocs);
      const completeness = await clientDocsCheckCompleteness(deal, service, mergedDocs);

      const statePayload = {
        at: nowIso,
        source,
        companyName,
        service,
        docs: mergedDocs,
        complete: completeness ? completeness.complete : false,
        missing: completeness ? completeness.missing : [],
      };
      const receivedPayload = {
        at: nowIso,
        source,
        files: savedNames,
      };

      const receivedText = analyzedDocs.map((d) =>
        `— ${d.fileName}: ${d.documentType}${d.person ? ` — ${d.person}` : ''}${d.instrument ? ` — ${d.instrument}` : ''}`
      ).join('\n');
      const missingText = completeness && completeness.missing.length
        ? completeness.missing.map((x) => `— ${x}`).join('\n')
        : '— предварительно не выявлено';
      const actionsText = completeness && completeness.actions_per_person.length
        ? `\n\nПо специалистам:\n${completeness.actions_per_person.map((x) => `— ${x}`).join('\n')}`
        : '';
      const warningsText = completeness && completeness.warnings.length
        ? `\n\nНужно проверить вручную:\n${completeness.warnings.map((x) => `— ${x}`).join('\n')}`
        : '';

      await bitrixRestCall('crm.timeline.comment.add', {
        fields: {
          ENTITY_ID: deal.ID,
          ENTITY_TYPE: 'deal',
          COMMENT: `${CLIENT_DOCS_RECEIVED_MARKER}\n${JSON.stringify(receivedPayload)}\n\n📨 ИИгорь получил документы через ${source} и сохранил их в папку компании.\n${receivedText}\n\nНе хватает:\n${missingText}${actionsText}${warningsText}\n\n${CLIENT_DOCS_STATE_MARKER}\n${JSON.stringify(statePayload)}`,
        },
      });

      pendingDocsCheck.delete(String(deal.ID)); // первый пуш уже не нужен: клиент что-то прислал
      await clientDocsNotifyExpert(deal, source, analyzedDocs, completeness);
      resultPerDeal.push({ deal, service, completeness });
    } catch (e) {
      console.warn(`[client-docs] deal=${deal.ID}: ${e.message || e}`);
    }
  }

  if (resultPerDeal.length) {
    const updateText = clientDocsBuildClientUpdate(resultPerDeal);
    const send = await sendClientTextByPreferredChannel(primary, updateText, `Получены документы: ${primary.TITLE}`).catch((e) => ({ ok:false, error:e.message || String(e) }));
    await bitrixRestCall('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: primary.ID,
        ENTITY_TYPE: 'deal',
        COMMENT: `[MAVIS_CLIENT_DOCS_REPLY]\nИИгорь: ${send.ok ? `отправил клиенту обновлённый статус через ${send.channel}` : `не смог отправить клиенту обновлённый статус: ${send.error || 'ошибка'}`}.`,
      },
    }).catch(() => {});
  }

  return { ok: true, processed: savedNames.length || analyzedDocs.length, deals: resultPerDeal.map((x) => x.deal.ID) };
}

async function clientDocsProcessIncomingWazzupMessage(msg) {
  const phone = normalizePhoneDigits((msg.contact && msg.contact.phone) || msg.chatId || '');
  if (!phone) return { ok: true, processed: 0, reason: 'no-phone' };
  const channel = String(msg.chatType || findChannelKeyByChannelId(msg.channelId) || 'Wazzup');
  const fallbackExt = String(msg.type || '').toLowerCase() === 'image' ? '.jpg' : '.pdf';
  const fromUrl = actsIncomingFileNameFromUrl(msg.contentUri, '');
  const fallback = fromUrl || `Документ_${phone.slice(-4)}_${Date.now()}${fallbackExt}`;
  const downloaded = await actsDownloadIncomingUrl(msg.contentUri, fallback);
  console.log(`[client-docs] Wazzup ${channel}: inbound ${downloaded.fileName}, phone=***${phone.slice(-4)}`);
  return clientDocsProcessIncomingAttachments({
    source: /^viber$/i.test(channel) ? 'Viber' : /^telegram$/i.test(channel) ? 'Telegram' : 'Wazzup',
    commType: 'PHONE',
    commValue: phone,
    messageText: msg.text || '',
    attachments: [downloaded],
  });
}

// ======================= /v78: CJM БЛОКИ 3–4 ================================

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
  if (/^\d+$/.test(attachedId)) ids.push(`n${attachedId}`);
  return ids;
}


// v67: короткоживущий прокси реального бинарного файла для Wazzup.
// Нельзя передавать Wazzup Bitrix urlDownload напрямую: URL часто заканчивается на .php,
// и мессенджер может получить/назвать вложение как PHP вместо исходного .docx/.pdf.
// Wazzup API принимает только contentUri, поэтому сервер сам скачивает бинарные байты Bitrix,
// проверяет, что это не HTML/PHP-страница, и отдаёт их Wazzup по URL с исходным именем и MIME.
const ACTS_FILE_CACHE_TTL_MS = 15 * 60 * 1000;
const actsFileProxyCache = new Map();

function actsSafeFileName(name) {
  const clean = String(name || 'act-file').replace(/[\\/\0\r\n]/g, '_').trim();
  return clean || 'act-file';
}

function actsMimeByFileName(name, upstreamType = '') {
  const ext = path.extname(String(name || '')).toLowerCase();
  const byExt = {
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.doc': 'application/msword',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.rtf': 'application/rtf',
    '.txt': 'text/plain; charset=utf-8',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
  };
  return byExt[ext] || (String(upstreamType || '').split(';')[0].trim() || 'application/octet-stream');
}

function actsBitrixOrigin() {
  try { return new URL(config.bitrixWebhookUrl).origin; } catch (_) { return 'https://mavisgroup.bitrix24.by'; }
}

function actsAbsoluteBitrixFileUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return '';
  try { return new URL(value).toString(); } catch (_) {}
  try { return new URL(value, `${actsBitrixOrigin()}/`).toString(); } catch (_) { return value; }
}

async function actsFetchBinaryFromUrl(sourceUrl, fileName) {
  const origin = actsBitrixOrigin();
  const response = await fetch(sourceUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      // Bitrix рекомендует browser-like User-Agent/Accept/Referer при скачивании DOWNLOAD_URL.
      'User-Agent': 'Mozilla/5.0 (compatible; MAVIS-Expert-Assistant/1.0; +https://mavisgroup.by)',
      'Accept': 'application/octet-stream,application/pdf,application/zip,*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.7',
      'Referer': `${origin}/`,
    },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('пустой ответ');
  if (buffer.length > 10 * 1024 * 1024) throw new Error('файл больше 10 МБ');

  // Защита от страницы авторизации/скрипта вместо бинарного документа.
  const head = buffer.subarray(0, Math.min(buffer.length, 512)).toString('utf8').trim().toLowerCase();
  if (head.startsWith('<?php') || head.startsWith('<!doctype html') || head.startsWith('<html') || head.includes('<body')) {
    throw new Error('вместо файла получена HTML/PHP-страница');
  }

  return {
    buffer,
    contentType: actsMimeByFileName(fileName, response.headers.get('content-type') || ''),
    upstreamType: response.headers.get('content-type') || 'unknown',
  };
}

async function actsDownloadRealFile(file) {
  let fileName = actsSafeFileName(file && file.name);
  const attempts = [];

  // 1) Сначала URL из task chat / attached object.
  const directUrl = actsAbsoluteBitrixFileUrl(file && file.url);
  if (directUrl) attempts.push({ label: 'task-url', url: directUrl });

  // 2) Если в чате есть реальный Disk file ID, просим у Bitrix официальный DOWNLOAD_URL.
  const diskId = String(file && file.id || '').trim();
  if (/^\d+$/.test(diskId)) {
    try {
      const diskFile = await bitrixRestCall('disk.file.get', { id: Number(diskId) });
      const diskUrl = actsAbsoluteBitrixFileUrl(diskFile && (diskFile.DOWNLOAD_URL || diskFile.downloadUrl));
      if (diskUrl && !attempts.some((x) => x.url === diskUrl)) attempts.push({ label: 'disk.file.get', url: diskUrl });
      const diskName = actsSafeFileName(diskFile && (diskFile.NAME || diskFile.name) || fileName);
      if ((!file || !file.name) && diskName) fileName = diskName;
    } catch (e) {
      console.warn(`[acts-file-download] disk.file.get id=${diskId} не сработал: ${e.message || e}`);
    }
  }

  if (!attempts.length) throw new Error(`У файла «${fileName}» нет URL для скачивания из Bitrix.`);

  let lastError = '';
  for (const attempt of attempts) {
    try {
      const result = await actsFetchBinaryFromUrl(attempt.url, fileName);
      console.log(`[acts-file-download] ${fileName}: ${result.buffer.length} bytes; type=${result.contentType}; source=${attempt.label}; upstream=${result.upstreamType}`);
      return { buffer: result.buffer, fileName, contentType: result.contentType };
    } catch (e) {
      lastError = `${attempt.label}: ${e.message || e}`;
      console.warn(`[acts-file-download] ${fileName}: ${lastError}`);
    }
  }

  throw new Error(`Не удалось скачать реальный файл «${fileName}» из Bitrix (${lastError}). Клиенту ничего не отправлено.`);
}

function actsCleanupFileProxyCache() {
  const now = Date.now();
  for (const [token, item] of actsFileProxyCache.entries()) {
    if (!item || item.expiresAt <= now) actsFileProxyCache.delete(token);
  }
}

async function actsPrepareWazzupFile(file) {
  actsCleanupFileProxyCache();
  const downloaded = await actsDownloadRealFile(file);
  const token = crypto.randomBytes(24).toString('hex');
  actsFileProxyCache.set(token, { ...downloaded, expiresAt: Date.now() + ACTS_FILE_CACHE_TTL_MS });
  const publicUrl = `${config.actsPublicBaseUrl}/api/acts/file/${token}/${encodeURIComponent(downloaded.fileName)}`;
  console.log(`[acts-file-proxy] Готов реальный файл для Wazzup: ${downloaded.fileName}; ${downloaded.buffer.length} bytes; TTL=15m.`);
  return { url: publicUrl, ...downloaded };
}

// Публичный короткоживущий endpoint нужен именно Wazzup: их API сам скачивает contentUri.
// Токен криптографически случайный, ссылка живёт 15 минут, Cache-Control запрещает кеширование.
app.get('/api/acts/file/:token/:filename', (req, res) => {
  actsCleanupFileProxyCache();
  const item = actsFileProxyCache.get(String(req.params.token || ''));
  if (!item || item.expiresAt <= Date.now()) return res.status(404).send('File expired or not found');

  res.setHeader('Content-Type', item.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', String(item.buffer.length));
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.fileName)}`);
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(200).send(item.buffer);
});

async function sendActEmailThroughBitrix(deal, contactId, toEmail, text, file) {
  const dealId = deal.ID;
  const responsibleId = deal.ASSIGNED_BY_ID || 1;
  let staff = null;
  try {
    const u = await bitrixRestCall('user.get', { ID: responsibleId });
    staff = Array.isArray(u) ? u[0] : u;
  } catch (_) {}

  const fields = {
    TYPE_ID: 4,
    SUBJECT: `Акт по сделке: ${deal.TITLE || dealId}`,
    DESCRIPTION: text + (file && file.url ? `

Ссылка на файл акта: ${file.url}` : ''),
    DESCRIPTION_TYPE: 1,
    DIRECTION: 2,
    OWNER_TYPE_ID: 2,
    OWNER_ID: dealId,
    RESPONSIBLE_ID: responsibleId,
    COMPLETED: 'Y',
    START_TIME: new Date().toISOString(),
    END_TIME: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    COMMUNICATIONS: [{ VALUE: toEmail, ENTITY_ID: Number(contactId || 0), ENTITY_TYPE_ID: 3, TYPE: 'EMAIL' }],
  };

  if (staff && staff.EMAIL) {
    const senderName = `${staff.NAME || ''} ${staff.LAST_NAME || ''}`.trim() || config.emailSenderName || 'MAVIS GROUP';
    fields.SETTINGS = { MESSAGE_FROM: `${senderName} <${staff.EMAIL}>` };
  }

  const storageIds = actsBuildEmailStorageElementIds(file);
  if (storageIds.length) {
    fields.STORAGE_TYPE_ID = 3;
    fields.STORAGE_ELEMENT_IDS = storageIds;
  }

  return await bitrixRestCall('crm.activity.add', { fields });
}


async function actsSendActToClientByPreferredChannel({ deal, task, file }) {
  if (!config.actsSendToClientEnabled) {
    return { skipped: true, message: 'ACTS_SEND_TO_CLIENT_ENABLED=false' };
  }

  // v84 HARD BLOCK: без реального файла акта клиенту не уходит НИ текст, НИ письмо.
  // Раньше file.url мог существовать, текст уже уходил, а фактическое скачивание файла падало позже.
  if (!file || !file.url) {
    return { ok: false, skipped: true, message: 'В задаче не найден файл акта. Автоотправка полностью заблокирована: пустое сообщение клиенту не отправляю.' };
  }

  const preferredChannel = await detectPreferredChannelResolved(deal);
  if (!preferredChannel) {
    const pref = preferredRawValue(deal);
    return { ok: false, skipped: true, message: `В сделке не распознано поле «Предпочитаемый канал связи» (поле ${pref.code || 'не найдено'}, значение ${String(pref.raw || 'пусто')}). Нужно выбрать Email / Telegram / Viber.` };
  }

  // v84: при нескольких контактах выбираем того, с кем была последняя переписка.
  const recipient = await actsResolveRecipientContact(deal);
  if (!recipient.ok) {
    return { ok: false, skipped: true, channel: preferredChannelLabel(preferredChannel), message: recipient.reason || 'Не удалось определить актуальный контакт для отправки.' };
  }

  const text = actsBuildClientMessage(deal, task, file);
  const taskId = String(actsTaskField(task, ['id','ID']) || '');
  const contactId = String(recipient.contactId || '');

  if (preferredChannel === 'email') {
    const email = actsContactEmail(recipient.contact);
    if (!email) {
      return { ok: false, skipped: true, channel: 'Email', contactId, message: `Выбран актуальный контакт «${recipient.label}», но у него нет email. На email компании/другого контакта автоматически НЕ переключаюсь.` };
    }

    // Для email требуем именно прикрепляемый Bitrix-файл, а не просто ссылку.
    const storageIds = actsBuildEmailStorageElementIds(file);
    if (!storageIds.length) {
      return { ok: false, skipped: true, channel: 'Email', contactId, message: 'Файл найден, но Bitrix не дал attachment-id для вложения в письмо. Пустое письмо без акта не отправляю.' };
    }
    try {
      await actsDownloadRealFile(file); // валидация: URL реально отдаёт бинарный файл, а не HTML/PHP-заглушку
    } catch (e) {
      return { ok: false, skipped: true, channel: 'Email', contactId, message: `Файл акта не удалось скачать/проверить (${e.message || e}). Письмо без файла не отправляю.` };
    }

    await sendActEmailThroughBitrix(deal, contactId, email, text, file);
    return {
      ok: true,
      channel: 'Email',
      contactId,
      contactLabel: recipient.label,
      recipientSource: recipient.source,
      email: maskEmailForLog(email),
      file: { name: file.name, id: file.id || '', attachedId: file.attachedId || '' },
      note: `Письмо отправлено через Bitrix (COMPLETED=Y) контакту «${recipient.label}».`,
    };
  }

  const phone = actsContactPhone(recipient.contact);
  if (!phone) {
    return { ok: false, skipped: true, channel: preferredChannelLabel(preferredChannel), contactId, message: `Выбран актуальный контакт «${recipient.label}», но у него нет телефона. На другого контакта автоматически НЕ переключаюсь.` };
  }

  const ch = getConfiguredWazzupChannel(preferredChannel);
  if (!ch || !ch.channelId || ch.key !== preferredChannel) {
    return { ok: false, skipped: true, channel: preferredChannelLabel(preferredChannel), contactId, message: `В сделке выбран ${preferredChannelLabel(preferredChannel)}, но именно этот Wazzup-канал не настроен в Render. На другой канал автоматически НЕ переключаюсь.` };
  }

  const textMarker = `[MAVIS_ACTS_TEXT_SENT] task=${taskId}`;
  const fileMarker = `[MAVIS_ACTS_FILE_SENT] task=${taskId}`;
  const textAlreadySent = taskId ? await fgTimelineHasMarker(deal.ID, textMarker, 50) : false;
  const fileAlreadySent = taskId ? await fgTimelineHasMarker(deal.ID, fileMarker, 50) : false;

  let textResult = null;
  let fileResult = null;
  let preparedFile = null;

  // v84: сначала убеждаемся, что реальный файл можно скачать и подготовить.
  // Только после успешной проверки разрешаем вообще отправлять клиенту что-либо.
  if (!fileAlreadySent) {
    try {
      preparedFile = await actsPrepareWazzupFile(file);
    } catch (e) {
      return {
        ok: false,
        skipped: true,
        channel: preferredChannelLabel(preferredChannel),
        contactId,
        message: `Не удалось подготовить реальный файл акта (${e.message || e}). Сообщение без файла клиенту НЕ отправлено.`,
      };
    }
  }

  try {
    // Сначала отправляем файл. Если Wazzup отверг файл — текст не уйдёт и не будет "пустого" сообщения.
    if (!fileAlreadySent) {
      fileResult = await sendWazzupFileInternal({
        channelKey: preferredChannel,
        contentUri: preparedFile.url,
        phone,
        dealId: deal.ID,
        fileName: preparedFile.fileName,
        crmMessageId: taskId ? `mavis-acts-file-${preferredChannel}-${deal.ID}-${taskId}` : '',
      });
      if (taskId) {
        await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${fileMarker}\nТехнический маркер: файл акта успешно отправлен через ${preferredChannelLabel(preferredChannel)} контакту #${contactId}.` } });
      }
    }

    // Текст отправляем только если файл уже был отправлен раньше или только что успешно ушёл.
    if (!textAlreadySent) {
      textResult = await sendWazzupMessageInternal({
        channelKey: preferredChannel,
        text,
        phone,
        dealId: deal.ID,
        ignoreStrictPreferredChannel: true,
        crmMessageId: taskId ? `mavis-acts-text-${preferredChannel}-${deal.ID}-${taskId}` : '',
      });
      if (taskId) {
        await bitrixRestCall('crm.timeline.comment.add', { fields: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal', COMMENT: `${textMarker}\nТехнический маркер: текст сообщения по акту успешно отправлен через ${preferredChannelLabel(preferredChannel)} контакту #${contactId}.` } });
      }
    }
  } catch (e) {
    return {
      ok: false,
      channel: preferredChannelLabel(preferredChannel),
      contactId,
      contactLabel: recipient.label,
      error: e.message || String(e),
      possiblyDelivered: Boolean(e.possiblyDelivered),
      partial: { textSent: textAlreadySent || Boolean(textResult), fileSent: fileAlreadySent || Boolean(fileResult) },
    };
  }

  return {
    ok: true,
    channel: (fileResult && fileResult.channel && fileResult.channel.label) || (textResult && textResult.channel && textResult.channel.label) || preferredChannelLabel(preferredChannel),
    contactId,
    contactLabel: recipient.label,
    recipientSource: recipient.source,
    phone: phone.replace(/(\d{3})\d+(\d{3})$/, '$1***$2'),
    file: { name: file.name, id: file.id || '', attachedId: file.attachedId || '' },
    partial: { textSent: true, fileSent: true },
  };
}


// legacy-name wrapper, чтобы старые ручные вызовы/логи не ломались
async function actsSendActToClientViaWazzup(args) {
  return actsSendActToClientByPreferredChannel(args);
}

async function actsHandleTaskDone(taskId, source = 'task-done-robot', options = {}) {
  if (!config.actsTasksEnabled) return { ok: false, skipped: true, message: 'ACTS_TASKS_ENABLED=false' };
  if (!config.actsProjectId) throw new Error('ACTS_PROJECT_ID не задан');

  // Bitrix24 does NOT return UF_CRM_TASK / UF_TASK_WEBDAV_FILES from tasks.task.get by default.
  // They must be explicitly selected, otherwise the task loses both its CRM deal binding
  // and its attached Disk files at this stage of the acts flow.
  const raw = await bitrixRestCall('tasks.task.get', {
    taskId,
    select: [
      'ID', 'TITLE', 'DESCRIPTION', 'GROUP_ID', 'STAGE_ID', 'STATUS', 'REAL_STATUS',
      'RESPONSIBLE_ID', 'CREATED_DATE', 'CHANGED_DATE', 'CHAT_ID',
      'UF_CRM_TASK', 'UF_TASK_WEBDAV_FILES'
    ],
  });
  const task = raw && (raw.task || raw.TASK || raw);
  if (!task) throw new Error(`Задача ${taskId} не найдена`);

  const groupId = actsTaskField(task, ['groupId','GROUP_ID','group_id']);
  if (String(groupId) !== String(config.actsProjectId)) {
    return { ok: false, skipped: true, taskId: String(taskId), groupId: String(groupId || ''), message: `Задача не из проекта Акты счета #${config.actsProjectId}` };
  }

  const taskStageId = actsTaskField(task, ['stageId','STAGE_ID','stage_id']);
  const requiredDoneStageId = String(config.actsDoneStageId || actsResolvedDoneStageId || await actsResolveDoneStageId() || '');
  if (!options.allowHistoricalDone && requiredDoneStageId && String(taskStageId || '') !== requiredDoneStageId) {
    return { ok: false, skipped: true, taskId: String(taskId), stageId: String(taskStageId || ''), message: `Задача не на стадии Сделано (${requiredDoneStageId})` };
  }

  const dealIds = actsExtractDealIdsFromTask(task);
  const fileResolution = await actsResolveTaskFiles(task);
  const files = fileResolution.files || [];
  const fileForClient = actsPickBestFileForClient(files);
  const crmBindingForLog = actsTaskField(task, ['ufCrmTask','UF_CRM_TASK','UF_CRM_TASKS','crm','CRM']);
  const webdavForLog = actsTaskField(task, ['ufTaskWebdavFiles','UF_TASK_WEBDAV_FILES']);
  const chatIdForLog = actsTaskField(task, ['chatId','CHAT_ID','chat_id']);
  console.log(`[acts] task=${taskId}: CRM=${JSON.stringify(crmBindingForLog || [])}; dealIds=${JSON.stringify(dealIds)}; webdav=${JSON.stringify(webdavForLog || [])}; chatId=${chatIdForLog || 'нет'}; files=${files.map(f => `${f.name || f.id}[${f.source || '?'}]${f.url ? ':url' : ':no-url'}`).join(', ') || 'нет'}${fileResolution.chatError ? '; chatError=' + fileResolution.chatError : ''}${fileResolution.diskErrors && fileResolution.diskErrors.length ? '; diskErrors=' + fileResolution.diskErrors.join(' || ') : ''}`);
  const title = actsTaskField(task, ['title','TITLE']) || '';
  const doneMarker = `${ACTS_TASK_DONE_MARKER} task=${taskId}`;
  const sentMarker = `${ACTS_TASK_SENT_MARKER} task=${taskId}`;
  const failedMarker = `${ACTS_TASK_SEND_FAILED_MARKER} task=${taskId}`;

  if (!dealIds.length) {
    return { ok: false, skipped: true, taskId: String(taskId), title, files, message: 'Не нашёл ID сделки производства в задаче. Проверь, что задача создана ИИгорем или в описании есть ссылка/ID сделки.' };
  }

  const allowedDealIds = config.actsAllDeals
    ? dealIds
    : dealIds.filter((id) => String(id) === String(config.actsTestDealId || ''));
  if (!allowedDealIds.length) {
    return {
      ok: false,
      skipped: true,
      taskId: String(taskId),
      title,
      dealIds: dealIds.map(String),
      message: `Безопасный режим актов: разрешена только тестовая сделка ${config.actsTestDealId || 'не задана'}. Для массового режима нужно явно ACTS_ALL_DEALS=true.`,
    };
  }

  const results = [];
  for (const dealId of allowedDealIds) {
    const alreadySent = await fgTimelineHasMarker(dealId, sentMarker, 50);
    if (alreadySent) {
      results.push({ dealId: String(dealId), duplicate: true, message: 'Этот акт уже был успешно отправлен ранее, повторно клиенту не отправляю.' });
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
    if (!fileForClient && fileResolution.diskErrors && fileResolution.diskErrors.some((x) => /insufficient_scope/i.test(x))) {
      sendResult = {
        ok: false,
        skipped: true,
        error: 'Bitrix видит ID файла, но вебхуку не хватает scope DISK/Диск, чтобы получить ссылку скачивания. Добавь право Диск во входящий вебхук.',
      };
    } else if (!fileForClient && fileResolution.chatError && /insufficient_scope/i.test(fileResolution.chatError)) {
      sendResult = {
        ok: false,
        skipped: true,
        error: 'Bitrix-вебхуку не хватает scope IM/Чаты для чтения файла из task chat. Если файл есть в «Результате задачи», v66 сначала попробует его через task+disk; иначе добавь право Чаты и уведомления (IM) во входящий вебхук.',
      };
    } else {
      try {
        sendResult = await actsSendActToClientByPreferredChannel({ deal, task, file: fileForClient });
      } catch (e) {
        sendResult = { ok: false, error: e.message || String(e), possiblyDelivered: Boolean(e.possiblyDelivered) };
      }
    }

    const fileLines = files.length
      ? files.map((f) => `— ${f.name || f.id}${f.url ? `\n  ${f.url}` : ''}`).join('\n')
      : 'Файлы в задаче через API не увидел. Проверь вложения в задаче вручную.';
    const sendLines = sendResult && sendResult.ok
      ? `✅ Клиенту отправлено через ${sendResult.channel || 'предпочитаемый канал'}: сообщение + файл акта.\nФайл: ${sendResult.file && sendResult.file.name ? sendResult.file.name : (fileForClient && fileForClient.name || 'акт')}\nКонтакт: ${sendResult.contactLabel || 'не определён'} (#${sendResult.contactId || '?'}) — ${sendResult.phone || sendResult.email || 'скрыт'}${sendResult.note ? `\nПримечание: ${sendResult.note}` : ''}`
      : `⚠️ Клиенту НЕ отправлено автоматически.\nПричина: ${(sendResult && (sendResult.message || sendResult.error)) || 'неизвестная ошибка'}\nЧто проверить: поле «Предпочитаемый канал связи», наличие актуального контакта по последней переписке, телефон/email этого контакта, настройки Wazzup Telegram/Viber и файл акта в задаче.`;

    const pushStateLine = sendResult && sendResult.ok
      ? `\n${ACTS_PUSH_STATE_MARKER} task=${taskId} channel=${actsNormalizeChannelKey(sendResult.channel)} contactId=${sendResult.contactId || ''} sentAt=${new Date().toISOString()}`
      : '';
    await bitrixRestCall('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId,
        ENTITY_TYPE: 'deal',
        COMMENT: `${sendResult && sendResult.ok ? sentMarker : failedMarker}\n${doneMarker}${pushStateLine}\nЗадача по акту в проекте «Акты счета» перешла на стадию «Сделано».\n\nЗадача: ${title || taskId}\nСсылка на задачу: ${actsTaskUrl(taskId)}\n\nФайлы, которые нашёл в задаче:\n${fileLines}\n\n${sendLines}`,
      },
    });
    if (sendResult && sendResult.ok) {
      await actsRegisterPushState({ taskId, dealId, channel: sendResult.channel, contactId: sendResult.contactId || '', sentAtMs: Date.now(), originalFileName: fileForClient && fileForClient.name || '' });
    }
    results.push({ dealId: String(dealId), commentAdded: true, sent: sendResult });
  }

  return { ok: true, event: 'acts_task_done_processed_and_sent_by_preferred_channel', source, taskId: String(taskId), title, dealIds: allowedDealIds.map(String), files, fileForClient, results };
}

app.post('/api/acts/task-done', async (req, res) => {
  try {
    const taskId = actsReqTaskId(req);
    console.log(`[acts-task-done] POST вызван${taskId ? `, task=${taskId}` : ', но task_id не найден'}.`);
    if (!taskId) return res.status(400).json({ ok: false, error: 'task_id не передан' });
    const result = await actsHandleTaskDone(taskId, 'task-done-post');
    console.log(`[acts-task-done] task=${taskId}: ${JSON.stringify({ ok: result.ok, event: result.event, dealIds: result.dealIds, results: result.results && result.results.map(x => ({ dealId: x.dealId, duplicate: x.duplicate, sent: x.sent && { ok: x.sent.ok, channel: x.sent.channel, message: x.sent.message, error: x.sent.error } })) })}`);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (e) {
    console.error('[acts-task-done]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/api/acts/task-done', async (req, res) => {
  try {
    const taskId = actsReqTaskId(req);
    console.log(`[acts-task-done] GET вызван${taskId ? `, task=${taskId}` : ', но task_id не найден'}.`);
    if (!taskId) return res.status(400).json({ ok: false, error: 'task_id не передан' });
    const result = await actsHandleTaskDone(taskId, 'task-done-get');
    console.log(`[acts-task-done] task=${taskId}: ${JSON.stringify({ ok: result.ok, event: result.event, dealIds: result.dealIds, results: result.results && result.results.map(x => ({ dealId: x.dealId, duplicate: x.duplicate, sent: x.sent && { ok: x.sent.ok, channel: x.sent.channel, message: x.sent.message, error: x.sent.error } })) })}`);
    res.status(result.ok ? 200 : 422).json(result);
  } catch (e) {
    console.error('[acts-task-done-get]', e.message || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// v60: резервный серверный контроль стадии «Сделано/Сделаны» в проекте «Акты счета».
// Он нужен, потому что робот Bitrix может не вызвать URL, а пользователь ожидает отправку
// именно по факту перемещения задачи в нужную Kanban-стадию.
let actsResolvedDoneStageId = '';
const actsPollRecentAttempts = new Map();
const actsPollPendingRetries = new Map(); // taskId -> { nextAt, allowHistoricalDone }

async function actsResolveDoneStageId() {
  if (config.actsDoneStageId) return String(config.actsDoneStageId);
  if (actsResolvedDoneStageId) return actsResolvedDoneStageId;
  const raw = await bitrixRestCall('task.stages.get', { entityId: config.actsProjectId });
  const stages = raw && typeof raw === 'object' ? Object.values(raw) : [];
  const done = stages.find((st) => /^сделан/i.test(actsCleanText(st && (st.TITLE || st.title))))
    || stages.find((st) => /готов/i.test(actsCleanText(st && (st.TITLE || st.title))));
  if (!done) {
    console.warn(`[acts-poll] Не нашёл стадию «Сделано/Сделаны» в проекте #${config.actsProjectId}. Доступные стадии: ${stages.map(st => `${st.ID || st.id}:${st.TITLE || st.title}`).join(', ')}`);
    return '';
  }
  actsResolvedDoneStageId = String(done.ID || done.id);
  console.log(`[acts-poll] Автоопределил стадию «${done.TITLE || done.title}» → ${actsResolvedDoneStageId}.`);
  return actsResolvedDoneStageId;
}

function actsTaskMatchesPilotDeal(task, targetDealId) {
  if (!targetDealId) return false;
  return actsExtractDealIdsFromTask(task).map(String).includes(String(targetDealId));
}

const ACTS_HISTORY_GRACE_MS = 2 * 60 * 1000;
const ACTS_FIRST_SCAN_LOOKBACK_MS = 60 * 60 * 1000;
let actsPollLastScanAt = Date.now() - ACTS_FIRST_SCAN_LOOKBACK_MS;

function actsParseDateMs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : 0;
}

async function actsTaskEnteredDoneStageSince(taskId, doneStageId, sinceMs) {
  try {
    const raw = await bitrixRestCall('tasks.task.history.list', {
      taskId: Number(taskId),
      filter: { FIELD: 'STAGE_ID' },
      order: { createdDate: 'DESC' },
    });
    const list = raw && Array.isArray(raw.list) ? raw.list
      : (raw && Array.isArray(raw.items) ? raw.items : []);
    const hit = list.find((ev) => {
      const field = String(ev && (ev.field || ev.FIELD) || '').toUpperCase();
      const value = ev && (ev.value || ev.VALUE) || {};
      const to = value && (value.to ?? value.TO);
      const created = actsParseDateMs(ev && (ev.createdDate || ev.CREATED_DATE));
      return field === 'STAGE_ID' && String(to ?? '') === String(doneStageId) && created >= sinceMs;
    });
    if (!hit) return null;
    const value = hit.value || hit.VALUE || {};
    return {
      eventId: hit.id || hit.ID || '',
      createdDate: hit.createdDate || hit.CREATED_DATE || '',
      from: value.from ?? value.FROM ?? '',
      to: value.to ?? value.TO ?? '',
    };
  } catch (e) {
    console.warn(`[acts-poll] task=${taskId}: не смог прочитать историю стадий: ${e.message || e}`);
    return null;
  }
}

async function runActsDonePollingCycle() {
  if (!config.bitrixWebhookUrl || !config.actsTasksEnabled || !config.actsSendToClientEnabled || !config.actsDonePollEnabled) return;
  const cycleStartedAt = Date.now();
  try {
    const doneStageId = await actsResolveDoneStageId();
    if (!doneStageId) return;
    const targetDealId = String(config.actsTestDealId || '').trim();
    const allDealsMode = Boolean(config.actsAllDeals);
    if (!targetDealId && !allDealsMode) {
      console.warn('[acts-poll] Нет ACTS_TEST_DEAL_ID и ACTS_ALL_DEALS=false — polling пропущен для защиты от массовой отправки.');
      return;
    }

    // v64: ищем только недавно изменённые задачи проекта, поэтому новая задача не может
    // потеряться из-за общего лимита первых 200 карточек. CHANGED_DATE поддерживает >= фильтр.
    const productionStartMs = actsParseDateMs(config.actsProductionStartIso) || 0;
    const scanSinceMs = Math.max(productionStartMs, 0, actsPollLastScanAt - ACTS_HISTORY_GRACE_MS);
    const scanSinceIso = new Date(scanSinceMs).toISOString();
    const projectTasks = await bitrixRestList('tasks.task.list', {
      filter: { GROUP_ID: config.actsProjectId, '>=CHANGED_DATE': scanSinceIso },
      order: { CHANGED_DATE: 'DESC' },
      select: ['ID','TITLE','DESCRIPTION','GROUP_ID','STAGE_ID','STATUS','REAL_STATUS','UF_CRM_TASK','CHANGED_DATE'],
    }, 1000);
    // Отдельно берём ВСЕ задачи, которые прямо сейчас находятся в «Сделано» — это даёт повторную
    // попытку после временной ошибки (например, scope/сеть), даже если CHANGED_DATE уже старый.
    let currentDoneTasks = [];
    try {
      currentDoneTasks = await bitrixRestList('tasks.task.list', {
        filter: { GROUP_ID: config.actsProjectId, STAGE_ID: doneStageId },
        order: { CHANGED_DATE: 'DESC' },
        select: ['ID','TITLE','DESCRIPTION','GROUP_ID','STAGE_ID','STATUS','REAL_STATUS','UF_CRM_TASK','CHANGED_DATE'],
      }, 1000);
    } catch (e) {
      console.warn(`[acts-poll] Не смог отдельно получить текущую стадию ${doneStageId}: ${e.message || e}`);
    }

    // v70: currentDoneTasks используем только для диагностики. В кандидаты НЕ подмешиваем
    // старые задачи, давно лежащие в «Сделано», иначе при включении ACTS_ALL_DEALS можно
    // случайно разослать исторические акты. К отправке идут только недавно изменённые задачи
    // (или отдельные retries ниже).
    const mergedTasks = projectTasks;

    const stageOf = (task) => String(actsTaskField(task, ['stageId','STAGE_ID','stage_id']) ?? '');
    const recentIds = new Set(projectTasks.map((t) => String(actsTaskField(t, ['id','ID']) || '')));
    const recentActTasks = mergedTasks.filter((task) => {
      const title = String(actsTaskField(task, ['title','TITLE']) || '');
      const description = String(actsTaskField(task, ['description','DESCRIPTION']) || '');
      const isActTask = title.includes(ACTS_ORIGINAL_MARKER) || description.includes(ACTS_ORIGINAL_MARKER) || /^СОБРАТЬ АКТ/i.test(title) || /^АКТ/i.test(title);
      if (!isActTask) return false;
      return allDealsMode ? true : actsTaskMatchesPilotDeal(task, targetDealId);
    });

    const candidates = [];
    for (const task of recentActTasks) {
      const taskId = String(actsTaskField(task, ['id','ID']) || '');
      if (!taskId) continue;
      if (stageOf(task) === String(doneStageId)) {
        candidates.push({ task, reason: 'current-stage', history: null });
        continue;
      }
      // Для карточек, которые недавно менялись, проверяем историю перехода.
      if (recentIds.has(taskId)) {
        const history = await actsTaskEnteredDoneStageSince(taskId, doneStageId, scanSinceMs);
        if (history) candidates.push({ task, reason: 'history-stage-transition', history });
      }
    }

    console.log(`[acts-poll] Проект #${config.actsProjectId}: с ${scanSinceIso} изменено ${projectTasks.length}; сейчас на стадии ${doneStageId}=${currentDoneTasks.length}; актовых кандидатов=${recentActTasks.length}; к обработке=${candidates.length}${allDealsMode ? ' (ACTS_ALL_DEALS=true)' : ` для тестовой сделки ${targetDealId}`}.`);

    if (!candidates.length) {
      const preview = recentActTasks.slice(0, 12).map((task) => ({
        id: actsTaskField(task, ['id','ID']),
        stage: stageOf(task),
        status: actsTaskField(task, ['status','STATUS','realStatus','REAL_STATUS']),
        changed: actsTaskField(task, ['changedDate','CHANGED_DATE','changed_date']),
        crm: actsTaskField(task, ['ufCrmTask','UF_CRM_TASK','uf_crm_task']),
        title: String(actsTaskField(task, ['title','TITLE']) || '').slice(0, 90),
      }));
      console.log(`[acts-poll] Недавно изменённые актовые задачи: ${JSON.stringify(preview)}`);
    }

    const candidateByTaskId = new Map(candidates.map((item) => [String(actsTaskField(item.task, ['id','ID']) || ''), item]));
    const now = Date.now();
    for (const [taskId, retry] of actsPollPendingRetries.entries()) {
      if (retry.nextAt <= now && !candidateByTaskId.has(String(taskId))) {
        candidateByTaskId.set(String(taskId), { task: { ID: String(taskId) }, reason: 'retry-after-failure', history: null, allowHistoricalDone: Boolean(retry.allowHistoricalDone) });
      }
    }

    for (const item of candidateByTaskId.values()) {
      const task = item.task;
      const taskId = String(actsTaskField(task, ['id','ID']) || '');
      if (!taskId) continue;
      const lastAttempt = actsPollRecentAttempts.get(taskId) || 0;
      if (now - lastAttempt < 45 * 1000) continue;
      actsPollRecentAttempts.set(taskId, now);
      try {
        if (item.reason === 'history-stage-transition') {
          console.log(`[acts-poll] task=${taskId}: переход в «Сделано» подтверждён историей ${item.history.from}→${item.history.to} at ${item.history.createdDate}; текущая стадия=${stageOf(task)}.`);
        }
        const allowHistoricalDone = item.reason === 'history-stage-transition' || item.reason === 'retry-after-failure' || Boolean(item.allowHistoricalDone);
        const result = await actsHandleTaskDone(taskId, 'task-done-poll', { allowHistoricalDone });
        const compact = result && result.results ? result.results.map(x => ({ dealId: x.dealId, duplicate: x.duplicate, sent: x.sent && { ok: x.sent.ok, channel: x.sent.channel, message: x.sent.message, error: x.sent.error, possiblyDelivered: x.sent.possiblyDelivered } })) : [];
        const successful = Boolean(result && result.results && result.results.length && result.results.every((x) => x.duplicate || (x.sent && x.sent.ok)));
        const uncertain = Boolean(result && result.results && result.results.some((x) => x.sent && x.sent.possiblyDelivered));
        if (successful) {
          actsPollPendingRetries.delete(taskId);
        } else if (!uncertain) {
          actsPollPendingRetries.set(taskId, { nextAt: Date.now() + Math.max(60, config.actsRetrySeconds || 120) * 1000, allowHistoricalDone });
        } else {
          actsPollPendingRetries.delete(taskId);
          console.warn(`[acts-poll] task=${taskId}: Wazzup вернул 5xx/неопределённый статус; автоматический повтор отключён, чтобы не задублировать уже возможно доставленное сообщение.`);
        }
        console.log(`[acts-poll] task=${taskId}: ${JSON.stringify({ ok: result && result.ok, trigger: item.reason, retryScheduled: !successful && !uncertain, deals: compact })}`);
      } catch (e) {
        console.error(`[acts-poll] task=${taskId}: ${e.message || e}`);
      }
    }
  } catch (e) {
    console.error('[acts-poll] Ошибка цикла:', e.message || e);
  } finally {
    // overlap на 2 минуты уже добавляется в начале следующего цикла, поэтому ничего не теряем
    // при небольшом рассинхроне времени Render/Bitrix.
    actsPollLastScanAt = cycleStartedAt;
  }
}


// v74: ручная месячная сверка оригиналов актов.
// Логика: успешные сделки Производства за месяц -> задача в проекте Акты счета -> стадия Архив.
const ACTS_RECON_MONTHS_RU = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];
const ACTS_RECON_EXPERT_ALIASES = [
  { re: /горбатова/i, label: 'Лиза' },
  { re: /панькова/i, label: 'Оля' },
  { re: /кананович/i, label: 'Иоланта' },
  { re: /николаева/i, label: 'Катя' },
  { re: /баженова/i, label: 'Мария' },
];

function actsReconParseMonth(raw) {
  const m = String(raw || '').trim().match(/^(20\d{2})-(0[1-9]|1[0-2])$/);
  if (!m) throw new Error('month должен быть в формате YYYY-MM, например 2026-08');
  return { year: Number(m[1]), month: Number(m[2]), key: `${m[1]}-${m[2]}` };
}

function actsReconMonthRange(raw) {
  const { year, month, key } = actsReconParseMonth(raw);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const pad = (n) => String(n).padStart(2, '0');
  // Минск в 2026 году UTC+3 без сезонного перевода времени.
  const startIso = `${year}-${pad(month)}-01T00:00:00+03:00`;
  const nextIso = `${nextYear}-${pad(nextMonth)}-01T00:00:00+03:00`;
  const endMs = Date.parse(nextIso) - 1000;
  const end = new Date(endMs);
  const endIso = `${end.getUTCFullYear()}-${pad(end.getUTCMonth()+1)}-${pad(end.getUTCDate())}T${pad(end.getUTCHours()+3)}:${pad(end.getUTCMinutes())}:${pad(end.getUTCSeconds())}+03:00`;
  return { year, month, key, startIso, endIso };
}

function actsReconNorm(value) {
  return String(value || '')
    .toLowerCase().replace(/ё/g, 'е')
    .replace(/[«»"'`]/g, ' ')
    .replace(/\b(ооо|одо|оао|зао|ип|чуп|уп|сп|общество с ограниченной ответственностью)\b/gi, ' ')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

function actsReconServiceKeyword(raw) {
  const s = actsReconNorm(raw);
  if (/\bспк\b|свидетельств.*техн|техн.*компет/.test(s)) return 'спк';
  if (/аттест/.test(s)) return 'аттест';
  if (/\bисо\b|\biso\b/.test(s)) return 'исо';
  if (/\bсуот\b/.test(s)) return 'суот';
  if (/\bмчс\b/.test(s)) return 'мчс';
  if (/\bмвд\b/.test(s)) return 'мвд';
  if (/сертиф/.test(s)) return 'сертиф';
  return '';
}

function actsReconTaskStage(task) {
  return String(actsTaskField(task, ['stageId','STAGE_ID','stage_id']) || '');
}

function actsReconTaskId(task) {
  return String(actsTaskField(task, ['id','ID']) || '');
}

function actsReconTaskTitle(task) {
  return actsCleanText(actsTaskField(task, ['title','TITLE']) || '');
}

async function actsReconUserInfo(userId, cache) {
  const key = String(userId || '');
  if (!key) return { id: '', full: 'Без ответственного', label: 'Без ответственного' };
  if (cache.has(key)) return cache.get(key);
  let user = null;
  try {
    const rows = await bitrixRestCall('user.get', { ID: key });
    user = Array.isArray(rows) ? rows[0] : rows;
  } catch (_) {}
  const full = actsCleanText(`${user && user.LAST_NAME || ''} ${user && user.NAME || ''}`) || `ID ${key}`;
  const hit = ACTS_RECON_EXPERT_ALIASES.find((x) => x.re.test(full));
  const label = hit ? hit.label : (actsCleanText(user && user.NAME) || full);
  const out = { id: key, full, label };
  cache.set(key, out);
  return out;
}

async function actsReconCompanyName(deal, cache) {
  const id = String(deal && deal.COMPANY_ID || '');
  if (!id) return actsCleanText(deal && deal.TITLE) || `Сделка ${deal && deal.ID || '?'}`;
  if (cache.has(id)) return cache.get(id);
  let name = '';
  try { name = await fgGetCompanyName(id); } catch (_) {}
  name = actsCleanText(name || deal.TITLE || `Компания ${id}`);
  cache.set(id, name);
  return name;
}

function actsReconFallbackCandidates(info, tasks) {
  const companyNorm = actsReconNorm(info.companyName);
  const dealNorm = actsReconNorm(info.deal.TITLE);
  const serviceKey = actsReconServiceKeyword(info.service);
  let candidates = tasks.filter((task) => {
    const t = actsReconNorm(actsReconTaskTitle(task));
    if (!t) return false;
    const byCompany = companyNorm.length >= 4 && t.includes(companyNorm);
    const byDeal = dealNorm.length >= 6 && (t.includes(dealNorm) || dealNorm.includes(t.replace(/^акт\s+/, '')));
    return byCompany || byDeal;
  });
  if (serviceKey && candidates.length > 1) {
    const byService = candidates.filter((task) => actsReconNorm(actsReconTaskTitle(task)).includes(serviceKey));
    if (byService.length) candidates = byService;
  }
  return candidates;
}

const actsReconServiceEnumCache = new Map();
async function actsReconResolveService(deal, serviceField) {
  const raw = deal && deal[serviceField];
  if (raw === null || raw === undefined || raw === '') return actsCleanText(detectServiceFromDeal(deal) || '');
  const direct = Array.isArray(raw) ? raw.map(String).join(', ') : String(raw);
  const ids = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x)).filter((x) => /^\d+$/.test(x));
  if (!ids.length) return actsCleanText(direct);
  try {
    let map = actsReconServiceEnumCache.get(serviceField);
    if (!map) {
      map = new Map();
      const fields = await bitrixRestList('crm.deal.userfield.list', { filter: { FIELD_NAME: serviceField } }, 20);
      const field = fields.find((f) => String(f.FIELD_NAME || f.fieldName || '') === serviceField) || fields[0];
      const list = field && (field.LIST || field.list);
      if (Array.isArray(list)) {
        for (const item of list) {
          const id = String(item.ID || item.id || '');
          const value = actsCleanText(item.VALUE || item.value || '');
          if (id && value) map.set(id, value);
        }
      }
      actsReconServiceEnumCache.set(serviceField, map);
    }
    const labels = ids.map((id) => map.get(id)).filter(Boolean);
    if (labels.length) return labels.join(', ');
    const titleFallback = fgProductionService(deal);
    return actsCleanText(titleFallback && !/^\d+(?:,\s*\d+)*$/.test(titleFallback) ? titleFallback : direct);
  } catch (_) {
    return actsCleanText(direct);
  }
}

function actsReconDisplayDeal(info) {
  // v76: в отчёте оставляем реальное название услуги из сделки.
  // Никаких общих «аттестации» вместо «Аттестация ГенПодр / СМР / ИНЖ ИЗЫСКАНИЯ».
  const service = actsCleanText(info.service || '');
  return service ? `${info.companyName} — ${service}` : info.companyName;
}

function actsReconReportLabel(row) {
  return actsCleanText(row && (row.reportLabel || row.label) || '');
}

function actsReconBuildText(monthInfo, groups) {
  const titleMonth = ACTS_RECON_MONTHS_RU[monthInfo.month - 1];
  const lines = [`Сверка оригиналов актов за ${titleMonth} ${monthInfo.year}`, ''];
  let idx = 1;
  for (const g of groups) {
    lines.push(`${idx}) ${g.expert.label}`);
    lines.push('Акты есть в оригинале:');
    if (g.have.length) g.have.forEach((x) => lines.push(`- ${actsReconReportLabel(x)}`));
    else lines.push('- нет');
    lines.push('Актов нет в оригинале:');
    if (g.missing.length) g.missing.forEach((x) => lines.push(`- ${actsReconReportLabel(x)}`));
    else lines.push('- нет');
    lines.push('Нужно проверить вручную:');
    if (g.review.length) g.review.forEach((x) => lines.push(`- ${actsReconReportLabel(x)}`));
    else lines.push('- нет');
    lines.push('');
    idx++;
  }
  return lines.join('\n').trim();
}

async function actsReconMapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency || 6, items.length || 1)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

function actsReconIsActTask(task) {
  const title = actsCleanText(actsReconTaskTitle(task));
  // В проекте есть договоры и счета. Для сверки оригиналов учитываем только задачи АКТ.
  return /^акт(?:\s|№|#|$)/i.test(title);
}

async function actsReconTasksForDeal(dealId) {
  return bitrixRestList('tasks.task.list', {
    filter: { GROUP_ID: config.actsProjectId, UF_CRM_TASK: `D_${dealId}` },
    select: ['ID','TITLE','DESCRIPTION','GROUP_ID','STAGE_ID','STATUS','REAL_STATUS','UF_CRM_TASK','CREATED_DATE','CHANGED_DATE','CLOSED_DATE'],
    order: { ID: 'DESC' },
  }, 100);
}

async function actsReconFallbackTasksByTitle(companyName, service) {
  const titleNeedle = actsCleanText(companyName || '').trim();
  if (!titleNeedle || titleNeedle.length < 3) return [];
  let tasks = await bitrixRestList('tasks.task.list', {
    filter: { GROUP_ID: config.actsProjectId, '%TITLE': titleNeedle },
    select: ['ID','TITLE','DESCRIPTION','GROUP_ID','STAGE_ID','STATUS','REAL_STATUS','UF_CRM_TASK','CREATED_DATE','CHANGED_DATE','CLOSED_DATE'],
    order: { ID: 'DESC' },
  }, 100);
  // Договоры / счета / счёт-заказы из того же проекта не являются актами.
  tasks = tasks.filter(actsReconIsActTask);
  const serviceKey = actsReconServiceKeyword(service);
  if (serviceKey && tasks.length > 1) {
    const narrowed = tasks.filter((task) => actsReconNorm(actsReconTaskTitle(task)).includes(serviceKey));
    if (narrowed.length) tasks = narrowed;
  }
  return tasks;
}

async function actsBuildMonthlyOriginalsReconciliation(monthRaw) {
  const startedAt = Date.now();
  const monthInfo = actsReconMonthRange(monthRaw);
  const productionCategoryId = Number(config.productionCategoryId || 28);
  const serviceField = config.serviceFieldCode || 'UF_CRM_1765113071';
  console.log(`[acts-recon] START month=${monthInfo.key}: определяю стадию Архив...`);
  const archiveStageId = await actsResolveArchiveStageId();
  if (!archiveStageId) throw new Error(`В проекте #${config.actsProjectId} не найдена стадия «Архив».`);

  console.log(`[acts-recon] month=${monthInfo.key}: загружаю успешно закрытые сделки Производства...`);
  const deals = await bitrixRestList('crm.deal.list', {
    filter: {
      CATEGORY_ID: productionCategoryId,
      STAGE_SEMANTIC_ID: 'S',
      '>=CLOSEDATE': monthInfo.startIso,
      '<=CLOSEDATE': monthInfo.endIso,
    },
    select: ['ID','TITLE','CATEGORY_ID','STAGE_ID','STAGE_SEMANTIC_ID','CLOSED','CLOSEDATE','ASSIGNED_BY_ID','COMPANY_ID', serviceField],
    order: { CLOSEDATE: 'ASC', ID: 'ASC' },
  }, 5000);
  console.log(`[acts-recon] month=${monthInfo.key}: найдено успешно закрытых сделок=${deals.length}. Ищу задачи актов точечно по CRM-привязке.`);

  const companyCache = new Map();
  const userCache = new Map();
  let done = 0;
  const rows = await actsReconMapWithConcurrency(deals, 6, async (deal) => {
    const dealId = String(deal.ID || '');
    const [companyName, service, expert] = await Promise.all([
      actsReconCompanyName(deal, companyCache),
      actsReconResolveService(deal, serviceField),
      actsReconUserInfo(deal.ASSIGNED_BY_ID, userCache),
    ]);
    const info = { deal, companyName, service, expert };

    // Правило v76: D_ID — абсолютный приоритет. Если есть АКТ, прямо связанный с D_ID сделки,
    // название компании вообще не участвует в выборе. По названию ищем только при отсутствии CRM-связи.
    const linkedTasks = await actsReconTasksForDeal(dealId);
    let candidates = linkedTasks.filter(actsReconIsActTask);
    let matchType = candidates.length ? 'crm-link' : 'none';
    if (!candidates.length) {
      candidates = await actsReconFallbackTasksByTitle(companyName, service);
      if (candidates.length === 1) matchType = 'title-fallback';
      else if (candidates.length > 1) matchType = 'ambiguous-title';
    }

    const trustedTasks = matchType === 'crm-link' ? candidates : (matchType === 'title-fallback' ? candidates.slice(0,1) : []);
    const archived = trustedTasks.filter((t) => actsReconTaskStage(t) === String(archiveStageId));
    const hasOriginal = archived.length > 0;
    const bestTask = archived[0] || trustedTasks[0] || null;

    done++;
    if (done === 1 || done % 10 === 0 || done === deals.length) {
      console.log(`[acts-recon] month=${monthInfo.key}: обработано ${done}/${deals.length} сделок.`);
    }

    return {
      dealId,
      dealTitle: actsCleanText(deal.TITLE),
      closeDate: deal.CLOSEDATE || '',
      expert,
      companyName,
      service,
      label: actsReconDisplayDeal(info),
      hasOriginal,
      status: hasOriginal ? 'have' : (matchType === 'ambiguous-title' ? 'review' : 'missing'),
      matchType,
      taskId: bestTask ? actsReconTaskId(bestTask) : '',
      taskTitle: bestTask ? actsReconTaskTitle(bestTask) : '',
      taskStageId: bestTask ? actsReconTaskStage(bestTask) : '',
      matchingTaskIds: candidates.map(actsReconTaskId).filter(Boolean),
      reason: hasOriginal
        ? `задача ${actsReconTaskId(archived[0])} в стадии Архив ${archiveStageId}`
        : matchType === 'none'
          ? 'задача на акт не найдена'
          : matchType === 'ambiguous-title'
            ? `по названию найдено несколько задач (${candidates.map(actsReconTaskId).join(', ')}) — автоматически не засчитываю`
            : bestTask
              ? `задача ${actsReconTaskId(bestTask)} найдена, но её стадия ${actsReconTaskStage(bestTask)} != Архив ${archiveStageId}`
              : 'оригинал не подтверждён',
    };
  });

  const byExpert = new Map();
  for (const row of rows) {
    const key = row.expert.id || 'none';
    if (!byExpert.has(key)) byExpert.set(key, { expert: row.expert, have: [], missing: [], review: [] });
    byExpert.get(key)[row.status || (row.hasOriginal ? 'have' : 'missing')].push(row);
  }

  const groups = [...byExpert.values()]
    .sort((a,b) => a.expert.label.localeCompare(b.expert.label, 'ru'))
    .map((g) => {
      const all = [...g.have, ...g.missing, ...g.review];
      const counts = new Map();
      for (const row of all) counts.set(row.label, (counts.get(row.label) || 0) + 1);
      for (const row of all) {
        row.reportLabel = counts.get(row.label) > 1 ? `${row.label} (сделка ${row.dealId})` : row.label;
      }
      const sorter = (a,b) => actsReconReportLabel(a).localeCompare(actsReconReportLabel(b), 'ru');
      return { ...g, have: g.have.sort(sorter), missing: g.missing.sort(sorter), review: g.review.sort(sorter) };
    });

  const text = actsReconBuildText(monthInfo, groups);
  const durationMs = Date.now() - startedAt;
  console.log(`[acts-recon] DONE month=${monthInfo.key}: ${rows.length} сделок за ${(durationMs/1000).toFixed(1)} сек.`);
  return {
    ok: true,
    month: monthInfo.key,
    productionCategoryId,
    actsProjectId: config.actsProjectId,
    archiveStageId,
    durationMs,
    dealsCount: rows.length,
    originalsCount: rows.filter((x) => x.status === 'have').length,
    missingCount: rows.filter((x) => x.status === 'missing').length,
    ambiguousCount: rows.filter((x) => x.status === 'review').length,
    groups,
    rows,
    text,
  };
}


function actsReconRequestAuthorized(req) {
  const expected = String(config.actsReconToken || '');
  if (!expected) return false;
  const supplied = String((req.query && req.query.token) || (req.body && req.body.token) || '').trim();
  if (!supplied || supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function actsReconReportTitleForMonth(monthRaw) {
  const info = actsReconParseMonth(monthRaw);
  return `Сверка оригиналов актов за ${ACTS_RECON_MONTHS_RU[info.month - 1]} ${info.year}`;
}

async function actsReconLeaderAlreadyHasReport(monthRaw) {
  const leaderId = String(config.actsReconLeaderId || '2182');
  const needle = actsReconReportTitleForMonth(monthRaw);
  try {
    // Надёжная дедупликация: получаем ID личного чата и ищем сообщение по тексту во всей истории,
    // а не только среди последних 50 сообщений.
    const dialogInfo = await bitrixRestCall('im.dialog.get', { DIALOG_ID: leaderId });
    const chatId = Number(dialogInfo && (dialogInfo.id || dialogInfo.ID || dialogInfo.chat_id || dialogInfo.CHAT_ID) || 0);
    if (chatId > 0) {
      const found = await bitrixRestCall('im.dialog.messages.search', { CHAT_ID: chatId, SEARCH_MESSAGE: needle, ORDER: { ID: 'DESC' }, LIMIT: 20 });
      const messages = found && (found.messages || found.MESSAGES);
      if (Array.isArray(messages)) {
        return messages.some((m) => String(m && (m.text || m.TEXT || m.message || m.MESSAGE) || '').includes(needle));
      }
    }
    // Резерв: если search недоступен, проверяем последние сообщения обычным методом.
    const dialog = await bitrixRestCall('im.dialog.messages.get', { DIALOG_ID: leaderId, LIMIT: 50 });
    const messages = dialog && (dialog.messages || dialog.MESSAGES);
    return Array.isArray(messages) && messages.some((m) => String(m && (m.text || m.TEXT || m.message || m.MESSAGE) || '').includes(needle));
  } catch (e) {
    console.warn(`[acts-recon] Не удалось проверить дубль отчёта в чате Тани: ${e.message || e}`);
    // Если проверка дубля недоступна, безопаснее НЕ слать автоматически повторно.
    return null;
  }
}

async function actsReconSendToLeader(report, { allowWhenDedupeUnknown = true } = {}) {
  const leaderId = String(config.actsReconLeaderId || '2182');
  const already = await actsReconLeaderAlreadyHasReport(report.month);
  if (already === true) return { leaderId, skipped: true, reason: 'report-already-sent' };
  if (already === null && !allowWhenDedupeUnknown) return { leaderId, skipped: true, reason: 'dedupe-check-failed' };
  const messageId = await bitrixRestCall('im.message.add', { DIALOG_ID: leaderId, MESSAGE: report.text });
  return { leaderId, messageId, skipped: false };
}

function actsReconLastWeekdayDay(year, month) {
  let day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  while (day > 0) {
    const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    if (wd !== 0 && wd !== 6) return day;
    day--;
  }
  return 1;
}

function actsReconIsAutoSendMoment(now = new Date()) {
  const p = actsMinskCalendarParts(now);
  const lastWeekday = actsReconLastWeekdayDay(p.y, p.m);
  return p.d === lastWeekday && p.hour >= Math.max(0, Math.min(23, Number(config.actsReconSendHourMinsk || 18)));
}

let actsReconAutoRunning = false;
async function runActsReconAutoCycle() {
  if (actsReconAutoRunning || !config.actsReconAutoEnabled || !config.bitrixWebhookUrl) return;
  if (!actsReconIsAutoSendMoment(new Date())) return;
  actsReconAutoRunning = true;
  try {
    const p = actsMinskCalendarParts(new Date());
    const monthKey = `${p.y}-${String(p.m).padStart(2, '0')}`;
    const already = await actsReconLeaderAlreadyHasReport(monthKey);
    if (already === true) {
      console.log(`[acts-recon-auto] ${monthKey}: отчёт уже есть в чате Тани — повтор не отправляю.`);
      return;
    }
    if (already === null) {
      console.warn(`[acts-recon-auto] ${monthKey}: не удалось проверить дубль — автоматическую отправку пропускаю ради безопасности.`);
      return;
    }
    console.log(`[acts-recon-auto] ${monthKey}: последний рабочий день месяца, формирую отчёт...`);
    const report = await actsBuildMonthlyOriginalsReconciliation(monthKey);
    const sent = await actsReconSendToLeader(report, { allowWhenDedupeUnknown: false });
    console.log(`[acts-recon-auto] ${monthKey}: ${sent && sent.skipped ? `пропущено (${sent.reason})` : `отправлено Тане, messageId=${sent && sent.messageId}`}.`);
  } catch (e) {
    console.error('[acts-recon-auto]', e.message || e);
  } finally {
    actsReconAutoRunning = false;
  }
}

async function actsReconEndpoint(req, res) {
  try {
    if (!config.actsReconToken) {
      return res.status(503).json({ ok: false, error: 'В Render не задан ACTS_RECON_TOKEN. Добавь секретную строку и повтори запрос.' });
    }
    if (!actsReconRequestAuthorized(req)) return res.status(403).json({ ok: false, error: 'Неверный ACTS_RECON_TOKEN.' });
    const rawMonth = String((req.query && req.query.month) || (req.body && req.body.month) || '').trim();
    const sendRaw = String((req.query && req.query.send) || (req.body && req.body.send) || '0').toLowerCase();
    const send = ['1','true','yes','y'].includes(sendRaw);
    const report = await actsBuildMonthlyOriginalsReconciliation(rawMonth);
    let sent = null;
    if (send) sent = await actsReconSendToLeader(report);
    console.log(`[acts-recon] month=${report.month}: успешно закрыто=${report.dealsCount}, оригиналы=${report.originalsCount}, нет=${report.missingCount}, неоднозначных=${report.ambiguousCount}, send=${send}.`);
    return res.json({ ...report, sent });
  } catch (e) {
    console.error('[acts-recon]', e.message || e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}

app.get('/api/acts/reconcile', actsReconEndpoint);
app.post('/api/acts/reconcile', actsReconEndpoint);

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

// ============================================================================
// v102: ВОЗВРАТ ОРИГИНАЛОВ — без технических lock-комментариев в задачах
//
// Логика:
// 1) «Отправлены» + истёк дедлайн -> «Эл. Почта» -> письмо №1 -> дедлайн +14 дней.
// 2) «Эл. Почта» + истёк новый дедлайн -> письмо №2 -> дедлайн +14 дней.
// 3) «Эл. Почта» + истёк второй дедлайн -> «Звонок», третьего письма нет.
// 4) «Приедут, не отправляем» и любые другие стадии не трогаем.
//
// Безопасность:
// - тестовая задача 47208 разрешена всегда;
// - остальные задачи автоматически обрабатываются только если созданы после даты запуска;
// - исторический хвост не трогаем, пока DOC_RETURN_INCLUDE_HISTORICAL=true не задан явно.
// ============================================================================

const DOC_RETURN_ENABLED = String(process.env.DOC_RETURN_ENABLED || 'true').toLowerCase() !== 'false';
const DOC_RETURN_TEST_TASK_ID = String(process.env.DOC_RETURN_TEST_TASK_ID || '').trim();
const DOC_RETURN_PROJECT_ID = String(process.env.DOC_RETURN_PROJECT_ID || '36');
// v106: backlog mode — one polling pass per minute. Old Render env values (e.g. 5) no longer slow the queue.
const DOC_RETURN_POLL_MINUTES = 1;
const DOC_RETURN_PRODUCTION_START_ISO = String(
  process.env.DOC_RETURN_PRODUCTION_START_ISO || '2026-08-24T13:22:00+03:00'
);
// v106: process the historical backlog from «Отправлены».
// Old tasks already sitting in «Эл. Почта» are still protected by docReturnShouldManageHistoricalEmailTask().
const DOC_RETURN_INCLUDE_HISTORICAL = true;

const DOC_RETURN_RECOVERY_TASK_IDS = new Set(
  String(process.env.DOC_RETURN_RECOVERY_TASK_IDS || '29072,30464,33014,33494')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
);

const DOC_RETURN_SMTP_HOST = String(process.env.MAIL_SMTP_HOST || 'smtp.mail.ru').trim();
const DOC_RETURN_SMTP_PORT = Number(process.env.MAIL_SMTP_PORT || 465);
const DOC_RETURN_SMTP_SECURE =
  String(process.env.MAIL_SMTP_SECURE || 'true').toLowerCase() !== 'false';
const DOC_RETURN_SMTP_USER = String(
  process.env.MAIL_SMTP_USER || process.env.MAIL_IMAP_USER || config.emailFrom || ''
).trim();
const DOC_RETURN_SMTP_PASSWORD = String(
  process.env.MAIL_SMTP_PASSWORD || process.env.MAIL_IMAP_PASSWORD || ''
);

const DOC_RETURN_IMAP_HOST = String(process.env.MAIL_IMAP_HOST || 'imap.mail.ru').trim();
const DOC_RETURN_IMAP_PORT = Number(process.env.MAIL_IMAP_PORT || 993);
const DOC_RETURN_IMAP_SECURE =
  String(process.env.MAIL_IMAP_SECURE || 'true').toLowerCase() !== 'false';
const DOC_RETURN_IMAP_USER = String(
  process.env.MAIL_IMAP_USER || process.env.MAIL_SMTP_USER || DOC_RETURN_SMTP_USER
).trim();
const DOC_RETURN_IMAP_PASSWORD = String(
  process.env.MAIL_IMAP_PASSWORD || process.env.MAIL_SMTP_PASSWORD || DOC_RETURN_SMTP_PASSWORD
);
const DOC_RETURN_CONFIRMED_TEXT = 'Отправка подтверждена почтовым сервером.';
// v106: never let stale Render env values throttle the queue back to 1 action.
const DOC_RETURN_MAX_ACTIONS_PER_CYCLE = Math.max(
  10,
  Number(process.env.DOC_RETURN_MAX_ACTIONS_PER_CYCLE || 10)
);
const DOC_RETURN_MAX_CHECKS_PER_CYCLE = Math.max(
  60,
  Number(process.env.DOC_RETURN_MAX_CHECKS_PER_CYCLE || 60)
);
// Temporary SMTP/REST failures retry later; data failures go straight to «Ручная отправка».
const DOC_RETURN_ERROR_COOLDOWN_MINUTES = Math.max(5, Math.min(30, Number(process.env.DOC_RETURN_ERROR_COOLDOWN_MINUTES || 15)));
// v106: one sender only — server polling. Bitrix robots/webhooks cannot trigger a second send.
const DOC_RETURN_ALLOW_WEBHOOK = false;
const DOC_RETURN_CONCURRENCY = Math.max(3, Math.min(5, Number(process.env.DOC_RETURN_CONCURRENCY || 3)));
const DOC_RETURN_MANUAL_STAGE_TITLE = String(process.env.DOC_RETURN_MANUAL_STAGE_TITLE || 'Ручная отправка').trim();
const DOC_RETURN_MANUAL_STAGE_COLOR = String(process.env.DOC_RETURN_MANUAL_STAGE_COLOR || '#FF8A65').trim();

// v108: письма о возврате оригиналов отправляем только в рабочее окно по Минску.
// 08:00 включительно — 19:00 не включительно. Значения можно переопределить в Render.
const DOC_RETURN_SEND_TIMEZONE = String(process.env.DOC_RETURN_SEND_TIMEZONE || 'Europe/Minsk').trim();
const DOC_RETURN_SEND_START_HOUR = Math.max(0, Math.min(23, Number(process.env.DOC_RETURN_SEND_START_HOUR || 8)));
const DOC_RETURN_SEND_END_HOUR = Math.max(1, Math.min(24, Number(process.env.DOC_RETURN_SEND_END_HOUR || 19)));

let docReturnSmtpTransport = null;
let docReturnCycleRunning = false;
let docReturnQueueCursor = 0;
const docReturnErrorCooldownUntil = new Map();

const DOC_RETURN_COMMENT_1 = 'Автоматическое напоминание №1 о возврате оригинала отправлено.';
const DOC_RETURN_COMMENT_2 = 'Автоматическое напоминание №2 о возврате оригинала отправлено.';
const DOC_RETURN_CALL_COMMENT =
  'Два email-напоминания отправлены. Документы не получены. Передано на ручной звонок.';

// Legacy-маркеры нужны только чтобы корректно продолжить уже начатый тест 47208.
const DOC_RETURN_LEGACY_MARKER_1 = '[MAVIS_DOC_RETURN_REMINDER_1]';
const DOC_RETURN_LEGACY_MARKER_2 = '[MAVIS_DOC_RETURN_REMINDER_2]';
const DOC_RETURN_LEGACY_CALL_MARKER = '[MAVIS_DOC_RETURN_CALL]';

const docReturnLocks = new Set();
let docReturnStageCache = { at: 0, sent: '', email: '', call: '', manual: '', rows: [] };

function docReturnReqTaskId(req) {
  const src = Object.assign({}, req.query || {}, req.body || {});
  const keys = ['task_id', 'taskId', 'TASK_ID', 'id', 'ID', 'entityId', 'ENTITY_ID'];
  for (const k of keys) {
    const v = src[k];
    if (v !== undefined && v !== null && String(v).trim()) return String(v).trim();
  }
  return '';
}

function docReturnTaskValue(task, names) {
  return actsTaskField(task, names);
}

function docReturnParseMs(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

function docReturnIsDeadlineExpired(task, nowMs = Date.now()) {
  const ms = docReturnParseMs(docReturnTaskValue(task, ['deadline', 'DEADLINE']));
  return ms > 0 && ms <= nowMs;
}

function docReturnCreatedMs(task) {
  return docReturnParseMs(
    docReturnTaskValue(task, ['createdDate', 'CREATED_DATE', 'created_date', 'createdAt', 'CREATED_AT'])
  );
}

function docReturnIsEligible(task) {
  const taskId = String(docReturnTaskValue(task, ['id', 'ID']) || '');
  if (taskId === DOC_RETURN_TEST_TASK_ID) return true;
  if (DOC_RETURN_INCLUDE_HISTORICAL) return true;

  const createdMs = docReturnCreatedMs(task);
  const startMs = docReturnParseMs(DOC_RETURN_PRODUCTION_START_ISO);
  return Boolean(createdMs && startMs && createdMs >= startMs);
}

function docReturnFirstEmail(entity) {
  const emails = Array.isArray(entity && entity.EMAIL) ? entity.EMAIL : [];
  const item = emails.find(
    (x) => x && x.VALUE && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(x.VALUE).trim())
  );
  return item ? String(item.VALUE).trim() : '';
}

async function docReturnResolveRecipient(deal) {
  if (!deal) return { ok: false, reason: 'crm-deal-not-linked' };

  // 1. Компания. Если там стоит наша собственная почта — НЕ используем её,
  // а продолжаем искать контакт / документ.
  const companyId = String(deal && deal.COMPANY_ID || '').trim();
  if (companyId && companyId !== '0') {
    try {
      const company = await bitrixRestCall('crm.company.get', { id: Number(companyId) });
      const email = docReturnFirstEmail(company);
      if (email && !docReturnIsForbiddenRecipient(email)) {
        return {
          ok: true,
          email,
          entityId: Number(companyId),
          entityTypeId: 4,
          source: 'company',
          label: String(company && company.TITLE || `Компания ${companyId}`),
        };
      }
      if (email) {
        console.warn(
          `[doc-return] deal=${deal.ID || '?'}: email компании ${docReturnMaskEmail(email)} ` +
          'заблокирован как адрес MAVIS/отправителя.'
        );
      }
    } catch (e) {
      console.warn(`[doc-return] company ${companyId}: ${e.message || e}`);
    }
  }

  // 2. Контакт. Та же жёсткая проверка.
  try {
    const recipient = await actsResolveRecipientContact(deal);
    if (recipient && recipient.ok && recipient.contact) {
      const email = actsContactEmail(recipient.contact);
      if (email && !docReturnIsForbiddenRecipient(email)) {
        return {
          ok: true,
          email,
          entityId: Number(recipient.contactId || 0),
          entityTypeId: 3,
          source: 'contact',
          label: recipient.label || `Контакт ${recipient.contactId}`,
        };
      }
      if (email) {
        console.warn(
          `[doc-return] deal=${deal.ID || '?'}: email контакта ${docReturnMaskEmail(email)} ` +
          'заблокирован как адрес MAVIS/отправителя.'
        );
      }
    }
  } catch (e) {
    console.warn(`[doc-return] contact resolver: ${e.message || e}`);
  }

  return { ok: false, reason: 'crm-external-email-not-found' };
}

function docReturnExtractEmailsFromText(value) {
  const source = String(value || '');
  const matches = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig) || [];
  const out = [];
  const seen = new Set();

  for (const raw of matches) {
    const email = String(raw || '')
      .replace(/^[<("'«]+/, '')
      .replace(/[>)"',;:»]+$/, '')
      .trim()
      .toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

function docReturnOwnEmails() {
  const set = new Set();
  const candidates = [
    config.emailFrom,
    process.env.EMAIL_FROM,
    process.env.MAIL_IMAP_USER,
    process.env.MAIL_SMTP_USER,
    'mavis.group@mail.ru',
  ];

  for (const v of candidates) {
    const e = String(v || '').trim().toLowerCase();
    if (e) set.add(e);
  }
  return set;
}

function docReturnIsForbiddenRecipient(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return true;

  const own = docReturnOwnEmails();
  if (own.has(value)) return true;

  // ЖЁСТКИЙ стоп: автоматизация возврата оригиналов никогда не пишет
  // на собственные адреса MAVIS, даже если такой email ошибочно записан в CRM
  // или встречается внутри нашего шаблона договора/счёта.
  if (value === 'mavis.group@mail.ru') return true;

  const domain = String(value.split('@')[1] || '').toLowerCase();
  if (
    domain === 'mavisgroup.by' ||
    domain.endsWith('.mavisgroup.by') ||
    domain === 'mavis-group.by' ||
    domain.endsWith('.mavis-group.by')
  ) return true;

  return false;
}

function docReturnAssertExternalRecipient(email, taskId = '') {
  if (docReturnIsForbiddenRecipient(email)) {
    throw new Error(
      `ЗАЩИТНЫЙ СТОП: адрес ${String(email || 'пусто')} относится к MAVIS/отправителю. ` +
      `Письмо по задаче ${taskId || '?'} НЕ отправлено.`
    );
  }
  return true;
}

function docReturnPickClientEmail(emails) {
  const cleaned = (emails || [])
    .map((x) => String(x || '').trim().toLowerCase())
    .filter(Boolean);

  // Никакого fallback на нашу почту. Если внешнего email нет — возвращаем пусто.
  return cleaned.find((email) => !docReturnIsForbiddenRecipient(email)) || '';
}

function docReturnDecodeXmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function docReturnExtractEmailsFromBuffer(buffer, fileName = '') {
  const name = String(fileName || '').toLowerCase();
  const found = [];

  const addFrom = (value) => {
    for (const email of docReturnExtractEmailsFromText(value)) {
      if (!found.includes(email)) found.push(email);
    }
  };

  if (/\.docx$/i.test(name)) {
    try {
      const zip = new AdmZip(buffer);
      const entries = zip.getEntries();
      for (const entry of entries) {
        const entryName = String(entry.entryName || '');
        if (
          /^word\/document\.xml$/i.test(entryName) ||
          /^word\/header\d*\.xml$/i.test(entryName) ||
          /^word\/footer\d*\.xml$/i.test(entryName) ||
          /^word\/comments\.xml$/i.test(entryName)
        ) {
          const xml = entry.getData().toString('utf8');
          addFrom(docReturnDecodeXmlEntities(xml.replace(/<[^>]+>/g, ' ')));
        }
      }
    } catch (e) {
      console.warn(`[doc-return] DOCX parse ${fileName}: ${e.message || e}`);
    }
  }

  try { addFrom(buffer.toString('latin1')); } catch (_) {}
  try { addFrom(buffer.toString('utf8')); } catch (_) {}
  try { addFrom(buffer.toString('utf16le')); } catch (_) {}

  return found;
}

function docReturnFileEmailPriority(file) {
  const name = String(file && file.name || '').toLowerCase().replace(/ё/g, 'е');
  if (/договор|contract/.test(name)) return 0;
  if (/счет|invoice/.test(name)) return 1;
  if (/акт|act/.test(name)) return 2;
  return 3;
}

async function docReturnGetTaskChatTexts(basic) {
  const chatId = String(
    docReturnTaskValue(basic && basic.task, ['chatId', 'CHAT_ID', 'chat_id']) || ''
  ).trim();
  if (!chatId) return [];

  try {
    const dialog = await bitrixRestCall('im.dialog.messages.get', {
      DIALOG_ID: `chat${chatId}`,
      LIMIT: 100,
    });

    const messages =
      (dialog && Array.isArray(dialog.messages) && dialog.messages) ||
      (dialog && Array.isArray(dialog.MESSAGES) && dialog.MESSAGES) ||
      (dialog && dialog.result && Array.isArray(dialog.result.messages) && dialog.result.messages) ||
      (dialog && dialog.RESULT && Array.isArray(dialog.RESULT.MESSAGES) && dialog.RESULT.MESSAGES) ||
      [];

    const texts = [];
    for (const msg of messages) {
      if (!msg) continue;
      const value =
        msg.text || msg.TEXT ||
        msg.message || msg.MESSAGE ||
        msg.content || msg.CONTENT ||
        '';
      const clean = String(value || '').trim();
      if (clean) texts.push(clean);
    }

    if (texts.length) {
      console.log(`[doc-return] task=${basic.taskId}: прочитано сообщений чата=${texts.length}`);
    }
    return texts;
  } catch (e) {
    console.warn(`[doc-return] task=${basic.taskId}: не смог прочитать текст чата: ${e.message || e}`);
    return [];
  }
}

async function docReturnResolveEmailFromTaskAndFiles(basic, mergedFiles, downloadCache) {
  const crm = await docReturnResolveRecipient(basic.deal);
  if (crm.ok) return crm;

  // 1. Название/описание задачи и классические комментарии задачи.
  const commentRows = await docReturnGetTaskCommentRows(basic.taskId);
  const taskTextual = [
    basic.title,
    docReturnTaskValue(basic.task, ['description', 'DESCRIPTION']) || '',
    ...commentRows.map((c) =>
      c && (
        c.POST_MESSAGE || c.postMessage ||
        c.MESSAGE || c.message ||
        c.TEXT || c.text || ''
      )
    ),
  ].join('\n');

  const taskTextEmail = docReturnPickClientEmail(docReturnExtractEmailsFromText(taskTextual));
  if (taskTextEmail) {
    return {
      ok: true,
      email: taskTextEmail,
      entityId: 0,
      entityTypeId: 0,
      source: 'task-text',
      label: 'Email из задачи/комментария',
    };
  }

  // 2. ВАЖНО v107: сообщения в правом «Чате задачи» Bitrix — это НЕ task.commentitem.
  // Поэтому email, который сотрудник написал прямо в чат (например YarmolyukAAV@yandex.by),
  // читаем отдельно через im.dialog.messages.get.
  const chatTexts = await docReturnGetTaskChatTexts(basic);
  const chatEmail = docReturnPickClientEmail(
    docReturnExtractEmailsFromText(chatTexts.join('\n'))
  );
  if (chatEmail) {
    console.log(
      `[doc-return] task=${basic.taskId}: email найден в чате задачи: ${docReturnMaskEmail(chatEmail)}`
    );
    return {
      ok: true,
      email: chatEmail,
      entityId: 0,
      entityTypeId: 0,
      source: 'task-chat',
      label: 'Email из чата задачи',
    };
  }

  // 3. Если в CRM/задаче/чате email нет — пробуем документы.
  const ordered = [...(mergedFiles || [])].sort(
    (a, b) => docReturnFileEmailPriority(a) - docReturnFileEmailPriority(b)
  );

  for (const file of ordered.slice(0, 20)) {
    if (!file || !file.url) continue;
    const key = `${file.id || ''}:${file.attachedId || ''}:${file.url || ''}:${file.name || ''}`;

    let downloaded = downloadCache.get(key);
    if (downloaded === undefined) {
      try {
        downloaded = await actsDownloadRealFile(file);
      } catch (e) {
        downloaded = null;
        console.warn(`[doc-return] task=${basic.taskId}: email-scan файл ${file.name}: ${e.message || e}`);
      }
      downloadCache.set(key, downloaded);
    }

    if (!downloaded || !downloaded.buffer) continue;

    const emails = docReturnExtractEmailsFromBuffer(
      downloaded.buffer,
      downloaded.fileName || file.name || ''
    );
    const email = docReturnPickClientEmail(emails);
    if (email) {
      console.log(
        `[doc-return] task=${basic.taskId}: email найден внутри документа ${downloaded.fileName || file.name}: ` +
        docReturnMaskEmail(email)
      );
      return {
        ok: true,
        email,
        entityId: 0,
        entityTypeId: 0,
        source: 'document',
        label: `Email из документа ${downloaded.fileName || file.name || ''}`.trim(),
        emailSourceFile: downloaded.fileName || file.name || '',
      };
    }
  }

  return {
    ok: false,
    reason:
      'Не найден email: нет внешней почты в CRM, задаче, комментариях, чате задачи и прикреплённых документах.',
  };
}

function docReturnDocKind(title, fileName = '') {
  const s = `${title || ''} ${fileName || ''}`.toLowerCase().replace(/ё/g, 'е');
  if (/договор/.test(s)) return { key: 'contract', genitive: 'договора', label: 'Договор' };
  if (/счет/.test(s)) return { key: 'invoice', genitive: 'счёта', label: 'Счёт' };
  if (/акт/.test(s)) return { key: 'act', genitive: 'акта', label: 'Акт' };
  return { key: 'document', genitive: 'документа', label: 'Документ' };
}

function docReturnPickFile(files, taskTitle) {
  const usable = (files || []).filter((f) => f && f.url);
  if (!usable.length) return null;

  const kind = docReturnDocKind(taskTitle);
  const rx = kind.key === 'contract'
    ? /договор/i
    : kind.key === 'invoice'
      ? /сч[её]т/i
      : kind.key === 'act'
        ? /акт/i
        : null;

  const ts = (f) => {
    const n = Date.parse(String(f && f.date || ''));
    return Number.isFinite(n) ? n : 0;
  };
  const newest = (arr) => [...arr].sort((a, b) => ts(b) - ts(a))[0] || null;

  // Если файл того же типа найден — предпочитаем его.
  if (rx) {
    const matching = usable.filter((f) => rx.test(String(f.name || '')));
    if (matching.length) return newest(matching);
  }

  // Fallback оставляем специально: в тестовых/старых задачах название файла может быть условным.
  const docs = usable.filter((f) => /\.(pdf|docx?|xlsx?)$/i.test(String(f.name || '')));
  return newest(docs.length ? docs : usable);
}

function docReturnBuildBody(taskTitle, fileName) {
  const kind = docReturnDocKind(taskTitle, fileName);
  return [
    'Здравствуйте!',
    '',
    `Нам не вернулся наш экземпляр подписанного с Вашей стороны ${kind.genitive}.`,
    '',
    'Просьба распечатать в 1 экз., поставить подпись и печать и отправить нам по адресу:',
    '',
    '220140, г. Минск, ул. Домбровская, д. 9, офис 12.2.2.',
    '',
    'Получатель ООО «Мавис групп».',
    '',
    'С Уважением, Жихарева Анна',
    'MAVIS GROUP',
    '+375333315898',
  ].join('\n');
}

function docReturnNextDeadline() {
  // +14 календарных дней, 18:00 по Минску.
  const now = new Date();
  const minskParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Minsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(minskParts.map((x) => [x.type, x.value]));
  const baseUtc = new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  baseUtc.setUTCDate(baseUtc.getUTCDate() + 14);
  const y = baseUtc.getUTCFullYear();
  const m = String(baseUtc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(baseUtc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}T18:00:00+03:00`;
}

function docReturnDateRu(iso) {
  const d = new Date(iso);
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Minsk',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

function docReturnMaskEmail(email) {
  const parts = String(email || '').split('@');
  if (parts.length !== 2) return String(email || '');
  return `${parts[0].slice(0, 2)}***@${parts[1]}`;
}

function docReturnNormalizeStageTitle(value) {
  return actsCleanText(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

async function docReturnResolveStages(force = false) {
  const now = Date.now();
  if (!force && docReturnStageCache.sent && docReturnStageCache.email && docReturnStageCache.call && docReturnStageCache.manual &&
      now - docReturnStageCache.at < 30 * 60 * 1000) {
    return docReturnStageCache;
  }

  const raw = await bitrixRestCall('task.stages.get', { entityId: Number(DOC_RETURN_PROJECT_ID) });
  const rows = raw && typeof raw === 'object' ? Object.values(raw) : [];

  const findBy = (fn) => {
    const row = rows.find((st) => fn(docReturnNormalizeStageTitle(st && (st.TITLE || st.title))));
    return row ? String(row.ID || row.id || '') : '';
  };

  const sent = findBy((t) => t === 'отправлены') || findBy((t) => /^отправлены(?:\s|$)/.test(t));
  const email = findBy((t) => /(^|\s)эл\.?\s*почт/.test(t) || /электрон.*почт/.test(t));
  const call = findBy((t) => /^звонок/.test(t) || /^звон/.test(t));
  let manual = findBy((t) => t === docReturnNormalizeStageTitle(DOC_RETURN_MANUAL_STAGE_TITLE));

  if (!sent || !email || !call) {
    const available = rows.map((st) => `${st.ID || st.id}:${st.TITLE || st.title}`).join(', ');
    throw new Error(
      `Не смог определить стадии возврата оригиналов. ` +
      `Отправлены=${sent || 'нет'}, Эл.Почта=${email || 'нет'}, Звонок=${call || 'нет'}. ` +
      `Доступные стадии: ${available}`
    );
  }

  // v106: stage is created manually in Bitrix. We only resolve and use it;
  // the webhook does not need permission to create project stages.
  if (!manual) {
    const available = rows.map((st) => `${st.ID || st.id}:${st.TITLE || st.title}`).join(', ');
    throw new Error(
      `Не найдена стадия «${DOC_RETURN_MANUAL_STAGE_TITLE}» в проекте ${DOC_RETURN_PROJECT_ID}. ` +
      `Создайте её вручную. Доступные стадии: ${available}`
    );
  }

  docReturnStageCache = { at: now, sent, email, call, manual, rows };
  console.log(
    `[doc-return] stages: Отправлены=${sent}; Эл.Почта=${email}; ` +
    `Ручная отправка=${manual}; Звонок=${call}`
  );
  return docReturnStageCache;
}

async function docReturnLoadTask(taskId) {
  const raw = await bitrixRestCall('tasks.task.get', {
    taskId: Number(taskId),
    select: [
      'ID', 'TITLE', 'DESCRIPTION', 'GROUP_ID', 'STAGE_ID', 'STATUS', 'REAL_STATUS',
      'RESPONSIBLE_ID', 'CREATED_BY', 'CREATED_DATE', 'CHANGED_DATE',
      'DEADLINE', 'CHAT_ID', 'UF_CRM_TASK', 'UF_TASK_WEBDAV_FILES',
    ],
  });
  const task = raw && (raw.task || raw.TASK || raw);
  if (!task) throw new Error(`Задача ${taskId} не найдена.`);

  const groupId = String(docReturnTaskValue(task, ['groupId', 'GROUP_ID', 'group_id']) || '');
  if (groupId !== DOC_RETURN_PROJECT_ID) {
    throw new Error(
      `Защитный стоп: задача ${taskId} не из проекта ${DOC_RETURN_PROJECT_ID} (GROUP_ID=${groupId || 'пусто'}).`
    );
  }
  return task;
}

async function docReturnLoadBasicContext(taskId, task = null) {
  task = task || await docReturnLoadTask(taskId);

  const dealIds = actsExtractDealIdsFromTask(task);
  let dealId = '';
  let deal = null;

  if (dealIds.length) {
    dealId = String(dealIds[0]);
    try {
      deal = await bitrixRestCall('crm.deal.get', { id: Number(dealId) });
    } catch (e) {
      console.warn(`[doc-return] task=${taskId}: не смог открыть CRM-сделку ${dealId}: ${e.message || e}`);
      deal = null;
    }
  }

  return {
    taskId: String(taskId),
    task,
    dealId,
    deal,
    title: String(docReturnTaskValue(task, ['title', 'TITLE']) || ''),
  };
}

async function docReturnGetTaskCommentRows(taskId) {
  try {
    const raw = await bitrixRestCall('task.commentitem.getlist', {
      TASKID: Number(taskId),
      ORDER: { ID: 'DESC' },
      FILTER: {},
    });
    return Array.isArray(raw)
      ? raw
      : (raw && Array.isArray(raw.items))
        ? raw.items
        : (raw && Array.isArray(raw.result))
          ? raw.result
          : [];
  } catch (e) {
    console.warn(`[doc-return] task=${taskId}: комментарии недоступны: ${e.message || e}`);
    return [];
  }
}

async function docReturnResolveCommentFiles(taskId) {
  const listRows = await docReturnGetTaskCommentRows(taskId);
  const files = [];
  const seen = new Set();

  const addObjects = (comment, attached) => {
    const objects = attached && typeof attached === 'object'
      ? Object.values(attached)
      : [];

    for (const obj of objects) {
      if (!obj) continue;

      const attachedId = String(
        obj.ATTACHMENT_ID || obj.attachmentId || obj.ID || obj.id || ''
      ).trim();
      const fileId = String(
        obj.FILE_ID || obj.fileId || obj.OBJECT_ID || obj.objectId || ''
      ).trim();
      const name = actsCleanText(
        obj.NAME || obj.name || obj.TITLE || obj.title || ''
      );
      const url = String(
        obj.DOWNLOAD_URL || obj.downloadUrl ||
        obj.URL || obj.url ||
        obj.VIEW_URL || obj.viewUrl || ''
      ).trim();
      const date = String(
        comment && (
          comment.POST_DATE || comment.postDate ||
          comment.DATE || comment.date || ''
        ) || ''
      ).trim();

      if (!name && !fileId && !attachedId) continue;

      const key = `${attachedId}:${fileId}:${name}:${url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      files.push({
        id: fileId,
        attachedId,
        name: name || (fileId ? `файл ${fileId}` : `вложение ${attachedId}`),
        url,
        date,
        source: 'task-comment',
      });
    }
  };

  for (const row of listRows.slice(0, 100)) {
    let full = row;
    let attached =
      row && (
        row.ATTACHED_OBJECTS ||
        row.attachedObjects ||
        row.attached_objects
      );

    if (!attached || !Object.keys(attached || {}).length) {
      const itemId = String(row && (row.ID || row.id) || '').trim();
      if (itemId) {
        try {
          const got = await bitrixRestCall('task.commentitem.get', {
            TASKID: Number(taskId),
            ITEMID: Number(itemId),
          });
          full = got && (got.item || got.ITEM || got) || row;
          attached =
            full && (
              full.ATTACHED_OBJECTS ||
              full.attachedObjects ||
              full.attached_objects
            );
        } catch (_) {}
      }
    }

    addObjects(full, attached);
  }

  if (files.length) {
    console.log(
      `[doc-return] task=${taskId}: файлов из старых комментариев=${files.length}: ` +
      files.slice(0, 10).map((f) => f.name).join(', ')
    );
  }

  return files;
}

async function docReturnShouldManageHistoricalEmailTask(task) {
  const taskId = String(docReturnTaskValue(task, ['id', 'ID']) || '');
  if (!taskId) return false;

  // v110 STRICT STAGE OWNERSHIP:
  // «Эл. Почта» НИКОГДА не является источником для первого письма.
  // Мы продолжаем контроль на этой стадии только если уже есть подтверждённый
  // комментарий НАШЕЙ автоматизации о реально отправленном письме №1/№2.
  // Дата создания/изменения задачи, recovery IDs и ручные перемещения больше
  // не дают права автоматизации трогать задачу в «Эл. Почта».
  const comments = await docReturnReadTaskComments({ taskId, task });
  for (const comment of comments) {
    const text = String(comment || '');
    const isOurReminder = text.includes(DOC_RETURN_COMMENT_1) || text.includes(DOC_RETURN_COMMENT_2);
    if (isOurReminder && text.includes(DOC_RETURN_CONFIRMED_TEXT)) return true;
    if (text.includes(DOC_RETURN_CALL_COMMENT)) return true;
  }

  return false;
}

function docReturnSendWindowStatus(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: DOC_RETURN_SEND_TIMEZONE,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type) => Number((parts.find((p) => p.type === type) || {}).value || 0);
    const hour = get('hour');
    const minute = get('minute');
    const minuteOfDay = hour * 60 + minute;
    const start = DOC_RETURN_SEND_START_HOUR * 60;
    const end = DOC_RETURN_SEND_END_HOUR * 60;
    return {
      open: minuteOfDay >= start && minuteOfDay < end,
      hour, minute, minuteOfDay, start, end,
      label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    };
  } catch (e) {
    // Если Intl неожиданно не смог определить TZ, безопаснее НЕ отправлять письмо.
    return { open: false, label: 'unknown', error: e.message || String(e) };
  }
}

async function docReturnLoadSendContext(basic) {
  const fileResolution = await actsResolveTaskFiles(basic.task);
  const commentFiles = await docReturnResolveCommentFiles(basic.taskId);

  const mergedFiles = [];
  const seen = new Set();
  for (const f of [...(fileResolution.files || []), ...commentFiles]) {
    if (!f) continue;
    const key = `${String(f.attachedId || '')}:${String(f.id || '')}:${String(f.name || '')}:${String(f.url || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    mergedFiles.push(f);
  }

  const downloadCache = new Map();

  const recipient = await docReturnResolveEmailFromTaskAndFiles(
    basic,
    mergedFiles,
    downloadCache
  );
  if (!recipient.ok) throw new Error(recipient.reason);

  // v103: письмо о возврате оригинала НИКОГДА не отправляем без реального файла.
  // Сначала пробуем наиболее подходящий файл, затем остальные кандидаты — это
  // спасает старые задачи, где первый найденный attachment уже недоступен, а файл
  // из старого комментария всё ещё можно скачать.
  const preferred = docReturnPickFile(mergedFiles, basic.title);
  const candidates = [];
  const candidateKeys = new Set();

  const pushCandidate = (f) => {
    if (!f) return;
    const key = `${String(f.attachedId || '')}:${String(f.id || '')}:${String(f.url || '')}:${String(f.name || '')}`;
    if (candidateKeys.has(key)) return;
    candidateKeys.add(key);
    candidates.push(f);
  };

  pushCandidate(preferred);
  for (const f of mergedFiles) pushCandidate(f);

  let file = null;
  let downloaded = null;
  const downloadErrors = [];

  for (const candidate of candidates) {
    if (!candidate || !candidate.url) {
      if (candidate) downloadErrors.push(`«${candidate.name || 'без названия'}»: нет ссылки для скачивания`);
      continue;
    }

    const cacheKey = `${candidate.id || ''}:${candidate.attachedId || ''}:${candidate.url || ''}:${candidate.name || ''}`;
    let got = downloadCache.get(cacheKey);

    if (got === undefined) {
      try {
        got = await actsDownloadRealFile(candidate);
      } catch (e) {
        got = null;
        downloadErrors.push(`«${candidate.name || 'без названия'}»: ${e.message || e}`);
      }
      downloadCache.set(cacheKey, got);
    }

    if (got && got.buffer && got.buffer.length) {
      file = candidate;
      downloaded = got;
      break;
    }

    if (got && (!got.buffer || !got.buffer.length)) {
      downloadErrors.push(`«${candidate.name || 'без названия'}»: файл пустой`);
    }
  }

  if (!downloaded) {
    const names = mergedFiles.map((f) => String(f && f.name || '')).filter(Boolean);
    const details = downloadErrors.slice(0, 8).join('; ');
    throw new Error(
      `Письмо НЕ отправлено: не удалось получить реальный файл для вложения. ` +
      `Найдено файлов: ${names.length ? names.join(', ') : '0'}.` +
      (details ? ` Ошибки: ${details}` : '')
    );
  }

  return {
    ...basic,
    recipient,
    file,
    downloaded,
    fileWarning: '',
    fileCandidates: mergedFiles.map((f) => ({
      name: String(f && f.name || ''),
      source: String(f && f.source || ''),
      id: String(f && f.id || ''),
      attachedId: String(f && f.attachedId || ''),
      hasUrl: Boolean(f && f.url),
    })),
  };
}

async function docReturnReadTaskComments(taskOrBasic) {
  // v109: Bitrix24 может показывать комментарии задачи в правом чате, но
  // task.commentitem.getlist их не всегда возвращает. Из-за этого старый код
  // "не видел" собственный комментарий об уже отправленном напоминании и
  // мог повторно отправить письмо №1. Теперь читаем ОБА источника.
  let basic;
  if (taskOrBasic && typeof taskOrBasic === 'object' && taskOrBasic.taskId) {
    basic = taskOrBasic;
  } else {
    const taskId = String(taskOrBasic || '').trim();
    const task = await docReturnLoadTask(taskId);
    basic = { taskId, task };
  }

  const rows = await docReturnGetTaskCommentRows(basic.taskId);
  const classic = rows.map((c) =>
    String(
      c && (
        c.POST_MESSAGE || c.postMessage ||
        c.MESSAGE || c.message ||
        c.TEXT || c.text || ''
      )
    ).trim()
  ).filter(Boolean);

  const chat = await docReturnGetTaskChatTexts(basic);
  const merged = [...new Set([...classic, ...(chat || [])].map((x) => String(x || '').trim()).filter(Boolean))];

  if (chat && chat.length) {
    console.log(
      `[doc-return] DEDUPE READ task=${basic.taskId}: classic=${classic.length}; chat=${chat.length}; merged=${merged.length}`
    );
  }

  return merged;
}

function docReturnEmailFromReminderComment(comment) {
  const match = String(comment || '').match(/(?:^|\n)\s*Email:\s*([^\s<>"']+@[^\s<>"']+)/i);
  return match ? String(match[1] || '').trim().toLowerCase() : '';
}

function docReturnReminderCommentStatus(comments, markerText) {
  let verified = false;
  let invalidOwnMail = false;
  let legacyUnverified = false;

  for (const comment of comments || []) {
    const value = String(comment || '');
    if (!value.includes(markerText)) continue;

    const email = docReturnEmailFromReminderComment(value);
    if (email && docReturnIsForbiddenRecipient(email)) {
      invalidOwnMail = true;
      continue;
    }

    if (value.includes(DOC_RETURN_CONFIRMED_TEXT)) {
      verified = true;
    } else {
      legacyUnverified = true;
    }
  }

  return { verified, invalidOwnMail, legacyUnverified };
}

async function docReturnReadState(basic) {
  const taskComments = await docReturnReadTaskComments(basic);

  const firstStatus = docReturnReminderCommentStatus(taskComments, DOC_RETURN_COMMENT_1);
  const secondStatus = docReturnReminderCommentStatus(taskComments, DOC_RETURN_COMMENT_2);

  let first = firstStatus.verified;
  let second = secondStatus.verified;
  let call = taskComments.some((comment) => String(comment || '').includes(DOC_RETURN_CALL_COMMENT));

  // Для legacy timeline доверяем только если в самой задаче нет сомнительного старого комментария.
  if (
    basic.dealId &&
    !first &&
    !firstStatus.invalidOwnMail &&
    !firstStatus.legacyUnverified
  ) {
    first = await fgTimelineHasMarker(
      basic.dealId,
      `${DOC_RETURN_LEGACY_MARKER_1} task=${basic.taskId}`,
      100
    );
  }
  if (
    basic.dealId &&
    !second &&
    !secondStatus.invalidOwnMail &&
    !secondStatus.legacyUnverified
  ) {
    second = await fgTimelineHasMarker(
      basic.dealId,
      `${DOC_RETURN_LEGACY_MARKER_2} task=${basic.taskId}`,
      100
    );
  }
  if (basic.dealId && !call) {
    call = await fgTimelineHasMarker(
      basic.dealId,
      `${DOC_RETURN_LEGACY_CALL_MARKER} task=${basic.taskId}`,
      100
    );
  }

  return {
    first,
    second,
    call,
    reminders: second ? 2 : first ? 1 : 0,
    invalidOwnMailFirst: firstStatus.invalidOwnMail,
    invalidOwnMailSecond: secondStatus.invalidOwnMail,
    legacyUnverifiedFirst: firstStatus.legacyUnverified,
    legacyUnverifiedSecond: secondStatus.legacyUnverified,
  };
}

async function docReturnAddTaskComment(task, text) {
  const taskId = Number(docReturnTaskValue(task, ['id', 'ID']) || 0);
  if (!taskId) throw new Error('Не удалось определить ID задачи для комментария.');

  try {
    await bitrixRestCall('task.commentitem.add', {
      TASKID: taskId,
      FIELDS: { POST_MESSAGE: text },
    });
    return 'task.commentitem.add';
  } catch (legacyError) {
    const chatId = Number(docReturnTaskValue(task, ['chatId', 'CHAT_ID', 'chat_id']) || 0);
    if (!chatId) throw legacyError;
    await bitrixRestCall('im.message.add', {
      DIALOG_ID: `chat${chatId}`,
      MESSAGE: text,
    });
    return 'im.message.add';
  }
}

function docReturnGetSmtpTransport() {
  if (docReturnSmtpTransport) return docReturnSmtpTransport;

  if (!DOC_RETURN_SMTP_USER || !DOC_RETURN_SMTP_PASSWORD) {
    throw new Error(
      'Нет CRM-связи для отправки через Bitrix и не настроена SMTP-почта. ' +
      'Нужны MAIL_SMTP_USER/MAIL_SMTP_PASSWORD или уже существующие MAIL_IMAP_USER/MAIL_IMAP_PASSWORD.'
    );
  }

  docReturnSmtpTransport = nodemailer.createTransport({
    host: DOC_RETURN_SMTP_HOST,
    port: DOC_RETURN_SMTP_PORT,
    secure: DOC_RETURN_SMTP_SECURE,
    auth: {
      user: DOC_RETURN_SMTP_USER,
      pass: DOC_RETURN_SMTP_PASSWORD,
    },
  });

  return docReturnSmtpTransport;
}


async function docReturnFindSentMailbox(client) {
  const boxes = await client.list();

  const special = boxes.find((box) =>
    String(box && box.specialUse || '').toLowerCase() === '\\sent'
  );
  if (special && special.path) return special.path;

  const named = boxes.find((box) =>
    /(^|\/)(sent|sent items|отправлен|отправленные|исходящ)/i.test(
      String(box && box.path || box && box.name || '')
    )
  );
  if (named && named.path) return named.path;

  // Mail.ru обычно отдаёт specialUse=\Sent, поэтому сюда попадём только при нестандартной папке.
  throw new Error('Не удалось определить папку «Отправленные» через IMAP.');
}

async function docReturnAppendToSent(rawMessage) {
  if (!DOC_RETURN_IMAP_USER || !DOC_RETURN_IMAP_PASSWORD) {
    throw new Error(
      'Нет IMAP-доступа для сохранения копии в «Отправленные». ' +
      'Нужны MAIL_IMAP_USER и MAIL_IMAP_PASSWORD.'
    );
  }

  const client = new ImapFlow({
    host: DOC_RETURN_IMAP_HOST,
    port: DOC_RETURN_IMAP_PORT,
    secure: DOC_RETURN_IMAP_SECURE,
    auth: {
      user: DOC_RETURN_IMAP_USER,
      pass: DOC_RETURN_IMAP_PASSWORD,
    },
    logger: false,
  });

  try {
    await client.connect();
    const sentPath = await docReturnFindSentMailbox(client);
    const result = await client.append(
      sentPath,
      rawMessage,
      ['\\Seen'],
      new Date()
    );
    console.log(
      `[doc-return] IMAP copy saved: folder=${sentPath}; uid=${result && result.uid || 'n/a'}`
    );
    return { ok: true, folder: sentPath, uid: result && result.uid || null };
  } finally {
    try { await client.logout(); } catch (_) {}
  }
}

async function docReturnBuildRawMail(ctx, subject, body) {
  const fromAddress = String(DOC_RETURN_SMTP_USER || '').trim();
  if (!fromAddress) {
    throw new Error('MAIL_SMTP_USER не задан — нельзя сформировать отправителя.');
  }

  const senderName = String(config.emailSenderName || 'MAVIS GROUP').trim();
  const messageId =
    `<mavis-doc-return-${String(ctx.taskId || 'task')}-${Date.now()}@mail.ru>`;

  const mail = {
    from: `${senderName} <${fromAddress}>`,
    to: ctx.recipient.email,
    replyTo: fromAddress,
    subject,
    text: body,
    date: new Date(),
    messageId,
  };

  // v108: ЖЁСТКИЙ ПРЕДОХРАНИТЕЛЬ. Письмо этого процесса физически не может
  // быть собрано без вложения. Если файла нет — исключение до SMTP.
  if (!ctx.downloaded || !ctx.downloaded.buffer || !ctx.downloaded.buffer.length) {
    throw new Error(
      'Письмо НЕ отправлено: файл для вложения отсутствует непосредственно перед сборкой MIME.'
    );
  }

  const originalName = String(
    ctx.downloaded.fileName ||
    (ctx.file && ctx.file.name) ||
    'document'
  );

  mail.attachments = [{
    filename: originalName,
    content: Buffer.from(ctx.downloaded.buffer),
    contentType: actsMimeByFileName(
      originalName,
      ctx.downloaded.contentType || ''
    ),
    contentDisposition: 'attachment',
  }];

  // Собираем ровно один RFC822/MIME message и именно его:
  // 1) отправляем SMTP,
  // 2) кладём в IMAP «Отправленные».
  const compiler = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });

  const built = await compiler.sendMail(mail);
  const raw = Buffer.isBuffer(built.message)
    ? built.message
    : Buffer.from(built.message);

  // v108: проверяем уже ГОТОВЫЙ RFC822/MIME перед SMTP.
  // Так мы не доверяем только объекту nodemailer — в самом письме обязан быть attachment-part.
  const rawHeaderText = raw.toString('latin1');
  const hasAttachmentDisposition = /Content-Disposition:\s*attachment/i.test(rawHeaderText);
  const hasAttachmentFilename = /filename(?:\*0\*?|\*)?=/i.test(rawHeaderText) || /name=/i.test(rawHeaderText);
  if (!hasAttachmentDisposition || !hasAttachmentFilename) {
    throw new Error(
      `Письмо НЕ отправлено: MIME-контроль не обнаружил вложение ` +
      `(disposition=${hasAttachmentDisposition}; filename=${hasAttachmentFilename}).`
    );
  }

  console.log(
    `[doc-return] ATTACHMENT VERIFIED task=${ctx.taskId}; file=${originalName}; ` +
    `fileBytes=${ctx.downloaded.buffer.length}; mimeBytes=${raw.length}`
  );

  return {
    raw,
    messageId,
    envelope: {
      from: fromAddress,
      to: [ctx.recipient.email],
    },
  };
}

async function docReturnSendViaSmtp(ctx, subject, body) {
  docReturnAssertExternalRecipient(ctx && ctx.recipient && ctx.recipient.email, ctx && ctx.taskId);

  const transporter = docReturnGetSmtpTransport();
  const built = await docReturnBuildRawMail(ctx, subject, body);

  const info = await transporter.sendMail({
    envelope: built.envelope,
    raw: built.raw,
  });

  const accepted = Array.isArray(info && info.accepted)
    ? info.accepted.map((x) => String(x || '').toLowerCase())
    : [];
  const rejected = Array.isArray(info && info.rejected)
    ? info.rejected.map((x) => String(x || '').toLowerCase())
    : [];
  const target = String(ctx.recipient.email || '').toLowerCase();

  if (!accepted.includes(target) || rejected.includes(target)) {
    throw new Error(
      `SMTP не подтвердил получателя ${ctx.recipient.email}. ` +
      `accepted=${accepted.join(',') || 'нет'}; rejected=${rejected.join(',') || 'нет'}.`
    );
  }

  // После подтверждения SMTP сохраняем ТОЧНО ТО ЖЕ MIME-письмо в «Отправленные».
  // Если IMAP временно не ответил, повторяем несколько раз, но само письмо повторно НЕ шлём.
  let sentCopy = null;
  let lastAppendError = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      sentCopy = await docReturnAppendToSent(built.raw);
      lastAppendError = null;
      break;
    } catch (e) {
      lastAppendError = e;
      console.warn(
        `[doc-return] IMAP Sent append attempt ${attempt}/3 failed: ${e.message || e}`
      );
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  if (lastAppendError) {
    // Письмо уже принято SMTP — повторная отправка опасна дублем.
    // Возвращаем sent=true, но явно отмечаем, что копию в Sent сохранить не удалось.
    return {
      smtp: true,
      sent: true,
      messageId: built.messageId,
      accepted,
      rejected,
      sentCopySaved: false,
      sentCopyError: lastAppendError.message || String(lastAppendError),
    };
  }

  return {
    smtp: true,
    sent: true,
    messageId: built.messageId,
    accepted,
    rejected,
    sentCopySaved: true,
    sentFolder: sentCopy && sentCopy.folder || '',
    sentUid: sentCopy && sentCopy.uid || null,
  };
}

async function docReturnSendEmail(ctx, sequence) {
  const subject = 'Срочно! Возврат оригинала!';
  const fileName = ctx.downloaded && ctx.downloaded.fileName
    ? ctx.downloaded.fileName
    : (ctx.file && ctx.file.name ? ctx.file.name : '');
  const body = docReturnBuildBody(ctx.title, fileName);

  // Финальный предохранитель — срабатывает независимо от того,
  // откуда пришёл email: CRM, договор, счёт или комментарий.
  docReturnAssertExternalRecipient(ctx.recipient.email, ctx.taskId);

  // v98: всегда SMTP. Так исходный DOC/DOCX/PDF прикладывается как настоящий
  // бинарный файл с исходным именем/расширением, а не как нестандартный объект Bitrix.
  const smtpResult = await docReturnSendViaSmtp(ctx, subject, body);

  console.log(
    `[doc-return] email #${sequence} task=${ctx.taskId}; transport=SMTP-v98; ` +
    `source=${ctx.recipient.source}; to=${docReturnMaskEmail(ctx.recipient.email)}; ` +
    `file=${ctx.downloaded ? ctx.downloaded.fileName : 'без вложения'}`
  );

  return smtpResult;
}

async function docReturnSetDeadline(taskId, deadline) {
  const targetMs = docReturnParseMs(deadline);
  if (!targetMs) throw new Error(`Некорректный новый дедлайн: ${deadline}`);

  // Legacy tasks.task.update на текущем портале обычно принимает DEADLINE.
  await bitrixRestCall('tasks.task.update', {
    taskId: Number(taskId),
    fields: { DEADLINE: deadline },
  });

  // Обязательно перечитываем задачу: Bitrix иногда отвечает success, но Kanban/поле
  // фактически остаются без изменения.
  let check = await docReturnLoadTask(taskId);
  let actual = String(docReturnTaskValue(check, ['deadline', 'DEADLINE']) || '');
  let actualMs = docReturnParseMs(actual);

  // Если legacy casing не применился — пробуем современное имя поля deadline.
  if (!actualMs || Math.abs(actualMs - targetMs) > 60 * 1000) {
    await bitrixRestCall('tasks.task.update', {
      taskId: Number(taskId),
      fields: { deadline },
    });
    check = await docReturnLoadTask(taskId);
    actual = String(docReturnTaskValue(check, ['deadline', 'DEADLINE']) || '');
    actualMs = docReturnParseMs(actual);
  }

  if (!actualMs || Math.abs(actualMs - targetMs) > 60 * 1000) {
    throw new Error(
      `Bitrix не применил дедлайн. Ожидалось ${deadline}, фактически ${actual || 'пусто'}.`
    );
  }

  console.log(`[doc-return] deadline task=${taskId}: ${actual}`);
  return check;
}

async function docReturnMoveStage(taskId, stageId) {
  // Для Kanban проекта нужен именно task.stages.movetask.
  // STAGE_ID через tasks.task.update может вернуть success, но карточку не передвинуть.
  await bitrixRestCall('task.stages.movetask', {
    id: Number(taskId),
    stageId: Number(stageId),
  });

  const check = await docReturnLoadTask(taskId);
  const actualStage = String(docReturnTaskValue(check, ['stageId', 'STAGE_ID', 'stage_id']) || '');
  if (actualStage !== String(stageId)) {
    throw new Error(
      `Bitrix не переместил задачу ${taskId}: ожидалась стадия ${stageId}, фактически ${actualStage || 'пусто'}.`
    );
  }

  console.log(`[doc-return] stage task=${taskId}: moved to ${actualStage}`);
  return check;
}

function docReturnReminderComment(sequence, ctx, nextDeadline, sendResult = null) {
  const lines = [
    sequence === 1 ? DOC_RETURN_COMMENT_1 : DOC_RETURN_COMMENT_2,
    `Email: ${ctx.recipient.email}`,
    `Источник email: ${
      ctx.recipient.source === 'company'
        ? 'компания в CRM'
        : ctx.recipient.source === 'contact'
          ? 'контакт в CRM'
          : ctx.recipient.source === 'document'
            ? `документ${ctx.recipient.emailSourceFile ? ` — ${ctx.recipient.emailSourceFile}` : ''}`
            : 'текст задачи/комментария'
    }`,
    `Документ: ${ctx.downloaded ? ctx.downloaded.fileName : 'без вложения'}`,
    `Следующий срок контроля: ${docReturnDateRu(nextDeadline)}.`,
    DOC_RETURN_CONFIRMED_TEXT,
  ];

  if (sendResult && sendResult.sentCopySaved) {
    lines.push(`Копия сохранена в «Отправленные»${sendResult.sentFolder ? ` (${sendResult.sentFolder})` : ''}.`);
  } else if (sendResult && sendResult.sentCopySaved === false) {
    lines.push('Письмо принято почтовым сервером, но копия в «Отправленные» не сохранилась.');
  }

  return lines.join('\n');
}


async function docReturnCleanupTechnicalLockComments(taskId) {
  try {
    const rows = await docReturnGetTaskCommentRows(taskId);
    for (const row of rows.slice(0, 100)) {
      const message = String(
        row && (
          row.POST_MESSAGE || row.postMessage ||
          row.MESSAGE || row.message ||
          row.TEXT || row.text || ''
        ) || ''
      );
      if (!message.includes('[MAVIS_DOC_RETURN_LOCK]')) continue;

      const itemId = Number(row && (row.ID || row.id) || 0);
      if (!itemId) continue;

      try {
        await bitrixRestCall('task.commentitem.delete', {
          TASKID: Number(taskId),
          ITEMID: itemId,
        });
        console.log(`[doc-return] cleanup technical lock-comment task=${taskId}; comment=${itemId}`);
      } catch (e) {
        console.warn(
          `[doc-return] cleanup lock-comment task=${taskId}; comment=${itemId}: ${e.message || e}`
        );
      }
    }
  } catch (e) {
    console.warn(`[doc-return] cleanup technical comments task=${taskId}: ${e.message || e}`);
  }
}

async function docReturnSendReminder(basic, sequence) {
  // v108: никаких писем ночью/вечером. 08:00 <= Минск < 19:00.
  const sendWindow = docReturnSendWindowStatus();
  if (!sendWindow.open) {
    console.log(
      `[doc-return] TIME WINDOW CLOSED task=${basic.taskId}; minsk=${sendWindow.label}; ` +
      `allowed=${String(DOC_RETURN_SEND_START_HOUR).padStart(2, '0')}:00-` +
      `${String(DOC_RETURN_SEND_END_HOUR).padStart(2, '0')}:00`
    );
    return {
      ok: true,
      skipped: true,
      taskId: String(basic.taskId),
      reason: 'outside-send-window',
      minskTime: sendWindow.label,
    };
  }

  // v102: никаких технических комментариев-lock в задаче.
  // Защита от дублей обеспечивается:
  // 1) webhook выключен по умолчанию,
  // 2) polling не пересекается внутри процесса,
  // 3) task-level local lock уже есть в docReturnProcessTask,
  // 4) перед SMTP перечитываем состояние и дедлайн ещё раз.
  await docReturnCleanupTechnicalLockComments(basic.taskId);

  let freshTask = await docReturnLoadTask(basic.taskId);
  let freshBasic = await docReturnLoadBasicContext(basic.taskId, freshTask);
  let freshState = await docReturnReadState(freshBasic);

  // v110 HARD DEDUPE: после успешного письма мы всегда ставим новый срок +14 дней.
  // Даже если Bitrix временно не отдал комментарий/чат, письмо №1 нельзя отправлять
  // повторно при будущем дедлайне. Это независимый второй предохранитель.
  if (sequence === 1 && !docReturnIsDeadlineExpired(freshTask)) {
    console.warn(
      `[doc-return] DUPLICATE BLOCK task=${freshBasic.taskId}: reminder #1 blocked because deadline is still in future (${docReturnTaskValue(freshTask, ['deadline', 'DEADLINE']) || 'n/a'}).`
    );
    return {
      ok: true,
      skipped: true,
      taskId: freshBasic.taskId,
      reason: 'reminder-1-future-deadline-hard-dedupe',
    };
  }

  if (sequence === 1 && freshState.first) {
    return {
      ok: true,
      skipped: true,
      taskId: freshBasic.taskId,
      reason: 'reminder-1-already-sent',
    };
  }

  if (sequence === 2) {
    if (freshState.second) {
      return {
        ok: true,
        skipped: true,
        taskId: freshBasic.taskId,
        reason: 'reminder-2-already-sent',
      };
    }
    if (!freshState.first) {
      throw new Error('Защитный стоп: нельзя отправлять письмо №2 без подтверждённого письма №1.');
    }
    if (!docReturnIsDeadlineExpired(freshTask)) {
      return {
        ok: true,
        skipped: true,
        taskId: freshBasic.taskId,
        reason: 'deadline-not-expired-before-send',
      };
    }
  }

  // Короткая повторная проверка перед отправкой.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  freshTask = await docReturnLoadTask(basic.taskId);
  freshBasic = await docReturnLoadBasicContext(basic.taskId, freshTask);
  freshState = await docReturnReadState(freshBasic);

  if (sequence === 1 && !docReturnIsDeadlineExpired(freshTask)) {
    console.warn(
      `[doc-return] DUPLICATE BLOCK RECHECK task=${freshBasic.taskId}: reminder #1 blocked because deadline is still in future (${docReturnTaskValue(freshTask, ['deadline', 'DEADLINE']) || 'n/a'}).`
    );
    return {
      ok: true,
      skipped: true,
      taskId: freshBasic.taskId,
      reason: 'reminder-1-future-deadline-hard-dedupe-recheck',
    };
  }

  if (sequence === 1 && freshState.first) {
    return {
      ok: true,
      skipped: true,
      taskId: freshBasic.taskId,
      reason: 'reminder-1-already-sent-recheck',
    };
  }
  if (sequence === 2) {
    if (freshState.second) {
      return {
        ok: true,
        skipped: true,
        taskId: freshBasic.taskId,
        reason: 'reminder-2-already-sent-recheck',
      };
    }
    if (!docReturnIsDeadlineExpired(freshTask)) {
      return {
        ok: true,
        skipped: true,
        taskId: freshBasic.taskId,
        reason: 'deadline-not-expired-recheck',
      };
    }
  }

  const ctx = await docReturnLoadSendContext(freshBasic);
  const nextDeadline = docReturnNextDeadline();

  docReturnAssertExternalRecipient(ctx.recipient.email, ctx.taskId);

  const activityId = await docReturnSendEmail(ctx, sequence);

  if (!activityId || activityId.sent !== true) {
    throw new Error('Почтовый сервер не подтвердил отправку. Комментарий и дедлайн не меняю.');
  }

  await docReturnSetDeadline(ctx.taskId, nextDeadline);

  const comment = docReturnReminderComment(sequence, ctx, nextDeadline, activityId);
  const commentVia = await docReturnAddTaskComment(ctx.task, comment);

  const marker = sequence === 1 ? DOC_RETURN_LEGACY_MARKER_1 : DOC_RETURN_LEGACY_MARKER_2;
  if (ctx.dealId) {
    await fgAddCommentOnce(
      ctx.dealId,
      `${marker} task=${ctx.taskId}`,
      `Система возврата оригиналов: email-напоминание №${sequence} отправлено. Следующий контроль ${docReturnDateRu(nextDeadline)}.`
    ).catch(() => {});
  }

  console.log(
    `[doc-return] SENT #${sequence} task=${ctx.taskId}; deal=${ctx.dealId}; ` +
    `email=${docReturnMaskEmail(ctx.recipient.email)}; file=${ctx.downloaded && ctx.downloaded.fileName || 'NONE'}; ` +
    `deadline=${nextDeadline}; dedupe=v110-strict-stage-ownership`
  );

  return {
    ok: true,
    action: `reminder-${sequence}`,
    taskId: ctx.taskId,
    dealId: ctx.dealId,
    email: docReturnMaskEmail(ctx.recipient.email),
    file: ctx.downloaded ? ctx.downloaded.fileName : null,
    sentWithoutAttachment: !ctx.downloaded,
    nextDeadline,
    activityId,
    commentVia,
  };
}

async function docReturnMoveToCall(basic, stages) {
  await docReturnMoveStage(basic.taskId, stages.call);
  await docReturnAddTaskComment(basic.task, DOC_RETURN_CALL_COMMENT);

  if (basic.dealId) {
    await fgAddCommentOnce(
      basic.dealId,
      `${DOC_RETURN_LEGACY_CALL_MARKER} task=${basic.taskId}`,
      'Система возврата оригиналов: два email-напоминания отправлены, задача передана на ручной звонок.'
    ).catch(() => {});
  }

  console.log(`[doc-return] CALL task=${basic.taskId}; moved to stage=${stages.call}`);

  return {
    ok: true,
    action: 'move-to-call',
    taskId: basic.taskId,
    dealId: basic.dealId,
    stageId: stages.call,
  };
}

function docReturnIsManualSendError(errorText) {
  const text = String(errorText || '');
  return (
    /Не найден email/i.test(text) ||
    /crm-external-email-not-found/i.test(text) ||
    /Письмо НЕ отправлено: не удалось получить реальный файл/i.test(text) ||
    /ЗАЩИТНЫЙ СТОП: адрес .* относится к MAVIS\/отправителю/i.test(text) ||
    /Неподтверждённая старая отправка/i.test(text)
  );
}

function docReturnManualReason(errorText) {
  const text = String(errorText || '');
  if (/Не найден email|crm-external-email-not-found/i.test(text)) {
    return 'Не найден корректный email клиента.';
  }
  if (/не удалось получить реальный файл/i.test(text)) {
    return 'Не удалось получить файл для вложения.';
  }
  if (/относится к MAVIS\/отправителю/i.test(text)) {
    return 'В CRM указан служебный/внутренний email вместо адреса клиента.';
  }
  if (/Неподтверждённая старая отправка/i.test(text)) {
    return 'Есть старый комментарий об отправке, но нет SMTP-подтверждения. Нужно вручную проверить, получал ли клиент письмо.';
  }
  return 'Автоматическая отправка невозможна.';
}

async function docReturnMoveToManual(taskId, originalError) {
  const stages = await docReturnResolveStages();
  let task = null;
  try {
    task = await docReturnLoadTask(taskId);
    const currentStage = String(docReturnTaskValue(task, ['stageId', 'STAGE_ID', 'stage_id']) || '');
    if (currentStage !== stages.manual) {
      task = await docReturnMoveStage(taskId, stages.manual);
    }
  } catch (e) {
    console.error(`[doc-return] MANUAL MOVE ERROR task=${taskId}: ${e.message || e}`);
    throw e;
  }

  const reason = docReturnManualReason(originalError);
  const comment =
    `Автоматическая отправка не выполнена. ${reason}\n` +
    `Задача перемещена в стадию «${DOC_RETURN_MANUAL_STAGE_TITLE}». ` +
    `Нужно проверить данные клиента/файл и отправить документ вручную.`;

  try {
    await docReturnAddTaskComment(task, comment);
  } catch (e) {
    console.warn(`[doc-return] manual comment task=${taskId}: ${e.message || e}`);
  }

  console.warn(`[doc-return] MANUAL task=${taskId}; reason=${reason}`);
  return {
    ok: true,
    action: 'move-to-manual-send',
    taskId: String(taskId),
    stageId: stages.manual,
    reason,
    originalError: String(originalError || ''),
  };
}

async function docReturnProcessTask(taskId, trigger = 'poll') {
  taskId = String(taskId || '').trim();
  if (!taskId) return { ok: false, skipped: true, reason: 'no-task-id' };
  if (docReturnLocks.has(taskId)) {
    return { ok: true, skipped: true, reason: 'locked', taskId };
  }

  docReturnLocks.add(taskId);
  try {
    const task = await docReturnLoadTask(taskId);

    if (!docReturnIsEligible(task)) {
      return {
        ok: true,
        skipped: true,
        taskId,
        reason: 'historical-protection',
        createdDate: docReturnTaskValue(task, ['createdDate', 'CREATED_DATE']) || '',
        productionStart: DOC_RETURN_PRODUCTION_START_ISO,
      };
    }

    const stages = await docReturnResolveStages();
    let currentTask = task;
    let stageId = String(docReturnTaskValue(currentTask, ['stageId', 'STAGE_ID', 'stage_id']) || '');
    const expired = docReturnIsDeadlineExpired(currentTask);
    let movedFromSent = false;

    // Стадия «Отправлены»: до перемещения делаем полный preflight.
    // Только email: адрес берём из CRM/задачи/документа.
    // Реальный файл DOC/DOCX/PDF обязателен; без него письмо не отправляется.
    if (stageId === stages.sent) {
      if (!expired) {
        return { ok: true, skipped: true, taskId, stage: 'sent', reason: 'deadline-not-expired' };
      }

      const preflightBasic = await docReturnLoadBasicContext(taskId, currentTask);
      const preflightState = await docReturnReadState(preflightBasic);

      if (!preflightState.first) {
        await docReturnLoadSendContext(preflightBasic);
      }

      currentTask = await docReturnMoveStage(taskId, stages.email);
      stageId = String(docReturnTaskValue(currentTask, ['stageId', 'STAGE_ID', 'stage_id']) || '');
      movedFromSent = true;
      console.log(`[doc-return] MOVE task=${taskId}: Отправлены -> Эл. Почта (${trigger})`);
    }

    // Другие стадии, включая «Приедут, не отправляем», не трогаем.
    if (stageId !== stages.email) {
      return {
        ok: true,
        skipped: true,
        taskId,
        reason: 'stage-not-managed',
        stageId,
      };
    }

    let basic = await docReturnLoadBasicContext(taskId, currentTask);
    const state = await docReturnReadState(basic);

    // v110: жёсткая страховка от повторного письма №1.
    // Если задача уже стоит в «Эл. Почта» и её дедлайн в будущем, значит текущий
    // цикл контроля ещё не наступил. НИЧЕГО не отправляем, даже если API Bitrix
    // по какой-то причине не вернул предыдущий комментарий.
    if (!state.first && !docReturnIsDeadlineExpired(currentTask)) {
      console.warn(
        `[doc-return] DUPLICATE SAFETY HOLD task=${taskId}: no readable reminder marker, ` +
        `but deadline is in future (${docReturnTaskValue(currentTask, ['deadline', 'DEADLINE']) || 'n/a'}). No email sent.`
      );
      return {
        ok: true,
        skipped: true,
        taskId,
        reason: 'future-deadline-without-readable-marker',
        deadline: docReturnTaskValue(currentTask, ['deadline', 'DEADLINE']) || '',
      };
    }

    // Старые комментарии v97/v98 без SMTP-подтверждения считаем сомнительными.
    // Не шлём повторно автоматически, чтобы не задублировать письмо клиенту.
    if (
      (state.legacyUnverifiedFirst && !state.invalidOwnMailFirst) ||
      (state.legacyUnverifiedSecond && !state.invalidOwnMailSecond)
    ) {
      console.warn(
        `[doc-return] UNVERIFIED LEGACY task=${taskId}: есть старый комментарий «отправлено», ` +
        'но нет SMTP-подтверждения. Автоповтор не делаю; отправляю задачу в «Ручная отправка».'
      );
      return await docReturnMoveToManual(
        taskId,
        'Неподтверждённая старая отправка: есть комментарий «отправлено», но нет SMTP-подтверждения.'
      );
    }

    // v110: письмо №1 разрешено ТОЛЬКО при входе со стадии «Отправлены».
    // Если задача уже была в «Эл. Почта» до этого цикла и нет подтверждённого
    // первого письма нашей автоматизации — вообще её не трогаем и тем более
    // не переводим в «Ручная отправка».
    if (!state.first) {
      if (!movedFromSent) {
        console.log(`[doc-return] SKIP EMAIL STAGE task=${taskId}: first reminder may only start from «Отправлены».`);
        return {
          ok: true,
          skipped: true,
          taskId,
          reason: 'email-stage-not-owned-no-first-reminder',
          stageId,
        };
      }
      return await docReturnSendReminder(basic, 1);
    }

    // Защита/ремонт уже начатого теста или редкой рассинхронизации:
    // письмо №1 уже существует, но задача почему-то оставалась в «Отправлены»
    // с просроченным старым дедлайном. Не шлём письмо №2 мгновенно.
    // Переводим в «Эл. Почта» и восстанавливаем полноценные 14 дней от текущего момента.
    if (movedFromSent && state.first && !state.second) {
      const repairedDeadline = docReturnNextDeadline();
      currentTask = await docReturnSetDeadline(taskId, repairedDeadline);

      console.log(
        `[doc-return] REPAIR task=${taskId}: reminder #1 уже был; ` +
        `стадия восстановлена на Эл. Почта, дедлайн=${repairedDeadline}`
      );

      return {
        ok: true,
        action: 'repair-after-reminder-1',
        taskId,
        dealId: basic.dealId,
        reminders: 1,
        nextDeadline: repairedDeadline,
        message: 'Первое письмо уже было отправлено ранее. Повтор не отправляю; восстановил стадию и срок +14 дней.',
      };
    }

    // Первое уже ушло: до нового дедлайна ничего не делаем.
    if (!docReturnIsDeadlineExpired(currentTask)) {
      return {
        ok: true,
        skipped: true,
        taskId,
        reminders: state.reminders,
        reason: 'deadline-not-expired',
        deadline: docReturnTaskValue(currentTask, ['deadline', 'DEADLINE']) || '',
      };
    }

    // Дедлайн после письма №1 истёк -> письмо №2.
    if (state.first && !state.second) {
      basic = await docReturnLoadBasicContext(taskId, currentTask);
      return await docReturnSendReminder(basic, 2);
    }

    // Дедлайн после письма №2 истёк -> «Звонок», третьего email нет.
    if (state.second && !state.call) {
      basic = await docReturnLoadBasicContext(taskId, currentTask);
      return await docReturnMoveToCall(basic, stages);
    }

    return {
      ok: true,
      skipped: true,
      taskId,
      reminders: state.reminders,
      reason: state.call ? 'already-in-call-flow' : 'nothing-to-do',
    };
  } catch (e) {
    const errorText = e.message || String(e);

    // v110: если ошибка возникла у задачи, которая уже находится в «Эл. Почта»,
    // но не имеет подтверждённого первого письма нашей автоматизации, НЕ ТРОГАЕМ её.
    // В «Ручная отправка» могут уходить ошибки только из нашего собственного контура.
    try {
      const guardTask = await docReturnLoadTask(taskId);
      const guardStages = await docReturnResolveStages();
      const guardStageId = String(docReturnTaskValue(guardTask, ['stageId', 'STAGE_ID', 'stage_id']) || '');
      if (guardStageId === guardStages.email) {
        const guardBasic = await docReturnLoadBasicContext(taskId, guardTask);
        const guardState = await docReturnReadState(guardBasic);
        if (!guardState.first && !guardState.second && !guardState.call) {
          console.warn(`[doc-return] EMAIL STAGE PROTECTED task=${taskId}: error ignored, task left untouched: ${errorText}`);
          return { ok: true, skipped: true, taskId, reason: 'email-stage-protected-on-error', error: errorText };
        }
      }
    } catch (guardError) {
      console.warn(`[doc-return] email-stage protection check failed task=${taskId}: ${guardError.message || guardError}`);
    }

    // Ошибки данных нашего собственного контура отправляем в «Ручная отправка».
    if (docReturnIsManualSendError(errorText)) {
      try {
        return await docReturnMoveToManual(taskId, errorText);
      } catch (moveError) {
        console.error(
          `[doc-return] ERROR task=${taskId}: ${errorText}; ` +
          `дополнительно не удалось перевести в ручную отправку: ${moveError.message || moveError}`
        );
        return {
          ok: false,
          taskId,
          error: errorText,
          manualMoveError: moveError.message || String(moveError),
        };
      }
    }

    // Временные технические ошибки (SMTP/REST/IMAP) не отправляем в ручную стадию сразу:
    // оставляем задачу в очереди и повторим автоматически позже.
    const until = Date.now() + DOC_RETURN_ERROR_COOLDOWN_MINUTES * 60 * 1000;
    docReturnErrorCooldownUntil.set(taskId, until);
    console.error(
      `[doc-return] ERROR task=${taskId}: ${errorText}; ` +
      `повтор через ${DOC_RETURN_ERROR_COOLDOWN_MINUTES} мин.`
    );
    return { ok: false, taskId, error: errorText };
  } finally {
    docReturnLocks.delete(taskId);
  }
}

async function docReturnListStageTasks(stageId, limit = 1000) {
  // Сначала пробуем сузить список по дате создания прямо в Bitrix.
  if (!DOC_RETURN_INCLUDE_HISTORICAL) {
    try {
      return await bitrixRestList('tasks.task.list', {
        filter: {
          GROUP_ID: Number(DOC_RETURN_PROJECT_ID),
          STAGE_ID: String(stageId),
          '>=CREATED_DATE': DOC_RETURN_PRODUCTION_START_ISO,
        },
        select: [
          'ID', 'TITLE', 'GROUP_ID', 'STAGE_ID', 'DEADLINE',
          'CREATED_DATE', 'CHANGED_DATE', 'UF_CRM_TASK',
        ],
        order: { ID: 'ASC' },
      }, limit);
    } catch (e) {
      console.warn(`[doc-return] stage-list filtered fallback: ${e.message || e}`);
    }
  }

  // Fallback: читаем стадию и фильтруем локально.
  const rows = await bitrixRestList('tasks.task.list', {
    filter: {
      GROUP_ID: Number(DOC_RETURN_PROJECT_ID),
      STAGE_ID: String(stageId),
    },
    select: [
      'ID', 'TITLE', 'GROUP_ID', 'STAGE_ID', 'DEADLINE',
      'CREATED_DATE', 'CHANGED_DATE', 'UF_CRM_TASK',
    ],
    order: { ID: 'ASC' },
  }, limit);

  return rows.filter((task) => docReturnIsEligible(task));
}

async function docReturnRunPollingCycle(trigger = 'interval') {
  if (docReturnCycleRunning) {
    console.warn(`[doc-return] poll ${trigger}: предыдущий цикл ещё работает, новый цикл пропущен.`);
    return { ok: true, skipped: true, reason: 'poll-cycle-already-running' };
  }

  docReturnCycleRunning = true;
  try {
  if (!DOC_RETURN_ENABLED || !config.bitrixWebhookUrl) {
    return { ok: true, skipped: true, reason: 'disabled-or-no-bitrix' };
  }

  const sendWindow = docReturnSendWindowStatus();
  if (!sendWindow.open) {
    console.log(
      `[doc-return] poll ${trigger}: пауза по времени; Минск ${sendWindow.label}; ` +
      `рассылка разрешена ${String(DOC_RETURN_SEND_START_HOUR).padStart(2, '0')}:00-` +
      `${String(DOC_RETURN_SEND_END_HOUR).padStart(2, '0')}:00.`
    );
    return {
      ok: true,
      skipped: true,
      reason: 'outside-send-window',
      minskTime: sendWindow.label,
    };
  }

  const stages = await docReturnResolveStages();
  const ids = new Set();

  // Тестовая задача всегда контролируется отдельно — независимо от даты создания.
  if (DOC_RETURN_TEST_TASK_ID) ids.add(DOC_RETURN_TEST_TASK_ID);

  // «Отправлены»: при historical=true берём весь старый хвост.
  const sentTasks = await docReturnListStageTasks(stages.sent, 1000);

  // «Эл. Почта»: v110 — берём ТОЛЬКО задачи, в которых уже есть подтверждённый
  // комментарий нашей автоматизации. Любые остальные задачи на этой стадии
  // полностью вне контура: не отправляем, не двигаем, не переводим в ручную.
  const emailAll = await bitrixRestList('tasks.task.list', {
    filter: {
      GROUP_ID: Number(DOC_RETURN_PROJECT_ID),
      STAGE_ID: String(stages.email),
    },
    select: [
      'ID', 'TITLE', 'GROUP_ID', 'STAGE_ID', 'DEADLINE',
      'CREATED_DATE', 'CHANGED_DATE', 'UF_CRM_TASK',
    ],
    order: { ID: 'ASC' },
  }, 1000);

  const emailTasks = [];
  for (const task of emailAll) {
    if (!DOC_RETURN_INCLUDE_HISTORICAL) {
      if (docReturnIsEligible(task)) emailTasks.push(task);
      continue;
    }
    if (await docReturnShouldManageHistoricalEmailTask(task)) {
      emailTasks.push(task);
    }
  }

  for (const task of [...sentTasks, ...emailTasks]) {
    const id = String(docReturnTaskValue(task, ['id', 'ID']) || '');
    if (id) ids.add(id);
  }

  const results = [];
  let actionCount = 0;
  let checksCount = 0;

  // v101: не начинаем каждый цикл снова с самых старых ID.
  // Иначе несколько старых задач без email бесконечно стояли первыми
  // и до остальных документов очередь практически не доходила.
  const allIds = Array.from(ids);
  const totalIds = allIds.length;
  const startIndex = totalIds ? (docReturnQueueCursor % totalIds) : 0;
  const orderedIds = totalIds
    ? [...allIds.slice(startIndex), ...allIds.slice(0, startIndex)]
    : [];

  let traversed = 0;
  let cursor = 0;

  // v104: обрабатываем разные задачи параллельно небольшими пачками.
  // Внутри одной задачи прежний lock и двойная проверка от дублей сохраняются.
  while (
    cursor < orderedIds.length &&
    actionCount < DOC_RETURN_MAX_ACTIONS_PER_CYCLE &&
    checksCount < DOC_RETURN_MAX_CHECKS_PER_CYCLE
  ) {
    const batch = [];

    while (
      cursor < orderedIds.length &&
      batch.length < DOC_RETURN_CONCURRENCY &&
      checksCount + batch.length < DOC_RETURN_MAX_CHECKS_PER_CYCLE
    ) {
      const taskId = orderedIds[cursor++];
      traversed++;

      const cooldownUntil = Number(docReturnErrorCooldownUntil.get(String(taskId)) || 0);
      if (cooldownUntil > Date.now()) continue;
      if (cooldownUntil) docReturnErrorCooldownUntil.delete(String(taskId));

      batch.push(String(taskId));
    }

    if (!batch.length) continue;
    checksCount += batch.length;

    const batchResults = await Promise.all(
      batch.map((taskId) => docReturnProcessTask(taskId, trigger))
    );

    for (const result of batchResults) {
      results.push(result);
      if (result && result.action) actionCount++;
    }
  }

  // Следующий цикл начинает с другого места очереди.
  if (totalIds) {
    docReturnQueueCursor = (startIndex + Math.max(traversed, 1)) % totalIds;
  }

  const actionable = results.filter((r) => r && r.action);
  const errors = results.filter((r) => r && r.ok === false);

  console.log(
    `[doc-return] poll ${trigger}: checked=${results.length}; actions=${actionable.length}; ` +
    `errors=${errors.length}; maxActions=${DOC_RETURN_MAX_ACTIONS_PER_CYCLE}; ` +
    `maxChecks=${DOC_RETURN_MAX_CHECKS_PER_CYCLE}; cursor=${docReturnQueueCursor}/${totalIds}; ` +
    `newOnly=${DOC_RETURN_INCLUDE_HISTORICAL ? 'NO' : `YES from ${DOC_RETURN_PRODUCTION_START_ISO}`}`
  );

  return { ok: errors.length === 0, checked: results.length, actions: actionable, errors };

  } finally {
    docReturnCycleRunning = false;
  }
}

async function docReturnDryRun(taskId) {
  const task = await docReturnLoadTask(taskId);
  const stages = await docReturnResolveStages();
  const stageId = String(docReturnTaskValue(task, ['stageId', 'STAGE_ID', 'stage_id']) || '');
  const basic = await docReturnLoadBasicContext(taskId, task);
  const state = await docReturnReadState(basic);

  let send = null;
  try {
    send = await docReturnLoadSendContext(basic);
  } catch (e) {
    send = { error: e.message || String(e) };
  }

  let nextAction = 'ничего';
  if (stageId === stages.sent) {
    nextAction = docReturnIsDeadlineExpired(task)
      ? 'перевести в «Эл. Почта» и отправить письмо №1'
      : 'ждать дедлайн на стадии «Отправлены»';
  } else if (stageId === stages.email) {
    if (!state.first) nextAction = 'отправить письмо №1';
    else if (!docReturnIsDeadlineExpired(task)) nextAction = `ждать дедлайн после письма №${state.reminders}`;
    else if (!state.second) nextAction = 'отправить письмо №2';
    else if (!state.call) nextAction = 'перевести в «Звонок» без третьего письма';
  } else if (stageId === stages.call) {
    nextAction = 'ручной звонок';
  }

  return {
    ok: true,
    dryRun: true,
    taskId: String(taskId),
    projectId: DOC_RETURN_PROJECT_ID,
    taskTitle: basic.title,
    dealId: basic.dealId,
    dealTitle: basic.deal ? (basic.deal.TITLE || '') : '',
    stageId,
    stages: { sent: stages.sent, email: stages.email, call: stages.call },
    deadline: docReturnTaskValue(task, ['deadline', 'DEADLINE']) || '',
    deadlineExpired: docReturnIsDeadlineExpired(task),
    state,
    eligible: docReturnIsEligible(task),
    productionStart: DOC_RETURN_PRODUCTION_START_ISO,
    includeHistorical: DOC_RETURN_INCLUDE_HISTORICAL,
    recipient: send && send.recipient ? {
      source: send.recipient.source,
      label: send.recipient.label,
      email: docReturnMaskEmail(send.recipient.email),
    } : null,
    file: send && send.downloaded ? {
      name: send.downloaded.fileName,
      bytes: send.downloaded.buffer.length,
      source: send.file && send.file.source || '',
    } : null,
    fileCandidates: send && Array.isArray(send.fileCandidates) ? send.fileCandidates : [],
    sentWithoutAttachment: Boolean(send && !send.error && !send.downloaded),
    fileWarning: send && send.fileWarning ? send.fileWarning : '',
    fileError: send && send.error ? send.error : '',
    subject: 'Срочно! Возврат оригинала!',
    nextAction,
    note: 'GET — только диагностика. Письма и перемещения не выполняются.',
  };
}

// GET — безопасная диагностика.
app.get('/api/doc-return-reminder', async (req, res) => {
  const taskId = docReturnReqTaskId(req) || DOC_RETURN_TEST_TASK_ID;
  try {
    const result = await docReturnDryRun(taskId);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, taskId, error: e.message || String(e) });
  }
});

// POST — реальная обработка одной задачи.
// Текущий тестовый робот Bitrix может продолжать вызывать task_id=47208.
// В бою серверный polling не зависит от этого робота.
app.post('/api/doc-return-reminder', async (req, res) => {
  const taskId = docReturnReqTaskId(req);
  if (!taskId) return res.status(400).json({ ok: false, error: 'task_id не передан' });

  // v100: webhook-обработка выключена по умолчанию.
  // Production ведёт только polling. Это убирает второй независимый источник отправки.
  if (!DOC_RETURN_ALLOW_WEBHOOK) {
    console.warn(
      `[doc-return] webhook task=${taskId}: проигнорирован (DOC_RETURN_ALLOW_WEBHOOK=false).`
    );
    return res.json({
      ok: true,
      skipped: true,
      taskId,
      reason: 'webhook-disabled-v100',
    });
  }

  const result = await docReturnProcessTask(taskId, 'webhook');
  return res.status(result.ok === false ? 500 : 200).json(result);
});


// ============================================================================
// ЛОКАЛЬНОЕ ПРИЛОЖЕНИЕ BITRIX24: «Возврат оригиналов»
// Отдельная страница в левом меню Bitrix. Никакого дополнительного пароля:
// браузер передаёт текущий OAuth-токен Bitrix, сервер валидирует user.current.
// ============================================================================
const { registerDocReturnLocalApp } = require('./doc_return_local_app');
registerDocReturnLocalApp({
  app,
  bitrixRestCall,
  bitrixRestList,
  actsExtractDealIdsFromTask,
  actsTaskField,
  actsCleanText,
  config,
});

console.log(
  `[doc-return] v110 STRICT_SENT_ONLY_START active: project=${DOC_RETURN_PROJECT_ID}; testTask=${DOC_RETURN_TEST_TASK_ID || 'none'}; ` +
  `poll=${DOC_RETURN_POLL_MINUTES}m; productionStart=${DOC_RETURN_PRODUCTION_START_ISO}; ` +
  `historical=${DOC_RETURN_INCLUDE_HISTORICAL}; ` +
  `allowWebhook=${DOC_RETURN_ALLOW_WEBHOOK}; maxActions=${DOC_RETURN_MAX_ACTIONS_PER_CYCLE}; ` +
  `maxChecks=${DOC_RETURN_MAX_CHECKS_PER_CYCLE}; concurrency=${DOC_RETURN_CONCURRENCY}; ` +
  `manualStage=«${DOC_RETURN_MANUAL_STAGE_TITLE}»; cooldownMin=${DOC_RETURN_ERROR_COOLDOWN_MINUTES}; ` +
  `sendWindow=${String(DOC_RETURN_SEND_START_HOUR).padStart(2, '0')}:00-${String(DOC_RETURN_SEND_END_HOUR).padStart(2, '0')}:00 ${DOC_RETURN_SEND_TIMEZONE}`
);

app.listen(PORT, () => {
  if (DOC_RETURN_ENABLED && config.bitrixWebhookUrl) {
    const docReturnPollMs = DOC_RETURN_POLL_MINUTES * 60 * 1000;
    console.log(`[doc-return] Автоконтроль включён: каждые ${DOC_RETURN_POLL_MINUTES} мин.`);
    setTimeout(() => {
      docReturnRunPollingCycle('startup').catch((e) =>
        console.error(`[doc-return] startup poll: ${e.message || e}`)
      );
    }, 10000);
    setInterval(() => {
      docReturnRunPollingCycle('interval').catch((e) =>
        console.error(`[doc-return] interval poll: ${e.message || e}`)
      );
    }, docReturnPollMs);
  } else {
    console.log('[doc-return] Автоконтроль выключен: нужен DOC_RETURN_ENABLED=true и BITRIX_WEBHOOK_URL.');
  }
  console.log(`MAVIS Bitrix Expert Assistant v125 is running on port ${PORT}`);
  console.log(`[startup] webhook=${config.bitrixWebhookUrl ? 'yes' : 'no'}, autopilot=${config.autopilotEnabled}, acts=${config.actsTasksEnabled}, actsSend=${config.actsSendToClientEnabled}, actsPoll=${config.actsDonePollEnabled}, actsPush=${config.actsPushEnabled}, actsIncoming=${config.actsIncomingEnabled}, incomingWazzup=${config.actsIncomingWazzupEnabled}, incomingEmail=${config.actsIncomingEmailEnabled}, clientDocs=${config.clientDocsIncomingEnabled}, clientDocsWazzup=${config.clientDocsWazzupEnabled}, clientDocsEmail=${config.clientDocsEmailEnabled}, clientDocsAll=${config.clientDocsAllDeals}, clientDocsTestDeal=${config.clientDocsTestDealId || 'not-set'}, firstCallTestMin=${config.firstCallTestMinutes || 0}, docsReminderTestMin=${config.docsReminderTestMinutes || 0}, executorTestDeal=${config.executorTestDealId || config.liveChatTestDealId || 'not-set'}, actsTestDeal=${config.actsTestDealId || 'not-set'}, actsAllDeals=${config.actsAllDeals}, actsProject=${config.actsProjectId}, actsProductionStart=${config.actsProductionStartIso}, actsReconManual=${Boolean(config.actsReconToken)}, actsReconAuto=${config.actsReconAutoEnabled}, actsReconLeader=${config.actsReconLeaderId}, distributionExperts=${(config.distributionExpertIds || []).join(',') || 'production-department-auto'}, collectionV85=${config.collectionControlEnabled}, selectionV85=${config.selectionControlEnabled}, cjmTestMode=${config.cjmTestMode}, cjmTestDeal=${config.cjmTestDealId}, cjmTestAllowNoCall=${config.cjmTestAllowNoCall}, noCallDeterministicV88=ON, cjmPriorityV89=ON.`);

  if (config.actsIncomingEnabled && config.actsIncomingWazzupEnabled) {
    setTimeout(() => actsLogWazzupIncomingWebhookStatus(), 5000);
  }

  if (config.bitrixWebhookUrl && config.actsReconAutoEnabled) {
    const reconCheckMs = Math.max(15, Number(config.actsReconCheckMinutes || 30)) * 60 * 1000;
    console.log(`[acts-recon-auto] Включено: последний Пн–Пт месяца после ${String(config.actsReconSendHourMinsk || 18).padStart(2,'0')}:00 по Минску; проверка раз в ${reconCheckMs / 60000} мин; получатель Таня ID ${config.actsReconLeaderId}.`);
    setTimeout(() => runActsReconAutoCycle(), 12000);
    setInterval(() => runActsReconAutoCycle(), reconCheckMs);
  } else {
    console.log('[acts-recon-auto] Автоматическая месячная сверка выключена.');
  }

  if (config.bitrixWebhookUrl && config.autopilotEnabled) {
    console.log(`[autopilot] Фоновый автопилот включён (интервал ${AUTOPILOT_POLL_INTERVAL_MS / 60000} мин). Timeline diagnostics=${config.autopilotTimelineDiagnostics ? 'ON' : 'OFF'}; anti-spam v79=ON. Старт с ${AUTOPILOT_START_DATE.toISOString()}.`);
    setTimeout(() => recoverPendingDocsChecks().catch((e) => console.warn(`[docsReminder] recovery: ${e.message || e}`)), 1500);
    // v60: первый цикл сразу после старта, а не через 2 минуты.
    setTimeout(() => runAutopilotPollingCycle(), 2000);
    setInterval(runAutopilotPollingCycle, AUTOPILOT_POLL_INTERVAL_MS);
  } else {
    console.log('[autopilot] Фоновый автопилот выключен. Для включения задай AUTOPILOT_ENABLED=true и BITRIX_WEBHOOK_URL в Render.');
  }

  if (config.bitrixWebhookUrl && config.actsTasksEnabled && config.actsSendToClientEnabled && config.actsDonePollEnabled) {
    const actsPollMs = Math.max(30, config.actsDonePollIntervalSeconds || 60) * 1000;
    console.log(`[acts-poll] Резервный контроль «Акты счета» включён, интервал ${actsPollMs / 1000} сек.`);
    setTimeout(() => runActsDonePollingCycle(), 4000);
    setInterval(runActsDonePollingCycle, actsPollMs);
  } else {
    console.log('[acts-poll] Резервный контроль актов выключен.');
  }

  if (config.bitrixWebhookUrl && config.actsPushEnabled) {
    const pushMs = Math.max(15, Number(config.actsPushIntervalMinutes || 60)) * 60 * 1000;
    const timingInfo = Number(config.actsPushTestMinutes || 0) > 0 || Number(config.actsCallTestMinutes || 0) > 0
      ? `ТЕСТ: push=${config.actsPushTestMinutes || 0} мин, call=${config.actsCallTestMinutes || 0} мин`
      : `push=${config.actsPushEveryDays || 2} календарных дня, call=${config.actsCallAfterDays || 7} дней`;
    console.log(`[acts-push] Контроль сканов/автопуши включены: ${timingInfo}; клиенту не пишем Сб/Вс. Проверка раз в ${pushMs / 60000} мин.`);
    setTimeout(async () => {
      await actsRecoverPushStatesFromBitrix();
      await runActsPushCycle();
      setInterval(() => runActsPushCycle().catch((e) => console.error('[acts-push] interval:', e.message || e)), pushMs);
    }, 7000);
  } else {
    console.log('[acts-push] Автопуши по актам выключены.');
  }

  if (config.foremanAutomationEnabled && config.foremanAllowGlobalScan && config.bitrixWebhookUrl) {
    const intervalMs = Math.max(15, config.foremanPollIntervalMinutes || 60) * 60 * 1000;
    console.log(`[foreman-auto] Глобальный обход ЯВНО включён: поле специалиста ${config.foremanProductionSpecialistField}, интервал ${intervalMs / 60000} мин.`);
    setTimeout(() => {
      runForemanAutomationCycle('startup').catch((e) => console.error('[foreman-auto] startup:', e.message || e));
      setInterval(() => runForemanAutomationCycle('interval').catch((e) => console.error('[foreman-auto] interval:', e.message || e)), intervalMs);
    }, 4 * 60 * 1000);
  } else {
    console.log('[foreman-auto] Глобальный обход прорабов выключен защитой v79. Для включения нужны FOREMAN_AUTOMATION_ENABLED=true + FOREMAN_ALLOW_GLOBAL_SCAN=true.');
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