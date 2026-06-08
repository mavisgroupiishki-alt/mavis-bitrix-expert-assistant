/* global BX24, APP_CONFIG */

const state = {
  user: null,
  isAdmin: false,
  isLeader: false,
  fields: {},
  fieldMap: {},
  deals: [],
  users: new Map(),
  companies: new Map(),
  selectedDeal: null,
  selectedAnalysis: '',
};

const REQUIRED_ITEMS = [
  { key: 'city', label: 'город клиента', keywords: ['город', 'адрес', 'минск', 'область'] },
  { key: 'service', label: 'какие услуги проданы', keywords: ['услуга', 'продукт', 'аттестация', 'стк', 'спк', 'iso', '45001'] },
  { key: 'kp', label: 'КП или коммерческое предложение', keywords: ['кп', 'коммерческое', 'предложение', 'счет', 'договор'] },
  { key: 'terms', label: 'что обещано клиенту по срокам', keywords: ['срок', 'срочно', 'дней', 'недел', 'до '] },
  { key: 'email', label: 'email клиента для документов', keywords: ['@', 'email', 'почта'] },
  { key: 'channel', label: 'канал связи', keywords: ['wazzup', 'whatsapp', 'viber', 'telegram', 'телеграм', 'вайбер'] },
  { key: 'fees', label: 'предупреждение о пошлинах и дополнительных счетах', keywords: ['пошлин', 'дополнительн', 'счет', 'оплат'] },
  { key: 'specialists', label: 'какие специалисты нужны / кто есть', keywords: ['специалист', 'прораб', 'мастер', 'главный инженер', 'аттестац'] },
  { key: 'transfer', label: 'кого нужно перевести на должность', keywords: ['перевести', 'перевод', 'должност'] },
  { key: 'searching', label: 'кого клиент ищет сам / кого подбирает MAVIS', keywords: ['ищет', 'подбира', 'подбор'] },
  { key: 'measurements', label: 'средства измерений', keywords: ['средств', 'измерен', 'аренд', 'прибор'] },
];

function bxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    BX24.callMethod(method, params, (result) => {
      if (result.error()) reject(new Error(`${method}: ${result.error()} ${result.error_description() || ''}`));
      else resolve(result.data());
    });
  });
}

async function bxList(method, params = {}, limit = 200) {
  const items = [];
  let start = 0;
  while (items.length < limit) {
    const page = await new Promise((resolve, reject) => {
      BX24.callMethod(method, { ...params, start }, (result) => {
        if (result.error()) reject(new Error(`${method}: ${result.error()} ${result.error_description() || ''}`));
        else resolve({ data: result.data(), next: result.more() ? result.next() : null });
      });
    });
    items.push(...(Array.isArray(page.data) ? page.data : []));
    if (!page.next) break;
    start = page.next;
  }
  return items.slice(0, limit);
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
    document.getElementById('user-line').textContent = `Пользователь: ${state.user.NAME || ''} ${state.user.LAST_NAME || ''} · ID ${state.user.ID} · режим: ${state.isAdmin || state.isLeader ? 'руководитель/админ' : 'эксперт'}`;

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

  const select = ['ID','TITLE','COMPANY_ID','CONTACT_ID','STAGE_ID','CATEGORY_ID','OPPORTUNITY','ASSIGNED_BY_ID','CREATED_BY_ID','DATE_CREATE','DATE_MODIFY'];
  Object.values(state.fieldMap).filter(Boolean).forEach((f) => { if (!select.includes(f)) select.push(f); });

  const filter = {};
  if (!(state.isAdmin || state.isLeader)) filter.ASSIGNED_BY_ID = state.user.ID;

  const deals = await bxList('crm.deal.list', {
    order: { DATE_MODIFY: 'DESC' },
    filter,
    select,
  }, Number(APP_CONFIG.maxDeals || 30));

  state.deals = deals;
  await hydrateDeals(deals);
  renderDeals();
}

async function hydrateDeals(deals) {
  const userIds = new Set();
  const companyIds = new Set();
  deals.forEach((d) => {
    if (d.ASSIGNED_BY_ID) userIds.add(d.ASSIGNED_BY_ID);
    if (d.CREATED_BY_ID) userIds.add(d.CREATED_BY_ID);
    if (d.COMPANY_ID) companyIds.add(d.COMPANY_ID);
  });
  await Promise.all([...userIds].map(async (id) => {
    try { const res = await bxCall('user.get', { ID: id }); state.users.set(String(id), Array.isArray(res) ? res[0] : res); } catch (_) {}
  }));
  await Promise.all([...companyIds].map(async (id) => {
    try { const res = await bxCall('crm.company.get', { id }); state.companies.set(String(id), res); } catch (_) {}
  }));
}

