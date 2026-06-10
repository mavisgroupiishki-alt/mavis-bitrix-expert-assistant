/* global BX24, APP_CONFIG */

const state = {
  user: null,
  role: 'expert',
  isAdmin: false,
  isLeader: false,
  isRop: false,
  fields: {},
  fieldMap: {},
  enumMaps: {},
  stageMap: new Map(),
  deals: [],
  users: new Map(),
  companies: new Map(),
  contacts: new Map(),
  activitiesByDeal: new Map(),
  tasksByDeal: new Map(),
  commentsByDeal: new Map(),
  auditByDeal: new Map(),
  selectedDeal: null,
  selectedAnalysis: '',
  selectedMissing: [],
  selectedAudit: null,
  selectedMode: '',
  selectedDeadlineTasks: [],
  selectedAiTasks: [],
  selectedAiPayload: null,
  selectedAiScenario: '',
  detailsLoading: false,
  detailsLoaded: false,
  detailsProgress: '',
  dashboardFilter: 'all',
  journalStatusFilter: 'all',
  journalManagerFilter: 'all',
  journalSearch: '',
  salesDealByProduction: new Map(),
  salesManagerLoading: false,
  salesManagerProgress: '',
  managerAiResults: [],
  managerAiTasks: [],
  aiQualityReport: null,
};

const REQUIRED_ITEMS = [
  {
    key: 'city',
    label: 'город клиента',
    why: 'нужен для выбора формата работы, логистики, органа и бумажных документов',
    exact: [/\b(минск|брест|гродно|гомель|витебск|могилев|могилёв|барановичи|борисов|мозырь|пинск|солигорск|лида|полоцк|новополоцк)\b/i, /\b(город|г\.|область|район|ул\.|улица|адрес)\b/i],
    weak: [/клиент/i],
  },
  {
    key: 'service',
    label: 'какие услуги проданы',
    why: 'без этого эксперт не понимает маршрут производства и перечень документов',
    exact: [/\b(услуга|продукт|товар|аттестация|стк|спк|iso|45001|9001|свидетельство|периодик|сертификат)\b/i],
    weak: [/оказание услуг/i],
  },
  {
    key: 'kp',
    label: 'КП или коммерческое предложение',
    why: 'в КП обычно зафиксированы состав услуги, цена, обещания и объём работ',
    exact: [/\b(кп|коммерческ\w* предложен\w*|договор клиенту|предложение отправлено|клиенту выслан)\b/i],
    weak: [/\b(счет|счёт|договор|оплата)\b/i],
  },
  {
    key: 'terms',
    label: 'что обещано клиенту по срокам',
    why: 'важно не повторно обещать клиенту сроки, которые производство не подтверждало',
    exact: [/(срок|срочно|получить|готово|выезд|подач|экзамен).{0,60}(до\s*\d{1,2}|\d{1,2}[\.\-/]\d{1,2}|\d+\s*(дн|день|дня|дней|недел))/i, /(до\s*\d{1,2}|\d{1,2}[\.\-/]\d{1,2}|\d+\s*(дн|день|дня|дней|недел)).{0,60}(срок|срочно|получить|готово|выезд|подач|экзамен)/i],
    weak: [/\b(срок|срочно|дедлайн|получить|дней|недел)\b/i],
  },
  {
    key: 'email',
    label: 'email клиента для документов',
    why: 'на email отправляются счета, перечни копий и документы на подпись',
    exact: [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i],
    weak: [/\b(email|e-mail|почта|mail)\b/i],
  },
  {
    key: 'channel',
    label: 'канал связи',
    why: 'эксперт должен понимать, куда дублировать ход работы и напоминания',
    exact: [/\b(wazzup|whatsapp|ватсап|viber|вайбер|telegram|телеграм|tg|открыт\w* лини)\b/i],
    weak: [/\b(мессенджер|написать|сообщение|чат)\b/i],
  },
  {
    key: 'fees',
    label: 'предупреждение о пошлинах и дополнительных счетах',
    why: 'если клиент не предупреждён, возможен конфликт и отказ оплачивать обязательные счета',
    exact: [/\b(пошлин|госпошлин|гос\. ?пошлин|дополнительн\w* счет|дополнительн\w* счёт|отдельн\w* счет|отдельн\w* счёт|стройдок|техкарт)\b/i],
    weak: [/\b(счет|счёт|оплат|платеж|платёж)\b/i],
  },
  {
    key: 'specialists',
    label: 'какие специалисты нужны / кто есть',
    why: 'для аттестации и СТК критично понимать, кем закрываются обязательные позиции',
    exact: [/\b(специалист|прораб|мастер|главн\w* инженер|гип|аттестованн\w* специалист|спец\w*|электромонтер|электромонтёр|сварщик)\b/i],
    weak: [/аттестация/i],
  },
  {
    key: 'transfer',
    label: 'кого нужно перевести на должность',
    why: 'перевод влияет на трудовую, комплект документов и возможность закрыть позицию',
    exact: [/\b(перевести|перевод|переводим|перевести на должность|должност|трудов\w* книжк|совмещен|совмещение)\b/i],
    weak: [/\b(директор|работает|оформить)\b/i],
  },
  {
    key: 'searching',
    label: 'кого клиент ищет сам / кого подбирает MAVIS',
    why: 'без этого непонятно, кто отвечает за закрытие кадрового блока',
    exact: [/\b(ищет сам|клиент ищет|ищут сами|подбирает|подбираем|подбор специалист|найти специалист|наш специалист|ваш специалист)\b/i],
    weak: [/\b(ищет|найти|подбор)\b/i],
  },
  {
    key: 'measurements',
    label: 'средства измерений',
    why: 'для СТК и части работ без средств измерений может сорваться подача или выезд',
    exact: [/\b(средств\w* измерен|измерительн\w* средств|прибор|поверк|аренд\w* прибор|аренд\w* средств|свои средства)\b/i],
    weak: [/\b(аренда|измерен)\b/i],
  },
];

const CRITICAL_KEYS = new Set(['service', 'kp', 'terms', 'email', 'fees', 'specialists']);
const AUDIT_TAG = 'MAVIS_AI_HANDOFF_AUDIT';
const AI_FEEDBACK_TAG = 'MAVIS_AI_FEEDBACK';
const ACTION_BUTTON_IDS = ['write-comment','create-manager-task','create-expert-task','mark-checked','create-workplan-tasks','create-deadline-tasks','create-ai-tasks','accept-ai-feedback','correct-ai-feedback'];
function hideActionButtons() { ACTION_BUTTON_IDS.forEach((x) => { const el = document.getElementById(x); if (el) el.classList.add('hidden'); }); }
function showAiFeedbackButtons(show = true) { ['accept-ai-feedback','correct-ai-feedback'].forEach((x) => { const el = document.getElementById(x); if (el) el.classList.toggle('hidden', !show); }); }
function bxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    BX24.callMethod(method, params, (result) => {
      if (result.error()) reject(new Error(`${method}: ${result.error()} ${result.error_description() || ''}`));
      else resolve(result.data());
    });
  });
}

async function bxList(method, params = {}, limit = 200) {
  // limit > 0: return not more than limit items.
  // limit = 0 / null / undefined: load all pages returned by Bitrix.
  // ВАЖНО: в BX24 JS SDK следующая страница загружается через result.next(callback),
  // а не через start = result.next(). Предыдущая версия из-за этого брала только первые 50 сделок.
  const normalizedLimit = Number(limit || 0);
  const useLimit = Number.isFinite(normalizedLimit) && normalizedLimit > 0;
  const items = [];

  return new Promise((resolve, reject) => {
    const handle = (result) => {
      if (result.error()) {
        reject(new Error(`${method}: ${result.error()} ${result.error_description() || ''}`));
        return;
      }

      const data = result.data();
      if (Array.isArray(data)) items.push(...data);
      else if (data && Array.isArray(data.items)) items.push(...data.items);
      else if (data && Array.isArray(data.tasks)) items.push(...data.tasks);

      if (useLimit && items.length >= normalizedLimit) {
        resolve(items.slice(0, normalizedLimit));
        return;
      }

      if (result.more && result.more() && typeof result.next === 'function') {
        result.next(handle);
      } else {
        resolve(useLimit ? items.slice(0, normalizedLimit) : items);
      }
    };

    BX24.callMethod(method, params, handle);
  });
}

async function mapLimit(items, limit, mapper) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const current = i++;
      out[current] = await mapper(items[current], current);
    }
  });
  await Promise.all(workers);
  return out;
}

function normalize(s) { return String(s || '').toLowerCase(); }
function val(v) { return Array.isArray(v) ? v.join(', ') : (v || ''); }
function fieldLabel(code) {
  const meta = state.fields && state.fields[code] ? state.fields[code] : {};
  return meta.title || meta.formLabel || meta.listLabel || meta.name || code || '';
}
function buildEnumMaps(fields) {
  const maps = {};
  Object.entries(fields || {}).forEach(([code, meta]) => {
    const items = meta && (meta.items || meta.ITEMS || meta.list || meta.LIST);
    if (!Array.isArray(items)) return;
    const map = {};
    items.forEach((item) => {
      const id = item.ID ?? item.id ?? item.VALUE_ID ?? item.valueId ?? item.VALUE;
      const value = item.VALUE ?? item.value ?? item.NAME ?? item.name ?? item.TITLE ?? item.title;
      if (id !== undefined && value !== undefined) map[String(id)] = String(value);
    });
    if (Object.keys(map).length) maps[code] = map;
  });
  return maps;
}
function resolveFieldValue(code, raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  const map = state.enumMaps && state.enumMaps[code];
  const convertOne = (x) => {
    if (x === null || x === undefined || x === '') return '';
    const key = String(x);
    return map && map[key] ? map[key] : key;
  };
  return Array.isArray(raw) ? raw.map(convertOne).filter(Boolean).join(', ') : convertOne(raw);
}
function metaText(meta) {
  if (!meta) return '';
  // Bitrix в разных порталах отдаёт подписи пользовательских полей в разных свойствах.
  // Берём все строковые подписи, а не только title/formLabel/listLabel.
  const parts = [];
  Object.entries(meta).forEach(([k, v]) => {
    if (typeof v === 'string') parts.push(`${k} ${v}`);
    if (Array.isArray(v)) {
      v.forEach((item) => {
        if (item && typeof item === 'object') {
          Object.values(item).forEach((iv) => { if (typeof iv === 'string') parts.push(iv); });
        }
      });
    }
  });
  return normalize(parts.join(' '));
}
function detectFieldMap(fields) {
  const entries = Object.entries(fields || {});
  const find = (needles, exactLabel = null) => {
    let found = entries.find(([code, meta]) => {
      const text = metaText(meta) + ' ' + normalize(code);
      if (exactLabel) {
        const labels = [meta.title, meta.formLabel, meta.listLabel, meta.name, meta.NAME].filter(Boolean).map((x) => normalize(x).trim());
        if (labels.some((l) => l === exactLabel)) return true;
      }
      return needles.some((n) => text.includes(n));
    });
    return found ? found[0] : null;
  };
  return {
    // В производственной карточке поле называется именно “Услуга”. Важно тянуть его из этой карточки,
    // а не только из товаров связанной продажи. Поэтому сначала ищем точное название поля “Услуга”.
    service: APP_CONFIG.serviceFieldCode || find(['услуга', 'продукт'], 'услуга'),
    startDate: find(['дата начала', 'начало оказания', 'оказания услуг']),
    salesDealLink: find(['ссылка на сделку отдела продаж', 'сделка отдела продаж', 'отдела продаж']),
  };
}

async function init() {
  try {
    await new Promise((resolve) => BX24.init(resolve));
    state.user = await bxCall('user.current');
    try { state.isAdmin = Boolean(await bxCall('user.admin')); } catch (_) { state.isAdmin = false; }
    state.isLeader = (APP_CONFIG.leaderUserIds || []).includes(String(state.user.ID)) || (APP_CONFIG.adminUserIds || []).includes(String(state.user.ID));
    state.isRop = (APP_CONFIG.ropUserIds || []).includes(String(state.user.ID));
    state.role = state.isAdmin || state.isLeader ? 'руководитель/админ' : state.isRop ? 'РОП' : 'эксперт';
    document.getElementById('user-line').textContent = `Пользователь: ${state.user.NAME || ''} ${state.user.LAST_NAME || ''} · ID ${state.user.ID} · режим: ${state.role}`;

    state.fields = await bxCall('crm.deal.fields');
    state.enumMaps = buildEnumMaps(state.fields);
    state.fieldMap = detectFieldMap(state.fields);
    await loadDeals();
  } catch (e) {
    showError(e.message);
  }
}

async function loadDeals() {
  document.getElementById('loading').classList.remove('hidden');
  document.getElementById('deals-table').classList.add('hidden');
  hideError();
  state.detailsLoaded = false;
  state.detailsLoading = false;
  state.detailsProgress = '';
  state.activitiesByDeal.clear();
  state.tasksByDeal.clear();
  state.commentsByDeal.clear();
  state.auditByDeal.clear();
  state.salesDealByProduction.clear();
  state.salesManagerLoading = false;
  state.salesManagerProgress = '';

  const select = ['*','UF_*','ID','TITLE','COMPANY_ID','CONTACT_ID','STAGE_ID','CATEGORY_ID','OPPORTUNITY','ASSIGNED_BY_ID','CREATED_BY_ID','DATE_CREATE','DATE_MODIFY','CLOSED'];
  Object.values(state.fieldMap).filter(Boolean).forEach((f) => { if (!select.includes(f)) select.push(f); });

  const filter = {};
  if (APP_CONFIG.productionCategoryId) filter.CATEGORY_ID = APP_CONFIG.productionCategoryId;
  if (APP_CONFIG.excludeClosedDeals !== false) filter.CLOSED = 'N';

  // По ТЗ личный кабинет эксперта показывает только его сделки.
  // Руководители/админы видят все сделки воронки.
  // РОП по умолчанию НЕ видит все производственные сделки, чтобы не смешивать клиентов экспертов.
  // Если нужно временно дать РОП общий обзор для теста: ALLOW_ROP_VIEW_ALL=true в Render.
  const canViewAllForLoad = state.isAdmin || state.isLeader || state.isRop || APP_CONFIG.allowRopViewAll;
  if (!canViewAllForLoad) filter.ASSIGNED_BY_ID = state.user.ID;

  const deals = await bxList('crm.deal.list', {
    order: { DATE_MODIFY: 'DESC' },
    filter,
    select,
  }, Number(APP_CONFIG.maxDeals || 0));

  state.deals = deals;

  // Быстрый первый экран: сначала показываем сделки, пользователей, компании и стадии.
  // Дела/задачи/комментарии грузятся фоном, иначе 400+ сделок дают 1000+ REST-запросов
  // и пользователь ждёт несколько минут до появления кабинета.
  await hydrateDeals(deals);
  await hydrateStages(deals);
  renderDeals();
  if (APP_CONFIG.autoLoadMeta) {
    backgroundHydrateDealMeta(deals);
  } else {
    state.detailsLoading = false;
    state.detailsLoaded = false;
    state.detailsProgress = 'Детали по делам/задачам не загружаются автоматически, чтобы кабинет не зависал. Для сводки нажмите “Загрузить счётчики / журнал”.';
    renderDeals();
  }
}


async function hydrateDeals(deals) {
  const userIds = new Set();
  const companyIds = new Set();
  const contactIds = new Set();
  deals.forEach((d) => {
    if (d.ASSIGNED_BY_ID) userIds.add(d.ASSIGNED_BY_ID);
    if (d.CREATED_BY_ID) userIds.add(d.CREATED_BY_ID);
    if (d.COMPANY_ID) companyIds.add(d.COMPANY_ID);
    if (d.CONTACT_ID) contactIds.add(d.CONTACT_ID);
  });
  await mapLimit([...userIds], 8, async (id) => {
    try { const res = await bxCall('user.get', { ID: id }); state.users.set(String(id), Array.isArray(res) ? res[0] : res); } catch (_) {}
  });
  await mapLimit([...companyIds], 8, async (id) => {
    try { const res = await bxCall('crm.company.get', { id }); state.companies.set(String(id), res); } catch (_) {}
  });
  await mapLimit([...contactIds], 8, async (id) => {
    try { const res = await bxCall('crm.contact.get', { id }); state.contacts.set(String(id), res); } catch (_) {}
  });
}

async function hydrateStages(deals) {
  state.stageMap.clear();

  // 1) Ручная карта из Render, если когда-нибудь понадобится точечно переименовать стадию.
  Object.entries(APP_CONFIG.stageMap || {}).forEach(([code, name]) => {
    if (code && name) state.stageMap.set(String(code), String(name));
  });

  // 2) Самый надёжный источник для части порталов: crm.deal.fields → STAGE_ID.items.
  // В некоторых Bitrix названия стадий не приходят через crm.status.list, но уже есть в метаданных поля.
  saveStageNamesFromDealFields();

  const categoryIds = [...new Set(deals.map((d) => String(d.CATEGORY_ID || '0')))];
  const entityIds = ['DEAL_STAGE', ...categoryIds.filter((id) => id !== '0').map((id) => `DEAL_STAGE_${id}`)];

  // 3) Основной источник: справочник стадий.
  await mapLimit(entityIds, 4, async (entityId) => {
    try {
      const rows = await bxList('crm.status.list', { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' } }, 0);
      rows.forEach((row) => saveStageName(entityId, row));
    } catch (_) {}
  });

  // 4) Fallback: иногда фильтр ENTITY_ID не срабатывает, поэтому тянем статусы без фильтра
  // и отбираем нужные на стороне приложения.
  try {
    const allStatuses = await bxList('crm.status.list', { order: { SORT: 'ASC' } }, 0);
    allStatuses
      .filter((row) => entityIds.includes(String(row.ENTITY_ID || row.entityId || row.entity_id || '')))
      .forEach((row) => saveStageName(row.ENTITY_ID || row.entityId || row.entity_id, row));
  } catch (_) {}

  // 5) Дополнительный fallback для пользовательских воронок.
  await mapLimit(categoryIds.filter((id) => id !== '0'), 4, async (categoryId) => {
    const variants = [
      { id: Number(categoryId), order: { SORT: 'ASC' } },
      { id: categoryId, order: { SORT: 'ASC' } },
      { categoryId: Number(categoryId), order: { SORT: 'ASC' } },
      { filter: { CATEGORY_ID: Number(categoryId) }, order: { SORT: 'ASC' } },
    ];
    for (const params of variants) {
      try {
        const rows = await bxList('crm.dealcategory.stage.list', params, 0);
        rows.forEach((row) => saveStageName(`DEAL_STAGE_${categoryId}`, row));
        if (rows.length) break;
      } catch (_) {}
    }
  });

  // 6) Минимальный защитный fallback для текущей производственной воронки, чтобы не показывать код вместо названия.
  // Остальные стадии всё равно должны подтянуться из API выше.
  if (String(APP_CONFIG.productionCategoryId || '') === '28') {
    if (!state.stageMap.has('C28:NEW')) state.stageMap.set('C28:NEW', '1. Эксперт назначен');
    if (!state.stageMap.has('C28:UC_MIFXBB')) state.stageMap.set('C28:UC_MIFXBB', '2. Сбор информации');
  }
}

function saveStageNamesFromDealFields() {
  const meta = state.fields && state.fields.STAGE_ID;
  const items = meta && (meta.items || meta.ITEMS || meta.list || meta.LIST);
  if (!Array.isArray(items)) return;
  items.forEach((item) => {
    const code = String(item.ID || item.id || item.VALUE_ID || item.valueId || item.STATUS_ID || item.statusId || '');
    const name = item.VALUE || item.value || item.NAME || item.name || item.TITLE || item.title || '';
    saveStageCandidate(code, name);
  });
}

function saveStageCandidate(code, name) {
  const c = String(code || '').trim();
  const n = String(name || '').trim();
  if (!c || !n || c === n) return;
  state.stageMap.set(c, n);
}

function saveStageName(entityId, row) {
  if (!row) return;
  const statusId = String(row.STATUS_ID || row.statusId || row.ID || row.id || row.STATUS || row.status || '');
  const name = row.NAME || row.name || row.TITLE || row.title || row.VALUE || row.value || statusId;
  if (!statusId) return;

  saveStageCandidate(statusId, name);

  const entity = String(entityId || row.ENTITY_ID || row.entityId || row.entity_id || '');
  const m = entity.match(/^DEAL_STAGE_(\d+)$/);
  if (m && !statusId.startsWith(`C${m[1]}:`)) {
    saveStageCandidate(`C${m[1]}:${statusId}`, name);
  }
}


async function hydrateActivities(deals) {
  state.activitiesByDeal.clear();
  await mapLimit(deals, 6, async (d) => {
    try {
      const acts = await bxList('crm.activity.list', {
        filter: { OWNER_ID: d.ID, OWNER_TYPE_ID: 2 },
        order: { DEADLINE: 'ASC' },
        select: ['ID','SUBJECT','DESCRIPTION','CREATED','DEADLINE','TYPE_ID','PROVIDER_ID','COMPLETED']
      }, 30);
      state.activitiesByDeal.set(String(d.ID), acts);
    } catch (_) {
      state.activitiesByDeal.set(String(d.ID), []);
    }
  });
}


async function hydrateTasks(deals) {
  state.tasksByDeal.clear();
  await mapLimit(deals, 6, async (d) => {
    try {
      const raw = await bxCall('tasks.task.list', {
        filter: { UF_CRM_TASK: `D_${d.ID}` },
        select: ['ID','TITLE','STATUS','DEADLINE','CREATED_DATE','CLOSED_DATE','UF_CRM_TASK']
      });
      const tasks = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tasks) ? raw.tasks : []);
      state.tasksByDeal.set(String(d.ID), tasks);
    } catch (_) {
      state.tasksByDeal.set(String(d.ID), []);
    }
  });
}


async function hydrateTimelineComments(deals) {
  state.commentsByDeal.clear();
  state.auditByDeal.clear();
  await mapLimit(deals, 6, async (d) => {
    try {
      // Берём несколько последних комментариев, чтобы найти служебную метку проверки.
      // Если брать только 1 комментарий, статус может потеряться из-за более свежего обычного комментария.
      const comments = await bxList('crm.timeline.comment.list', {
        filter: { ENTITY_ID: d.ID, ENTITY_TYPE: 'deal' },
        order: { ID: 'DESC' }
      }, 20);
      state.commentsByDeal.set(String(d.ID), comments);
      const audit = findLatestAudit(comments);
      if (audit) state.auditByDeal.set(String(d.ID), audit);
    } catch (_) {
      state.commentsByDeal.set(String(d.ID), []);
    }
  });
}


async function hydrateDealMeta(d) {
  const id = String(d.ID);
  try {
    const acts = await bxList('crm.activity.list', {
      filter: { OWNER_ID: d.ID, OWNER_TYPE_ID: 2 },
      order: { DEADLINE: 'ASC' },
      select: ['ID','SUBJECT','DESCRIPTION','CREATED','LAST_UPDATED','DEADLINE','TYPE_ID','PROVIDER_ID','COMPLETED']
    }, 30);
    state.activitiesByDeal.set(id, acts);
  } catch (_) {
    state.activitiesByDeal.set(id, []);
  }

  try {
    const raw = await bxCall('tasks.task.list', {
      filter: { UF_CRM_TASK: `D_${d.ID}` },
      select: ['ID','TITLE','STATUS','DEADLINE','CREATED_DATE','CHANGED_DATE','CLOSED_DATE','UF_CRM_TASK']
    });
    const tasks = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.tasks) ? raw.tasks : []);
    state.tasksByDeal.set(id, tasks);
  } catch (_) {
    state.tasksByDeal.set(id, []);
  }

  try {
    const comments = await bxList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: d.ID, ENTITY_TYPE: 'deal' },
      order: { ID: 'DESC' }
    }, 20);
    state.commentsByDeal.set(id, comments);
    const audit = findLatestAudit(comments);
    if (audit) state.auditByDeal.set(id, audit);
  } catch (_) {
    state.commentsByDeal.set(id, []);
  }
}

async function ensureDealMeta(dealId) {
  const id = String(dealId);
  if (state.activitiesByDeal.has(id) && state.tasksByDeal.has(id) && state.commentsByDeal.has(id)) return;
  const deal = state.deals.find((d) => String(d.ID) === id) || await bxCall('crm.deal.get', { id });
  await hydrateDealMeta(deal);
}

async function backgroundHydrateDealMeta(deals) {
  state.detailsLoading = true;
  state.detailsLoaded = false;
  state.detailsProgress = `Дозагружаем дела, задачи и проверки: 0/${deals.length}`;
  renderDeals();

  let done = 0;
  await mapLimit(deals, Number(APP_CONFIG.metaConcurrency || 4), async (d) => {
    await hydrateDealMeta(d);
    done += 1;
    if (done === deals.length || done % 25 === 0) {
      state.detailsProgress = `Дозагружаем дела, задачи и проверки: ${done}/${deals.length}`;
      renderDeals();
    }
  });

  state.detailsLoading = false;
  state.detailsLoaded = true;
  state.detailsProgress = `Дела, задачи и проверки загружены: ${deals.length}/${deals.length}`;
  renderDeals();
}


async function loadDashboardMeta() {
  if (state.detailsLoading) {
    alert('Детали уже загружаются. Дождись завершения текущей загрузки.');
    return;
  }
  const ok = confirm('Загрузить счётчики руководителя и журнал ошибок по всем активным сделкам? Это может занять несколько минут, но кабинет уже не будет зависать при открытии.');
  if (!ok) return;
  await backgroundHydrateDealMeta(getRoleVisibleDeals());
}

function metaStatusText() {
  if (state.detailsLoaded && !state.detailsLoading) return 'Данные по делам/задачам загружены.';
  if (state.detailsLoading) return state.detailsProgress || 'Догружаем дела, задачи и проверки...';
  return 'Детали не загружены автоматически. Открывайте конкретную сделку для проверки или нажмите “Загрузить счётчики / журнал”.';
}

function metaPlaceholder(kind) {
  if (state.detailsLoading) return '<span class="muted">загружается...</span>';
  if (kind === 'audit') return '<span class="status-chip status-none">не загружено</span>';
  return '<span class="muted">не загружено</span>';
}

function getTimelineComments(dealId) { return state.commentsByDeal.get(String(dealId)) || []; }

