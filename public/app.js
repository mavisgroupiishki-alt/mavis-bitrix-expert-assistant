/* global BX24, APP_CONFIG */

const state = {
  user: null,
  role: 'expert',
  isAdmin: false,
  isLeader: false,
  isRop: false,
  fields: {},
  fieldMap: {},
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

function detectFieldMap(fields) {
  const entries = Object.entries(fields || {});
  const find = (needles) => {
    const found = entries.find(([code, meta]) => {
      const title = normalize(`${code} ${meta.title || ''} ${meta.formLabel || ''} ${meta.listLabel || ''}`);
      return needles.some((n) => title.includes(n));
    });
    return found ? found[0] : null;
  };
  return {
    service: find(['услуга', 'продукт']),
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

  const select = ['ID','TITLE','COMPANY_ID','CONTACT_ID','STAGE_ID','CATEGORY_ID','OPPORTUNITY','ASSIGNED_BY_ID','CREATED_BY_ID','DATE_CREATE','DATE_MODIFY','CLOSED'];
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
  await hydrateDeals(deals);
  await hydrateStages(deals);
  await hydrateActivities(deals);
  await hydrateTasks(deals);
  await hydrateTimelineComments(deals);
  renderDeals();
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
  const categoryIds = [...new Set(deals.map((d) => String(d.CATEGORY_ID || '0')))];
  const entityIds = ['DEAL_STAGE', ...categoryIds.filter((id) => id !== '0').map((id) => `DEAL_STAGE_${id}`)];

  await mapLimit(entityIds, 4, async (entityId) => {
    try {
      const rows = await bxList('crm.status.list', { filter: { ENTITY_ID: entityId }, order: { SORT: 'ASC' } }, 0);
      rows.forEach((row) => saveStageName(entityId, row));
    } catch (_) {}
  });

  // Extra fallback for custom deal pipelines. Some portals return custom pipeline
  // stages more reliably through crm.dealcategory.stage.list.
  await mapLimit(categoryIds.filter((id) => id !== '0'), 4, async (categoryId) => {
    try {
      const rows = await bxList('crm.dealcategory.stage.list', { id: categoryId, order: { SORT: 'ASC' } }, 0);
      rows.forEach((row) => saveStageName(`DEAL_STAGE_${categoryId}`, row));
    } catch (_) {}
  });
}

function saveStageName(entityId, row) {
  if (!row) return;
  const statusId = String(row.STATUS_ID || row.statusId || row.ID || row.id || '');
  const name = row.NAME || row.name || row.TITLE || row.title || statusId;
  if (!statusId) return;
  state.stageMap.set(statusId, name);
  const m = String(entityId).match(/^DEAL_STAGE_(\d+)$/);
  if (m && !statusId.startsWith(`C${m[1]}:`)) {
    state.stageMap.set(`C${m[1]}:${statusId}`, name);
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
function stageName(stageId) { return state.stageMap.get(String(stageId)) || stageId || '—'; }
function getService(deal) { return state.fieldMap.service ? val(deal[state.fieldMap.service]) : ''; }
function getStartDate(deal) { return state.fieldMap.startDate ? val(deal[state.fieldMap.startDate]) : ''; }
function getSalesLink(deal) { return state.fieldMap.salesDealLink ? val(deal[state.fieldMap.salesDealLink]) : ''; }
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
  const filtered = roleVisibleDeals.filter((d) => normalize(`${d.TITLE} ${companyName(d.COMPANY_ID)} ${getService(d)} ${d.STAGE_ID} ${stageName(d.STAGE_ID)} ${d.CATEGORY_ID} ${auditLabel(getAudit(d.ID))}`).includes(q));

  filtered.forEach((deal) => {
    const next = nextStep(deal.ID);
    const noOpen = !hasNextStep(deal.ID);
    const lastWork = lastWorkDate(deal);
    const stale = daysSince(lastWork) >= 2;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(companyName(deal.COMPANY_ID))}</td>
      <td><strong>${escapeHtml(deal.TITLE || '')}</strong><br><span class="muted">ID ${deal.ID}</span></td>
      <td>${escapeHtml(getService(deal) || '—')}</td>
      <td><span class="badge" title="${escapeHtml(deal.STAGE_ID || '')}">${escapeHtml(stageName(deal.STAGE_ID))}</span><br><span class="muted">${escapeHtml(deal.STAGE_ID || '—')}</span></td>
      <td>${escapeHtml(deal.CATEGORY_ID ?? '0')}</td>
      <td>${escapeHtml(formatMoney(deal.OPPORTUNITY))}</td>
      <td>${escapeHtml(formatDate(getStartDate(deal)) || '—')}</td>
      <td>${escapeHtml(userName(deal.ASSIGNED_BY_ID))}</td>
      <td>${next ? `${escapeHtml(formatDate(next.date))}<br><span class="muted">${escapeHtml(next.kind)}: ${escapeHtml(next.title || '')}</span>` : '<span class="warn">нет открытого дела/задачи</span>'}</td>
      <td>${escapeHtml(formatDate(lastWork) || '—')}${stale ? '<br><span class="warn">2+ дня</span>' : ''}</td>
      <td>${auditHtml(deal.ID)}</td>
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
  document.getElementById('count-no-activity').textContent = visibleForRole.filter((d) => !hasNextStep(d.ID)).length;
  document.getElementById('count-stale').textContent = visibleForRole.filter((d) => daysSince(lastWorkDate(d)) >= 2).length;
  const isRopOnly = state.isRop && !(state.isAdmin || state.isLeader) && !APP_CONFIG.allowRopViewAll;
  document.getElementById('label-count-all').textContent = isRopOnly ? 'Ошибки передачи' : 'Активные открытые сделки';
  document.getElementById('label-count-check').textContent = isRopOnly ? 'Ошибки передачи' : 'Не проверено';
  document.getElementById('count-check').textContent = isRopOnly ? visibleForRole.length : visibleForRole.filter((d) => !getAudit(d.ID)).length;
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
    + `${APP_CONFIG.excludeClosedDeals !== false ? 'Закрытые сделки исключены. ' : 'Закрытые сделки НЕ исключены. '} ${roleNote} ${limitNote}`;

}

async function openDeal(id) {
  const deal = state.deals.find((d) => String(d.ID) === String(id)) || await bxCall('crm.deal.get', { id });
  state.selectedDeal = deal;
  state.selectedAnalysis = '';
  state.selectedMissing = [];
  state.selectedAudit = null;
  state.selectedMode = '';
  document.getElementById('dialog-title').textContent = deal.TITLE || `Сделка ${id}`;
  document.getElementById('analysis-result').classList.add('hidden');
  ['write-comment','create-manager-task','create-expert-task','mark-checked'].forEach((x) => document.getElementById(x).classList.add('hidden'));
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
  const salesId = extractDealId(getSalesLink(deal) || contextToText(production));
  if (salesId && String(salesId) !== String(deal.ID)) {
    try {
      const salesDeal = await bxCall('crm.deal.get', { id: salesId });
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
  state.selectedAudit = buildAuditPayload({ deal, status, found, uncertain, missing, technicalMissing });
  state.selectedAnalysis = formatAnalysisV3({ status, found, uncertain, missing, technicalMissing, risks, deal, salesId });

  const out = document.getElementById('analysis-result');
  out.textContent = state.selectedAnalysis;
  out.classList.remove('hidden');
  document.getElementById('write-comment').classList.remove('hidden');
  document.getElementById('create-manager-task').classList.toggle('hidden', !actionItems.length);
  document.getElementById('create-expert-task').classList.remove('hidden');
  document.getElementById('mark-checked').classList.remove('hidden');
}


function buildAuditPayload({ deal, status, found, uncertain, missing, technicalMissing }) {
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
  const riskBlock = missing.length || uncertain.length
    ? `\nЧто нужно уточнить/закрыть перед отправкой клиенту:\n${missing.map((x) => `— не хватает: ${x}`).join('\n')}${missing.length && uncertain.length ? '\n' : ''}${uncertain.map((x) => `— подтвердить: ${x}`).join('\n')}`
    : '\nКритичных пробелов по передаче сделки в текущей проверке не зафиксировано.';

  return `Черновик хода работы по сделке\n\n` +
    `Компания: ${company}\n` +
    `Контакт: ${contact}\n` +
    `Сделка: ${deal.TITLE || ''} / ID ${deal.ID}\n` +
    `Услуга: ${service}\n` +
    `Стадия производства: ${stage}\n` +
    `Дата начала оказания услуг: ${dateStart}\n` +
    `Ответственный эксперт: ${userName(deal.ASSIGNED_BY_ID)}\n` +
    `Следующее дело/задача: ${nextText}\n\n` +
    `Логика текущего этапа:\n— ${advice}.\n\n` +
    `Что делает MAVIS GROUP:\n` +
    `— проверяет комплектность данных и документов по услуге;\n` +
    `— готовит/актуализирует перечень документов и копий;\n` +
    `— при необходимости заказывает счета, пошлины, техкарты, Стройдок или другие обязательные платежи;\n` +
    `— контролирует подготовку, подачу/выезд, замечания и фактическое получение результата.\n\n` +
    `Что нужно от клиента:\n` +
    `— подтвердить ответственного со стороны клиента;\n` +
    `— прислать недостающие документы/данные по перечню эксперта;\n` +
    `— оплатить обязательные счета/пошлины и прислать платёжку, если это применимо;\n` +
    `— заранее предупредить, если срок по документам или оплате сдвигается.\n` +
    `${riskBlock}\n\n` +
    `Черновик сообщения клиенту в мессенджер:\n` +
    `${clientName}, добрый день! По вашей услуге “${service}” фиксирую ход работы.\n` +
    `С нашей стороны: проверяем комплектность данных, готовим документы/перечни и контролируем дальнейший этап: ${stage}.\n` +
    `С вашей стороны сейчас важно: прислать недостающие данные/документы и оплатить обязательные счета/пошлины, если они будут выставлены.\n` +
    `Следующий контрольный шаг: ${nextText}.\n` +
    `Если документы или оплата будут задержаны, сроки подачи/получения могут сдвинуться.\n\n` +
    `Комментарий для карточки сделки:\n` +
    `Ход работы сформирован ассистентом. Текущий этап: ${stage}. Следующий шаг: ${nextText}. Эксперту нужно подтвердить с клиентом документы, оплаты, дедлайны и зафиксировать итог первого/следующего касания.`;
}

async function generateWorkPlan() {
  if (!state.selectedDeal) return;
  state.selectedMode = 'workplan';
  state.selectedAudit = null;
  state.selectedMissing = [];
  state.selectedAnalysis = buildWorkPlanText(state.selectedDeal);
  const out = document.getElementById('analysis-result');
  out.textContent = state.selectedAnalysis;
  out.classList.remove('hidden');
  document.getElementById('write-comment').classList.remove('hidden');
  document.getElementById('create-manager-task').classList.add('hidden');
  document.getElementById('create-expert-task').classList.add('hidden');
  document.getElementById('mark-checked').classList.add('hidden');
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
  await createTask({
    title: 'Сделать первое касание клиента',
    responsibleId: d.ASSIGNED_BY_ID,
    description: `Связаться с клиентом, подтвердить ход работы, документы, оплаты, дедлайны и следующий шаг. После звонка зафиксировать итоги в комментарии сделки.\n\n${state.selectedAnalysis || ''}`,
    dealId: d.ID,
  });
}

async function createTask({ title, responsibleId, description, dealId }) {
  await bxCall('tasks.task.add', {
    fields: {
      TITLE: title,
      RESPONSIBLE_ID: Number(responsibleId),
      DESCRIPTION: description,
      UF_CRM_TASK: [`D_${dealId}`],
    }
  });
  alert('Задача создана.');
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
document.getElementById('generate-workplan').addEventListener('click', generateWorkPlan);
document.getElementById('write-comment').addEventListener('click', writeComment);
document.getElementById('create-manager-task').addEventListener('click', createManagerTask);
document.getElementById('create-expert-task').addEventListener('click', createExpertTask);
document.getElementById('mark-checked').addEventListener('click', markChecked);

init();