function userName(id) {
  const u = state.users.get(String(id));
  return u ? `${u.NAME || ''} ${u.LAST_NAME || ''}`.trim() || `ID ${id}` : `ID ${id || '—'}`;
}
function companyName(id) {
  const c = state.companies.get(String(id));
  return c ? c.TITLE || `ID ${id}` : `ID ${id || '—'}`;
}
function getService(deal) { return state.fieldMap.service ? val(deal[state.fieldMap.service]) : ''; }
function getStartDate(deal) { return state.fieldMap.startDate ? val(deal[state.fieldMap.startDate]) : ''; }
function getSalesLink(deal) { return state.fieldMap.salesDealLink ? val(deal[state.fieldMap.salesDealLink]) : ''; }

function renderDeals() {
  document.getElementById('loading').classList.add('hidden');
  const table = document.getElementById('deals-table');
  table.classList.remove('hidden');
  const q = normalize(document.getElementById('search').value);
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';

  const filtered = state.deals.filter((d) => normalize(`${d.TITLE} ${companyName(d.COMPANY_ID)} ${getService(d)} ${d.STAGE_ID}`).includes(q));

  filtered.forEach((deal) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(companyName(deal.COMPANY_ID))}</td>
      <td><strong>${escapeHtml(deal.TITLE || '')}</strong><br><span class="muted">ID ${deal.ID}</span></td>
      <td>${escapeHtml(getService(deal) || '—')}</td>
      <td><span class="badge">${escapeHtml(deal.STAGE_ID || '—')}</span></td>
      <td>${escapeHtml(deal.OPPORTUNITY || '0')}</td>
      <td>${escapeHtml(getStartDate(deal) || '—')}</td>
      <td>${escapeHtml(userName(deal.ASSIGNED_BY_ID))}</td>
      <td>${escapeHtml(deal.DATE_MODIFY || '—')}</td>
      <td>
        <button class="secondary" data-open="${deal.ID}">Открыть</button>
        <button class="primary" data-check="${deal.ID}">Проверить</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('count-all').textContent = state.deals.length;
  document.getElementById('count-no-activity').textContent = '—';
  document.getElementById('count-stale').textContent = state.deals.filter((d) => daysSince(d.DATE_MODIFY) >= 2).length;
  document.getElementById('count-check').textContent = state.deals.length;
}

async function openDeal(id) {
  const deal = state.deals.find((d) => String(d.ID) === String(id)) || await bxCall('crm.deal.get', { id });
  state.selectedDeal = deal;
  state.selectedAnalysis = '';
  document.getElementById('dialog-title').textContent = deal.TITLE || `Сделка ${id}`;
  document.getElementById('analysis-result').classList.add('hidden');
  ['write-comment','create-manager-task','create-expert-task'].forEach((x) => document.getElementById(x).classList.add('hidden'));
  document.getElementById('deal-details').innerHTML = detailHtml(deal);
  document.getElementById('deal-dialog').showModal();
}

function detailHtml(deal) {
  const fields = [
    ['Компания', companyName(deal.COMPANY_ID)],
    ['Услуга', getService(deal) || '—'],
    ['Стадия', deal.STAGE_ID || '—'],
    ['Сумма', deal.OPPORTUNITY || '0'],
    ['Дата начала оказания услуг', getStartDate(deal) || '—'],
    ['Ответственный', userName(deal.ASSIGNED_BY_ID)],
    ['Кто создал сделку', userName(deal.CREATED_BY_ID)],
    ['Ссылка на сделку отдела продаж', getSalesLink(deal) || '—'],
  ];
  return fields.map(([k, v]) => `<div class="detail"><span>${escapeHtml(k)}</span>${escapeHtml(v)}</div>`).join('');
}

async function checkHandoff() {
  if (!state.selectedDeal) return;
  const deal = state.selectedDeal;
  const productionText = await collectDealText(deal.ID, deal);

  let salesText = '';
  const salesId = extractDealId(getSalesLink(deal) || productionText);
  if (salesId && String(salesId) !== String(deal.ID)) {
    try {
      const salesDeal = await bxCall('crm.deal.get', { id: salesId });
      salesText = await collectDealText(salesId, salesDeal);
    } catch (e) {
      salesText = `Не удалось открыть связанную сделку продаж ID ${salesId}: ${e.message}`;
    }
  }

  const text = `${productionText}\n\n--- СВЯЗАННАЯ СДЕЛКА ПРОДАЖ ---\n${salesText}`;
  const found = [];
  const missing = [];
  REQUIRED_ITEMS.forEach((item) => {
    const source = item.key === 'service' && getService(deal) ? 'поле “Услуга” производственной сделки' : findSource(text, item.keywords);
    if (source) found.push({ label: item.label, source });
    else missing.push(item.label);
  });

  const status = missing.length ? 'есть ошибки передачи' : 'готова к производству';
  const risks = missing.length
    ? [
        'эксперту придётся повторно уточнять базовую информацию у клиента',
        'может сдвинуться запуск производства',
        'есть риск расхождения между обещаниями продаж и фактическим процессом',
      ]
    : ['критичных рисков передачи по найденным данным не выявлено'];

  state.selectedAnalysis = formatAnalysis(status, found, missing, risks, deal);
  const out = document.getElementById('analysis-result');
  out.textContent = state.selectedAnalysis;
  out.classList.remove('hidden');
  document.getElementById('write-comment').classList.remove('hidden');
  document.getElementById('create-manager-task').classList.toggle('hidden', !missing.length);
  document.getElementById('create-expert-task').classList.remove('hidden');
}