function findLatestAudit(comments) {
  for (const c of comments || []) {
    const raw = String(c.COMMENT || c.TEXT || '');
    const parsed = parseAuditMarker(raw);
    if (parsed) return parsed;
  }
  // Fallback for старые комментарии без JSON-метки.
  for (const c of comments || []) {
    const text = stripHtml(String(c.COMMENT || c.TEXT || ''));
    if (!/ИИ-проверка передачи сделки в производство/i.test(text)) continue;
    const statusLine = (text.match(/Статус:\s*([^\n]+)/i) || [])[1] || 'проверено';
    let statusCode = 'partial';
    if (/есть ошибки/i.test(statusLine)) statusCode = 'error';
    else if (/готова|достаточ/i.test(statusLine)) statusCode = 'ok';
    return {
      version: 0,
      statusCode,
      status: statusLine,
      checkedAt: c.CREATED || c.DATE_CREATE || c.created || '',
      checkedByName: 'из комментария Bitrix',
      missing: [],
      uncertain: [],
      technical: [],
      legacy: true,
    };
  }
  return null;
}

function parseAuditMarker(raw) {
  const text = String(raw || '');
  const idx = text.indexOf(`${AUDIT_TAG}:`);
  if (idx === -1) return null;
  const jsonPart = text.slice(idx + AUDIT_TAG.length + 1).trim().split(/\n|<br\s*\/?>/i)[0].trim();
  try {
    return JSON.parse(jsonPart);
  } catch (_) {
    return null;
  }
}

function getAudit(dealId) { return state.auditByDeal.get(String(dealId)) || null; }
function auditLabel(audit) {
  if (!audit) return 'Не проверено';
  if (audit.statusCode === 'ok') return 'Проверено — достаточно';
  if (audit.statusCode === 'error') return 'Есть ошибки передачи';
  if (audit.statusCode === 'partial') return 'Нужно подтвердить';
  return audit.status || 'Проверено';
}
function auditClass(audit) {
  if (!audit) return 'status-none';
  if (audit.statusCode === 'ok') return 'status-ok';
  if (audit.statusCode === 'error') return 'status-error';
  if (audit.statusCode === 'partial') return 'status-partial';
  return 'status-none';
}
function auditHtml(dealId) {
  const audit = getAudit(dealId);
  const meta = audit && audit.checkedAt ? `${formatDate(audit.checkedAt)}${audit.checkedByName ? ' · ' + audit.checkedByName : ''}` : '';
  return `<span class="status-chip ${auditClass(audit)}">${escapeHtml(auditLabel(audit))}</span>${meta ? `<span class="audit-meta">${escapeHtml(meta)}</span>` : ''}`;
}

function userName(id) {
  const u = state.users.get(String(id));
  return u ? `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || `ID ${id}` : `ID ${id || '—'}`;
}
function companyName(id) {
  const c = state.companies.get(String(id));
  return c ? c.TITLE || `ID ${id}` : `ID ${id || '—'}`;
}
function contactName(id) {
  const c = state.contacts.get(String(id));
  if (!c) return id ? `ID ${id}` : '—';
  return `${c.NAME || ''} ${c.LAST_NAME || ''}`.trim() || c.FULL_NAME || `ID ${id}`;
}
function stageName(stageId) {
  const code = String(stageId || '');
  return state.stageMap.get(code) || code || '—';
}
function isStageResolved(stageId) {
  const code = String(stageId || '');
  return Boolean(code && state.stageMap.has(code) && state.stageMap.get(code) !== code);
}
function getService(deal) {
  if (!deal) return '';
  if (state.fieldMap.service && deal[state.fieldMap.service] !== undefined) {
    const direct = resolveFieldValue(state.fieldMap.service, deal[state.fieldMap.service]);
    if (direct) return direct;
  }
  // Fallback: ищем любое заполненное поле, которое в Bitrix называется “Услуга”.
  // Это нужно, если crm.deal.fields отдал нестандартную подпись или код поля не совпал при автоопределении.
  for (const [code, meta] of Object.entries(state.fields || {})) {
    const labels = [meta.title, meta.formLabel, meta.listLabel, meta.name, meta.NAME].filter(Boolean).map((x) => normalize(x).trim());
    const looksLikeService = labels.some((l) => l === 'услуга' || l.includes('услуга')) || normalize(code).includes('SERVICE');
    if (!looksLikeService) continue;
    const value = resolveFieldValue(code, deal[code]);
    if (value) return value;
  }
  return '';
}
function getStartDate(deal) { return state.fieldMap.startDate ? resolveFieldValue(state.fieldMap.startDate, deal[state.fieldMap.startDate]) : ''; }
function getSalesLink(deal) { return state.fieldMap.salesDealLink ? resolveFieldValue(state.fieldMap.salesDealLink, deal[state.fieldMap.salesDealLink]) : ''; }

function getSalesDealId(deal) {
  return extractDealId(getSalesLink(deal));
}

function cachedSalesManagerInfo(deal) {
  const audit = getAudit(deal.ID);
  if (audit && audit.salesManagerId) {
    return {
      salesId: audit.salesDealId || getSalesDealId(deal) || '',
      managerId: String(audit.salesManagerId),
      source: 'из проверки передачи / сделки продаж',
      title: audit.salesDealTitle || '',
    };
  }
  return state.salesDealByProduction.get(String(deal.ID)) || null;
}

async function ensureUserCached(id) {
  if (!id || state.users.has(String(id))) return;
  try {
    const res = await bxCall('user.get', { ID: id });
    state.users.set(String(id), Array.isArray(res) ? res[0] : res);
  } catch (_) {}
}

async function ensureSalesManagerForDeal(deal) {
  const prodId = String(deal.ID);
  if (state.salesDealByProduction.has(prodId)) return state.salesDealByProduction.get(prodId);
  const salesId = getSalesDealId(deal);
  if (!salesId || String(salesId) === prodId) {
    const fallback = { salesId: '', managerId: String(deal.CREATED_BY_ID || deal.ASSIGNED_BY_ID || '0'), source: 'нет связанной сделки продаж, взят создатель производства', title: '' };
    state.salesDealByProduction.set(prodId, fallback);
    return fallback;
  }
  try {
    const salesDeal = await bxCall('crm.deal.get', { id: salesId });
    const managerId = String(salesDeal.ASSIGNED_BY_ID || salesDeal.CREATED_BY_ID || deal.CREATED_BY_ID || deal.ASSIGNED_BY_ID || '0');
    await ensureUserCached(managerId);
    const info = {
      salesId: String(salesId),
      managerId,
      source: 'ответственный в связанной сделке продаж',
      title: salesDeal.TITLE || '',
      salesAssignedById: String(salesDeal.ASSIGNED_BY_ID || ''),
      salesCreatedById: String(salesDeal.CREATED_BY_ID || ''),
    };
    state.salesDealByProduction.set(prodId, info);
    return info;
  } catch (e) {
    const fallback = { salesId: String(salesId), managerId: String(deal.CREATED_BY_ID || deal.ASSIGNED_BY_ID || '0'), source: 'не удалось открыть связанную сделку продаж, взят создатель производства', title: '', error: e.message };
    state.salesDealByProduction.set(prodId, fallback);
    return fallback;
  }
}

async function enrichJournalSalesManagers(rows) {
  if (state.salesManagerLoading) return;
  const targets = (rows || []).filter((row) => getSalesDealId(row.deal) && !cachedSalesManagerInfo(row.deal));
  if (!targets.length) return;
  state.salesManagerLoading = true;
  state.salesManagerProgress = `Уточняем менеджеров из связанных сделок продаж: 0/${targets.length}`;
  let done = 0;
  await mapLimit(targets, Number(APP_CONFIG.salesManagerConcurrency || 3), async (row) => {
    await ensureSalesManagerForDeal(row.deal);
    done += 1;
    if (done === targets.length || done % 10 === 0) state.salesManagerProgress = `Уточняем менеджеров из связанных сделок продаж: ${done}/${targets.length}`;
  });
  state.salesManagerLoading = false;
  state.salesManagerProgress = `Менеджеры из сделок продаж уточнены: ${targets.length}/${targets.length}`;
  renderDeals();
}
function getActivities(dealId) { return state.activitiesByDeal.get(String(dealId)) || []; }
function getTasks(dealId) { return state.tasksByDeal.get(String(dealId)) || []; }
function openActivities(dealId) { return getActivities(dealId).filter((a) => String(a.COMPLETED || 'N').toUpperCase() !== 'Y'); }
function openTasks(dealId) { return getTasks(dealId).filter((t) => !['5','completed','supposedlyCompleted'].includes(String(t.STATUS || t.status || '').toLowerCase()) && !t.CLOSED_DATE && !t.closedDate); }
function nextActivity(dealId) {
  const open = openActivities(dealId).filter((a) => a.DEADLINE);
  if (!open.length) return null;
  return open.sort((a, b) => new Date(a.DEADLINE) - new Date(b.DEADLINE))[0];
}
function nextTask(dealId) {
  const open = openTasks(dealId).filter((t) => t.DEADLINE || t.deadline);
  if (!open.length) return null;
  return open.sort((a, b) => new Date(a.DEADLINE || a.deadline) - new Date(b.DEADLINE || b.deadline))[0];
}
function hasNextStep(dealId) { return openActivities(dealId).length > 0 || openTasks(dealId).length > 0; }
function nextStep(dealId) {
  const a = nextActivity(dealId);
  const t = nextTask(dealId);
  if (!a && !t) return null;
  if (a && !t) return { kind: 'дело', date: a.DEADLINE, title: a.SUBJECT || '' };
  if (t && !a) return { kind: 'задача', date: t.DEADLINE || t.deadline, title: t.TITLE || t.title || '' };
  return new Date(a.DEADLINE) <= new Date(t.DEADLINE || t.deadline)
    ? { kind: 'дело', date: a.DEADLINE, title: a.SUBJECT || '' }
    : { kind: 'задача', date: t.DEADLINE || t.deadline, title: t.TITLE || t.title || '' };
}
function lastWorkDate(deal) {
  // We intentionally do NOT treat a future deadline as activity.
  // Working activity = deal creation, activity creation, task creation/closing, manual CRM comments.
  const dates = [deal.DATE_CREATE];
  getActivities(deal.ID).forEach((a) => dates.push(a.CREATED, a.LAST_UPDATED));
  getTasks(deal.ID).forEach((t) => dates.push(t.CREATED_DATE || t.createdDate, t.CLOSED_DATE || t.closedDate, t.CHANGED_DATE || t.changedDate));
  getTimelineComments(deal.ID).forEach((c) => dates.push(c.CREATED || c.DATE_CREATE || c.created));
  const parsed = dates.map((x) => new Date(x)).filter((d) => !Number.isNaN(d.getTime()) && d.getTime() <= Date.now());
  if (!parsed.length) return deal.DATE_CREATE;
  return new Date(Math.max(...parsed.map((d) => d.getTime()))).toISOString();
}



function getDeadlineValue(item) {
  return item.DEADLINE || item.deadline || item.DEADLINE_DATE || item.deadlineDate || '';
}
function isOverdueDate(value) {
  if (!value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < Date.now();
}
function isTodayDate(value) {
  if (!value) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}
function getDealIssueFlags(deal) {
  const audit = getAudit(deal.ID);
  const acts = openActivities(deal.ID);
  const tasks = openTasks(deal.ID);
  const deadlines = [
    ...acts.map((a) => a.DEADLINE).filter(Boolean),
    ...tasks.map((t) => getDeadlineValue(t)).filter(Boolean),
  ];
  const noDeadlineCount = acts.filter((a) => !a.DEADLINE).length + tasks.filter((t) => !getDeadlineValue(t)).length;
  const flags = {
    handoffErrors: Boolean(audit && audit.statusCode === 'error'),
    handoffPartial: Boolean(audit && audit.statusCode === 'partial'),
    unchecked: !audit,
    noNext: !hasNextStep(deal.ID),
    stale: daysSince(lastWorkDate(deal)) >= 2,
    overdue: deadlines.some(isOverdueDate),
    today: deadlines.some(isTodayDate),
    noDeadline: noDeadlineCount > 0,
    noDeadlineCount,
  };
  flags.problem = flags.handoffErrors || flags.handoffPartial || flags.noNext || flags.stale || flags.overdue || flags.noDeadline;
  return flags;
}
function dealMatchesDashboardFilter(deal, filter) {
  if (!filter || filter === 'all') return true;
  const f = getDealIssueFlags(deal);
  if (filter === 'problems') return f.problem;
  return Boolean(f[filter]);
}
function dashboardFilterName(filter) {
  const names = {
    all: 'показаны все сделки',
    problems: 'показаны только проблемные сделки',
    handoffErrors: 'фильтр: ошибки передачи',
    noNext: 'фильтр: сделки без следующего шага',
    stale: 'фильтр: без рабочей активности 2+ дня',
    overdue: 'фильтр: просроченные дедлайны',
    today: 'фильтр: дедлайны на сегодня',
  };
  return names[filter] || 'показаны все сделки';
}
function renderManagerDashboard(deals, metaReady) {
  const panel = document.getElementById('manager-dashboard');
  if (!panel) return;
  const shouldShow = state.isAdmin || state.isLeader || state.isRop || APP_CONFIG.allowRopViewAll;
  panel.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) return;

  const value = (n) => metaReady ? String(n) : (state.detailsLoading ? '…' : '—');
  const flags = metaReady ? deals.map((d) => ({ deal: d, flags: getDealIssueFlags(d) })) : [];
  const count = (key) => metaReady ? flags.filter((x) => x.flags[key]).length : 0;
  const cards = [
    { label: 'Ошибки передачи', value: value(count('handoffErrors')), cls: 'danger' },
    { label: 'Нужно подтвердить', value: value(count('handoffPartial')), cls: 'warning' },
    { label: 'Не проверено', value: value(count('unchecked')), cls: 'info' },
    { label: 'Без следующего шага', value: value(count('noNext')), cls: 'warning' },
    { label: 'Просрочено', value: value(count('overdue')), cls: 'danger' },
    { label: 'Сегодня', value: value(count('today')), cls: 'info' },
  ];
  document.getElementById('manager-dashboard-cards').innerHTML = cards.map((c) => `
    <div class="dashboard-card ${c.cls}"><span>${escapeHtml(c.label)}</span><strong>${escapeHtml(c.value)}</strong></div>
  `).join('');

  panel.querySelectorAll('[data-dashboard-filter]').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-dashboard-filter') === state.dashboardFilter);
  });

  const label = metaReady
    ? `${dashboardFilterName(state.dashboardFilter)}. Данные по делам/задачам загружены.`
    : metaStatusText();
  document.getElementById('manager-dashboard-filter-label').textContent = label;

  if (!metaReady) {
    document.getElementById('manager-dashboard-owners').innerHTML = '';
    renderHandoffJournal(deals, metaReady);
    return;
  }

  const byOwner = new Map();
  flags.forEach(({ deal, flags }) => {
    const id = String(deal.ASSIGNED_BY_ID || '0');
    if (!byOwner.has(id)) byOwner.set(id, { total: 0, handoffErrors: 0, noNext: 0, stale: 0, overdue: 0, today: 0 });
    const row = byOwner.get(id);
    row.total += 1;
    if (flags.handoffErrors) row.handoffErrors += 1;
    if (flags.noNext) row.noNext += 1;
    if (flags.stale) row.stale += 1;
    if (flags.overdue) row.overdue += 1;
    if (flags.today) row.today += 1;
  });
  const owners = [...byOwner.entries()]
    .map(([id, row]) => ({ id, ...row, problem: row.handoffErrors + row.noNext + row.stale + row.overdue }))
    .sort((a, b) => b.problem - a.problem || b.total - a.total)
    .slice(0, 9);
  document.getElementById('manager-dashboard-owners').innerHTML = owners.map((o) => `
    <div class="owner-card">
      <h3>${escapeHtml(userName(o.id))}</h3>
      <div class="owner-stats">
        Всего сделок: <strong>${o.total}</strong><br>
        Ошибки передачи: <strong>${o.handoffErrors}</strong><br>
        Без шага: <strong>${o.noNext}</strong> · 2+ дня: <strong>${o.stale}</strong><br>
        Просрочено: <strong>${o.overdue}</strong> · Сегодня: <strong>${o.today}</strong>
      </div>
    </div>
  `).join('');
  renderHandoffJournal(deals, metaReady);
}


function shortFlagLabels(flags) {
  const out = [];
  if (flags.handoffErrors) out.push('ошибка передачи');
  if (flags.handoffPartial) out.push('нужно подтвердить передачу');
  if (flags.unchecked) out.push('не проверено');
  if (flags.noNext) out.push('нет следующего шага');
  if (flags.stale) out.push('нет активности 2+ дня');
  if (flags.overdue) out.push('есть просрочка');
  if (flags.today) out.push('дедлайн сегодня');
  if (flags.noDeadline) out.push('есть дела/задачи без дедлайна');
  return out.length ? out : ['без критичных рисков'];
}

function buildManagerReport(deals) {
  const rows = deals.map((deal) => ({ deal, flags: getDealIssueFlags(deal) }));
  const count = (key) => rows.filter((x) => x.flags[key]).length;
  const problemRows = rows.filter((x) => x.flags.problem);
  const priorityRows = problemRows
    .sort((a, b) => {
      const score = (x) => (x.flags.handoffErrors ? 100 : 0) + (x.flags.overdue ? 80 : 0) + (x.flags.noNext ? 60 : 0) + (x.flags.stale ? 40 : 0) + (x.flags.handoffPartial ? 30 : 0) + (x.flags.unchecked ? 10 : 0);
      return score(b) - score(a) || daysSince(lastWorkDate(b.deal)) - daysSince(lastWorkDate(a.deal));
    })
    .slice(0, 20);

  const byOwner = new Map();
  rows.forEach(({ deal, flags }) => {
    const id = String(deal.ASSIGNED_BY_ID || '0');
    if (!byOwner.has(id)) byOwner.set(id, { id, total: 0, handoffErrors: 0, handoffPartial: 0, unchecked: 0, noNext: 0, stale: 0, overdue: 0, today: 0, noDeadline: 0, problems: 0 });
    const row = byOwner.get(id);
    row.total += 1;
    ['handoffErrors','handoffPartial','unchecked','noNext','stale','overdue','today','noDeadline'].forEach((k) => { if (flags[k]) row[k] += 1; });
    if (flags.problem) row.problems += 1;
  });
  const owners = [...byOwner.values()].sort((a, b) => b.problems - a.problems || b.total - a.total);

  const metrics = {
    total: deals.length,
    problem: problemRows.length,
    handoffErrors: count('handoffErrors'),
    handoffPartial: count('handoffPartial'),
    unchecked: count('unchecked'),
    noNext: count('noNext'),
    stale: count('stale'),
    overdue: count('overdue'),
    today: count('today'),
    noDeadline: count('noDeadline'),
  };

  const date = new Date().toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const actions = [];
  if (metrics.handoffErrors) actions.push(`Разобрать ошибки передачи с РОП/менеджерами: ${metrics.handoffErrors} сдел.`);
  if (metrics.overdue) actions.push(`Закрыть просроченные дела/задачи сегодня: ${metrics.overdue} сдел.`);
  if (metrics.noNext) actions.push(`Поставить следующий шаг по сделкам без дела/задачи: ${metrics.noNext} сдел.`);
  if (metrics.stale) actions.push(`Проверить сделки без рабочей активности 2+ дня: ${metrics.stale} сдел.`);
  if (metrics.handoffPartial) actions.push(`Подтвердить спорные данные передачи: ${metrics.handoffPartial} сдел.`);
  if (metrics.unchecked) actions.push(`Проверить передачу по непроверенным сделкам: ${metrics.unchecked} сдел.`);
  if (!actions.length) actions.push('Критичных действий по текущим данным нет.');

  const textLines = [];
  textLines.push(`ОТЧЁТ ИИ-АССИСТЕНТА ЭКСПЕРТА`);
  textLines.push(`Дата формирования: ${date}`);
  textLines.push('');
  textLines.push(`1. Сводка`);
  textLines.push(`— Активные сделки: ${metrics.total}`);
  textLines.push(`— Проблемные сделки: ${metrics.problem}`);
  textLines.push(`— Ошибки передачи: ${metrics.handoffErrors}`);
  textLines.push(`— Нужно подтвердить передачу: ${metrics.handoffPartial}`);
  textLines.push(`— Не проверено: ${metrics.unchecked}`);
  textLines.push(`— Без следующего шага: ${metrics.noNext}`);
  textLines.push(`— Без активности 2+ дня: ${metrics.stale}`);
  textLines.push(`— Просрочено: ${metrics.overdue}`);
  textLines.push(`— Дедлайны на сегодня: ${metrics.today}`);
  textLines.push(`— Дела/задачи без дедлайна: ${metrics.noDeadline}`);
  textLines.push('');
  textLines.push(`2. Что сделать на планёрке`);
  actions.forEach((a) => textLines.push(`— ${a}`));
  textLines.push('');
  textLines.push(`3. Сводка по ответственным`);
  owners.slice(0, 12).forEach((o) => textLines.push(`— ${userName(o.id)}: всего ${o.total}, проблем ${o.problems}, ошибки передачи ${o.handoffErrors}, без шага ${o.noNext}, 2+ дня ${o.stale}, просрочено ${o.overdue}, сегодня ${o.today}`));
  textLines.push('');
  textLines.push(`4. Приоритетные проблемные сделки`);
  if (!priorityRows.length) {
    textLines.push('— Проблемных сделок по текущим критериям нет.');
  } else {
    priorityRows.forEach(({ deal, flags }, index) => {
      const next = nextStep(deal.ID);
      textLines.push(`${index + 1}. ${companyName(deal.COMPANY_ID)} / ${deal.TITLE || 'без названия'} / ID ${deal.ID}`);
      textLines.push(`   Услуга: ${getService(deal) || 'не указана'}; ответственный: ${userName(deal.ASSIGNED_BY_ID)}; стадия: ${stageName(deal.STAGE_ID)}`);
      textLines.push(`   Риски: ${shortFlagLabels(flags).join(', ')}`);
      textLines.push(`   Следующий шаг: ${next ? `${formatDate(next.date)} — ${next.kind}: ${next.title || ''}` : 'не запланирован'}`);
    });
  }

  return { metrics, owners, actions, priorityRows, text: textLines.join('\n'), date };
}

function renderManagerReport(report) {
  const box = document.getElementById('manager-report');
  if (!box) return;
  const metricCards = [
    ['Активные', report.metrics.total],
    ['Проблемные', report.metrics.problem],
    ['Ошибки передачи', report.metrics.handoffErrors],
    ['Без шага', report.metrics.noNext],
    ['Просрочено', report.metrics.overdue],
    ['Сегодня', report.metrics.today],
  ];
  const priorityHtml = report.priorityRows.length
    ? `<ol class="report-list">${report.priorityRows.slice(0, 10).map(({ deal, flags }) => `<li><strong>${escapeHtml(companyName(deal.COMPANY_ID))}</strong> · ${escapeHtml(getService(deal) || 'услуга не указана')} · ${escapeHtml(userName(deal.ASSIGNED_BY_ID))}<br><span class="muted">${escapeHtml(shortFlagLabels(flags).join(', '))}</span></li>`).join('')}</ol>`
    : '<p class="muted">Проблемных сделок по текущим критериям нет.</p>';
  box.innerHTML = `
    <div class="manager-report-header">
      <div>
        <h3>Отчёт руководителя</h3>
        <p class="muted small-note">Сформировано: ${escapeHtml(report.date)}. Можно скопировать текст и использовать на планёрке.</p>
      </div>
      <div class="manager-report-actions">
        <button id="copy-manager-report" class="secondary">Скопировать отчёт</button>
      </div>
    </div>
    <div class="manager-report-grid">
      ${metricCards.map(([label, value]) => `<div class="report-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('')}
    </div>
    <div class="report-section"><h4>Что сделать на планёрке</h4><ul class="report-list">${report.actions.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul></div>
    <div class="report-section"><h4>Приоритетные проблемные сделки</h4>${priorityHtml}</div>
    <div class="report-text"><textarea id="manager-report-text" readonly>${escapeHtml(report.text)}</textarea></div>
  `;
  box.classList.remove('hidden');
  const copyButton = document.getElementById('copy-manager-report');
  if (copyButton) copyButton.addEventListener('click', async () => {
    const text = document.getElementById('manager-report-text')?.value || report.text;
    try {
      await navigator.clipboard.writeText(text);
      alert('Отчёт скопирован.');
    } catch (_) {
      const ta = document.getElementById('manager-report-text');
      if (ta) { ta.focus(); ta.select(); }
      alert('Не удалось скопировать автоматически. Выделила текст отчёта — скопируй вручную.');
    }
  });
}

async function generateManagerReport() {
  const shouldShow = state.isAdmin || state.isLeader || state.isRop || APP_CONFIG.allowRopViewAll;
  if (!shouldShow) return;
  if (state.detailsLoading) {
    alert('Данные по делам, задачам и проверкам ещё догружаются. Подожди завершения загрузки и нажми ещё раз.');
    return;
  }
  if (!state.detailsLoaded) {
    const ok = confirm('Для отчёта нужно загрузить счётчики и журнал по всем сделкам. Запустить загрузку сейчас?');
    if (!ok) return;
    await backgroundHydrateDealMeta(getRoleVisibleDeals());
  }
  const deals = getRoleVisibleDeals();
  const report = buildManagerReport(deals);
  renderManagerReport(report);
}


function parseAiFeedbackMarker(raw) {
  const text = String(raw || '');
  const idx = text.indexOf(`${AI_FEEDBACK_TAG}:`);
  if (idx === -1) return null;
  let encoded = text.slice(idx + AI_FEEDBACK_TAG.length + 1).trim();
  encoded = encoded.split(/-->|\n|<br\s*\/?>|\s{2,}/i)[0].trim();
  encoded = encoded.replace(/[^A-Za-z0-9+/=]/g, '');
  if (!encoded) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(encoded))));
  } catch (_) {
    try { return JSON.parse(atob(encoded)); } catch (__) { return null; }
  }
}

function findAiFeedbacksForDeal(deal) {
  const comments = getTimelineComments(deal.ID);
  const out = [];
  (comments || []).forEach((c) => {
    const raw = String(c.COMMENT || c.TEXT || '');
    const parsed = parseAiFeedbackMarker(raw);
    if (!parsed) return;
    out.push({
      ...parsed,
      dealId: String(parsed.dealId || deal.ID),
      deal,
      commentCreatedAt: c.CREATED || c.DATE_CREATE || c.created || '',
      commentId: c.ID || c.id || '',
    });
  });
  return out.sort((a, b) => new Date(b.createdAt || b.commentCreatedAt || 0) - new Date(a.createdAt || a.commentCreatedAt || 0));
}

function buildAiQualityReport(deals) {
  const feedbacks = [];
  deals.forEach((deal) => feedbacks.push(...findAiFeedbacksForDeal(deal)));

  const accepted = feedbacks.filter((x) => x.kind === 'accepted');
  const corrections = feedbacks.filter((x) => x.kind === 'correction');
  const byScenario = new Map();
  const byUser = new Map();
  const byModel = new Map();

  feedbacks.forEach((fb) => {
    const scenario = fb.scenarioLabel || aiScenarioLabel(fb.scenario) || 'не указан сценарий';
    if (!byScenario.has(scenario)) byScenario.set(scenario, { label: scenario, total: 0, accepted: 0, corrections: 0 });
    const row = byScenario.get(scenario);
    row.total += 1;
    if (fb.kind === 'accepted') row.accepted += 1;
    if (fb.kind === 'correction') row.corrections += 1;

    const user = fb.userName || userName(fb.userId) || 'не указан пользователь';
    if (!byUser.has(user)) byUser.set(user, { label: user, total: 0, accepted: 0, corrections: 0 });
    const u = byUser.get(user);
    u.total += 1;
    if (fb.kind === 'accepted') u.accepted += 1;
    if (fb.kind === 'correction') u.corrections += 1;

    const model = fb.model || 'не указана модель';
    byModel.set(model, (byModel.get(model) || 0) + 1);
  });

  const latestCorrections = corrections
    .sort((a, b) => new Date(b.createdAt || b.commentCreatedAt || 0) - new Date(a.createdAt || a.commentCreatedAt || 0))
    .slice(0, 15);

  const scenarioRows = [...byScenario.values()].sort((a, b) => b.total - a.total || b.corrections - a.corrections);
  const userRows = [...byUser.values()].sort((a, b) => b.total - a.total || b.corrections - a.corrections);
  const total = feedbacks.length;
  const correctionRate = total ? Math.round((corrections.length / total) * 100) : 0;
  const acceptedRate = total ? Math.round((accepted.length / total) * 100) : 0;
  const qualityStatus = !total
    ? 'ещё нет оценок'
    : correctionRate <= 20
      ? 'хорошо, можно расширять тестирование'
      : correctionRate <= 40
        ? 'нужно доработать промпты / сценарии'
        : 'много правок, автоматизацию пока не расширять';

  const actions = [];
  if (!total) {
    actions.push('Собрать минимум 10–15 оценок ИИ от экспертов по реальным сделкам.');
    actions.push('Попросить экспертов нажимать “ИИ-вывод верный” или “Правка к ИИ” после каждого ИИ-сценария.');
  } else {
    actions.push(`Процент правок: ${correctionRate}%. ${correctionRate > 30 ? 'Нужно разобрать правки и усилить промпты.' : 'Можно продолжать тестирование в ручном режиме.'}`);
    if (latestCorrections.length) actions.push('Разобрать последние правки экспертов и выделить 3–5 типовых ошибок ИИ.');
    if (scenarioRows.length) {
      const worst = [...scenarioRows].sort((a, b) => (b.corrections / Math.max(1, b.total)) - (a.corrections / Math.max(1, a.total)))[0];
      if (worst && worst.corrections) actions.push(`Первым улучшить сценарий: “${worst.label}” — правок ${worst.corrections} из ${worst.total}.`);
    }
  }

  return {
    date: new Date().toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }),
    totalDeals: deals.length,
    total,
    accepted: accepted.length,
    corrections: corrections.length,
    acceptedRate,
    correctionRate,
    qualityStatus,
    scenarioRows,
    userRows,
    modelRows: [...byModel.entries()].map(([model, count]) => ({ model, count })).sort((a, b) => b.count - a.count),
    latestCorrections,
    actions,
  };
}

function aiQualityReportText(report) {
  const lines = [];
  lines.push('СВОДКА КАЧЕСТВА ИИ-АССИСТЕНТА');
  lines.push(`Дата: ${report.date}`);
  lines.push(`Сделок в выборке: ${report.totalDeals}`);
  lines.push(`Оценок ИИ: ${report.total}`);
  lines.push(`Принято экспертами: ${report.accepted} (${report.acceptedRate}%)`);
  lines.push(`С правками: ${report.corrections} (${report.correctionRate}%)`);
  lines.push(`Статус: ${report.qualityStatus}`);
  lines.push('');
  lines.push('Что сделать дальше:');
  report.actions.forEach((x) => lines.push(`— ${x}`));
  lines.push('');
  lines.push('По сценариям:');
  if (!report.scenarioRows.length) lines.push('— пока нет данных');
  report.scenarioRows.forEach((r) => lines.push(`— ${r.label}: всего ${r.total}, принято ${r.accepted}, правок ${r.corrections}`));
  lines.push('');
  lines.push('Последние правки экспертов:');
  if (!report.latestCorrections.length) lines.push('— пока нет правок');
  report.latestCorrections.forEach((fb, i) => {
    const deal = fb.deal || {};
    lines.push(`${i + 1}. ${companyName(deal.COMPANY_ID)} / ${deal.TITLE || 'без названия'} / ID ${deal.ID || fb.dealId}`);
    lines.push(`   Сценарий: ${fb.scenarioLabel || aiScenarioLabel(fb.scenario) || 'не указан'}`);
    lines.push(`   Правка: ${String(fb.correction || '').slice(0, 400) || '—'}`);
  });
  return lines.join('\n');
}

function renderAiQualityReport(report) {
  const box = document.getElementById('manager-ai-report');
  if (!box) return;
  const text = aiQualityReportText(report);
  const metricCards = [
    ['Оценок ИИ', report.total],
    ['Принято', `${report.accepted} / ${report.acceptedRate}%`],
    ['С правками', `${report.corrections} / ${report.correctionRate}%`],
    ['Сценариев', report.scenarioRows.length],
  ];
  const scenarios = report.scenarioRows.length
    ? report.scenarioRows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.total)}</td><td>${escapeHtml(r.accepted)}</td><td>${escapeHtml(r.corrections)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="muted">Пока нет оценок по сценариям.</td></tr>`;
  const users = report.userRows.length
    ? report.userRows.slice(0, 10).map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.total)}</td><td>${escapeHtml(r.accepted)}</td><td>${escapeHtml(r.corrections)}</td></tr>`).join('')
    : `<tr><td colspan="4" class="muted">Пока нет оценок по экспертам.</td></tr>`;
  const corrections = report.latestCorrections.length
    ? report.latestCorrections.map((fb) => {
        const deal = fb.deal || {};
        return `<li><strong>${escapeHtml(companyName(deal.COMPANY_ID))}</strong> · ${escapeHtml(deal.TITLE || `ID ${fb.dealId}`)}<br><span class="muted">${escapeHtml(fb.scenarioLabel || aiScenarioLabel(fb.scenario) || 'сценарий не указан')}</span><br>${escapeHtml(String(fb.correction || '—'))}</li>`;
      }).join('')
    : '<li class="muted">Пока нет правок экспертов.</li>';

  box.innerHTML = `<div class="manager-report-header">
    <div>
      <h3>Сводка качества ИИ</h3>
      <p class="muted small-note">Сформировано: ${escapeHtml(report.date)}. Отчёт строится по отметкам “ИИ-вывод верный” и “Правка к ИИ”.</p>
    </div>
    <div class="manager-report-actions">
      <button id="copy-ai-quality-report" class="secondary">Скопировать сводку</button>
    </div>
  </div>
  <div class="manager-report-grid">
    ${metricCards.map(([label, value]) => `<div class="report-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('')}
  </div>
  <div class="result-card ${report.correctionRate > 40 ? 'card-risk' : report.correctionRate > 20 ? 'card-uncertain' : 'card-found'}">
    <h4>Статус качества</h4>
    <p>${escapeHtml(report.qualityStatus)}</p>
    <ul>${report.actions.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
  </div>
  <div class="report-section"><h4>Качество по ИИ-сценариям</h4><table class="mini-table"><thead><tr><th>Сценарий</th><th>Всего</th><th>Принято</th><th>Правки</th></tr></thead><tbody>${scenarios}</tbody></table></div>
  <div class="report-section"><h4>Оценки по экспертам</h4><table class="mini-table"><thead><tr><th>Эксперт</th><th>Всего</th><th>Принято</th><th>Правки</th></tr></thead><tbody>${users}</tbody></table></div>
  <div class="report-section"><h4>Последние правки</h4><ol class="report-list">${corrections}</ol></div>
  <div class="report-text"><textarea id="ai-quality-report-text" readonly>${escapeHtml(text)}</textarea></div>`;
  box.classList.remove('hidden');
  const copyBtn = document.getElementById('copy-ai-quality-report');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const ta = document.getElementById('ai-quality-report-text');
    try {
      await navigator.clipboard.writeText(ta?.value || text);
      alert('Сводка качества ИИ скопирована.');
    } catch (_) {
      if (ta) { ta.focus(); ta.select(); }
      alert('Не удалось скопировать автоматически. Выделила текст — скопируй вручную.');
    }
  });
}

async function generateAIQualityReport() {
  const shouldShow = state.isAdmin || state.isLeader || state.isRop || APP_CONFIG.allowRopViewAll;
  if (!shouldShow) return;
  if (state.detailsLoading) {
    alert('Сначала дождись завершения загрузки счётчиков/журнала. Сводка качества ИИ строится по комментариям сделок.');
    return;
  }
  if (!state.detailsLoaded) {
    const ok = confirm('Для сводки качества ИИ нужно загрузить комментарии по активным сделкам. Запустить загрузку счётчиков/журнала сейчас?');
    if (!ok) return;
    await backgroundHydrateDealMeta(getRoleVisibleDeals());
  }
  const report = buildAiQualityReport(getRoleVisibleDeals());
  state.aiQualityReport = report;
  renderAiQualityReport(report);
}


function managerProblemScore(deal) {
  const f = getDealIssueFlags(deal);
  return (f.handoffErrors ? 120 : 0)
    + (f.overdue ? 100 : 0)
    + (f.noNext ? 80 : 0)
    + (f.stale ? 60 : 0)
    + (f.handoffPartial ? 40 : 0)
    + (f.noDeadline ? 25 : 0)
    + (f.unchecked ? 15 : 0)
    + (f.today ? 10 : 0);
}

function getPriorityProblemDeals(limit = 5) {
  return getRoleVisibleDeals()
    .filter((deal) => getDealIssueFlags(deal).problem)
    .sort((a, b) => managerProblemScore(b) - managerProblemScore(a) || daysSince(lastWorkDate(b)) - daysSince(lastWorkDate(a)))
    .slice(0, Math.max(1, Number(limit || 5)));
}

function managerAiResultText(results) {
  const date = new Date().toLocaleString('ru-RU', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
  const lines = [];
  lines.push('ИИ-СВОДКА ПО ПРОБЛЕМНЫМ СДЕЛКАМ');
  lines.push(`Дата: ${date}`);
  lines.push(`Проанализировано сделок: ${results.length}`);
  lines.push('');
  results.forEach((row, index) => {
    const deal = row.deal;
    lines.push(`${index + 1}. ${companyName(deal.COMPANY_ID)} / ${deal.TITLE || 'без названия'} / ID ${deal.ID}`);
    lines.push(`   Услуга: ${getService(deal) || 'не указана'}`);
    lines.push(`   Стадия: ${stageName(deal.STAGE_ID)}`);
    lines.push(`   Эксперт: ${userName(deal.ASSIGNED_BY_ID)}`);
    lines.push(`   Риски системы: ${shortFlagLabels(getDealIssueFlags(deal)).join(', ')}`);
    if (row.error) {
      lines.push(`   Ошибка ИИ: ${row.error}`);
      lines.push('');
      return;
    }
    const r = row.ai && row.ai.result ? row.ai.result : row.ai || {};
    lines.push(`   Статус ИИ: ${r.status_label || r.status || 'нужна проверка'}`);
    lines.push(`   Вывод: ${(r.summary || []).slice(0, 3).join('; ') || '—'}`);
    lines.push(`   Не хватает: ${(r.missing || []).slice(0, 3).join('; ') || '—'}`);
    lines.push(`   Риски: ${(r.risks || []).slice(0, 3).join('; ') || '—'}`);
    lines.push(`   Действия: ${(r.next_steps || []).slice(0, 4).join('; ') || '—'}`);
    if (r.tasks && r.tasks.length) {
      lines.push('   Рекомендуемые задачи:');
      r.tasks.slice(0, 5).forEach((t) => lines.push(`   — ${t.title}${t.responsible ? ` (${t.responsible})` : ''}${t.deadline_hint ? `, ${t.deadline_hint}` : ''}`));
    }
    lines.push('');
  });
  lines.push('Важно: это ИИ-черновик для руководителя/РОП. Перед постановкой задач вывод нужно проверить.');
  return lines.join('\n');
}

function renderManagerAiReport(results) {
  const box = document.getElementById('manager-ai-report');
  if (!box) return;
  const okRows = results.filter((r) => !r.error);
  const errorRows = results.filter((r) => r.error);
  const text = managerAiResultText(results);
  const tasks = [];
  results.forEach((row) => {
    if (row.error) return;
    const built = buildAITasks(row.deal, row.ai).map((task) => ({ ...task, deal: row.deal }));
    built.forEach((task) => tasks.push(task));
  });
  state.managerAiTasks = tasks;

  const cards = results.map((row) => {
    const deal = row.deal;
    const flags = shortFlagLabels(getDealIssueFlags(deal)).join(', ');
    if (row.error) {
      return `<div class="result-card card-risk">
        <h4>${escapeHtml(companyName(deal.COMPANY_ID))} · ${escapeHtml(deal.TITLE || '')}</h4>
        <p><strong>Ошибка ИИ:</strong> ${escapeHtml(row.error)}</p>
        <p class="muted">${escapeHtml(flags)}</p>
      </div>`;
    }
    const r = row.ai.result || row.ai;
    return `<div class="result-card card-action">
      <h4>${escapeHtml(companyName(deal.COMPANY_ID))} · ${escapeHtml(getService(deal) || 'услуга не указана')}</h4>
      <div class="result-status ${aiStatusClass(r.status)}">${escapeHtml(r.status_label || r.status || 'нужна проверка')}</div>
      <p class="muted small-note">Сделка ID ${escapeHtml(deal.ID)} · ${escapeHtml(stageName(deal.STAGE_ID))} · ${escapeHtml(userName(deal.ASSIGNED_BY_ID))}</p>
      <p><strong>Почему проблемная:</strong> ${escapeHtml(flags)}</p>
      <p><strong>Вывод ИИ:</strong> ${escapeHtml((r.summary || []).slice(0, 2).join('; ') || '—')}</p>
      <p><strong>Что сделать:</strong> ${escapeHtml((r.next_steps || []).slice(0, 3).join('; ') || '—')}</p>
      <p><strong>Задачи:</strong> ${escapeHtml((r.tasks || []).slice(0, 3).map((t) => t.title).join('; ') || '—')}</p>
      <button class="secondary" data-open="${escapeHtml(deal.ID)}">Открыть сделку</button>
    </div>`;
  }).join('');

  box.innerHTML = `<div class="manager-report-header">
    <div>
      <h3>ИИ-сводка проблемных сделок</h3>
      <p class="muted small-note">Готово: ${okRows.length}; с ошибкой: ${errorRows.length}. Задачи не создаются автоматически.</p>
    </div>
    <div class="manager-report-actions">
      <button id="copy-manager-ai-report" class="secondary">Скопировать ИИ-сводку</button>
      <button id="create-manager-ai-tasks" class="primary ${tasks.length ? '' : 'hidden'}">Создать задачи из ИИ-сводки (${tasks.length})</button>
    </div>
  </div>
  <div class="manager-ai-cards">${cards || '<p class="muted">Нет результатов ИИ-анализа.</p>'}</div>
  <div class="report-text"><textarea id="manager-ai-report-text" readonly>${escapeHtml(text)}</textarea></div>`;
  box.classList.remove('hidden');

  const copyBtn = document.getElementById('copy-manager-ai-report');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const ta = document.getElementById('manager-ai-report-text');
    try {
      await navigator.clipboard.writeText(ta?.value || text);
      alert('ИИ-сводка скопирована.');
    } catch (_) {
      if (ta) { ta.focus(); ta.select(); }
      alert('Не удалось скопировать автоматически. Выделила текст — скопируй вручную.');
    }
  });
  const createBtn = document.getElementById('create-manager-ai-tasks');
  if (createBtn) createBtn.addEventListener('click', createManagerAITasks);
}

async function runManagerAIAnalysis() {
  const shouldShow = state.isAdmin || state.isLeader || state.isRop || APP_CONFIG.allowRopViewAll;
  if (!shouldShow) return;
  const box = document.getElementById('manager-ai-report');
  if (!box) return;
  if (!APP_CONFIG.aiEnabled) {
    box.innerHTML = `<div class="result-card card-risk"><h3>ИИ пока не включён</h3><p>Проверь Render Environment: AI_ENABLED=true, AI_PROVIDER=vibe, AI_BASE_URL, AI_MODEL и AI_API_KEY.</p></div>`;
    box.classList.remove('hidden');
    return;
  }
  if (state.detailsLoading) {
    alert('Сначала дождись завершения загрузки счётчиков/журнала.');
    return;
  }
  if (!state.detailsLoaded) {
    const ok = confirm('Для ИИ-анализа проблемных сделок нужно загрузить счётчики и журнал. Запустить загрузку сейчас?');
    if (!ok) return;
    await backgroundHydrateDealMeta(getRoleVisibleDeals());
  }
  const limit = Number(APP_CONFIG.managerAiLimit || 5) || 5;
  const deals = getPriorityProblemDeals(limit);
  if (!deals.length) {
    box.innerHTML = `<div class="result-card card-found"><h3>Проблемных сделок не найдено</h3><p class="muted">По текущим критериям нет сделок для массового ИИ-анализа.</p></div>`;
    box.classList.remove('hidden');
    return;
  }

  box.innerHTML = `<div class="result-card card-action"><h3>ИИ-анализ проблемных сделок...</h3><p>Взято сделок: ${deals.length}. Анализируем по одной, чтобы не перегружать VibeCode и Bitrix.</p><p id="manager-ai-progress" class="muted">Старт...</p></div>`;
  box.classList.remove('hidden');

  const results = [];
  for (let i = 0; i < deals.length; i += 1) {
    const deal = deals[i];
    const progress = document.getElementById('manager-ai-progress');
    if (progress) progress.textContent = `${i + 1}/${deals.length}: ${companyName(deal.COMPANY_ID)} · ${deal.TITLE || ''}`;
    try {
      let context = await buildAIContext(deal);
      context = await enrichAIContextByScenario(context, deal, 'manager_deal');
      context.managerBatch = {
        position: i + 1,
        total: deals.length,
        problemScore: managerProblemScore(deal),
        visibleFlags: shortFlagLabels(getDealIssueFlags(deal)),
      };
      const response = await fetch('/api/ai/analyze-deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, scenario: 'manager_deal' }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.ok) throw new Error(data.error || `Ошибка ИИ HTTP ${response.status}`);
      data.scenario_label = data.scenario_label || 'ИИ-анализ проблемной сделки для руководителя';
      results.push({ deal, ai: data });
    } catch (e) {
      results.push({ deal, error: e.message || String(e) });
    }
  }

  state.managerAiResults = results;
  renderManagerAiReport(results);
}

async function createManagerAITasks() {
  const tasks = state.managerAiTasks || [];
  if (!tasks.length) {
    alert('Новых задач из ИИ-сводки нет или похожие открытые задачи уже существуют.');
    return;
  }
  const preview = tasks.slice(0, 20).map((t, i) => `${i + 1}. ${t.title} — ${userName(t.responsibleId)}, ${formatDate(t.deadline)} (${companyName(t.deal.COMPANY_ID)})`).join('\n');
  const suffix = tasks.length > 20 ? `\n...и ещё ${tasks.length - 20}` : '';
  if (!window.confirm(`Будут созданы задачи из ИИ-сводки: ${tasks.length}\n\n${preview}${suffix}\n\nСоздать?`)) return;
  let created = 0;
  for (const task of tasks) {
    await createTask({
      title: task.title,
      responsibleId: task.responsibleId,
      description: task.description,
      dealId: task.deal.ID,
      deadline: task.deadline,
      silent: true,
    });
    created += 1;
  }
  alert(`Создано задач из ИИ-сводки: ${created}`);
  state.managerAiTasks = [];
  await loadDeals();
}


function auditIssueList(audit) {
  if (!audit) return [];
  const items = [
    ...(audit.missing || []).map((x) => ({ type: 'не передано', text: x })),
    ...(audit.uncertain || []).map((x) => ({ type: 'подтвердить', text: x })),
    ...(audit.technical || []).map((x) => ({ type: 'технически не хватает', text: x })),
  ];
  return items.filter((x) => String(x.text || '').trim());
}

function auditAgeDays(audit) {
  if (!audit || !audit.checkedAt) return 0;
  const d = new Date(audit.checkedAt);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
}

function handoffJournalStatus(audit) {
  if (!audit) return { key: 'unchecked', label: 'не проверено', cls: 'info' };
  const age = auditAgeDays(audit);
  if (audit.statusCode === 'error' && age >= 1) return { key: 'overdue', label: `просрочено исправление ${age} дн.`, cls: 'danger' };
  if (audit.statusCode === 'error') return { key: 'new', label: 'новая ошибка', cls: 'danger' };
  if (audit.statusCode === 'partial') return { key: 'partial', label: 'нужно подтвердить', cls: 'warning' };
  return { key: 'ok', label: 'исправлено / принято', cls: 'ok' };
}

function managerIdForHandoff(deal) {
  const salesInfo = cachedSalesManagerInfo(deal);
  if (salesInfo && salesInfo.managerId) return String(salesInfo.managerId);
  return String(deal.CREATED_BY_ID || deal.ASSIGNED_BY_ID || '0');
}

function managerSourceForHandoff(deal) {
  const salesInfo = cachedSalesManagerInfo(deal);
  if (salesInfo && salesInfo.source) return salesInfo.source;
  return getSalesDealId(deal) ? 'связанная сделка продаж ещё не загружена' : 'создатель производственной сделки';
}

function buildHandoffJournalRows(deals) {
  return deals
    .map((deal) => {
      const audit = getAudit(deal.ID);
      if (!audit || !['error', 'partial'].includes(audit.statusCode)) return null;
      const status = handoffJournalStatus(audit);
      const issues = auditIssueList(audit);
      return { deal, audit, issues, status, managerId: managerIdForHandoff(deal), managerSource: managerSourceForHandoff(deal), salesDealId: (cachedSalesManagerInfo(deal) || {}).salesId || getSalesDealId(deal) || '', expertId: String(deal.ASSIGNED_BY_ID || '0'), checkedAt: audit.checkedAt || deal.DATE_MODIFY || deal.DATE_CREATE };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const priority = { overdue: 100, new: 80, partial: 50, ok: 0 };
      return (priority[b.status.key] || 0) - (priority[a.status.key] || 0) || new Date(b.checkedAt || 0) - new Date(a.checkedAt || 0);
    });
}

function filteredHandoffJournalRows(deals) {
  const q = normalize(state.journalSearch || '');
  return buildHandoffJournalRows(deals).filter((row) => {
    if (state.journalStatusFilter !== 'all' && row.status.key !== state.journalStatusFilter) return false;
    if (state.journalManagerFilter !== 'all' && String(row.managerId) !== String(state.journalManagerFilter)) return false;
    if (!q) return true;
    const hay = normalize([
      companyName(row.deal.COMPANY_ID), row.deal.TITLE, getService(row.deal), userName(row.managerId), userName(row.expertId), row.issues.map((x) => `${x.type} ${x.text}`).join(' '),
    ].join(' '));
    return hay.includes(q);
  });
}

function renderHandoffJournal(deals, metaReady) {
  const box = document.getElementById('handoff-journal');
  if (!box) return;
  const shouldShow = state.isAdmin || state.isLeader || state.isRop || APP_CONFIG.allowRopViewAll;
  box.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) return;

  const allRows = metaReady ? buildHandoffJournalRows(deals) : [];
  const rows = metaReady ? filteredHandoffJournalRows(deals) : [];
  if (metaReady && allRows.length) enrichJournalSalesManagers(allRows);
  const tbody = document.querySelector('#handoff-journal-table tbody');
  const managerSelect = document.getElementById('journal-manager-filter');
  const summary = document.getElementById('handoff-journal-summary');

  if (!metaReady) {
    const txt = state.detailsLoading ? 'Догружаем проверки...' : 'Не загружено';
    const msg = state.detailsLoading ? 'Дела, задачи и проверки ещё догружаются. Журнал появится автоматически.' : 'Чтобы сформировать журнал, нажмите кнопку “Загрузить счётчики / журнал”.';
    summary.innerHTML = `<div class="journal-card info"><span>Статус</span><strong>${escapeHtml(txt)}</strong></div>`;
    tbody.innerHTML = `<tr><td colspan="7" class="muted">${escapeHtml(msg)}</td></tr>`;
    return;
  }

  const managerOptions = [...new Set(allRows.map((r) => String(r.managerId)))].sort((a, b) => userName(a).localeCompare(userName(b)));
  const currentManager = state.journalManagerFilter || 'all';
  managerSelect.innerHTML = '<option value="all">Все менеджеры</option>' + managerOptions.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(userName(id))}</option>`).join('');
  managerSelect.value = managerOptions.includes(currentManager) ? currentManager : 'all';
  state.journalManagerFilter = managerSelect.value;

  const count = (key) => allRows.filter((r) => r.status.key === key).length;
  const unresolvedOver1Day = allRows.filter((r) => r.status.key === 'overdue').length;
  summary.innerHTML = [
    ['Всего ошибок/спорных', allRows.length, 'info'],
    ['Новые ошибки', count('new'), 'danger'],
    ['Нужно подтвердить', count('partial'), 'warning'],
    ['Не исправлено больше 1 дня', unresolvedOver1Day, 'danger'],
  ].map(([label, value, cls]) => `<div class="journal-card ${cls}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`).join('');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted">По выбранным фильтрам ошибок передачи нет.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.slice(0, 100).map((row) => {
    const issues = row.issues.length
      ? row.issues.slice(0, 6).map((x) => `<li><strong>${escapeHtml(x.type)}:</strong> ${escapeHtml(x.text)}</li>`).join('')
      : '<li>нет детализации, нужно открыть проверку</li>';
    return `
      <tr>
        <td>${escapeHtml(formatDate(row.checkedAt) || '—')}<br><span class="muted">${escapeHtml(row.audit.checkedByName || '')}</span></td>
        <td><strong>${escapeHtml(companyName(row.deal.COMPANY_ID))}</strong><br>${escapeHtml(row.deal.TITLE || '')}<br><span class="muted">ID ${escapeHtml(row.deal.ID)} · ${escapeHtml(getService(row.deal) || 'услуга не указана')}</span></td>
        <td>
          <strong>${escapeHtml(userName(row.managerId))}</strong>
          <div class="muted small-note">${escapeHtml(row.managerSource || '')}${row.salesDealId ? ` · продажа ID ${escapeHtml(row.salesDealId)}` : ''}</div>
        </td>
        <td>${escapeHtml(userName(row.expertId))}</td>
        <td><ul class="journal-issues">${issues}</ul></td>
        <td><span class="status-chip status-${escapeHtml(row.status.cls)}">${escapeHtml(row.status.label)}</span></td>
        <td class="journal-row-actions">
          <button class="secondary" data-open="${escapeHtml(row.deal.ID)}">Открыть</button>
          <button class="secondary" data-handoff-task="${escapeHtml(row.deal.ID)}">Задача менеджеру</button>
          <button class="secondary" data-mark-handoff-ok="${escapeHtml(row.deal.ID)}">Закрыть ошибку</button>
        </td>
      </tr>`;
  }).join('');
}