async function collectDealText(id, deal) {
  const chunks = [`Сделка ID ${id}: ${JSON.stringify(deal, null, 2)}`];
  try {
    const comments = await bxList('crm.timeline.comment.list', { filter: { ENTITY_ID: id, ENTITY_TYPE: 'deal' }, order: { ID: 'DESC' } }, 50);
    chunks.push('Комментарии таймлайна:\n' + comments.map((c) => `${c.CREATED || c.DATE_CREATE || ''}: ${c.COMMENT || c.TEXT || JSON.stringify(c)}`).join('\n'));
  } catch (e) {
    chunks.push(`Комментарии таймлайна недоступны: ${e.message}`);
  }
  try {
    const acts = await bxList('crm.activity.list', { filter: { OWNER_ID: id, OWNER_TYPE_ID: 2 }, order: { ID: 'DESC' }, select: ['ID','SUBJECT','DESCRIPTION','CREATED','DEADLINE','TYPE_ID','PROVIDER_ID'] }, 50);
    chunks.push('Дела/активности:\n' + acts.map((a) => `${a.CREATED || ''}: ${a.SUBJECT || ''} ${a.DESCRIPTION || ''}`).join('\n'));
  } catch (e) {
    chunks.push(`Активности недоступны: ${e.message}`);
  }
  return chunks.join('\n\n');
}

function findSource(text, keywords) {
  const lower = normalize(text);
  const hit = keywords.find((k) => lower.includes(k));
  if (!hit) return null;
  if (lower.includes('связанная сделка продаж') && lower.indexOf(hit) > lower.indexOf('связанная сделка продаж')) return `связанная сделка продаж / найдено слово “${hit}”`;
  return `производственная сделка или история / найдено слово “${hit}”`;
}

function formatAnalysis(status, found, missing, risks, deal) {
  return `ИИ-проверка передачи сделки в производство\n\n` +
    `Сделка: ${deal.TITLE || ''}\n` +
    `Компания: ${companyName(deal.COMPANY_ID)}\n` +
    `Услуга: ${getService(deal) || '—'}\n\n` +
    `Статус: ${status}\n\n` +
    `Что найдено:\n${found.length ? found.map((x) => `— ${x.label}; источник: ${x.source}`).join('\n') : '— данных не найдено'}\n\n` +
    `Чего не хватает:\n${missing.length ? missing.map((x) => `— ${x}; важно для запуска производства и чтобы эксперт не уточнял базу повторно`).join('\n') : '— критичных пробелов не найдено'}\n\n` +
    `Риски:\n${risks.map((x) => `— ${x}`).join('\n')}\n\n` +
    `Что нужно сделать:\n` +
    (missing.length
      ? `— менеджеру дозаполнить/подтвердить недостающие данные;\n— эксперту при первом касании подтвердить спорные пункты;\n— при системной ошибке передачи — разобрать с РОП.`
      : `— эксперту сделать первое касание клиента;\n— зафиксировать ход работы, документы, оплаты, дедлайны и следующий шаг.`);
}

async function writeComment() {
  if (!state.selectedDeal || !state.selectedAnalysis) return;
  await bxCall('crm.timeline.comment.add', {
    fields: { ENTITY_ID: Number(state.selectedDeal.ID), ENTITY_TYPE: 'deal', COMMENT: state.selectedAnalysis }
  });
  alert('Комментарий записан в сделку.');
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

function extractDealId(text) {
  const s = String(text || '');
  const m = s.match(/deal\/details\/(\d+)/i) || s.match(/\bD_(\d+)\b/i) || s.match(/\bdeal_id=(\d+)\b/i);
  return m ? m[1] : null;
}
function daysSince(dateString) {
  if (!dateString) return 999;
  const d = new Date(dateString);
  if (Number.isNaN(d.getTime())) return 999;
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function showError(message) { document.getElementById('loading').classList.add('hidden'); const el = document.getElementById('error'); el.textContent = message; el.classList.remove('hidden'); }
function hideError() { document.getElementById('error').classList.add('hidden'); }

document.getElementById('reload').addEventListener('click', loadDeals);
document.getElementById('search').addEventListener('input', renderDeals);
document.getElementById('deals-table').addEventListener('click', (e) => {
  const openId = e.target.getAttribute('data-open') || e.target.getAttribute('data-check');
  if (openId) openDeal(openId).then(() => {
    if (e.target.getAttribute('data-check')) checkHandoff();
  });
});
document.getElementById('close-dialog').addEventListener('click', () => document.getElementById('deal-dialog').close());
document.getElementById('check-handoff').addEventListener('click', checkHandoff);
document.getElementById('write-comment').addEventListener('click', writeComment);
document.getElementById('create-manager-task').addEventListener('click', createManagerTask);
document.getElementById('create-expert-task').addEventListener('click', createExpertTask);

init();