function buildHandoffFixTask(row) {
  const issues = row.issues.length ? row.issues.map((x) => `— ${x.type}: ${x.text}`).join('\n') : '— открыть проверку передачи и дозаполнить недостающие данные';
  return {
    title: `Исправить ошибку передачи по сделке ID ${row.deal.ID}`,
    responsibleId: row.managerId,
    deadline: deadlineTodayEnd(),
    description: `По производственной сделке зафиксирована ошибка/спорная передача.\n\nСделка: ${row.deal.TITLE || ''}\nКомпания: ${companyName(row.deal.COMPANY_ID)}\nУслуга: ${getService(row.deal) || 'услуга не указана'}\nЭксперт: ${userName(row.expertId)}\nСтатус: ${row.status.label}\n\nЧто нужно исправить/подтвердить:\n${issues}\n\nЧто сделать менеджеру:\n1. Дозаполнить информацию в исходной сделке продаж или комментарии к производственной сделке.\n2. Подтвердить эксперту, что данные исправлены.\n3. Если данные спорные — написать комментарий для РОП/руководителя экспертного отдела.`
  };
}

async function createHandoffTaskForDeal(dealId, silent = false) {
  const row = buildHandoffJournalRows(getRoleVisibleDeals()).find((x) => String(x.deal.ID) === String(dealId));
  if (!row) { if (!silent) alert('По этой сделке нет активной ошибки передачи.'); return false; }
  const task = buildHandoffFixTask(row);
  if (hasOpenTaskWithTitle(row.deal.ID, task.title)) { if (!silent) alert('Похожая открытая задача менеджеру уже есть.'); return false; }
  await createTask({ title: task.title, responsibleId: task.responsibleId, description: task.description, dealId: row.deal.ID, deadline: task.deadline, silent: true });
  await bxCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: Number(row.deal.ID), ENTITY_TYPE: 'deal', COMMENT: `ИИ-ассистент: создана задача менеджеру на исправление ошибки передачи.\nМенеджер: ${userName(row.managerId)}\nСтатус ошибки: ${row.status.label}` }
  });
  if (!silent) alert('Задача менеджеру создана.');
  return true;
}


function uniqueIds(ids) {
  return [...new Set((ids || []).map((x) => String(x || '').trim()).filter(Boolean).filter((x) => x !== '0'))];
}

function escalationResponsibleId() {
  return String(APP_CONFIG.escalationResponsibleId || (APP_CONFIG.leaderUserIds || [])[0] || state.user.ID || '').trim();
}

function escalationAuditorIds() {
  const responsible = escalationResponsibleId();
  const configured = uniqueIds(APP_CONFIG.escalationAuditorIds || []);
  const fallback = uniqueIds([...(APP_CONFIG.leaderUserIds || []), ...(APP_CONFIG.ropUserIds || [])]);
  return (configured.length ? configured : fallback).filter((id) => String(id) !== String(responsible));
}

function overdueItemsForDeal(deal) {
  const activities = openActivities(deal.ID)
    .filter((a) => isOverdueDate(a.DEADLINE))
    .map((a) => ({ kind: 'дело', title: a.SUBJECT || 'без названия', deadline: a.DEADLINE }));
  const tasks = openTasks(deal.ID)
    .filter((t) => isOverdueDate(getDeadlineValue(t)))
    .map((t) => ({ kind: 'задача', title: t.TITLE || t.title || 'без названия', deadline: getDeadlineValue(t) }));
  return [...activities, ...tasks];
}

function buildEscalationReason(deal) {
  const flags = getDealIssueFlags(deal);
  const audit = getAudit(deal.ID);
  const reasons = [];
  const details = [];

  if (audit && audit.statusCode === 'error') {
    const age = auditAgeDays(audit);
    reasons.push(age >= 1 ? 'ошибка передачи не исправлена 1+ день' : 'ошибка передачи');
    const issues = auditIssueList(audit);
    if (issues.length) details.push('Ошибки передачи:\n' + issues.map((x) => `— ${x.type}: ${x.text}`).join('\n'));
  }
  if (audit && audit.statusCode === 'partial' && auditAgeDays(audit) >= 1) {
    reasons.push('спорные данные передачи не подтверждены 1+ день');
    const issues = auditIssueList(audit);
    if (issues.length) details.push('Нужно подтвердить по передаче:\n' + issues.map((x) => `— ${x.type}: ${x.text}`).join('\n'));
  }

  const overdue = overdueItemsForDeal(deal);
  if (overdue.length) {
    reasons.push('есть просроченные дела/задачи');
    details.push('Просрочено:\n' + overdue.slice(0, 8).map((x) => `— ${x.kind}: ${x.title}, дедлайн ${formatDate(x.deadline)}`).join('\n'));
  }
  if (flags.noNext) reasons.push('нет следующего шага');
  if (flags.stale) reasons.push(`нет рабочей активности ${daysSince(lastWorkDate(deal))}+ дня`);
  if (flags.noDeadline) reasons.push(`есть открытые дела/задачи без дедлайна: ${flags.noDeadlineCount}`);

  return { reasons, details, flags };
}

function escalationScore(row) {
  const f = row.flags;
  const audit = getAudit(row.deal.ID);
  return (f.overdue ? 100 : 0)
    + (audit && audit.statusCode === 'error' && auditAgeDays(audit) >= 1 ? 90 : 0)
    + (f.noNext ? 60 : 0)
    + (f.stale ? 45 : 0)
    + (f.noDeadline ? 20 : 0)
    + (audit && audit.statusCode === 'partial' && auditAgeDays(audit) >= 1 ? 30 : 0);
}

function buildEscalationRows(deals) {
  return (deals || [])
    .map((deal) => {
      const { reasons, details, flags } = buildEscalationReason(deal);
      const audit = getAudit(deal.ID);
      const critical = flags.overdue
        || (audit && audit.statusCode === 'error' && auditAgeDays(audit) >= 1)
        || (audit && audit.statusCode === 'partial' && auditAgeDays(audit) >= 1)
        || (flags.noNext && flags.stale);
      if (!critical) return null;
      return { deal, reasons, details, flags, score: 0 };
    })
    .filter(Boolean)
    .map((row) => ({ ...row, score: escalationScore(row) }))
    .sort((a, b) => b.score - a.score || new Date(b.deal.DATE_MODIFY || 0) - new Date(a.deal.DATE_MODIFY || 0));
}

function buildEscalationTask(row) {
  const deal = row.deal;
  const salesInfo = cachedSalesManagerInfo(deal);
  const managerId = managerIdForHandoff(deal);
  const details = row.details.length ? row.details.join('\n\n') : 'Детализация не найдена, нужно открыть сделку и проверить вручную.';
  return {
    title: `Эскалация по проблемной производственной сделке ID ${deal.ID}`,
    responsibleId: escalationResponsibleId(),
    auditorIds: escalationAuditorIds(),
    deadline: deadlineTodayEnd(),
    description: `Нужно управленческое решение/контроль по производственной сделке.\n\nСделка: ${deal.TITLE || ''}\nКомпания: ${companyName(deal.COMPANY_ID)}\nУслуга: ${getService(deal) || 'услуга не указана'}\nСтадия: ${stageName(deal.STAGE_ID)}\nЭксперт: ${userName(deal.ASSIGNED_BY_ID)}\nМенеджер передачи: ${userName(managerId)}${salesInfo && salesInfo.salesId ? `\nСвязанная сделка продаж: ID ${salesInfo.salesId}` : ''}\n\nПричины эскалации:\n${row.reasons.map((x) => `— ${x}`).join('\n')}\n\nДетали:\n${details}\n\nЧто сделать руководителю/РОП:\n1. Проверить, кто должен закрыть проблему: эксперт или менеджер.\n2. Поставить короткий срок исправления.\n3. При необходимости связаться с клиентом и зафиксировать новый следующий шаг.\n4. После исправления закрыть ошибку/эскалацию в кабинете ассистента.`
  };
}

async function createEscalationTasks() {
  if (!state.detailsLoaded || state.detailsLoading) {
    alert('Сначала нажми “Загрузить счётчики / журнал” и дождись загрузки. Эскалации считаются только после загрузки дел, задач и проверок.');
    return;
  }
  const rows = buildEscalationRows(getRoleVisibleDeals())
    .filter((row) => !hasOpenTaskWithTitle(row.deal.ID, `Эскалация по проблемной производственной сделке ID ${row.deal.ID}`));
  if (!rows.length) {
    alert('Новых критических эскалаций нет: либо проблем нет, либо задачи уже созданы.');
    return;
  }
  const preview = rows.slice(0, 12).map((row, i) => `${i + 1}. ${companyName(row.deal.COMPANY_ID)} / ${row.deal.TITLE || ''}: ${row.reasons.join(', ')}`).join('\n');
  if (!window.confirm(`Будут созданы задачи-эскалации руководителю: ${rows.length}\n\n${preview}${rows.length > 12 ? '\n...' : ''}\n\nСоздать?`)) return;

  let created = 0;
  for (const row of rows) {
    const task = buildEscalationTask(row);
    await createTask({
      title: task.title,
      responsibleId: task.responsibleId,
      auditorIds: task.auditorIds,
      description: task.description,
      dealId: row.deal.ID,
      deadline: task.deadline,
      silent: true,
    });
    await bxCall('crm.timeline.comment.add', {
      fields: { ENTITY_ID: Number(row.deal.ID), ENTITY_TYPE: 'deal', COMMENT: `ИИ-ассистент: создана управленческая эскалация по проблемной сделке.\nПричины: ${row.reasons.join('; ')}\nОтветственный по эскалации: ${userName(task.responsibleId)}` }
    });
    created += 1;
  }
  alert(`Создано задач-эскалаций: ${created}`);
  await backgroundHydrateDealMeta(getRoleVisibleDeals());
}

async function createHandoffReminderTasks() {
  const rows = buildHandoffJournalRows(getRoleVisibleDeals())
    .filter((row) => ['overdue', 'new', 'partial'].includes(row.status.key))
    .filter((row) => !hasOpenTaskWithTitle(row.deal.ID, `Исправить ошибку передачи по сделке ID ${row.deal.ID}`));
  if (!rows.length) { alert('Новых задач по ошибкам передачи нет: либо ошибок нет, либо задачи уже созданы.'); return; }
  const preview = rows.slice(0, 15).map((row, i) => `${i + 1}. ${companyName(row.deal.COMPANY_ID)} / ${row.deal.TITLE || ''} → ${userName(row.managerId)} (${row.status.label})`).join('\n');
  if (!window.confirm(`Будут созданы задачи менеджерам по ошибкам передачи: ${rows.length}\n\n${preview}${rows.length > 15 ? '\n...' : ''}\n\nСоздать?`)) return;
  let created = 0;
  for (const row of rows) {
    const ok = await createHandoffTaskForDeal(row.deal.ID, true);
    if (ok) created += 1;
  }
  alert(`Создано задач по ошибкам передачи: ${created}`);
  await loadDeals();
}

async function markHandoffIssueOk(dealId) {
  const deal = state.deals.find((d) => String(d.ID) === String(dealId));
  if (!deal) return;
  if (!window.confirm('Закрыть ошибку передачи вручную? Сделка будет отмечена как “проверено — принято в работу”.')) return;
  const audit = { version: 1, dealId: String(deal.ID), statusCode: 'ok', status: 'ошибка передачи закрыта руководителем / РОП', checkedAt: new Date().toISOString(), checkedById: String(state.user.ID), checkedByName: `${state.user.NAME || ''} ${state.user.LAST_NAME || ''}`.trim(), missing: [], uncertain: [], technical: [], foundCount: 0, manualClose: true };
  await bxCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: Number(deal.ID), ENTITY_TYPE: 'deal', COMMENT: `ИИ-проверка передачи сделки в производство\n\nСтатус: ошибка передачи закрыта вручную.\n\nЗакрыл пользователь: ${audit.checkedByName}.\n${auditMarker(audit)}` }
  });
  state.auditByDeal.set(String(deal.ID), audit);
  renderDeals();
  alert('Ошибка передачи закрыта.');
}


function getRoleVisibleDeals() {
  const isRopOnly = state.isRop && !(state.isAdmin || state.isLeader) && !APP_CONFIG.allowRopViewAll;
  if (isRopOnly) return state.deals.filter((d) => {
    const audit = getAudit(d.ID);
    return audit && audit.statusCode === 'error';
  });
  return state.deals;
}

function renderDeals() {
  document.getElementById('loading').classList.add('hidden');
  const table = document.getElementById('deals-table');
  table.classList.remove('hidden');
  const q = normalize(document.getElementById('search').value);
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';

  const roleVisibleDeals = getRoleVisibleDeals();
  const metaReady = state.detailsLoaded && !state.detailsLoading;
  renderManagerDashboard(roleVisibleDeals, metaReady);

  const filterBase = metaReady
    ? roleVisibleDeals.filter((d) => dealMatchesDashboardFilter(d, state.dashboardFilter))
    : roleVisibleDeals;
  const filtered = filterBase.filter((d) => normalize(`${d.TITLE} ${companyName(d.COMPANY_ID)} ${getService(d)} ${d.STAGE_ID} ${stageName(d.STAGE_ID)} ${d.CATEGORY_ID} ${auditLabel(getAudit(d.ID))}`).includes(q));

  filtered.forEach((deal) => {
    const next = metaReady ? nextStep(deal.ID) : null;
    const noOpen = metaReady ? !hasNextStep(deal.ID) : false;
    const lastWork = metaReady ? lastWorkDate(deal) : '';
    const stale = metaReady ? daysSince(lastWork) >= 2 : false;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(companyName(deal.COMPANY_ID))}</td>
      <td><strong>${escapeHtml(deal.TITLE || '')}</strong><br><span class="muted">ID ${deal.ID}</span></td>
      <td>${escapeHtml(getService(deal) || '—')}</td>
      <td><span class="badge" title="${escapeHtml(deal.STAGE_ID || '')}">${escapeHtml(stageName(deal.STAGE_ID))}</span>${isStageResolved(deal.STAGE_ID) ? `<br><span class="muted">${escapeHtml(deal.STAGE_ID || '—')}</span>` : ''}</td>
      <td>${escapeHtml(deal.CATEGORY_ID ?? '0')}</td>
      <td>${escapeHtml(formatMoney(deal.OPPORTUNITY))}</td>
      <td>${escapeHtml(formatDate(getStartDate(deal)) || '—')}</td>
      <td>${escapeHtml(userName(deal.ASSIGNED_BY_ID))}</td>
      <td>${!metaReady ? metaPlaceholder('next') : next ? `${escapeHtml(formatDate(next.date))}<br><span class="muted">${escapeHtml(next.kind)}: ${escapeHtml(next.title || '')}</span>` : '<span class="warn">нет открытого дела/задачи</span>'}</td>
      <td>${!metaReady ? metaPlaceholder('last') : `${escapeHtml(formatDate(lastWork) || '—')}${stale ? '<br><span class="warn">2+ дня</span>' : ''}`}</td>
      <td>${!metaReady ? metaPlaceholder('audit') : auditHtml(deal.ID)}</td>
      <td>
        <button class="secondary" data-bx="${deal.ID}">В Bitrix</button>
        <button class="secondary" data-open="${deal.ID}">Открыть</button>
        <button class="primary" data-check="${deal.ID}">Проверить</button>
      </td>
    `;
    if (noOpen) tr.classList.add('row-warn');
    tbody.appendChild(tr);
  });

  const visibleForRole = getRoleVisibleDeals();
  document.getElementById('count-all').textContent = visibleForRole.length;
  document.getElementById('count-no-activity').textContent = metaReady ? visibleForRole.filter((d) => !hasNextStep(d.ID)).length : (state.detailsLoading ? '…' : '—');
  document.getElementById('count-stale').textContent = metaReady ? visibleForRole.filter((d) => daysSince(lastWorkDate(d)) >= 2).length : (state.detailsLoading ? '…' : '—');
  const isRopOnly = state.isRop && !(state.isAdmin || state.isLeader) && !APP_CONFIG.allowRopViewAll;
  document.getElementById('label-count-all').textContent = isRopOnly ? 'Ошибки передачи' : 'Активные открытые сделки';
  document.getElementById('label-count-check').textContent = isRopOnly ? 'Ошибки передачи' : 'Не проверено';
  document.getElementById('count-check').textContent = metaReady ? (isRopOnly ? visibleForRole.length : visibleForRole.filter((d) => !getAudit(d.ID)).length) : (state.detailsLoading ? '…' : '—');
  document.getElementById('deals-title').textContent = isRopOnly ? 'Ошибки передачи из продаж' : 'Активные сделки';

  const roleNote = state.isRop && !(state.isAdmin || state.isLeader) && !APP_CONFIG.allowRopViewAll
    ? 'Режим РОП: общий список экспертов скрыт. Для временного общего просмотра поставь ALLOW_ROP_VIEW_ALL=true.'
    : state.isAdmin || state.isLeader
      ? 'Режим руководителя: показаны все открытые сделки выбранной воронки.'
      : 'Режим эксперта: показаны только открытые сделки, где текущий пользователь — ответственный.';
  const limitNote = Number(APP_CONFIG.maxDeals || 0) > 0
    ? `Технический лимит загрузки: MAX_DEALS=${APP_CONFIG.maxDeals}.`
    : 'Технический лимит не задан: приложение загружает все открытые сделки через пагинацию Bitrix.';
  document.getElementById('category-note').textContent = (APP_CONFIG.productionCategoryId
    ? `Фильтр по воронке производства: CATEGORY_ID=${APP_CONFIG.productionCategoryId}. `
    : 'Фильтр по воронке пока не задан. Посмотри колонку “Воронка ID” и добавь PRODUCTION_CATEGORY_ID в Render. ')
    + `${APP_CONFIG.excludeClosedDeals !== false ? 'Закрытые сделки исключены. ' : 'Закрытые сделки НЕ исключены. '} ${roleNote} ${limitNote} ${metaStatusText()}`;

}

async function openDeal(id) {
  const deal = state.deals.find((d) => String(d.ID) === String(id)) || await bxCall('crm.deal.get', { id });
  await ensureDealMeta(id);
  state.selectedDeal = deal;
  state.selectedAnalysis = '';
  state.selectedMissing = [];
  state.selectedAudit = null;
  state.selectedMode = '';
  document.getElementById('dialog-title').textContent = deal.TITLE || `Сделка ${id}`;
  document.getElementById('analysis-result').classList.add('hidden');
  hideActionButtons();
  state.selectedDeadlineTasks = [];
  document.getElementById('deal-details').innerHTML = detailHtml(deal);
  document.getElementById('deal-dialog').showModal();
}

function detailHtml(deal) {
  const next = nextStep(deal.ID);
  const fields = [
    ['Компания', companyName(deal.COMPANY_ID)],
    ['Контакт', contactName(deal.CONTACT_ID)],
    ['Услуга', getService(deal) || '—'],
    ['Стадия', `${stageName(deal.STAGE_ID)} (${deal.STAGE_ID || '—'})`],
    ['Воронка ID', deal.CATEGORY_ID ?? '0'],
    ['Сумма', formatMoney(deal.OPPORTUNITY)],
    ['Дата начала оказания услуг', formatDate(getStartDate(deal)) || '—'],
    ['Ответственный', userName(deal.ASSIGNED_BY_ID)],
    ['Кто создал сделку', userName(deal.CREATED_BY_ID)],
    ['Ссылка на сделку отдела продаж', getSalesLink(deal) || '—'],
    ['Проверка передачи', stripHtml(auditLabel(getAudit(deal.ID)))],
    ['Следующее дело/задача', next ? `${formatDate(next.date)} — ${next.kind}: ${next.title || ''}` : 'нет открытого дела/задачи'],
  ];
  return fields.map(([k, v]) => `<div class="detail"><span>${escapeHtml(k)}</span>${escapeHtml(v)}</div>`).join('');
}

async function checkHandoff() {
  if (!state.selectedDeal) return;
  const deal = state.selectedDeal;
  const production = await collectDealContext(deal.ID, deal, 'производственная сделка');

  let sales = null;
  let salesDealObj = null;
  const salesId = extractDealId(getSalesLink(deal) || contextToText(production));
  if (salesId && String(salesId) !== String(deal.ID)) {
    try {
      const salesDeal = await bxCall('crm.deal.get', { id: salesId });
      salesDealObj = salesDeal;
      const salesManagerId = String(salesDeal.ASSIGNED_BY_ID || salesDeal.CREATED_BY_ID || '');
      if (salesManagerId) await ensureUserCached(salesManagerId);
      state.salesDealByProduction.set(String(deal.ID), {
        salesId: String(salesId),
        managerId: salesManagerId,
        source: 'ответственный в связанной сделке продаж',
        title: salesDeal.TITLE || '',
        salesAssignedById: String(salesDeal.ASSIGNED_BY_ID || ''),
        salesCreatedById: String(salesDeal.CREATED_BY_ID || ''),
      });
      sales = await collectDealContext(salesId, salesDeal, 'связанная сделка продаж');
    } catch (e) {
      sales = { dealId: salesId, label: 'связанная сделка продаж', sections: [{ source: 'ошибка открытия сделки продаж', text: `Не удалось открыть сделку продаж ID ${salesId}: ${e.message}` }] };
    }
  }

  const contexts = sales ? [production, sales] : [production];
  const results = REQUIRED_ITEMS.map((item) => analyzeRequirement(item, contexts, deal));
  const found = results.filter((r) => r.status === 'found');
  const uncertain = results.filter((r) => r.status === 'uncertain');
  const missing = results.filter((r) => r.status === 'missing');

  const noOpen = !hasNextStep(deal.ID);
  const technicalMissing = [];
  if (noOpen) technicalMissing.push({ label: 'нет открытого дела/задачи / следующего шага в Bitrix', why: 'сделка может зависнуть без контрольного действия' });
  if (!getSalesLink(deal)) technicalMissing.push({ label: 'нет ссылки на исходную сделку отдела продаж', why: 'сложнее сверить обещания продаж, КП и договорённости' });

  const criticalMisses = missing.filter((r) => CRITICAL_KEYS.has(r.key));
  const criticalUncertain = uncertain.filter((r) => CRITICAL_KEYS.has(r.key));
  const status = criticalMisses.length || technicalMissing.length
    ? 'есть ошибки передачи'
    : criticalUncertain.length || uncertain.length
      ? 'частично готова, нужно подтвердить спорные пункты'
      : 'готова к производству';

  const risks = buildRisks({ missing, uncertain, technicalMissing });
  const actionItems = [...missing.map((r) => r.label), ...uncertain.map((r) => `${r.label} — подтвердить`), ...technicalMissing.map((r) => r.label)];
  state.selectedMode = 'handoff';
  state.selectedMissing = actionItems;
  state.selectedAudit = buildAuditPayload({ deal, status, found, uncertain, missing, technicalMissing, salesId, salesDeal: salesDealObj });
  state.selectedAnalysis = formatAnalysisV3({ status, found, uncertain, missing, technicalMissing, risks, deal, salesId });

  const out = document.getElementById('analysis-result');
  out.innerHTML = renderHandoffResultHtml({ status, found, uncertain, missing, technicalMissing, risks, deal, salesId });
  out.classList.remove('hidden');
  document.getElementById('write-comment').classList.remove('hidden');
  document.getElementById('create-manager-task').classList.toggle('hidden', !actionItems.length);
  document.getElementById('create-expert-task').classList.remove('hidden');
  document.getElementById('mark-checked').classList.remove('hidden');
  document.getElementById('create-workplan-tasks').classList.add('hidden');
  document.getElementById('create-deadline-tasks').classList.add('hidden');
  document.getElementById('create-ai-tasks').classList.add('hidden');
}



function buildAuditPayload({ deal, status, found, uncertain, missing, technicalMissing, salesId, salesDeal }) {
  const statusCode = /есть ошибки/i.test(status) ? 'error' : /частично|подтверд/i.test(status) ? 'partial' : 'ok';
  return {
    version: 1,
    dealId: String(deal.ID),
    statusCode,
    status,
    checkedAt: new Date().toISOString(),
    checkedById: String(state.user.ID),
    checkedByName: `${state.user.NAME || ''} ${state.user.LAST_NAME || ''}`.trim(),
    missing: missing.map((x) => x.label),
    uncertain: uncertain.map((x) => x.label),
    technical: (technicalMissing || []).map((x) => x.label),
    foundCount: found.length,
    salesDealId: salesId ? String(salesId) : '',
    salesDealTitle: salesDeal && salesDeal.TITLE ? String(salesDeal.TITLE) : '',
    salesManagerId: salesDeal ? String(salesDeal.ASSIGNED_BY_ID || salesDeal.CREATED_BY_ID || '') : '',
  };
}

function auditMarker(audit) {
  return `\n\n---\nСлужебная метка ассистента: ${AUDIT_TAG}:${JSON.stringify(audit)}`;
}

async function collectDealContext(id, deal, label) {
  const sections = [];
  sections.push({ source: `${label}: поля сделки`, text: summarizeDealFields(id, deal) });

  try {
    const products = await bxCall('crm.deal.productrows.get', { id });
    const text = Array.isArray(products) && products.length
      ? products.map((p) => `${p.PRODUCT_NAME || p.PRODUCT_ID || 'товар'}; количество ${p.QUANTITY || ''}; цена ${p.PRICE || ''}`).join('\n')
      : 'товары не заполнены';
    sections.push({ source: `${label}: товары/услуги`, text });
  } catch (e) {
    sections.push({ source: `${label}: товары/услуги`, text: `недоступны: ${e.message}` });
  }

  try {
    const comments = await bxList('crm.timeline.comment.list', { filter: { ENTITY_ID: id, ENTITY_TYPE: 'deal' }, order: { ID: 'DESC' } }, 50);
    const text = comments.map((c) => stripHtml(`${c.CREATED || c.DATE_CREATE || ''}: ${c.COMMENT || c.TEXT || ''}`)).filter(Boolean).join('\n');
    sections.push({ source: `${label}: комментарии`, text: text || 'комментариев нет' });
  } catch (e) {
    sections.push({ source: `${label}: комментарии`, text: `недоступны: ${e.message}` });
  }

  try {
    const acts = await bxList('crm.activity.list', { filter: { OWNER_ID: id, OWNER_TYPE_ID: 2 }, order: { ID: 'DESC' }, select: ['ID','SUBJECT','DESCRIPTION','CREATED','DEADLINE','TYPE_ID','PROVIDER_ID','COMPLETED'] }, 50);
    const text = acts.map((a) => stripHtml(`${a.CREATED || ''}: ${a.SUBJECT || ''}. ${a.DESCRIPTION || ''}. Дедлайн ${a.DEADLINE || ''}. Завершено ${a.COMPLETED || ''}. Провайдер ${a.PROVIDER_ID || ''}`)).filter(Boolean).join('\n');
    sections.push({ source: `${label}: дела/активности`, text: text || 'дел/активностей нет' });
  } catch (e) {
    sections.push({ source: `${label}: дела/активности`, text: `недоступны: ${e.message}` });
  }

  return { dealId: id, label, sections };
}

function summarizeDealFields(id, deal) {
  const company = state.companies.get(String(deal.COMPANY_ID)) || {};
  const contact = state.contacts.get(String(deal.CONTACT_ID)) || {};
  const pieces = [
    `Сделка ID ${id}: ${deal.TITLE || ''}`,
    `Компания: ${companyName(deal.COMPANY_ID)}`,
    `Контакт: ${contactName(deal.CONTACT_ID)}`,
    `Услуга: ${getService(deal) || ''}`,
    `Стадия: ${stageName(deal.STAGE_ID)} (${deal.STAGE_ID || ''})`,
    `Сумма: ${deal.OPPORTUNITY || ''}`,
    `Дата начала оказания услуг: ${getStartDate(deal) || ''}`,
    `Ответственный: ${userName(deal.ASSIGNED_BY_ID)}`,
    `Создал сделку: ${userName(deal.CREATED_BY_ID)}`,
    `Ссылка на сделку отдела продаж: ${getSalesLink(deal) || ''}`,
    `Компания адрес: ${company.ADDRESS || ''} ${company.ADDRESS_CITY || ''} ${company.ADDRESS_REGION || ''} ${company.ADDRESS_PROVINCE || ''}`,
    `Компания email: ${extractMultiField(company.EMAIL)}`,
    `Компания телефон: ${extractMultiField(company.PHONE)}`,
    `Контакт email: ${extractMultiField(contact.EMAIL)}`,
    `Контакт телефон: ${extractMultiField(contact.PHONE)}`,
  ];
  return pieces.filter((x) => String(x).trim() && !String(x).endsWith(': ')).join('\n');
}

function analyzeRequirement(item, contexts, deal) {
  const direct = directEvidence(item, deal, contexts);
  if (direct) return { ...direct, key: item.key, label: item.label, why: item.why };

  const exact = findEvidence(contexts, item.exact || []);
  if (exact) return { key: item.key, label: item.label, why: item.why, status: 'found', source: exact.source, snippet: exact.snippet };

  const weak = findEvidence(contexts, item.weak || []);
  if (weak) return { key: item.key, label: item.label, why: item.why, status: 'uncertain', source: weak.source, snippet: weak.snippet };

  return { key: item.key, label: item.label, why: item.why, status: 'missing' };
}

function directEvidence(item, deal, contexts) {
  if (item.key === 'service' && getService(deal)) {
    return { status: 'found', source: 'поле “Услуга” производственной сделки', snippet: getService(deal) };
  }
  if (item.key === 'email') {
    const evidence = findEvidence(contexts, [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i]);
    if (evidence) return { status: 'found', source: evidence.source, snippet: evidence.snippet };
  }
  if (item.key === 'kp') {
    const productEvidence = findEvidence(contexts.filter((c) => c.sections.some((s) => s.source.includes('товары'))), [/./]);
    if (productEvidence && !/товары не заполнены|недоступны/i.test(productEvidence.snippet)) {
      const kpEvidence = findEvidence(contexts, item.exact || []);
      if (kpEvidence) return { status: 'found', source: kpEvidence.source, snippet: kpEvidence.snippet };
    }
  }
  return null;
}

function findEvidence(contexts, patterns) {
  for (const ctx of contexts) {
    for (const section of ctx.sections || []) {
      const text = section.text || '';
      if (!text || /недоступны|комментариев нет|дел\/активностей нет/i.test(text)) continue;
      for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match) {
          return { source: section.source, snippet: makeSnippet(text, match.index || 0, match[0]) };
        }
      }
    }
  }
  return null;
}

function contextToText(ctx) {
  return (ctx.sections || []).map((s) => `${s.source}\n${s.text}`).join('\n\n');
}

function makeSnippet(text, index, hit) {
  const start = Math.max(0, index - 100);
  const end = Math.min(text.length, index + String(hit || '').length + 140);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function buildRisks({ missing, uncertain, technicalMissing }) {
  const risks = [];
  if (missing.length) risks.push('эксперту придётся повторно уточнять базовую информацию у клиента');
  if (missing.some((r) => r.key === 'fees') || uncertain.some((r) => r.key === 'fees')) risks.push('возможен конфликт по пошлинам или дополнительным счетам');
  if (missing.some((r) => r.key === 'terms') || uncertain.some((r) => r.key === 'terms')) risks.push('есть риск расхождения между обещанными сроками и фактическим производством');
  if (missing.some((r) => ['specialists', 'transfer', 'searching'].includes(r.key))) risks.push('может зависнуть кадровый блок по специалистам');
  if (missing.some((r) => r.key === 'measurements') || uncertain.some((r) => r.key === 'measurements')) risks.push('для СТК/периодики может сорваться подача из-за средств измерений');
  if (technicalMissing.length) risks.push('в Bitrix не зафиксирован следующий шаг или связь с продажной сделкой');
  return risks.length ? risks : ['критичных рисков передачи по найденным данным не выявлено'];
}


function resultStatusClass(status) {
  const s = normalize(status);
  if (s.includes('ошиб')) return 'error';
  if (s.includes('частично') || s.includes('подтверд')) return 'partial';
  return 'ok';
}
function listHtml(items, emptyText, renderer) {
  if (!items || !items.length) return `<p class="muted">${escapeHtml(emptyText)}</p>`;
  return `<ul>${items.map((x) => `<li>${renderer ? renderer(x) : escapeHtml(String(x))}</li>`).join('')}</ul>`;
}
function evidenceHtml(x, mode = 'found') {
  const note = mode === 'uncertain' ? 'найден только косвенный признак' : 'источник';
  const source = x.source ? `<span class="source-note">${escapeHtml(note)}: ${escapeHtml(x.source)}</span>` : '';
  const snippet = x.snippet ? `<span class="source-note">фрагмент: “${escapeHtml(x.snippet)}”</span>` : '';
  return `<strong>${escapeHtml(x.label)}</strong>${source}${snippet}`;
}
function renderHandoffResultHtml({ status, found, uncertain, missing, technicalMissing, risks, deal, salesId }) {
  const technical = technicalMissing || [];
  const statusClass = resultStatusClass(status);
  const needActions = missing.length || uncertain.length || technical.length;
  const actions = needActions
    ? [
        'Менеджеру дозаполнить или подтвердить недостающие данные',
        'Эксперту при первом касании подтвердить спорные пункты',
        'Если проблема повторяется — РОП/руководителю разобрать качество передачи сделки',
      ]
    : [
        'Эксперту сделать первое касание клиента',
        'Зафиксировать ход работы, документы, оплаты, дедлайны и следующий шаг',
      ];
  return `
    <div class="result-header">
      <div class="result-header-title">
        <h3>ИИ-проверка передачи сделки в производство</h3>
        <span class="result-status ${statusClass}">${escapeHtml(status)}</span>
      </div>
      <div class="result-grid">
        <div class="result-field"><span>Сделка</span>${escapeHtml(deal.TITLE || '')}</div>
        <div class="result-field"><span>Компания</span>${escapeHtml(companyName(deal.COMPANY_ID))}</div>
        <div class="result-field"><span>Контакт</span>${escapeHtml(contactName(deal.CONTACT_ID))}</div>
        <div class="result-field"><span>Услуга</span>${escapeHtml(getService(deal) || '—')}</div>
        <div class="result-field"><span>Стадия</span>${escapeHtml(stageName(deal.STAGE_ID))}</div>
        <div class="result-field"><span>Связанная сделка продаж</span>${escapeHtml(salesId ? `ID ${salesId}` : 'не найдена')}</div>
      </div>
    </div>
    <div class="result-card card-found">
      <h3>Найдено точно</h3>
      ${listHtml(found, 'Точных подтверждений пока нет', (x) => evidenceHtml(x, 'found'))}
    </div>
    <div class="result-card card-uncertain">
      <h3>Нужно подтвердить</h3>
      ${listHtml(uncertain, 'Спорных пунктов нет', (x) => evidenceHtml(x, 'uncertain'))}
    </div>
    <div class="result-card card-missing">
      <h3>Не найдено</h3>
      ${listHtml(missing, 'Критичных пробелов не найдено', (x) => `<strong>${escapeHtml(x.label)}</strong><span class="source-note">почему важно: ${escapeHtml(x.why)}</span>`)}
      ${technical.length ? `<h3 style="margin-top:14px">Технически не хватает</h3>${listHtml(technical, '', (x) => `<strong>${escapeHtml(x.label)}</strong><span class="source-note">почему важно: ${escapeHtml(x.why)}</span>`)}` : ''}
    </div>
    <div class="result-card card-risk">
      <h3>Риски</h3>
      ${listHtml(risks, 'Критичных рисков не выявлено')}
    </div>
    <div class="result-card card-action">
      <h3>Что сделать дальше</h3>
      ${listHtml(actions, 'Действий нет')}
    </div>
  `;
}
function renderWorkPlanResultHtml(deal, plainText) {
  const stage = stageName(deal.STAGE_ID);
  const service = getService(deal) || 'услуга не указана';
  const profile = productProfileForDeal(deal);
  const company = companyName(deal.COMPANY_ID);
  const contact = contactName(deal.CONTACT_ID);
  const next = nextStep(deal.ID);
  const nextText = next ? `${formatDate(next.date)} — ${next.kind}: ${next.title || ''}` : 'следующий шаг в Bitrix не запланирован';
  const audit = getAudit(deal.ID) || state.selectedAudit;
  const missing = audit ? [...(audit.missing || []), ...(audit.technical || [])] : [];
  const uncertain = audit ? [...(audit.uncertain || [])] : [];
  const clientName = contact && contact !== '—' ? contact.split(/\s+/)[0] : '[Имя]';
  const message = `${clientName}, добрый день! По вашей услуге “${service}” фиксирую ход работы.\n` +
    `С нашей стороны: ${profile.mavis.slice(0, 2).map((x) => x.charAt(0).toLowerCase() + x.slice(1)).join('; ')}.\n` +
    `С вашей стороны сейчас важно: ${profile.clientSummary}.\n` +
    `Следующий контрольный шаг: ${nextText}.\n` +
    `Если документы, обратная связь или оплата будут задержаны, сроки подачи/получения результата могут сдвинуться.`;
  const clarify = [
    ...(profile.clarify || []).map((x) => `Уточнить по продукту: ${x}`),
    ...missing.map((x) => `Не хватает: ${x}`),
    ...uncertain.map((x) => `Подтвердить: ${x}`),
  ];
  return `
    <div class="result-header">
      <div class="result-header-title"><h3>Черновик хода работы</h3><span class="result-status partial">требует проверки эксперта</span></div>
      <div class="result-grid">
        <div class="result-field"><span>Компания</span>${escapeHtml(company)}</div>
        <div class="result-field"><span>Контакт</span>${escapeHtml(contact)}</div>
        <div class="result-field"><span>Услуга</span>${escapeHtml(service)}</div>
        <div class="result-field"><span>Продуктовая логика</span>${escapeHtml(profile.label)}</div>
        <div class="result-field"><span>Стадия</span>${escapeHtml(stage)}</div>
        <div class="result-field"><span>Дата начала</span>${escapeHtml(formatDate(getStartDate(deal)) || 'не указана')}</div>
        <div class="result-field"><span>Следующий шаг</span>${escapeHtml(nextText)}</div>
      </div>
    </div>
    <div class="result-card card-found"><h3>Что делает MAVIS GROUP</h3>${listHtml(profile.mavis, '')}</div>
    <div class="result-card card-action"><h3>Что нужно от клиента</h3>${listHtml(profile.client, '')}</div>
    <div class="result-card card-checklist"><h3>Чек-лист документов и данных</h3>${listHtml(productDocumentChecklist(profile).clientDocs, '')}</div>
    <div class="result-card card-uncertain"><h3>Что нужно уточнить перед отправкой</h3>${listHtml(clarify, 'Критичных уточнений не зафиксировано')}</div>
    <div class="result-card"><h3>Черновик сообщения клиенту</h3><div class="message-draft">${escapeHtml(message)}</div></div>
    <details class="result-card"><summary><strong>Показать полный текст для комментария</strong></summary><pre class="analysis-pre" style="margin-top:10px">${escapeHtml(plainText)}</pre></details>
  `;
}

function formatAnalysisV3({ status, found, uncertain, missing, technicalMissing, risks, deal, salesId }) {
  const technical = technicalMissing || [];
  return `ИИ-проверка передачи сделки в производство\n\n` +
    `Сделка: ${deal.TITLE || ''}\n` +
    `Компания: ${companyName(deal.COMPANY_ID)}\n` +
    `Контакт: ${contactName(deal.CONTACT_ID)}\n` +
    `Услуга: ${getService(deal) || '—'}\n` +
    `Стадия: ${stageName(deal.STAGE_ID)}\n` +
    `Воронка ID: ${deal.CATEGORY_ID ?? '0'}\n` +
    `Связанная сделка продаж: ${salesId ? `ID ${salesId}` : 'не найдена'}\n\n` +
    `Статус: ${status}\n\n` +
    `Найдено точно:\n${found.length ? found.map((x) => `— ${x.label}; источник: ${x.source}; фрагмент: “${x.snippet}”`).join('\n') : '— нет точных подтверждений'}\n\n` +
    `Нужно подтвердить:\n${uncertain.length ? uncertain.map((x) => `— ${x.label}; найден только косвенный признак; источник: ${x.source}; фрагмент: “${x.snippet}”`).join('\n') : '— нет спорных пунктов'}\n\n` +
    `Не найдено:\n${missing.length ? missing.map((x) => `— ${x.label}; почему важно: ${x.why}`).join('\n') : '— критичных пробелов не найдено'}\n` +
    `${technical.length ? '\nТехнически не хватает:\n' + technical.map((x) => `— ${x.label}; почему важно: ${x.why}`).join('\n') + '\n' : ''}\n` +
    `Риски:\n${risks.map((x) => `— ${x}`).join('\n')}\n\n` +
    `Что нужно сделать:\n` +
    (missing.length || uncertain.length || technical.length
      ? `— менеджеру дозаполнить/подтвердить недостающие данные;\n— эксперту при первом касании подтвердить спорные пункты;\n— если проблема повторяется — РОП/руководителю разобрать качество передачи сделки.`
      : `— эксперту сделать первое касание клиента;\n— зафиксировать ход работы, документы, оплаты, дедлайны и следующий шаг.`);
}

function extractMultiField(value) {
  if (!value) return '';
  if (Array.isArray(value)) return value.map((x) => x.VALUE || x.value || '').filter(Boolean).join(', ');
  return String(value);
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}



function detectProductProfile(service, title = '') {
  const text = normalize([service, title].join(' '));
  const profile = {
    key: 'general',
    label: service || 'услуга',
    mavis: [
      'Проверяет комплектность данных и документов по услуге',
      'Готовит или актуализирует перечень документов и копий',
      'При необходимости заказывает счета, пошлины, техкарты, Стройдок или другие обязательные платежи',
      'Контролирует подготовку, подачу/выезд, замечания и фактическое получение результата',
    ],
    client: [
      'Подтвердить ответственного со стороны клиента',
      'Прислать недостающие документы/данные по перечню эксперта',
      'Оплатить обязательные счета/пошлины и прислать платёжку, если это применимо',
      'Заранее предупредить, если срок по документам или оплате сдвигается',
    ],
    clarify: [
      'точный состав услуги и ожидаемый результат',
      'срок, к которому клиенту нужен результат',
      'кто со стороны клиента отвечает за документы, оплату и связь',
    ],
    firstTask: 'Сформировать перечень документов по услуге',
    paymentRequired: true,
    clientSummary: 'прислать недостающие данные/документы и оплатить обязательные счета/пошлины, если они будут выставлены',
  };

  if (/периодик|подтвержден|подтвержден|подтверждение|подтверд.*стк|подтверд.*спк/.test(text)) {
    return {
      ...profile,
      key: 'stk_periodic',
      label: 'Периодика / подтверждение СТК',
      mavis: [
        'Проверяет действующее свидетельство технической компетентности и сроки подтверждения',
        'Сверяет область технической компетентности, средства измерений, специалистов и изменения с прошлого периода',
        'Готовит перечень актуальных документов/копий и данные для подачи',
        'Контролирует оплату обязательных счетов, подачу и замечания органа',
      ],
      client: [
        'Прислать действующее СТК и документы/копии по перечню эксперта',
        'Подтвердить актуальность специалистов, оборудования и средств измерений',
        'Сообщить, были ли изменения в компании с прошлого подтверждения',
        'Оплатить обязательные счета/пошлины и прислать платёжку',
      ],
      clarify: ['срок окончания/подтверждения СТК', 'актуальная область технической компетентности', 'изменения по специалистам, оборудованию и средствам измерений'],
      firstTask: 'Сформировать перечень документов для периодики/подтверждения СТК',
      clientSummary: 'прислать действующее СТК, подтвердить актуальность специалистов/оборудования/СИ и оплатить обязательные счета',
    };
  }

  if (/\b(спк|стк)\b|свидетельств.*техническ|техническ.*компетент/.test(text)) {
    return {
      ...profile,
      key: 'stk',
      label: 'Свидетельство технической компетентности',
      mavis: [
        'Проверяет исходные данные компании, область технической компетентности и нужный результат',
        'Сверяет специалистов, оборудование, средства измерений и недостающие документы',
        'Готовит перечень копий/документов, заявку и сопроводительные материалы',
        'Контролирует счета/пошлины, подачу, выезд/проверку и замечания органа',
      ],
      client: [
        'Подтвердить нужную область технической компетентности и сроки',
        'Прислать документы/копии по перечню эксперта',
        'Предоставить данные по специалистам, оборудованию и средствам измерений',
        'Оплатить обязательные счета/пошлины и прислать платёжку',
      ],
      clarify: ['нужная область технической компетентности', 'есть ли свои специалисты и средства измерений', 'срок, к которому клиенту нужно получить результат'],
      firstTask: 'Сформировать перечень документов для СТК/СПК',
      clientSummary: 'подтвердить область работ, прислать документы/копии, данные по специалистам и средствам измерений, оплатить обязательные счета',
    };
  }

  if (/аттеста.*специал|специалист/.test(text)) {
    return {
      ...profile,
      key: 'specialist_attestation',
      label: 'Аттестация специалиста',
      mavis: [
        'Проверяет должность, образование, стаж и соответствие специалиста требованиям',
        'Сверяет, подходит ли компания/аттестат организации для зачёта стажа',
        'Готовит перечень документов, заявление и маршрут прохождения аттестации',
        'Контролирует оплату, запись/экзамен, результат и получение документа',
      ],
      client: [
        'Прислать документы специалиста по перечню эксперта',
        'Подтвердить должность, стаж, образование и текущую компанию',
        'Сообщить желаемый срок аттестации/экзамена',
        'Оплатить обязательные счета и прислать подтверждение оплаты',
      ],
      clarify: ['ФИО и должность специалиста', 'образование и стаж', 'направление/вид аттестации и желаемый срок'],
      firstTask: 'Проверить исходные данные специалиста для аттестации',
      clientSummary: 'прислать документы специалиста, подтвердить должность/стаж/образование и оплатить обязательные счета',
    };
  }

  if (/аттеста.*организац|аттеста.*компан|категор/.test(text)) {
    return {
      ...profile,
      key: 'company_attestation',
      label: 'Аттестация организации',
      mavis: [
        'Проверяет категорию/виды работ и требования к компании',
        'Сверяет специалистов, документы компании, опыт и недостающие данные',
        'Готовит перечень документов, заявку и пакет для подачи',
        'Контролирует оплату, подачу, замечания и получение результата',
      ],
      client: [
        'Подтвердить нужную категорию и виды работ',
        'Прислать документы компании и специалистов по перечню',
        'Сообщить желаемый срок получения результата',
        'Оплатить обязательные счета/пошлины и прислать платёжку',
      ],
      clarify: ['категория и виды работ', 'наличие специалистов', 'срок, к которому результат нужен клиенту'],
      firstTask: 'Сформировать перечень документов для аттестации организации',
      clientSummary: 'подтвердить категорию/виды работ, прислать документы компании и специалистов, оплатить обязательные счета',
    };
  }

  if (/iso|9001|45001|суот|охран.*труд/.test(text)) {
    return {
      ...profile,
      key: 'iso',
      label: 'ISO / СУОТ / охрана труда',
      mavis: [
        'Уточняет стандарт и цель сертификата: тендер, объект, контрагент или внутренний запрос',
        'Собирает исходные данные по компании, деятельности, штату и процессам',
        'Готовит комплект документов/систему и согласует маршрут сертификации',
        'Контролирует оплату, аудит/проверку, замечания и получение сертификата',
      ],
      client: [
        'Подтвердить нужный стандарт и цель получения сертификата',
        'Прислать данные по компании, видам деятельности, штату и процессам',
        'Согласовать сроки подготовки и проверки',
        'Оплатить обязательные счета и прислать подтверждение оплаты',
      ],
      clarify: ['какой стандарт нужен: ISO 9001 / ISO 45001 / СУОТ / другое', 'для чего нужен сертификат и к какому сроку', 'есть ли действующие документы/система'],
      firstTask: 'Собрать исходные данные для ISO/СУОТ',
      clientSummary: 'подтвердить стандарт и цель сертификата, прислать данные по компании/процессам и согласовать сроки',
    };
  }

  if (/подбор|специалист.*подбор|ищет|найти/.test(text)) {
    return {
      ...profile,
      key: 'recruiting',
      label: 'Подбор специалиста',
      mavis: [
        'Уточняет требуемую должность, квалификацию, документы и сроки выхода специалиста',
        'Фиксирует условия клиента: формат, занятость, регион, оплата, требования к опыту',
        'Передаёт задачу на подбор и контролирует статус кандидатов',
        'Фиксирует договорённости по переводу/оформлению специалиста и следующему контакту',
      ],
      client: [
        'Подтвердить, кого именно нужно подобрать и к какому сроку',
        'Передать требования к специалисту, документам, опыту и формату работы',
        'Оперативно давать обратную связь по кандидатам',
        'Сообщить, если параллельно ищут специалиста самостоятельно',
      ],
      clarify: ['кого ищем', 'требования к специалисту', 'срок и формат выхода', 'условия оплаты/занятости'],
      firstTask: 'Зафиксировать требования к подбору специалиста',
      paymentRequired: false,
      clientSummary: 'подтвердить требования к специалисту, сроки, формат работы и быстро давать обратную связь по кандидатам',
    };
  }

  return profile;
}


function productDocumentChecklist(profile) {
  const key = profile.key || 'general';
  const base = {
    clientDocs: [
      'Карточка компании / реквизиты и актуальные контактные данные',
      'Документы и данные по перечню эксперта для выбранной услуги',
      'Подтверждение ответственного со стороны клиента и канала связи',
      'Платёжные документы по обязательным счетам/пошлинам, если применимо',
    ],
    mavisChecks: [
      'Проверить, что услуга и результат совпадают с ожиданием клиента',
      'Сверить срок, который был обещан клиенту продажами',
      'Проверить наличие следующего дела/задачи в Bitrix',
      'Зафиксировать недостающие данные в комментарии сделки',
    ],
    riskControls: [
      'Если нет документов или оплаты — предупредить клиента, что сроки могут сдвинуться',
      'Если есть спорные обещания продаж — передать РОП/руководителю экспертного отдела',
      'Если клиент не отвечает 2 дня — поставить задачу на звонок и уведомить руководителя',
    ],
  };

  if (key === 'stk' || key === 'stk_periodic') {
    return {
      clientDocs: [
        'Реквизиты компании и актуальные контактные данные ответственного',
        'Текующее свидетельство технической компетентности, если это подтверждение/периодика',
        'Нужная область технической компетентности / виды работ',
        'Перечень специалистов, которые закрывают область работ',
        'Документы по специалистам: дипломы, трудовые, удостоверения, аттестаты — по перечню эксперта',
        'Данные по оборудованию и средствам измерений',
        'Документы по средствам измерений: поверка/калибровка/аренда/право использования — если применимо',
        'Подтверждение оплаты счетов/пошлин/дополнительных обязательных платежей',
      ],
      mavisChecks: [
        'Сверить область технической компетентности с проданной услугой',
        'Проверить, хватает ли специалистов под заявленную область',
        'Проверить средства измерений и сроки их поверки/действия',
        'Сформировать перечень копий и документов для клиента',
        'Поставить контроль оплаты счетов/пошлин и даты подачи/выезда',
      ],
      riskControls: [
        'Нет средств измерений или поверки — риск переноса подачи/выезда',
        'Нет нужных специалистов — риск невозможности закрыть область работ',
        'Клиент не предупреждён о пошлинах/доп. счетах — риск конфликта по оплате',
      ],
    };
  }

  if (key === 'company_attestation') {
    return {
      clientDocs: [
        'Реквизиты компании и данные ответственного лица',
        'Нужная категория и виды работ для аттестации',
        'Учредительные/регистрационные данные компании — по перечню эксперта',
        'Документы по специалистам, закрывающим требования по категории',
        'Информация по опыту/объектам/договорам, если требуется для категории',
        'Подтверждение оплаты обязательных счетов/пошлин',
      ],
      mavisChecks: [
        'Сверить категорию и виды работ с проданной услугой',
        'Проверить, хватает ли специалистов и документов под категорию',
        'Проверить сроки и обещания продаж по получению результата',
        'Подготовить перечень документов и маршрут подачи',
      ],
      riskControls: [
        'Категория/виды работ не подтверждены — риск подготовки не того пакета',
        'Не хватает специалистов — риск отказа/замечаний',
        'Нет подтверждения сроков — риск некорректных ожиданий клиента',
      ],
    };
  }

  if (key === 'specialist_attestation') {
    return {
      clientDocs: [
        'ФИО специалиста и должность, на которую нужна аттестация',
        'Документ об образовании специалиста',
        'Трудовая книжка / сведения о стаже',
        'Данные по текущему месту работы и должности',
        'Действующие удостоверения/аттестаты, если есть',
        'Фото/заявление/дополнительные формы — по перечню эксперта',
        'Подтверждение оплаты обязательных счетов',
      ],
      mavisChecks: [
        'Проверить образование и стаж под нужную должность',
        'Проверить, засчитывается ли стаж в строительной компании и по нужной должности',
        'Проверить наличие действующей аттестации организации, если она влияет на зачёт стажа',
        'Зафиксировать дату экзамена/подачи/получения результата',
      ],
      riskControls: [
        'Непрофильное образование или недостаточный стаж — риск отказа/переноса',
        'Нет подтверждения должности — риск незачёта стажа',
        'Не согласована дата экзамена — риск срыва срока клиента',
      ],
    };
  }

  if (key === 'iso') {
    return {
      clientDocs: [
        'Реквизиты компании и данные ответственного лица',
        'Какой стандарт нужен: ISO 9001 / ISO 45001 / СУОТ / другой',
        'Цель получения сертификата: тендер, объект, контрагент, внутренний запрос',
        'Виды деятельности компании и численность сотрудников',
        'Данные по процессам/структуре компании — по перечню эксперта',
        'Действующие документы системы менеджмента, если есть',
        'Подтверждение оплаты обязательных счетов',
      ],
      mavisChecks: [
        'Сверить стандарт и цель сертификата с проданной услугой',
        'Проверить срочность и срок, к которому сертификат нужен клиенту',
        'Определить, нужен ли аудит/выезд/дополнительные документы',
        'Согласовать маршрут подготовки и получения сертификата',
      ],
      riskControls: [
        'Неясна цель сертификата — риск выбрать неверный стандарт/орган',
        'Нет данных по процессам — риск задержки подготовки документов',
        'Сжатый срок тендера — риск не успеть без ускоренного маршрута',
      ],
    };
  }

  if (key === 'recruiting') {
    return {
      clientDocs: [
        'Кого нужно подобрать: должность, квалификация, категория/аттестация',
        'Требования к опыту, документам и региону',
        'Формат занятости и срок выхода специалиста',
        'Условия оплаты/оформления/перевода специалиста',
        'Кто принимает решение по кандидатам со стороны клиента',
      ],
      mavisChecks: [
        'Зафиксировать требования к специалисту в сделке',
        'Понять, ищет ли клиент сам параллельно',
        'Поставить контроль обратной связи по кандидатам',
        'Зафиксировать договорённости по переводу/оформлению',
      ],
      riskControls: [
        'Нет требований к специалисту — риск подбора неподходящих кандидатов',
        'Нет быстрого ЛПР — риск зависания кандидатов',
        'Клиент ищет сам параллельно — риск потери сделки без контроля',
      ],
    };
  }

  return base;
}

function productProfileForDeal(deal) {
  return detectProductProfile(getService(deal) || '', deal.TITLE || '');
}

function productBullets(title, items) {
  return `${title}:\n${items.map((x) => `— ${x}`).join('\n')}`;
}

function stageWorkPlanAdvice(stage) {
  const s = normalize(stage);
  if (/эксперт назначен/.test(s)) return 'провести первое касание, подтвердить состав услуги, документы, оплаты, сроки и следующий шаг';
  if (/сбор информации/.test(s)) return 'собрать недостающие данные и документы, поставить клиенту понятный дедлайн';
  if (/заявка подана/.test(s)) return 'контролировать поданную заявку, оплату обязательных счетов и следующий срок реакции';
  if (/подбор/.test(s)) return 'зафиксировать, кого ищет клиент, кого подбирает MAVIS, и какой дедлайн по специалистам';
  if (/обучение/.test(s)) return 'контролировать обучение/подготовку специалиста и следующий контрольный срок';
  if (/передан оформителю/.test(s)) return 'проверить, что оформитель получил все данные, и назначить контроль готовности пакета';
  if (/документы готовы/.test(s)) return 'сверить готовый пакет, отправить клиенту инструкции по подписи/копиям и зафиксировать дату передачи';
  if (/выезд|подач/.test(s)) return 'подтвердить дату выезда/подачи, готовность документов, оплат и ответственных лиц';
  if (/проверка органом/.test(s)) return 'контролировать статус проверки органом и заранее подготовить действия на случай замечаний';
  if (/устранение замечан/.test(s)) return 'зафиксировать замечания, причину, ответственного и дедлайн устранения';
  if (/работа с возвратом|возврат/.test(s)) return 'передать ситуацию руководителю, собрать факты из КП, звонков и переписки';
  return 'зафиксировать текущий статус, следующий шаг, ответственного и дедлайн';
}

function buildWorkPlanText(deal) {
  const stage = stageName(deal.STAGE_ID);
  const service = getService(deal) || 'услуга не указана';
  const profile = productProfileForDeal(deal);
  const company = companyName(deal.COMPANY_ID);
  const contact = contactName(deal.CONTACT_ID);
  const next = nextStep(deal.ID);
  const audit = getAudit(deal.ID) || state.selectedAudit;
  const missing = audit ? [...(audit.missing || []), ...(audit.technical || [])] : [];
  const uncertain = audit ? [...(audit.uncertain || [])] : [];
  const clientName = contact && contact !== '—' ? contact.split(/\s+/)[0] : '[Имя]';
  const nextText = next ? `${formatDate(next.date)} — ${next.kind}: ${next.title || ''}` : 'следующий шаг в Bitrix не запланирован';
  const dateStart = formatDate(getStartDate(deal)) || 'не указана';
  const advice = stageWorkPlanAdvice(stage);
  const productClarify = profile.clarify || [];
  const riskBlock = missing.length || uncertain.length || productClarify.length
    ? `\nЧто нужно уточнить/закрыть перед отправкой клиенту:\n` +
      `${productClarify.map((x) => `— уточнить по продукту: ${x}`).join('\n')}` +
      `${productClarify.length && (missing.length || uncertain.length) ? '\n' : ''}` +
      `${missing.map((x) => `— не хватает: ${x}`).join('\n')}` +
      `${missing.length && uncertain.length ? '\n' : ''}` +
      `${uncertain.map((x) => `— подтвердить: ${x}`).join('\n')}`
    : '\nКритичных пробелов по передаче сделки в текущей проверке не зафиксировано.';

  return `Черновик хода работы по сделке\n\n` +
    `Компания: ${company}\n` +
    `Контакт: ${contact}\n` +
    `Сделка: ${deal.TITLE || ''} / ID ${deal.ID}\n` +
    `Услуга: ${service}\n` +
    `Продуктовая логика: ${profile.label}\n` +
    `Стадия производства: ${stage}\n` +
    `Дата начала оказания услуг: ${dateStart}\n` +
    `Ответственный эксперт: ${userName(deal.ASSIGNED_BY_ID)}\n` +
    `Следующее дело/задача: ${nextText}\n\n` +
    `Логика текущего этапа:\n— ${advice}.\n\n` +
    productBullets('Что делает MAVIS GROUP', profile.mavis) + `\n\n` +
    productBullets('Что нужно от клиента', profile.client) + `\n\n` +
    productBullets('Чек-лист документов и данных', productDocumentChecklist(profile).clientDocs) + `\n\n` +
    productBullets('Что проверяет эксперт внутри MAVIS', productDocumentChecklist(profile).mavisChecks) + `\n` +
    `${riskBlock}\n\n` +
    `Черновик сообщения клиенту в мессенджер:\n` +
    `${clientName}, добрый день! По вашей услуге “${service}” фиксирую ход работы.\n` +
    `С нашей стороны: ${profile.mavis.slice(0, 2).map((x) => x.charAt(0).toLowerCase() + x.slice(1)).join('; ')}.\n` +
    `С вашей стороны сейчас важно: ${profile.clientSummary}.\n` +
    `Следующий контрольный шаг: ${nextText}.\n` +
    `Если документы, обратная связь или оплата будут задержаны, сроки подачи/получения результата могут сдвинуться.\n\n` +
    `Комментарий для карточки сделки:\n` +
    `Ход работы сформирован ассистентом. Продуктовая логика: ${profile.label}. Текущий этап: ${stage}. Следующий шаг: ${nextText}. Эксперту нужно подтвердить с клиентом документы, оплаты, дедлайны и зафиксировать итог первого/следующего касания.`;
}


async function buildAIContext(deal) {
  const product = productProfileForDeal(deal);
  const checklist = productDocumentChecklist(product);
  const audit = getAudit(deal.ID) || state.selectedAudit || null;
  const production = await collectDealContext(deal.ID, deal, 'производственная сделка');

  let sales = null;
  let salesDeal = null;
  const salesId = getSalesDealId(deal) || extractDealId(contextToText(production));
  if (salesId && String(salesId) !== String(deal.ID)) {
    try {
      salesDeal = await bxCall('crm.deal.get', { id: salesId });
      sales = await collectDealContext(salesId, salesDeal, 'связанная сделка продаж');
      const managerId = String(salesDeal.ASSIGNED_BY_ID || salesDeal.CREATED_BY_ID || '');
      if (managerId) await ensureUserCached(managerId);
    } catch (e) {
      sales = { dealId: salesId, label: 'связанная сделка продаж', sections: [{ source: 'ошибка загрузки', text: e.message }] };
    }
  }

  const acts = state.activitiesByDeal.get(String(deal.ID)) || [];
  const tasks = state.tasksByDeal.get(String(deal.ID)) || [];
  return {
    deal: {
      id: String(deal.ID),
      title: deal.TITLE || '',
      company: companyName(deal.COMPANY_ID),
      contact: contactName(deal.CONTACT_ID),
      service: getService(deal) || '',
      stage: stageName(deal.STAGE_ID),
      stageCode: deal.STAGE_ID || '',
      sum: deal.OPPORTUNITY || '',
      startDate: getStartDate(deal) || '',
      expert: userName(deal.ASSIGNED_BY_ID),
      createdBy: userName(deal.CREATED_BY_ID),
      salesDealLink: getSalesLink(deal) || '',
      salesDealId: salesId || '',
      salesManager: salesDeal ? userName(salesDeal.ASSIGNED_BY_ID || salesDeal.CREATED_BY_ID) : '',
      nextStep: nextStep(deal.ID) ? `${formatDate(nextStep(deal.ID).date)} — ${nextStep(deal.ID).kind}: ${nextStep(deal.ID).title || ''}` : '',
      lastWorkDate: formatDate(lastWorkDate(deal)) || '',
    },
    currentAudit: audit ? {
      status: auditLabel(audit),
      missing: audit.missing || [],
      uncertain: audit.uncertain || [],
      technical: audit.technical || [],
      checkedAt: audit.checkedAt || '',
    } : null,
    product: {
      key: product.key,
      label: product.label,
      mavisActions: product.mavis || [],
      clientActions: product.client || [],
      clarify: product.clarify || [],
    },
    checklist,
    openActivities: acts.slice(0, 20).map((a) => ({ subject: a.SUBJECT || '', deadline: a.DEADLINE || '', completed: a.COMPLETED || '', type: a.PROVIDER_ID || a.TYPE_ID || '' })),
    openTasks: tasks.slice(0, 20).map((t) => ({ title: (t.title || t.TITLE || ''), deadline: (t.deadline || t.DEADLINE || ''), status: (t.status || t.STATUS || '') })),
    contexts: { production, sales },
  };
}

function aiStatusClass(status) {
  if (status === 'ok') return 'ok';
  if (status === 'risk' || status === 'error') return 'error';
  return 'partial';
}

function aiResultToComment(deal, ai) {
  const r = ai.result || ai;
  const tasks = (r.tasks || []).map((t) => `— ${t.title}${t.deadline_hint ? ` (${t.deadline_hint})` : ''}: ${t.description || ''}`).join('\n') || '— нет';
  return `ИИ-анализ сделки\n\nСделка: ${deal.TITLE || ''} / ID ${deal.ID}\nКомпания: ${companyName(deal.COMPANY_ID)}\nУслуга: ${getService(deal) || 'не указана'}\nСтатус: ${r.status_label || r.status || 'нужна проверка'}\n\nЧто понятно:\n${(r.summary || []).map((x) => `— ${x}`).join('\n') || '— нет'}\n\nЧего не хватает / уточнить:\n${(r.missing || []).map((x) => `— ${x}`).join('\n') || '— нет'}\n\nРиски:\n${(r.risks || []).map((x) => `— ${x}`).join('\n') || '— нет'}\n\nСледующие действия:\n${(r.next_steps || []).map((x) => `— ${x}`).join('\n') || '— нет'}\n\nРекомендуемые задачи:\n${tasks}\n\nЧерновик сообщения клиенту:\n${r.client_message || '—'}\n\nКомментарий ИИ:\n${r.comment || '—'}\n\nВажно: это черновик ИИ. Эксперт должен проверить вывод перед отправкой клиенту или постановкой задач.`;
}

function renderAIAnalysisHtml(deal, ai) {
  const r = ai.result || ai;
  const title = ai.scenario_label || ai.title || 'ИИ-анализ сделки';
  const tasks = (r.tasks || []).map((t) => `${t.title}${t.responsible ? ` — ${t.responsible}` : ''}${t.deadline_hint ? `, ${t.deadline_hint}` : ''}${t.description ? `<span class="source-note">${escapeHtml(t.description)}</span>` : ''}`);
  return `
    <div class="result-header">
      <div class="result-header-title"><h3>${escapeHtml(title)}</h3><span class="result-status ${aiStatusClass(r.status)}">${escapeHtml(r.status_label || r.status || 'нужна проверка')}</span></div>
      <div class="result-grid">
        <div class="result-field"><span>Компания</span>${escapeHtml(companyName(deal.COMPANY_ID))}</div>
        <div class="result-field"><span>Услуга</span>${escapeHtml(getService(deal) || '—')}</div>
        <div class="result-field"><span>Стадия</span>${escapeHtml(stageName(deal.STAGE_ID))}</div>
        <div class="result-field"><span>Модель</span>${escapeHtml(ai.model || APP_CONFIG.aiModel || 'AI')}</div>
      </div>
    </div>
    <div class="result-card card-found"><h3>Что понятно по сделке</h3>${listHtml(r.summary || [], 'ИИ не вернул краткое резюме')}</div>
    <div class="result-card card-uncertain"><h3>Чего не хватает / что уточнить</h3>${listHtml(r.missing || [], 'Критичных уточнений не найдено')}</div>
    <div class="result-card card-risk"><h3>Риски</h3>${listHtml(r.risks || [], 'Критичных рисков не найдено')}</div>
    <div class="result-card card-action"><h3>Следующие действия эксперта</h3>${listHtml(r.next_steps || [], 'Следующие действия не определены')}</div>
    <div class="result-card card-checklist"><h3>Рекомендуемые задачи</h3>${listHtml(tasks, 'ИИ не предложил отдельные задачи')}</div>
    <div class="result-card"><h3>Черновик сообщения клиенту</h3><div class="message-draft">${escapeHtml(r.client_message || '—')}</div></div>
    <details class="result-card"><summary><strong>Показать полный текст для комментария</strong></summary><div class="message-draft">${escapeHtml(aiResultToComment(deal, ai))}</div></details>
    <p class="muted small-note">ИИ ничего не отправляет клиенту и не создаёт задачи автоматически. Сначала эксперт проверяет результат. После проверки можно отметить, что вывод верный, или оставить правку — это сохранится в сделке для обучения и контроля качества.</p>
  `;
}


function aiResponsibleId(deal, responsible) {
  const role = String(responsible || '').toLowerCase();
  if (role.includes('manager')) {
    const sales = state.salesDealByProduction.get(String(deal.ID));
    return sales && sales.managerId ? sales.managerId : (deal.CREATED_BY_ID || deal.ASSIGNED_BY_ID);
  }
  if (role.includes('leader') || role.includes('rop') || role.includes('руковод')) {
    const leader = (APP_CONFIG.escalationResponsibleId || (APP_CONFIG.leaderUserIds || [])[0] || (APP_CONFIG.ropUserIds || [])[0] || deal.ASSIGNED_BY_ID);
    return leader;
  }
  return deal.ASSIGNED_BY_ID;
}

function deadlineFromAIHint(hint) {
  const text = normalize(hint || '');
  if (!text) return deadlineTomorrow(12);
  if (text.includes('1 час') || text.includes('час')) return deadlineInHours(1);
  if (text.includes('сегодня') || text.includes('до конца дня')) return deadlineTodayEnd();
  if (text.includes('завтра') || text.includes('следующий рабочий')) return deadlineTomorrow(12);
  if (text.includes('2 дня') || text.includes('двух дней')) {
    const d = new Date();
    d.setDate(d.getDate() + 2);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  }
  return deadlineTomorrow(12);
}

function buildAITasks(deal, aiPayload) {
  const result = aiPayload && aiPayload.result ? aiPayload.result : aiPayload;
  const rawTasks = Array.isArray(result && result.tasks) ? result.tasks : [];
  return rawTasks
    .map((t) => {
      const title = String(t.title || '').trim();
      if (!title) return null;
      const role = String(t.responsible || 'expert').trim();
      const deadline = deadlineFromAIHint(t.deadline_hint || '');
      const description = `Задача предложена ИИ-ассистентом по сделке “${deal.TITLE || ''}”.\n\nУслуга: ${getService(deal) || 'не указана'}\nРоль: ${role}\nОриентир по сроку: ${t.deadline_hint || 'ближайший рабочий контроль'}\n\nЧто сделать:\n${t.description || title}\n\nВажно: задача создана после ручного подтверждения эксперта/руководителя.`;
      return {
        title: `ИИ: ${title}`,
        responsibleId: aiResponsibleId(deal, role),
        deadline,
        description,
        role,
      };
    })
    .filter(Boolean)
    .filter((task) => !hasOpenTaskWithTitle(deal.ID, task.title.replace(/^ИИ:\s*/i, '')) && !hasOpenTaskWithTitle(deal.ID, task.title));
}

async function createAITasks() {
  if (!state.selectedDeal) return;
  const d = state.selectedDeal;
  const tasks = state.selectedAiTasks || [];
  if (!tasks.length) {
    alert('ИИ не предложил новых задач или похожие открытые задачи уже есть.');
    return;
  }
  const confirmText = `Будут созданы задачи по ИИ-анализу (${tasks.length}):\n\n${tasks.map((t, i) => `${i + 1}. ${t.title} — ответственный ${userName(t.responsibleId)}, дедлайн ${formatDate(t.deadline)}`).join('\n')}\n\nСоздать?`;
  if (!window.confirm(confirmText)) return;
  for (const task of tasks) {
    await createTask({
      title: task.title,
      responsibleId: task.responsibleId,
      description: task.description,
      dealId: d.ID,
      deadline: task.deadline,
      silent: true,
    });
  }
  await bxCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: Number(d.ID), ENTITY_TYPE: 'deal', COMMENT: `ИИ-ассистент: создано задач по ИИ-анализу: ${tasks.length}.\n\n${tasks.map((t) => `— ${t.title}; ответственный: ${userName(t.responsibleId)}; дедлайн: ${formatDate(t.deadline)}`).join('\n')}` }
  });
  alert(`Создано задач по ИИ-анализу: ${tasks.length}`);
  state.selectedAiTasks = [];
  document.getElementById('create-ai-tasks').classList.add('hidden');
  await ensureDealMeta(d.ID);
  await loadDeals();
  if (state.selectedDeal) openDeal(String(d.ID));
}

function aiScenarioLabel(scenario) {
  const map = {
    deal_analyze: 'ИИ-анализ сделки',
    handoff: 'ИИ-проверка передачи',
    workplan: 'ИИ-ход работы',
    documents: 'ИИ-проверка документов',
    manager_deal: 'ИИ-анализ проблемной сделки для руководителя',
  };
  return map[scenario] || 'ИИ-анализ сделки';
}

async function enrichAIContextByScenario(context, deal, scenario) {
  if (scenario === 'handoff') {
    context.scenario = 'handoff';
    context.requiredHandoffItems = REQUIRED_ITEMS.map((x) => ({ key: x.key, label: x.label, why: x.why }));
    context.localHandoffAudit = getAudit(deal.ID) || state.selectedAudit || null;
    context.note = 'ИИ должен проверить качество передачи сделки из продаж в производство и отдельно выделить ошибки менеджера, спорные пункты и действия эксперта.';
  }

  if (scenario === 'workplan') {
    context.scenario = 'workplan';
    context.localWorkPlanDraft = buildWorkPlanText(deal);
    context.note = 'ИИ должен улучшить ход работы: сделать его понятным для эксперта и клиента, не обещать сроки без подтверждения, предложить задачи и контрольные точки.';
  }

  if (scenario === 'documents') {
    context.scenario = 'documents';
    const collected = await collectIncomingDocuments(deal);
    const docAnalysis = analyzeIncomingDocuments(deal, collected);
    context.localDocumentCheck = {
      status: docAnalysis.status,
      product: docAnalysis.profile.label,
      found: docAnalysis.found,
      uncertain: docAnalysis.uncertain,
      missing: docAnalysis.missing,
      unknownDocs: docAnalysis.unknownDocs,
      totalIncomingItems: (docAnalysis.docs || []).length,
    };
    context.note = 'ИИ должен проверить документы по чек-листу: что найдено, что только упоминается и требует ручной проверки, что нужно запросить у клиента.';
  }

  if (scenario === 'manager_deal') {
    context.scenario = 'manager_deal';
    context.issueFlags = shortFlagLabels(getDealIssueFlags(deal));
    context.managementNote = 'Результат нужен руководителю/РОП для планёрки: кратко, по делу, с ответственным и следующим действием. Приоритет — не общий пересказ, а управленческое решение по проблемной сделке.';
  }

  return context;
}

async function runAIScenario(scenario = 'deal_analyze') {
  if (!state.selectedDeal) return;
  const title = aiScenarioLabel(scenario);
  state.selectedMode = 'ai';
  state.selectedAudit = null;
  state.selectedMissing = [];
  state.selectedDeadlineTasks = [];
  hideActionButtons();

  const out = document.getElementById('analysis-result');
  out.innerHTML = `<div class="result-card card-action"><h3>${escapeHtml(title)}...</h3><p class="muted">Собираем данные сделки, комментарии, задачи, связанную сделку продаж и продуктовую логику. Обычно это занимает 10–40 секунд.</p></div>`;
  out.classList.remove('hidden');

  if (!APP_CONFIG.aiEnabled) {
    out.innerHTML = `<div class="result-card card-risk"><h3>ИИ пока не включён</h3><p>Добавь в Render переменные <strong>AI_ENABLED=true</strong>, <strong>AI_PROVIDER=vibe</strong>, <strong>AI_API_KEY</strong>, <strong>AI_BASE_URL</strong> и <strong>AI_MODEL</strong>, затем сделай деплой.</p><p class="muted">Ключ в чат присылать не нужно.</p></div>`;
    return;
  }

  try {
    let context = await buildAIContext(state.selectedDeal);
    context = await enrichAIContextByScenario(context, state.selectedDeal, scenario);
    const response = await fetch('/api/ai/analyze-deal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context, scenario }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || `Ошибка ИИ HTTP ${response.status}`);
    data.scenario_label = data.scenario_label || title;
    state.selectedAiPayload = data;
    state.selectedAiScenario = scenario;
    state.selectedAnalysis = aiResultToComment(state.selectedDeal, data).replace(/^ИИ-анализ сделки/, title);
    state.selectedAiTasks = buildAITasks(state.selectedDeal, data);
    out.innerHTML = renderAIAnalysisHtml(state.selectedDeal, data);
    document.getElementById('write-comment').classList.remove('hidden');
    document.getElementById('create-ai-tasks').classList.toggle('hidden', !state.selectedAiTasks.length);
    showAiFeedbackButtons(true);
  } catch (e) {
    state.selectedAnalysis = '';
    state.selectedAiTasks = [];
    state.selectedAiPayload = null;
    state.selectedAiScenario = '';
    document.getElementById('create-ai-tasks').classList.add('hidden');
    showAiFeedbackButtons(false);
    out.innerHTML = `<div class="result-card card-risk"><h3>Ошибка: ${escapeHtml(title)}</h3><p>${escapeHtml(e.message || String(e))}</p><p class="muted">Проверь переменные Render: AI_ENABLED, AI_PROVIDER, AI_API_KEY, AI_MODEL.</p></div>`;
  }
}

async function analyzeDealWithAI() {
  return runAIScenario('deal_analyze');
}

async function analyzeHandoffWithAI() {
  return runAIScenario('handoff');
}

async function generateWorkPlanWithAI() {
  return runAIScenario('workplan');
}

async function checkDocumentsWithAI() {
  return runAIScenario('documents');
}

async function generateWorkPlan() {
  if (!state.selectedDeal) return;
  state.selectedMode = 'workplan';
  state.selectedAudit = null;
  state.selectedMissing = [];
  state.selectedAnalysis = buildWorkPlanText(state.selectedDeal);
  const out = document.getElementById('analysis-result');
  out.innerHTML = renderWorkPlanResultHtml(state.selectedDeal, state.selectedAnalysis);
  out.classList.remove('hidden');
  document.getElementById('write-comment').classList.remove('hidden');
  document.getElementById('create-manager-task').classList.add('hidden');
  document.getElementById('create-expert-task').classList.add('hidden');
  document.getElementById('mark-checked').classList.add('hidden');
  document.getElementById('create-workplan-tasks').classList.remove('hidden');
  document.getElementById('create-deadline-tasks').classList.add('hidden');
  document.getElementById('create-ai-tasks').classList.add('hidden');
}



function buildChecklistText(deal) {
  const service = getService(deal) || 'услуга не указана';
  const profile = productProfileForDeal(deal);
  const checklist = productDocumentChecklist(profile);
  const audit = getAudit(deal.ID) || state.selectedAudit;
  const missing = audit ? [...(audit.missing || []), ...(audit.technical || [])] : [];
  const uncertain = audit ? [...(audit.uncertain || [])] : [];
  return `Чек-лист документов и данных по сделке\n\n` +
    `Сделка: ${deal.TITLE || ''} / ID ${deal.ID}\n` +
    `Компания: ${companyName(deal.COMPANY_ID)}\n` +
    `Услуга: ${service}\n` +
    `Продуктовая логика: ${profile.label}\n\n` +
    productBullets('Что запросить/проверить у клиента', checklist.clientDocs) + `\n\n` +
    productBullets('Что проверить эксперту внутри MAVIS', checklist.mavisChecks) + `\n\n` +
    productBullets('Риски, которые нужно контролировать', checklist.riskControls) + `\n\n` +
    `По проверке передачи сейчас:\n` +
    `${missing.length ? missing.map((x) => `— не хватает: ${x}`).join('\n') : '— критичных отсутствующих пунктов не зафиксировано'}\n` +
    `${uncertain.length ? uncertain.map((x) => `— подтвердить: ${x}`).join('\n') : ''}`;
}

function renderChecklistResultHtml(deal) {
  const service = getService(deal) || 'услуга не указана';
  const profile = productProfileForDeal(deal);
  const checklist = productDocumentChecklist(profile);
  const audit = getAudit(deal.ID) || state.selectedAudit;
  const missing = audit ? [...(audit.missing || []), ...(audit.technical || [])] : [];
  const uncertain = audit ? [...(audit.uncertain || [])] : [];
  const clientRequest = `Добрый день! Для запуска/продолжения работы по услуге “${service}” просим подготовить и направить данные/документы по чек-листу:\n` +
    checklist.clientDocs.map((x) => `— ${x}`).join('\n') +
    `\n\nЕсли по какому-то пункту информации пока нет — напишите, пожалуйста, что именно отсутствует и к какой дате сможете передать.`;
  return `
    <div class="result-header">
      <div class="result-header-title"><h3>Чек-лист документов и данных</h3><span class="result-status partial">требует проверки эксперта</span></div>
      <div class="result-grid">
        <div class="result-field"><span>Компания</span>${escapeHtml(companyName(deal.COMPANY_ID))}</div>
        <div class="result-field"><span>Услуга</span>${escapeHtml(service)}</div>
        <div class="result-field"><span>Продуктовая логика</span>${escapeHtml(profile.label)}</div>
        <div class="result-field"><span>Стадия</span>${escapeHtml(stageName(deal.STAGE_ID))}</div>
      </div>
    </div>
    <div class="result-card card-checklist"><h3>Что запросить/проверить у клиента</h3>${listHtml(checklist.clientDocs, '')}</div>
    <div class="result-card card-found"><h3>Что проверяет эксперт внутри MAVIS</h3>${listHtml(checklist.mavisChecks, '')}</div>
    <div class="result-card card-risk"><h3>Риски по документам</h3>${listHtml(checklist.riskControls, '')}</div>
    <div class="result-card card-uncertain"><h3>Уточнения по текущей проверке передачи</h3>${listHtml([...missing.map((x) => `Не хватает: ${x}`), ...uncertain.map((x) => `Подтвердить: ${x}`)], 'Критичных уточнений по проверке передачи нет')}</div>
    <div class="result-card"><h3>Черновик сообщения клиенту</h3><div class="message-draft">${escapeHtml(clientRequest)}</div></div>
    <details class="result-card"><summary><strong>Показать полный текст для комментария</strong></summary><div class="message-draft">${escapeHtml(buildChecklistText(deal))}</div></details>
  `;
}

async function generateChecklist() {
  if (!state.selectedDeal) return;
  state.selectedMode = 'checklist';
  state.selectedAudit = getAudit(state.selectedDeal.ID) || state.selectedAudit;
  state.selectedMissing = [];
  state.selectedAnalysis = buildChecklistText(state.selectedDeal);
  const out = document.getElementById('analysis-result');
  out.innerHTML = renderChecklistResultHtml(state.selectedDeal);
  out.classList.remove('hidden');
  document.getElementById('write-comment').classList.remove('hidden');
  document.getElementById('create-manager-task').classList.add('hidden');
  document.getElementById('create-expert-task').classList.add('hidden');
  document.getElementById('mark-checked').classList.add('hidden');
  document.getElementById('create-workplan-tasks').classList.remove('hidden');
  document.getElementById('create-deadline-tasks').classList.add('hidden');
  document.getElementById('create-ai-tasks').classList.add('hidden');
}


function normalizeDocText(value) {
  return normalize(String(value || '').replace(/[ё]/g, 'е'));
}

function evidenceLabel(e) {
  if (!e) return '';
  return [e.source, e.name, e.text].filter(Boolean).join(' — ');
}

async function tryResolveFileName(id) {
  const cleanId = String(id || '').replace(/[^0-9]/g, '');
  if (!cleanId) return '';
  try {
    const f = await bxCall('disk.file.get', { id: cleanId });
    return f && (f.NAME || f.name || f.TITLE || f.title || `файл ID ${cleanId}`);
  } catch (_) {}
  try {
    const a = await bxCall('disk.attachedObject.get', { id: cleanId });
    const obj = a && (a.OBJECT || a.object || a.FILE || a.file || a);
    return obj && (obj.NAME || obj.name || obj.TITLE || obj.title || `файл ID ${cleanId}`);
  } catch (_) {}
  return `файл ID ${cleanId}`;
}

function collectFileIdsFromValue(raw, out = []) {
  if (raw === null || raw === undefined || raw === '' || raw === false) return out;
  if (Array.isArray(raw)) {
    raw.forEach((x) => collectFileIdsFromValue(x, out));
    return out;
  }
  if (typeof raw === 'object') {
    ['ID','id','FILE_ID','fileId','ATTACHMENT_ID','attachmentId','OBJECT_ID','objectId','DISK_FILE_ID','diskFileId'].forEach((k) => {
      if (raw[k]) out.push(String(raw[k]));
    });
    Object.values(raw).forEach((v) => {
      if (Array.isArray(v) || (v && typeof v === 'object')) collectFileIdsFromValue(v, out);
    });
    return out;
  }
  const text = String(raw);
  if (/^\d{2,}$/.test(text)) out.push(text);
  return out;
}

function dealFieldLooksLikeFile(code, meta, raw) {
  const text = normalizeDocText([code, fieldLabel(code), metaText(meta), JSON.stringify(raw)].join(' '));
  if (/file|disk|файл|документ|копи|скан|вложен|прикреп|загруз/.test(text)) return true;
  const metaType = normalizeDocText(meta && (meta.type || meta.USER_TYPE_ID || meta.userTypeId || meta.dataType));
  return /file|disk/.test(metaType);
}

async function collectIncomingDocuments(deal) {
  const docs = [];
  const sources = [];
  const dealId = deal.ID;

  const addSource = (source, text, name = '') => {
    const clean = stripHtml(String(text || '')).trim();
    const cleanName = stripHtml(String(name || '')).trim();
    if (!clean && !cleanName) return;
    sources.push({ source, name: cleanName, text: clean });
  };

  const addDoc = (source, name, text = '') => {
    const cleanName = stripHtml(String(name || '')).trim();
    const cleanText = stripHtml(String(text || '')).trim();
    if (!cleanName && !cleanText) return;
    docs.push({ source, name: cleanName || cleanText.slice(0, 80), text: cleanText });
    addSource(source, cleanText, cleanName);
  };

  try {
    const fresh = await bxCall('crm.deal.get', { id: dealId });
    Object.entries(fresh || {}).forEach(([code, raw]) => {
      const meta = state.fields[code] || {};
      if (!dealFieldLooksLikeFile(code, meta, raw)) return;
      const resolved = resolveFieldValue(code, raw);
      if (resolved && !/^false$/i.test(String(resolved))) addDoc(`поле сделки: ${fieldLabel(code) || code}`, resolved, resolved);
    });
  } catch (_) {}

  let comments = [];
  try {
    comments = await bxList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
      order: { ID: 'DESC' },
    }, 80);
  } catch (_) {
    comments = getTimelineComments(dealId);
  }
  comments.forEach((c) => {
    const raw = `${c.COMMENT || c.TEXT || ''}`;
    const clean = stripHtml(raw);
    if (/файл|документ|копи|скан|прикреп|загруз|диплом|трудов|удостовер|аттестат|свидетельств|поверк|платеж|платёж|счет|счёт|реквизит|карточк/i.test(clean)) {
      addDoc(`комментарий ${formatDate(c.CREATED || c.DATE_CREATE || c.created)}`, clean.slice(0, 120), clean);
    } else {
      addSource(`комментарий ${formatDate(c.CREATED || c.DATE_CREATE || c.created)}`, clean);
    }
    collectFileIdsFromValue(c.FILES || c.files || c.ATTACHMENTS || c.attachments || c.FILE_ID || c.fileId || []).slice(0, 15).forEach((id) => addDoc('файл из комментария', `файл ID ${id}`, clean));
  });

  let activities = [];
  try {
    activities = await bxList('crm.activity.list', {
      filter: { OWNER_ID: dealId, OWNER_TYPE_ID: 2 },
      order: { ID: 'DESC' },
      select: ['ID','SUBJECT','DESCRIPTION','CREATED','DEADLINE','TYPE_ID','PROVIDER_ID','COMPLETED','STORAGE_TYPE_ID','STORAGE_ELEMENT_IDS','FILES'],
    }, 80);
  } catch (_) {
    activities = getActivities(dealId);
  }

  const fileIds = new Set();
  activities.forEach((a) => {
    const clean = stripHtml(`${a.SUBJECT || ''}. ${a.DESCRIPTION || ''}`);
    if (/файл|документ|копи|скан|прикреп|загруз|диплом|трудов|удостовер|аттестат|свидетельств|поверк|платеж|платёж|счет|счёт|реквизит|карточк/i.test(clean)) {
      addDoc(`дело/активность ${formatDate(a.CREATED || a.created)}`, a.SUBJECT || 'активность', clean);
    } else {
      addSource(`дело/активность ${formatDate(a.CREATED || a.created)}`, clean);
    }
    collectFileIdsFromValue(a.STORAGE_ELEMENT_IDS || a.storageElementIds || a.FILES || a.files || a.ATTACHMENTS || a.attachments || []).forEach((id) => fileIds.add(id));
  });

  const resolvedIds = [...fileIds].slice(0, 30);
  await mapLimit(resolvedIds, 4, async (id) => {
    const name = await tryResolveFileName(id);
    if (name) addDoc('прикреплённый файл Bitrix', name, `ID ${id}`);
  });

  const unique = [];
  const seen = new Set();
  docs.forEach((d) => {
    const key = normalizeDocText(`${d.source}|${d.name}|${d.text}`).slice(0, 300);
    if (!key || seen.has(key)) return;
    seen.add(key);
    unique.push(d);
  });

  return { docs: unique, sources };
}

function docPatternsForItem(item, profile) {
  const text = normalizeDocText(`${item} ${profile.label || ''} ${profile.key || ''}`);
  const groups = [];
  if (/реквизит|карточк|контакт|компани|ответствен/.test(text)) groups.push(/реквизит|карточк|унп|компани|ответствен|контакт|email|почт/);
  if (/свидетельств|стк|спк/.test(text)) groups.push(/стк|спк|свидетельств|техническ.*компетент/);
  if (/област|виды работ|категор/.test(text)) groups.push(/област|вид.*работ|категор|виды|работ/);
  if (/специалист|диплом|трудов|удостовер|аттестат|фио|стаж|образован|должност/.test(text)) groups.push(/специалист|диплом|трудов|удостовер|аттестат|фио|стаж|образован|должност|прораб|мастер|гип/);
  if (/оборуд|средств|измер|поверк|калибров|аренд|прибор/.test(text)) groups.push(/оборуд|средств.*измер|измеритель|поверк|калибров|аренд|прибор/);
  if (/оплат|счет|счёт|пошлин|платеж|платёж/.test(text)) groups.push(/оплат|счет|счёт|пошлин|платеж|платёж|платежк|платёжк|стройдок|техкарт/);
  if (/стандарт|iso|9001|45001|суот|процесс|штат|деятельност|систем/.test(text)) groups.push(/iso|9001|45001|суот|охран.*труд|стандарт|процесс|штат|деятельност|систем/);
  if (/подбор|квалификац|регион|занятост|условия|кандидат/.test(text)) groups.push(/подбор|квалификац|регион|занятост|условия|кандидат|резюме|специалист/);

  const words = text.split(/[^а-яa-z0-9]+/).filter((w) => w.length >= 5 && !['клиента','данные','документы','подтверждение','перечню','эксперта','обязательных','если','применимо','нужная','актуальные'].includes(w));
  if (words.length) groups.push(new RegExp(words.slice(0, 4).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i'));
  return groups;
}

function analyzeIncomingDocuments(deal, collected) {
  const profile = productProfileForDeal(deal);
  const checklist = productDocumentChecklist(profile);
  const allEvidence = [...(collected.docs || []), ...(collected.sources || [])];
  const corpusItems = allEvidence.map((e) => ({ raw: e, text: normalizeDocText(evidenceLabel(e)) })).filter((x) => x.text);

  const found = [];
  const uncertain = [];
  const missing = [];

  checklist.clientDocs.forEach((item) => {
    const patterns = docPatternsForItem(item, profile);
    const matches = corpusItems.filter((e) => patterns.some((p) => p.test(e.text)));
    const fileMatches = matches.filter((e) => collected.docs && collected.docs.includes(e.raw));
    if (fileMatches.length) {
      found.push({ label: item, source: fileMatches[0].raw.source, snippet: fileMatches[0].raw.name || fileMatches[0].raw.text });
    } else if (matches.length) {
      uncertain.push({ label: item, source: matches[0].raw.source, snippet: matches[0].raw.name || matches[0].raw.text });
    } else {
      missing.push({ label: item });
    }
  });

  const unknownDocs = (collected.docs || []).filter((doc) => {
    const text = normalizeDocText(evidenceLabel(doc));
    return !found.some((f) => text.includes(normalizeDocText(f.snippet).slice(0, 25))) && !uncertain.some((u) => text.includes(normalizeDocText(u.snippet).slice(0, 25)));
  }).slice(0, 20);

  const status = missing.length === 0
    ? 'комплект документов выглядит закрытым, нужна ручная проверка эксперта'
    : found.length || uncertain.length
      ? 'документы частично найдены, есть что дозапросить'
      : 'входящие документы не найдены или не распознаны';

  return { profile, checklist, found, uncertain, missing, unknownDocs, status, docs: collected.docs || [] };
}

function buildDocumentsText(deal, analysis) {
  return `Проверка входящих документов по сделке\n\n` +
    `Сделка: ${deal.TITLE || ''} / ID ${deal.ID}\n` +
    `Компания: ${companyName(deal.COMPANY_ID)}\n` +
    `Услуга: ${getService(deal) || '—'}\n` +
    `Продуктовая логика: ${analysis.profile.label}\n` +
    `Статус: ${analysis.status}\n\n` +
    `Найдено по чек-листу:\n${analysis.found.length ? analysis.found.map((x) => `— ${x.label}; источник: ${x.source}; фрагмент: “${x.snippet}”`).join('\n') : '— ничего не найдено'}\n\n` +
    `Нужно проверить вручную:\n${analysis.uncertain.length ? analysis.uncertain.map((x) => `— ${x.label}; источник: ${x.source}; фрагмент: “${x.snippet}”`).join('\n') : '— спорных совпадений нет'}\n\n` +
    `Не найдено / нужно запросить:\n${analysis.missing.length ? analysis.missing.map((x) => `— ${x.label}`).join('\n') : '— критичных отсутствующих пунктов не выявлено'}\n\n` +
    `Нераспределённые входящие файлы/упоминания:\n${analysis.unknownDocs.length ? analysis.unknownDocs.map((x) => `— ${x.name || x.text}; источник: ${x.source}`).join('\n') : '— нет'}\n\n` +
    `Важно: ассистент не подтверждает юридическую корректность файлов, а только сверяет наличие/упоминания документов с продуктовым чек-листом. Эксперт должен открыть файлы и проверить содержание.`;
}

function renderDocumentsResultHtml(deal, analysis) {
  const request = analysis.missing.length
    ? `Добрый день! По услуге “${getService(deal) || 'услуга'}” сейчас не хватает части документов/данных. Просим направить:\n${analysis.missing.map((x) => `— ${x.label}`).join('\n')}\n\nЕсли какой-то документ пока не готов — напишите, пожалуйста, к какой дате сможете передать.`
    : `Добрый день! По услуге “${getService(deal) || 'услуга'}” документы предварительно получены/зафиксированы. Мы проверим содержание и вернёмся с обратной связью, если потребуется дополнение.`;
  return `
    <div class="result-header">
      <div class="result-header-title"><h3>Проверка входящих документов</h3><span class="result-status ${analysis.missing.length ? 'partial' : 'ok'}">${escapeHtml(analysis.status)}</span></div>
      <div class="result-grid">
        <div class="result-field"><span>Компания</span>${escapeHtml(companyName(deal.COMPANY_ID))}</div>
        <div class="result-field"><span>Услуга</span>${escapeHtml(getService(deal) || '—')}</div>
        <div class="result-field"><span>Продуктовая логика</span>${escapeHtml(analysis.profile.label)}</div>
        <div class="result-field"><span>Найдено входящих файлов/упоминаний</span>${escapeHtml(String(analysis.docs.length))}</div>
      </div>
    </div>
    <div class="result-card card-found"><h3>Найдено по чек-листу</h3>${listHtml(analysis.found, 'Пока ничего не найдено', (x) => `<strong>${escapeHtml(x.label)}</strong><span class="source-note">${escapeHtml(x.source)} · ${escapeHtml(x.snippet)}</span>`)}</div>
    <div class="result-card card-uncertain"><h3>Нужно проверить вручную</h3>${listHtml(analysis.uncertain, 'Спорных совпадений нет', (x) => `<strong>${escapeHtml(x.label)}</strong><span class="source-note">${escapeHtml(x.source)} · ${escapeHtml(x.snippet)}</span>`)}</div>
    <div class="result-card card-missing"><h3>Не найдено / запросить у клиента</h3>${listHtml(analysis.missing.map((x) => x.label), 'Критичных отсутствующих пунктов не выявлено')}</div>
    <div class="result-card card-checklist"><h3>Нераспределённые файлы и упоминания</h3>${listHtml(analysis.unknownDocs, 'Нет отдельных файлов/упоминаний', (x) => `<strong>${escapeHtml(x.name || 'файл/упоминание')}</strong><span class="source-note">${escapeHtml(x.source)}${x.text ? ' · ' + escapeHtml(x.text).slice(0, 160) : ''}</span>`)}</div>
    <div class="result-card"><h3>Черновик сообщения клиенту</h3><div class="message-draft">${escapeHtml(request)}</div></div>
    <details class="result-card"><summary><strong>Показать полный текст для комментария</strong></summary><div class="message-draft">${escapeHtml(buildDocumentsText(deal, analysis))}</div></details>
  `;
}

async function checkIncomingDocuments() {
  if (!state.selectedDeal) return;
  const out = document.getElementById('analysis-result');
  out.innerHTML = '<div class="result-card"><h3>Проверяем входящие документы...</h3><p class="muted">Смотрим поля сделки, комментарии, дела/активности и доступные прикреплённые файлы.</p></div>';
  out.classList.remove('hidden');

  const collected = await collectIncomingDocuments(state.selectedDeal);
  const analysis = analyzeIncomingDocuments(state.selectedDeal, collected);
  state.selectedMode = 'documents';
  state.selectedAudit = null;
  state.selectedMissing = analysis.missing.map((x) => x.label);
  state.selectedAnalysis = buildDocumentsText(state.selectedDeal, analysis);
  out.innerHTML = renderDocumentsResultHtml(state.selectedDeal, analysis);

  document.getElementById('write-comment').classList.remove('hidden');
  document.getElementById('create-manager-task').classList.add('hidden');
  document.getElementById('create-expert-task').classList.remove('hidden');
  document.getElementById('mark-checked').classList.add('hidden');
  document.getElementById('create-workplan-tasks').classList.toggle('hidden', !analysis.missing.length);
  document.getElementById('create-deadline-tasks').classList.add('hidden');
  document.getElementById('create-ai-tasks').classList.add('hidden');
}

function parseDateValue(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isPastDate(value) {
  const d = parseDateValue(value);
  return d ? d.getTime() < Date.now() : false;
}

function isTodayDate(value) {
  const d = parseDateValue(value);
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function deadlineStatusLabel(value) {
  if (!value) return 'без дедлайна';
  if (isPastDate(value)) return 'просрочено';
  if (isTodayDate(value)) return 'сегодня';
  return 'запланировано';
}

function taskKey(title) {
  return normalize(title).replace(/\s+/g, ' ').trim();
}

function uniqueRecommendedTasks(dealId, tasks) {
  const seen = new Set();
  return tasks.filter((task) => {
    const key = taskKey(task.title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !hasOpenTaskWithTitle(dealId, task.title);
  });
}

function stageControlAdvice(stage, profile) {
  const text = normalize(`${stage} ${profile.key || ''} ${profile.label || ''}`);
  if (/эксперт назначен|new/.test(text)) {
    return {
      title: 'Сделать первое касание клиента',
      deadline: deadlineInHours(1),
      why: 'сделка только назначена эксперту, важно быстро подтвердить клиенту ход работы и следующий шаг',
    };
  }
  if (/сбор/.test(text)) {
    return {
      title: 'Проконтролировать сбор документов от клиента',
      deadline: deadlineTomorrow(12),
      why: 'на стадии сбора информации основная зона риска — клиент не прислал документы или данные',
    };
  }
  if (/заявк|подач|проверка органом|орган/.test(text)) {
    return {
      title: 'Проверить статус заявки / подачи в органе',
      deadline: deadlineTomorrow(15),
      why: 'после подачи важно не потерять статус рассмотрения, замечания и сроки ответа органа',
    };
  }
  if (/подбор/.test(text)) {
    return {
      title: 'Проконтролировать подбор специалиста',
      deadline: deadlineTomorrow(12),
      why: 'на стадии подбора важно зафиксировать, кто ищет специалиста и к какой дате',
    };
  }
  if (/обучен|экзамен/.test(text)) {
    return {
      title: 'Проконтролировать обучение / экзамен',
      deadline: deadlineTomorrow(12),
      why: 'по обучению и экзаменам важно подтвердить дату, документы и явку специалиста',
    };
  }
  if (/передан оформителю|оформител/.test(text)) {
    return {
      title: 'Проверить статус оформления документов',
      deadline: deadlineTomorrow(12),
      why: 'после передачи оформителю нужно контролировать готовность документов и возможные правки',
    };
  }
  if (/документы готовы|готов/.test(text)) {
    return {
      title: 'Передать результат клиенту и зафиксировать получение',
      deadline: deadlineTodayEnd(),
      why: 'если документы готовы, важно закрыть передачу результата и не держать сделку открытой без причины',
    };
  }
  if (/выезд/.test(text)) {
    return {
      title: 'Подтвердить дату выезда / подачи с клиентом',
      deadline: deadlineTomorrow(12),
      why: 'по выезду/подаче важны дата, готовность документов, оплата и ответственный со стороны клиента',
    };
  }
  if (/устранение замечаний|замечан/.test(text)) {
    return {
      title: 'Отработать замечания органа',
      deadline: deadlineTodayEnd(),
      why: 'замечания органа напрямую влияют на срок получения результата',
    };
  }
  if (/возврат/.test(text)) {
    return {
      title: 'Разобрать причину возврата и согласовать следующий шаг',
      deadline: deadlineTodayEnd(),
      why: 'возврат требует быстрого решения: исправление, повторная подача или эскалация руководителю',
    };
  }
  return {
    title: profile.firstTask || 'Поставить следующий производственный контроль по сделке',
    deadline: deadlineTomorrow(12),
    why: 'по текущей стадии нужен явный контрольный шаг, чтобы сделка не зависла',
  };
}

function buildDeadlineControl(deal) {
  const profile = productProfileForDeal(deal);
  const stage = stageName(deal.STAGE_ID);
  const service = getService(deal) || 'услуга не указана';
  const next = nextStep(deal.ID);
  const lastWork = lastWorkDate(deal);
  const staleDays = daysSince(lastWork);
  const openActs = openActivities(deal.ID);
  const openTs = openTasks(deal.ID);
  const dueToday = [];
  const overdue = [];
  const withoutDeadline = [];

  openActs.forEach((a) => {
    const item = { kind: 'дело', title: a.SUBJECT || 'дело без названия', deadline: a.DEADLINE };
    if (!a.DEADLINE) withoutDeadline.push(item);
    else if (isPastDate(a.DEADLINE)) overdue.push(item);
    else if (isTodayDate(a.DEADLINE)) dueToday.push(item);
  });
  openTs.forEach((t) => {
    const item = { kind: 'задача', title: t.TITLE || t.title || 'задача без названия', deadline: t.DEADLINE || t.deadline };
    if (!item.deadline) withoutDeadline.push(item);
    else if (isPastDate(item.deadline)) overdue.push(item);
    else if (isTodayDate(item.deadline)) dueToday.push(item);
  });

  const risks = [];
  const controls = [];
  const recommendedTasks = [];
  const addTask = (title, deadline, description, reason = '') => {
    recommendedTasks.push({ title, deadline, description, reason });
  };

  if (!next) {
    risks.push('В сделке нет открытого дела/задачи — нет зафиксированного следующего шага.');
    addTask(
      'Поставить следующий контрольный шаг по сделке',
      deadlineTodayEnd(),
      `В сделке “${deal.TITLE}” нет открытого дела/задачи. Нужно определить следующий шаг по стадии “${stage}”, зафиксировать дедлайн и ответственного.\n\nУслуга: ${service}.`,
      'нет следующего шага'
    );
  } else {
    controls.push(`Следующий шаг: ${formatDate(next.date)} — ${next.kind}: ${next.title || 'без названия'} (${deadlineStatusLabel(next.date)}).`);
    if (isPastDate(next.date)) {
      risks.push('Ближайший следующий шаг просрочен.');
      addTask(
        'Закрыть просроченный следующий шаг по сделке',
        deadlineInHours(2),
        `По сделке “${deal.TITLE}” просрочен следующий шаг: ${next.kind} “${next.title || ''}”, дедлайн ${formatDate(next.date)}. Нужно выполнить действие, перенести дедлайн или зафиксировать причину задержки в комментарии.`,
        'есть просроченный следующий шаг'
      );
    }
  }

  if (staleDays >= 2) {
    risks.push(`Нет рабочей активности ${staleDays} дн. — сделка может зависнуть без движения.`);
    addTask(
      'Вернуть сделку в работу / связаться с клиентом',
      deadlineTodayEnd(),
      `По сделке “${deal.TITLE}” нет рабочей активности ${staleDays} дн. Нужно связаться с клиентом или выполнить внутренний следующий шаг, затем зафиксировать итог в комментарии сделки.`,
      'нет активности 2+ дня'
    );
  }

  if (overdue.length) {
    risks.push(`Есть просроченные дела/задачи: ${overdue.length}.`);
  }
  if (dueToday.length) {
    controls.push(`Дедлайны на сегодня: ${dueToday.length}.`);
    addTask(
      'Проверить дедлайны на сегодня по сделке',
      deadlineTodayEnd(),
      `По сделке “${deal.TITLE}” есть дедлайны на сегодня. Нужно проверить выполнение и зафиксировать результат.\n\n${dueToday.map((x) => `— ${x.kind}: ${x.title}, дедлайн ${formatDate(x.deadline)}`).join('\n')}`,
      'есть дедлайны на сегодня'
    );
  }
  if (withoutDeadline.length) {
    risks.push(`Есть открытые дела/задачи без дедлайна: ${withoutDeadline.length}.`);
    addTask(
      'Проставить дедлайны по открытым делам/задачам',
      deadlineTodayEnd(),
      `По сделке “${deal.TITLE}” есть открытые дела/задачи без дедлайна. Нужно проставить даты контроля или закрыть неактуальные элементы.\n\n${withoutDeadline.map((x) => `— ${x.kind}: ${x.title}`).join('\n')}`,
      'есть открытые элементы без дедлайна'
    );
  }

  const stageAdvice = stageControlAdvice(stage, profile);
  addTask(
    stageAdvice.title,
    stageAdvice.deadline,
    `Контроль по стадии “${stage}” и услуге “${service}”.\n\nЧто сделать: ${stageAdvice.why}.\n\nПродуктовая логика: ${profile.label}.`,
    'контроль текущей стадии'
  );

  if (profile.paymentRequired) {
    addTask(
      'Проверить оплату счетов/пошлин по сделке',
      deadlineTomorrow(12),
      `Проверить по сделке “${deal.TITLE}”, нужны ли счета, пошлины, Стройдок, техкарты или другие обязательные платежи. Зафиксировать статус оплаты/обещанную дату оплаты в комментарии.`,
      'контроль оплат/пошлин'
    );
  }

  const uniqueTasks = uniqueRecommendedTasks(deal.ID, recommendedTasks);
  const status = overdue.length || staleDays >= 2 || !next
    ? 'есть риски по дедлайнам'
    : dueToday.length || withoutDeadline.length
      ? 'нужен контроль сегодня'
      : 'критичных рисков по дедлайнам не найдено';

  return { profile, stage, service, next, lastWork, staleDays, openActs, openTs, dueToday, overdue, withoutDeadline, controls, risks, recommendedTasks: uniqueTasks, status };
}

function buildDeadlineControlText(deal, analysis) {
  const itemLine = (x) => `— ${x.kind}: ${x.title}${x.deadline ? `, дедлайн ${formatDate(x.deadline)}` : ', без дедлайна'}`;
  return `Контроль дедлайнов по сделке\n\n` +
    `Сделка: ${deal.TITLE || ''} / ID ${deal.ID}\n` +
    `Компания: ${companyName(deal.COMPANY_ID)}\n` +
    `Услуга: ${analysis.service}\n` +
    `Продуктовая логика: ${analysis.profile.label}\n` +
    `Стадия: ${analysis.stage}\n` +
    `Статус: ${analysis.status}\n\n` +
    `Текущий следующий шаг:\n${analysis.next ? `— ${analysis.next.kind}: ${analysis.next.title || ''}, дедлайн ${formatDate(analysis.next.date)}` : '— не запланирован'}\n\n` +
    `Последняя рабочая активность: ${formatDate(analysis.lastWork)} (${analysis.staleDays} дн. назад)\n\n` +
    `Просрочено:\n${analysis.overdue.length ? analysis.overdue.map(itemLine).join('\n') : '— нет'}\n\n` +
    `Дедлайны сегодня:\n${analysis.dueToday.length ? analysis.dueToday.map(itemLine).join('\n') : '— нет'}\n\n` +
    `Без дедлайна:\n${analysis.withoutDeadline.length ? analysis.withoutDeadline.map(itemLine).join('\n') : '— нет'}\n\n` +
    `Риски:\n${analysis.risks.length ? analysis.risks.map((x) => `— ${x}`).join('\n') : '— критичных рисков не выявлено'}\n\n` +
    `Рекомендуемые задачи контроля:\n${analysis.recommendedTasks.length ? analysis.recommendedTasks.map((x) => `— ${x.title}; дедлайн ${formatDate(x.deadline)}; причина: ${x.reason}`).join('\n') : '— новые задачи не требуются или уже созданы'}`;
}

function renderDeadlineControlHtml(deal, analysis) {
  const statusClass = analysis.status.includes('риски') ? 'error' : analysis.status.includes('сегодня') ? 'partial' : 'ok';
  const itemRenderer = (x) => `<strong>${escapeHtml(x.kind)}: ${escapeHtml(x.title || 'без названия')}</strong><span class="source-note">${escapeHtml(x.deadline ? formatDate(x.deadline) : 'без дедлайна')}</span>`;
  const taskRenderer = (x) => `<strong>${escapeHtml(x.title)}</strong><span class="source-note">дедлайн: ${escapeHtml(formatDate(x.deadline))}</span>${x.reason ? `<span class="source-note">причина: ${escapeHtml(x.reason)}</span>` : ''}`;
  return `
    <div class="result-header">
      <div class="result-header-title"><h3>Контроль дедлайнов</h3><span class="result-status ${statusClass}">${escapeHtml(analysis.status)}</span></div>
      <div class="result-grid">
        <div class="result-field"><span>Компания</span>${escapeHtml(companyName(deal.COMPANY_ID))}</div>
        <div class="result-field"><span>Услуга</span>${escapeHtml(analysis.service)}</div>
        <div class="result-field"><span>Стадия</span>${escapeHtml(analysis.stage)}</div>
        <div class="result-field"><span>Последняя активность</span>${escapeHtml(formatDate(analysis.lastWork))}</div>
        <div class="result-field"><span>Следующий шаг</span>${escapeHtml(analysis.next ? `${formatDate(analysis.next.date)} — ${analysis.next.kind}: ${analysis.next.title || ''}` : 'не запланирован')}</div>
        <div class="result-field"><span>Открыто дел/задач</span>${escapeHtml(String(analysis.openActs.length + analysis.openTs.length))}</div>
      </div>
    </div>
    <div class="result-card card-risk"><h3>Риски по дедлайнам</h3>${listHtml(analysis.risks, 'Критичных рисков не выявлено')}</div>
    <div class="result-card card-uncertain"><h3>Просрочено</h3>${listHtml(analysis.overdue, 'Просроченных дел/задач нет', itemRenderer)}</div>
    <div class="result-card card-action"><h3>Дедлайны на сегодня</h3>${listHtml(analysis.dueToday, 'На сегодня дедлайнов нет', itemRenderer)}</div>
    <div class="result-card card-missing"><h3>Открытые дела/задачи без дедлайна</h3>${listHtml(analysis.withoutDeadline, 'Открытых элементов без дедлайна нет', itemRenderer)}</div>
    <div class="result-card card-found"><h3>Рекомендуемые задачи контроля</h3>${listHtml(analysis.recommendedTasks, 'Новые задачи не требуются или уже созданы', taskRenderer)}</div>
    <details class="result-card"><summary><strong>Показать полный текст для комментария</strong></summary><div class="message-draft">${escapeHtml(buildDeadlineControlText(deal, analysis))}</div></details>
  `;
}

async function checkDeadlines() {
  if (!state.selectedDeal) return;
  await ensureDealMeta(state.selectedDeal.ID);
  state.selectedMode = 'deadlines';
  state.selectedAudit = null;
  state.selectedMissing = [];
  const analysis = buildDeadlineControl(state.selectedDeal);
  state.selectedDeadlineTasks = analysis.recommendedTasks;
  state.selectedAnalysis = buildDeadlineControlText(state.selectedDeal, analysis);
  const out = document.getElementById('analysis-result');
  out.innerHTML = renderDeadlineControlHtml(state.selectedDeal, analysis);
  out.classList.remove('hidden');

  document.getElementById('write-comment').classList.remove('hidden');
  document.getElementById('create-manager-task').classList.add('hidden');
  document.getElementById('create-expert-task').classList.add('hidden');
  document.getElementById('mark-checked').classList.add('hidden');
  document.getElementById('create-workplan-tasks').classList.add('hidden');
  document.getElementById('create-deadline-tasks').classList.toggle('hidden', !state.selectedDeadlineTasks.length);
  document.getElementById('create-ai-tasks').classList.add('hidden');
}

async function createDeadlineTasks() {
  if (!state.selectedDeal) return;
  const d = state.selectedDeal;
  const tasks = state.selectedDeadlineTasks && state.selectedDeadlineTasks.length
    ? state.selectedDeadlineTasks
    : buildDeadlineControl(d).recommendedTasks;
  if (!tasks.length) {
    alert('Новые задачи контроля не требуются или уже созданы.');
    return;
  }
  const confirmText = `Будут созданы задачи контроля (${tasks.length}):\n\n${tasks.map((t, i) => `${i + 1}. ${t.title} — дедлайн ${formatDate(t.deadline)}`).join('\n')}\n\nСоздать?`;
  if (!window.confirm(confirmText)) return;
  for (const task of tasks) {
    await createTask({
      title: task.title,
      responsibleId: d.ASSIGNED_BY_ID,
      description: task.description,
      dealId: d.ID,
      deadline: task.deadline,
      silent: true,
    });
  }
  alert(`Создано задач контроля: ${tasks.length}`);
  state.selectedDeadlineTasks = [];
  await loadDeals();
  if (state.selectedDeal) openDeal(String(d.ID));
}



function aiFeedbackMarker(payload) {
  return `\n<!--${AI_FEEDBACK_TAG}:${btoa(unescape(encodeURIComponent(JSON.stringify(payload))))}-->`;
}

function selectedAiFeedbackBase() {
  const deal = state.selectedDeal || {};
  const ai = state.selectedAiPayload || {};
  const r = ai.result || {};
  return {
    version: 1,
    dealId: String(deal.ID || ''),
    scenario: state.selectedAiScenario || ai.scenario || '',
    scenarioLabel: ai.scenario_label || aiScenarioLabel(state.selectedAiScenario),
    model: ai.model || (window.APP_CONFIG && APP_CONFIG.aiModel) || '',
    status: r.status || '',
    statusLabel: r.status_label || '',
    userId: state.user ? String(state.user.ID) : '',
    userName: state.user ? `${state.user.NAME || ''} ${state.user.LAST_NAME || ''}`.trim() : '',
    createdAt: new Date().toISOString(),
  };
}

async function saveAiFeedback(kind, correctionText = '') {
  if (!state.selectedDeal || !state.selectedAiPayload) return;
  const base = selectedAiFeedbackBase();
  const isOk = kind === 'ok';
  const payload = { ...base, kind: isOk ? 'accepted' : 'correction', correction: String(correctionText || '').trim() };
  const comment = isOk
    ? `Оценка ИИ-анализа\n\nСтатус: вывод принят экспертом.\nСценарий: ${base.scenarioLabel}.\nПроверил: ${base.userName || 'пользователь'}.\n\nЭта отметка нужна для контроля качества ИИ-ассистента и режима обучения.${aiFeedbackMarker(payload)}`
    : `Оценка ИИ-анализа\n\nСтатус: нужна правка / вывод неполный.\nСценарий: ${base.scenarioLabel}.\nПроверил: ${base.userName || 'пользователь'}.\n\nПравка эксперта:\n${payload.correction || '—'}\n\nЭта правка нужна для контроля качества ИИ-ассистента и режима обучения.${aiFeedbackMarker(payload)}`;
  await bxCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: Number(state.selectedDeal.ID), ENTITY_TYPE: 'deal', COMMENT: comment }
  });
  alert(isOk ? 'Оценка сохранена: ИИ-вывод принят.' : 'Правка к ИИ сохранена в сделке.');
}

async function acceptAIFeedback() {
  await saveAiFeedback('ok');
}

async function correctAIFeedback() {
  if (!state.selectedDeal || !state.selectedAiPayload) return;
  const text = window.prompt('Что ИИ понял неверно или что нужно добавить? Эта правка сохранится в комментарии сделки.');
  if (text === null) return;
  if (!String(text).trim()) {
    alert('Правка пустая. Напиши, что нужно исправить или добавить.');
    return;
  }
  await saveAiFeedback('correction', text);
}

async function writeComment() {
  if (!state.selectedDeal || !state.selectedAnalysis) return;
  await bxCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: Number(state.selectedDeal.ID), ENTITY_TYPE: 'deal', COMMENT: `${state.selectedAnalysis}${state.selectedAudit ? auditMarker(state.selectedAudit) : ''}` }
  });
  if (state.selectedAudit) state.auditByDeal.set(String(state.selectedDeal.ID), state.selectedAudit);
  renderDeals();
  alert(state.selectedMode === 'workplan' ? 'Ход работы записан в комментарий сделки.' : 'Комментарий записан в сделку.');
}



async function markChecked() {
  if (!state.selectedDeal) return;
  const d = state.selectedDeal;
  const audit = {
    version: 1,
    dealId: String(d.ID),
    statusCode: 'ok',
    status: 'проверено вручную — принято в работу',
    checkedAt: new Date().toISOString(),
    checkedById: String(state.user.ID),
    checkedByName: `${state.user.NAME || ''} ${state.user.LAST_NAME || ''}`.trim(),
    missing: [],
    uncertain: [],
    technical: [],
    foundCount: 0,
    manual: true,
  };
  const comment = `ИИ-проверка передачи сделки в производство\n\nСтатус: проверено вручную — принято в работу.\n\nПользователь отметил передачу как проверенную в кабинете ИИ-ассистента.\n${auditMarker(audit)}`;
  await bxCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: Number(d.ID), ENTITY_TYPE: 'deal', COMMENT: comment }
  });
  state.auditByDeal.set(String(d.ID), audit);
  renderDeals();
  alert('Сделка отмечена как проверенная.');
}

async function createManagerTask() {
  const d = state.selectedDeal;
  await createTask({
    title: 'Дозаполнить данные для передачи в производство',
    responsibleId: d.CREATED_BY_ID || d.ASSIGNED_BY_ID,
    description: `По сделке “${d.TITLE}” не хватает данных для запуска производства.\n\n${state.selectedAnalysis}\n\nПожалуйста, дозаполните информацию в комментарии к сделке или в исходной сделке продаж.`,
    dealId: d.ID,
  });
}

async function createExpertTask() {
  const d = state.selectedDeal;
  const isDocs = state.selectedMode === 'documents';
  await createTask({
    title: isDocs ? 'Проверить входящие документы по сделке' : 'Сделать первое касание клиента',
    responsibleId: d.ASSIGNED_BY_ID,
    description: isDocs
      ? `Открыть входящие файлы/комментарии по сделке, сверить содержание документов с чек-листом и дозапросить недостающее у клиента.

${state.selectedAnalysis || ''}`
      : `Связаться с клиентом, подтвердить ход работы, документы, оплаты, дедлайны и следующий шаг. После звонка зафиксировать итоги в комментарии сделки.

${state.selectedAnalysis || ''}`,
    dealId: d.ID,
  });
}

function deadlineInHours(hours) {
  const d = new Date(Date.now() + hours * 60 * 60 * 1000);
  return d.toISOString();
}

function deadlineTodayEnd() {
  const d = new Date();
  d.setHours(18, 0, 0, 0);
  if (d.getTime() < Date.now()) return deadlineInHours(2);
  return d.toISOString();
}

function deadlineTomorrow(hour = 12) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function hasOpenTaskWithTitle(dealId, title) {
  const normalized = normalize(title);
  return openTasks(dealId).some((t) => normalize(t.TITLE || t.title || '').includes(normalized) || normalized.includes(normalize(t.TITLE || t.title || '')));
}

function buildWorkPlanTasks(deal) {
  const audit = getAudit(deal.ID) || state.selectedAudit;
  const missing = audit ? [...(audit.missing || []), ...(audit.technical || [])] : [];
  const uncertain = audit ? [...(audit.uncertain || [])] : [];
  const stage = stageName(deal.STAGE_ID);
  const service = getService(deal) || 'услуга не указана';
  const profile = productProfileForDeal(deal);
  const next = nextStep(deal.ID);
  const tasks = [];

  tasks.push({
    title: 'Отправить ход работы клиенту',
    deadline: deadlineInHours(1),
    description: `Отправить клиенту ход работы по сделке “${deal.TITLE}” (${service}).\n\nЧто зафиксировать клиенту:\n— что делает MAVIS GROUP;\n— что нужно от клиента;\n— какие документы/данные нужны;\n— какие оплаты/пошлины могут понадобиться;\n— следующий контрольный шаг.\n\nЧерновик хода работы:\n${state.selectedAnalysis || ''}`,
  });

  tasks.push({
    title: 'Зафиксировать итоги первого/текущего касания в сделке',
    deadline: deadlineTodayEnd(),
    description: `Зафиксировать в комментарии сделки итоги касания по услуге “${service}”: документы, оплаты, дедлайны, следующий шаг и риски по срокам.`,
  });

  tasks.push({
    title: profile.firstTask || 'Сформировать перечень документов по услуге',
    deadline: deadlineTomorrow(12),
    description: `Подготовить продуктовый перечень по сделке “${deal.TITLE}”.

Продуктовая логика: ${profile.label}.

Что проверить:
${(profile.clarify || []).map((x) => `— ${x}`).join('\n') || '— исходные данные по услуге'}

Чек-лист документов и данных:
${productDocumentChecklist(profile).clientDocs.map((x) => `— ${x}`).join('\n')}

Что запросить у клиента:
${profile.client.map((x) => `— ${x}`).join('\n')}`,
  });

  if (missing.length || uncertain.length) {
    tasks.push({
      title: 'Запросить у клиента недостающие данные/документы',
      deadline: deadlineTomorrow(12),
      description: `Запросить и зафиксировать недостающие данные по сделке “${deal.TITLE}”.\n\nНе хватает / нужно подтвердить:\n${[...missing.map((x) => `— ${x}`), ...uncertain.map((x) => `— подтвердить: ${x}`)].join('\n') || '— уточнить перечень документов и данных'}`,
    });
  }

  const needsPaymentControl = profile.paymentRequired || /пошлин|счет|счёт|оплат|стройдок|техкарт/i.test(`${state.selectedAnalysis || ''} ${missing.join(' ')} ${uncertain.join(' ')}`);
  if (needsPaymentControl) {
    tasks.push({
      title: 'Проверить оплату счетов/пошлин по сделке',
      deadline: deadlineTomorrow(12),
      description: `Проверить, какие счета/пошлины/обязательные платежи нужны по сделке “${deal.TITLE}”, зафиксировать дату оплаты или дату обещанной оплаты.`,
    });
  }

  if (!next) {
    tasks.push({
      title: 'Поставить следующий контрольный шаг по сделке',
      deadline: deadlineTodayEnd(),
      description: `В сделке нет открытого дела/задачи. Нужно поставить следующий контрольный шаг по текущей стадии “${stage}”.`,
    });
  }

  return tasks.filter((task) => !hasOpenTaskWithTitle(deal.ID, task.title));
}


async function showDealFields() {
  if (!state.selectedDeal) return;
  const id = state.selectedDeal.ID;
  let fresh = state.selectedDeal;
  try { fresh = await bxCall('crm.deal.get', { id }); } catch (_) {}

  const lines = [];
  lines.push('Диагностика полей сделки');
  lines.push('Сделка ID: ' + id);
  lines.push('');
  lines.push('Как пользоваться: найди строку, где значение равно услуге из карточки Bitrix.');
  lines.push('Например: тест ии / СПК / Аттестация / ISO.');
  lines.push('Код слева нужно будет добавить в Render как SERVICE_FIELD_CODE.');
  lines.push('');

  const entries = Object.entries(fresh || {})
    .filter(([code, raw]) => raw !== null && raw !== undefined && raw !== '' && !(Array.isArray(raw) && !raw.length))
    .map(([code, raw]) => {
      const label = fieldLabel(code);
      const resolved = resolveFieldValue(code, raw);
      return { code, label, value: resolved || JSON.stringify(raw) };
    })
    .filter((x) => String(x.value || '').trim() !== '')
    .sort((a, b) => {
      const au = a.code.startsWith('UF_') ? 0 : 1;
      const bu = b.code.startsWith('UF_') ? 0 : 1;
      if (au !== bu) return au - bu;
      return a.code.localeCompare(b.code);
    });

  const likely = entries.filter((x) => {
    const txt = normalize([x.code, x.label, x.value].join(' '));
    return txt.includes('услуг') || txt.includes('спк') || txt.includes('стк') || txt.includes('аттеста') || txt.includes('iso') || txt.includes('сертифик') || txt.includes('периодик') || txt.includes('тест ии');
  });

  if (likely.length) {
    lines.push('Возможные поля услуги:');
    likely.slice(0, 30).forEach((x) => {
      lines.push(`— ${x.code} | ${x.label || 'без подписи'} | ${x.value}`);
    });
    lines.push('');
  }

  lines.push('Все заполненные поля сделки:');
  entries.forEach((x) => {
    lines.push(`— ${x.code} | ${x.label || 'без подписи'} | ${x.value}`);
  });

  const out = document.getElementById('analysis-result');
  out.innerHTML = `<pre class="analysis-pre">${escapeHtml(lines.join('\n'))}</pre>`;
  out.classList.remove('hidden');
}

async function createWorkPlanTasks() {
  if (!state.selectedDeal) return;
  const d = state.selectedDeal;
  const tasks = buildWorkPlanTasks(d);
  if (!tasks.length) {
    alert('Открытые задачи по ходу работы уже есть или новых задач не требуется.');
    return;
  }
  const confirmText = `Будут созданы задачи (${tasks.length}):\n\n${tasks.map((t, i) => `${i + 1}. ${t.title} — дедлайн ${formatDate(t.deadline)}`).join('\n')}\n\nСоздать?`;
  if (!window.confirm(confirmText)) return;
  for (const task of tasks) {
    await createTask({
      title: task.title,
      responsibleId: d.ASSIGNED_BY_ID,
      description: task.description,
      dealId: d.ID,
      deadline: task.deadline,
      silent: true,
    });
  }
  alert(`Создано задач: ${tasks.length}`);
  await loadDeals();
  if (state.selectedDeal) openDeal(String(d.ID));
}

async function createTask({ title, responsibleId, description, dealId, deadline = null, auditorIds = [], accompliceIds = [], silent = false }) {
  const fields = {
    TITLE: title,
    RESPONSIBLE_ID: Number(responsibleId),
    DESCRIPTION: description,
    UF_CRM_TASK: [`D_${dealId}`],
  };
  if (deadline) fields.DEADLINE = deadline;
  const auditors = uniqueIds(auditorIds).filter((id) => Number(id));
  const accomplices = uniqueIds(accompliceIds).filter((id) => Number(id));
  if (auditors.length) fields.AUDITORS = auditors.map(Number);
  if (accomplices.length) fields.ACCOMPLICES = accomplices.map(Number);
  await bxCall('tasks.task.add', { fields });
  if (!silent) alert('Задача создана.');
}

function openInBitrix(id) {
  const path = `/crm/deal/details/${id}/`;
  if (BX24.openPath) BX24.openPath(path);
  else window.open(path, '_blank');
}

function extractDealId(text) {
  const s = String(text || '');
  const m = s.match(/deal\/details\/(\d+)/i) || s.match(/\bD_(\d+)\b/i) || s.match(/\bdeal_id=(\d+)\b/i) || s.match(/\bID\s*(\d{3,})\b/i);
  return m ? m[1] : null;
}
function daysSince(dateString) {
  if (!dateString) return 999;
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return 999;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function formatMoney(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return String(value || '0');
  return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function showError(message) { document.getElementById('loading').classList.add('hidden'); const el = document.getElementById('error'); el.textContent = message; el.classList.remove('hidden'); }
function hideError() { document.getElementById('error').classList.add('hidden'); }

document.getElementById('reload').addEventListener('click', loadDeals);
document.getElementById('search').addEventListener('input', renderDeals);
document.getElementById('deals-table').addEventListener('click', (e) => {
  const bxId = e.target.getAttribute('data-bx');
  if (bxId) return openInBitrix(bxId);
  const openId = e.target.getAttribute('data-open') || e.target.getAttribute('data-check');
  if (openId) openDeal(openId).then(() => {
    if (e.target.getAttribute('data-check')) checkHandoff();
  });
});
document.getElementById('close-dialog').addEventListener('click', () => document.getElementById('deal-dialog').close());
document.getElementById('check-handoff').addEventListener('click', checkHandoff);
document.getElementById('ai-analyze').addEventListener('click', analyzeDealWithAI);
document.getElementById('ai-handoff').addEventListener('click', analyzeHandoffWithAI);
document.getElementById('ai-workplan').addEventListener('click', generateWorkPlanWithAI);
document.getElementById('ai-documents').addEventListener('click', checkDocumentsWithAI);
document.getElementById('generate-workplan').addEventListener('click', generateWorkPlan);
document.getElementById('generate-checklist').addEventListener('click', generateChecklist);
document.getElementById('check-documents').addEventListener('click', checkIncomingDocuments);
document.getElementById('check-deadlines').addEventListener('click', checkDeadlines);
document.getElementById('write-comment').addEventListener('click', writeComment);
document.getElementById('create-manager-task').addEventListener('click', createManagerTask);
document.getElementById('create-expert-task').addEventListener('click', createExpertTask);
document.getElementById('create-workplan-tasks').addEventListener('click', createWorkPlanTasks);
document.getElementById('create-deadline-tasks').addEventListener('click', createDeadlineTasks);
document.getElementById('create-ai-tasks').addEventListener('click', createAITasks);
document.getElementById('accept-ai-feedback').addEventListener('click', acceptAIFeedback);
document.getElementById('correct-ai-feedback').addEventListener('click', correctAIFeedback);
document.getElementById('mark-checked').addEventListener('click', markChecked);
document.getElementById('show-fields').addEventListener('click', showDealFields);
const managerDashboard = document.getElementById('manager-dashboard');
if (managerDashboard) {
  managerDashboard.addEventListener('click', (e) => {
    const loadMetaButton = e.target.closest && e.target.closest('#load-dashboard-meta');
    if (loadMetaButton) return loadDashboardMeta();
    const reportButton = e.target.closest && e.target.closest('#generate-manager-report');
    if (reportButton) return generateManagerReport();
    const remindersButton = e.target.closest && e.target.closest('#create-handoff-reminders');
    if (remindersButton) return createHandoffReminderTasks();
    const escalationsButton = e.target.closest && e.target.closest('#create-escalations');
    if (escalationsButton) return createEscalationTasks();
    const managerAiButton = e.target.closest && e.target.closest('#run-manager-ai');
    if (managerAiButton) return runManagerAIAnalysis();
    const aiQualityButton = e.target.closest && e.target.closest('#generate-ai-quality-report');
    if (aiQualityButton) return generateAIQualityReport();
    const taskId = e.target.getAttribute('data-handoff-task');
    if (taskId) return createHandoffTaskForDeal(taskId);
    const markOkId = e.target.getAttribute('data-mark-handoff-ok');
    if (markOkId) return markHandoffIssueOk(markOkId);
    const openId = e.target.getAttribute('data-open');
    if (openId) return openDeal(openId);
    const filter = e.target.getAttribute('data-dashboard-filter');
    if (!filter) return;
    state.dashboardFilter = filter;
    renderDeals();
  });
  const journalStatus = document.getElementById('journal-status-filter');
  const journalManager = document.getElementById('journal-manager-filter');
  const journalSearch = document.getElementById('journal-search');
  if (journalStatus) journalStatus.addEventListener('change', (e) => { state.journalStatusFilter = e.target.value; renderDeals(); });
  if (journalManager) journalManager.addEventListener('change', (e) => { state.journalManagerFilter = e.target.value; renderDeals(); });
  if (journalSearch) journalSearch.addEventListener('input', (e) => { state.journalSearch = e.target.value; renderDeals(); });
}

init();
