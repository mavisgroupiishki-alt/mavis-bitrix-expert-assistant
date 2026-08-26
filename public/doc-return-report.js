/* global BX24 */

const state = {
  auth: null,
  user: null,
  raw: [],
  filtered: [],
  stages: [],
  expandedCompany: '',
  loadedAt: null,
  activeTab: 'control',
  mailing: { loaded: false, loading: false, responses: [], categories: [], events: [], scanReady: false, scanScanning: false, scanError: '' },
  history: { loaded: false, loading: false, ready: false, scanning: false, months: [], error: '' },
  editingTaskId: '',
  companySearchTimer: null,
  responseCategoryTouched: false,
};

const MONTHS = [
  [1, 'Январь'], [2, 'Февраль'], [3, 'Март'], [4, 'Апрель'], [5, 'Май'], [6, 'Июнь'],
  [7, 'Июль'], [8, 'Август'], [9, 'Сентябрь'], [10, 'Октябрь'], [11, 'Ноябрь'], [12, 'Декабрь'],
];
const CACHE_KEY = 'mavis:return-originals:v114:snapshot'; // stable key: не теряем мгновенный снимок после обновления версии
const MAILING_CAMPAIGN_START = new Date('2026-08-26T00:00:00+03:00');
const els = {};

function qs(id) { return document.getElementById(id); }
function fmtNum(value) { return new Intl.NumberFormat('ru-RU').format(Number(value || 0)); }
function fmtPct(part, total) { return total ? `${((Number(part || 0) / Number(total)) * 100).toFixed(1).replace('.', ',')}%` : '0,0%'; }
function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}
function fmtDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return String(value);
  return new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);
}
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function normalize(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/gi, ' ').trim();
}
function monthLabel(month) { return MONTHS.find(([id]) => Number(id) === Number(month))?.[1] || String(month); }
function todayIso() { return new Date().toISOString().slice(0, 10); }
function uniqueSorted(values) { return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ru')); }
function byId(rows) { return new Map((rows || []).map((r) => [String(r.taskId), r])); }

function bxCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    BX24.callMethod(method, params, (result) => {
      if (result.error()) reject(new Error(result.error_description ? result.error_description() : result.error()));
      else resolve(result.data());
    });
  });
}
async function initBitrix() {
  await new Promise((resolve) => BX24.init(resolve));
  let auth = BX24.getAuth();
  if (!auth) auth = await new Promise((resolve) => BX24.refreshAuth(resolve));
  if (!auth || !auth.access_token || !auth.domain) throw new Error('Не удалось получить авторизацию Bitrix24. Откройте отчёт через пункт приложения в Bitrix24.');
  state.auth = auth;
  try { state.user = await bxCall('user.current'); } catch (_) {}
}
function authHeaders() {
  return { 'x-b24-domain': state.auth.domain, 'x-b24-auth': state.auth.access_token, 'x-b24-member': state.auth.member_id || '' };
}
async function apiFetch(url, options = {}, retry = true) {
  const headers = { ...(options.headers || {}), ...authHeaders() };
  if (options.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401 && retry) {
    state.auth = await new Promise((resolve) => BX24.refreshAuth(resolve));
    return apiFetch(url, options, false);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function populateMonthSelect(select, includeAll = true) {
  select.innerHTML = (includeAll ? '<option value="all">Все месяцы</option>' : '') + MONTHS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
}
function populateStaticFilters() {
  populateMonthSelect(els.month);
  populateMonthSelect(els.mailingMonth);
}
function populateDynamicFilters() {
  const current = { company: els.company.value, expert: els.expert.value, stage: els.stage.value, type: els.type.value };
  const optionList = (values, allLabel) => `<option value="all">${allLabel}</option>` + values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join('');
  els.company.innerHTML = optionList(uniqueSorted(state.raw.map((r) => r.companyName)), 'Все компании');
  els.expert.innerHTML = optionList(uniqueSorted(state.raw.map((r) => r.expert)), 'Все эксперты');
  els.stage.innerHTML = optionList(uniqueSorted(state.raw.map((r) => r.stageName)), 'Все стадии');
  els.type.innerHTML = optionList(uniqueSorted(state.raw.map((r) => r.documentType)), 'Все типы');
  for (const [key, value] of Object.entries(current)) if ([...els[key].options].some((opt) => opt.value === value)) els[key].value = value;
}
function populateMailingCategories() {
  const categories = state.mailing.categories.length ? state.mailing.categories : ['Вышлет в ближайшее время','Ошибка / переотправить документ','Услуга не оказана','Возврат','Другое'];
  els.mailingCategory.innerHTML = '<option value="all">Все категории</option>' + categories.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
  els.responseAddCategory.innerHTML = categories.map((x) => `<option value="${escapeHtml(x)}">${escapeHtml(x)}</option>`).join('');
}

function readFilters() {
  return {
    year: els.year.value, month: els.month.value, from: els.from.value, to: els.to.value,
    company: els.company.value, expert: els.expert.value, stage: els.stage.value, type: els.type.value,
    overdue: els.overdue.value, search: els.search.value.trim().toLowerCase(),
  };
}
function applyFilters() {
  const f = readFilters();
  const fromMs = f.from ? new Date(`${f.from}T00:00:00`).getTime() : null;
  const toMs = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : null;
  state.filtered = state.raw.filter((row) => {
    const created = row.createdAt ? new Date(row.createdAt) : null;
    const createdMs = created && Number.isFinite(created.getTime()) ? created.getTime() : null;
    if (f.year !== 'all' && String(row.createdYear || '') !== f.year) return false;
    if (f.month !== 'all' && String(row.createdMonth || '') !== f.month) return false;
    if (fromMs != null && (createdMs == null || createdMs < fromMs)) return false;
    if (toMs != null && (createdMs == null || createdMs > toMs)) return false;
    if (f.company !== 'all' && row.companyName !== f.company) return false;
    if (f.expert !== 'all' && row.expert !== f.expert) return false;
    if (f.stage !== 'all' && row.stageName !== f.stage) return false;
    if (f.type !== 'all' && row.documentType !== f.type) return false;
    if (f.overdue === 'yes' && !row.overdue) return false;
    if (f.overdue === 'no' && row.overdue) return false;
    if (f.search) {
      const hay = `${row.companyName} ${row.title} ${row.expert} ${row.stageName} ${row.serviceArticle || ''}`.toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  });
  renderControl();
}
function currentPeriodText() {
  const f = readFilters(); const parts = [];
  if (f.year !== 'all') parts.push(f.year);
  if (f.month !== 'all') parts.push(monthLabel(f.month));
  if (f.from || f.to) parts.push(`${f.from ? fmtDate(f.from) : '…'} — ${f.to ? fmtDate(f.to) : '…'}`);
  return parts.length ? parts.join(' · ') : 'Все время';
}

function controlRows(rows = state.filtered) {
  return rows.filter((r) => r.stageGroup === 'early' || r.stageGroup === 'control');
}
function sentAndReturnedRows(rows = state.filtered) {
  return rows.filter((r) => String(r.stageId) === '1132' || r.stageGroup === 'control' || r.stageGroup === 'returned');
}

function renderKpis() {
  const rows = state.filtered;
  const active = controlRows(rows);
  const early = rows.filter((r) => r.stageGroup === 'early').length;
  const control = rows.filter((r) => r.stageGroup === 'control').length;
  const returned = rows.filter((r) => r.stageGroup === 'returned').length;
  const sentBaseRows = sentAndReturnedRows(rows);
  const sentBase = sentBaseRows.length;
  const notReturnedAfterSend = sentBaseRows.filter((r) => r.stageGroup !== 'returned').length;
  const overdue = active.filter((r) => r.overdue).length;
  const email = active.filter((r) => String(r.stageId) === '1126' || /эл\.\s*почта/i.test(r.stageName)).length;
  const call = active.filter((r) => String(r.stageId) === '1128' || /^звонок$/i.test(r.stageName)).length;
  const companies = new Set(active.map((r) => r.companyId || `name:${r.companyName}`)).size;
  els.kpiEarly.textContent = fmtNum(early);
  els.kpiControl.textContent = fmtNum(control);
  els.kpiReturned.textContent = fmtNum(returned);
  els.kpiNotReturnedShare.textContent = fmtPct(notReturnedAfterSend, sentBase);
  els.kpiNotReturnedCount.textContent = `${fmtNum(notReturnedAfterSend)} из ${fmtNum(sentBase)} отправленных`;
  els.kpiReturnedShare.textContent = fmtPct(returned, sentBase);
  els.kpiSentBase.textContent = `${fmtNum(returned)} из ${fmtNum(sentBase)} отправленных`;
  els.kpiOverdue.textContent = fmtNum(overdue);
  els.kpiOverdueShare.textContent = `${fmtPct(overdue, active.length)} от невозвращённых`;
  els.kpiEmail.textContent = fmtNum(email);
  els.kpiCall.textContent = fmtNum(call);
  els.kpiCompanies.textContent = fmtNum(companies);
  els.periodLabel.textContent = `Период создания: ${currentPeriodText()} · вернувшиеся учитываются отдельно`;
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) { const key = keyFn(row) || 'Не определено'; map.set(key, (map.get(key) || 0) + 1); }
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'ru'));
}
function renderBars(container, data, maxItems = 10, className = '') {
  const rows = data.slice(0, maxItems); const max = Math.max(1, ...rows.map((r) => r.value));
  container.innerHTML = rows.length ? rows.map((row) => `
    <div class="bar-item" title="${escapeHtml(row.label)}: ${fmtNum(row.value)}">
      <div class="bar-label">${escapeHtml(row.label)}</div>
      <div class="bar-track"><div class="bar-fill ${className}" style="width:${Math.max(1.5, (row.value / max) * 100)}%"></div></div>
      <div class="bar-value">${fmtNum(row.value)}</div>
    </div>`).join('') : '<div class="empty-state">Нет данных по выбранным фильтрам</div>';
}
function groupCompanies(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.companyId || `name:${row.companyName}`;
    if (!map.has(key)) map.set(key, { key, id: row.companyId, name: row.companyName, expert: row.expert, rows: [], overdue: 0, email: 0, call: 0, oldest: row.createdAt });
    const item = map.get(key); item.rows.push(row);
    if (row.overdue) item.overdue++;
    if (String(row.stageId) === '1126' || /эл\.\s*почта/i.test(row.stageName)) item.email++;
    if (String(row.stageId) === '1128' || /^звонок$/i.test(row.stageName)) item.call++;
    if ((!item.oldest && row.createdAt) || (row.createdAt && new Date(row.createdAt) < new Date(item.oldest))) item.oldest = row.createdAt;
    if (row.expert && row.expert !== 'Не определён') item.expert = row.expert;
  }
  return [...map.values()].sort((a, b) => b.rows.length - a.rows.length || b.overdue - a.overdue || a.name.localeCompare(b.name, 'ru'));
}
function renderCompanyDocuments(company) {
  const sorted = [...company.rows].sort((a, b) => Number(b.overdue) - Number(a.overdue) || String(a.createdAt).localeCompare(String(b.createdAt)));
  return `<div class="docs-wrap"><table class="docs-table"><thead><tr><th>Документ</th><th>Тип</th><th>Статья услуги</th><th>Стадия</th><th>Создан</th><th>Дедлайн</th><th>Эксперт</th><th></th></tr></thead><tbody>
    ${sorted.map((row) => `<tr>
      <td class="doc-title">${escapeHtml(row.title)}</td>
      <td><span class="type-chip">${escapeHtml(row.documentType)}</span></td>
      <td>${escapeHtml(row.serviceArticle || '—')}</td>
      <td><span class="stage-chip">${escapeHtml(row.stageName)}</span></td>
      <td>${fmtDate(row.createdAt)}</td><td>${fmtDate(row.deadline)}</td><td>${escapeHtml(row.expert)}</td>
      <td><div class="doc-actions"><button class="link-btn task-edit-btn" data-task="${row.taskId}">Редактировать</button><button class="link-btn open-task" data-url="${escapeHtml(row.taskUrl)}">Открыть</button><button class="link-btn history-btn" data-task="${row.taskId}" data-title="${escapeHtml(row.title)}">История</button></div></td>
    </tr>`).join('')}
  </tbody></table></div>`;
}
function renderCompanies(rows = controlRows(state.filtered)) {
  const companies = groupCompanies(rows);
  els.companySummary.textContent = `${fmtNum(companies.length)} компаний · ${fmtNum(rows.length)} невозвращённых документов`;
  if (!companies.length) { els.companies.innerHTML = '<div class="empty-state">По выбранным фильтрам ничего не найдено</div>'; return; }
  els.companies.innerHTML = companies.map((company) => {
    const open = state.expandedCompany === company.key;
    return `<div class="company-group" data-key="${escapeHtml(company.key)}">
      <div class="company-row ${open ? 'open' : ''}" data-company-key="${escapeHtml(company.key)}">
        <div class="company-name"><span class="chevron">›</span><span class="company-name-text">${escapeHtml(company.name)}</span></div>
        <div class="expert-name">${escapeHtml(company.expert)}</div><div><span class="count-pill">${fmtNum(company.rows.length)}</span></div>
        <div><span class="count-pill overdue">${fmtNum(company.overdue)}</span></div><div><span class="count-pill email">${fmtNum(company.email)}</span></div>
        <div><span class="count-pill call">${fmtNum(company.call)}</span></div><div class="oldest">${fmtDate(company.oldest)}</div>
      </div>${open ? renderCompanyDocuments(company) : ''}</div>`;
  }).join('');
}
function qualityRows(kind) {
  const rows = controlRows(state.filtered);
  if (kind === 'unmatched') return rows.filter((r) => !r.companyId);
  if (kind === 'noDeadline') return rows.filter((r) => !r.deadline);
  if (kind === 'older90') return rows.filter((r) => Number(r.ageDays || 0) >= 90);
  if (kind === 'older180') return rows.filter((r) => Number(r.ageDays || 0) >= 180);
  return [];
}
function renderQuality() {
  const cards = [
    ['unmatched', 'Компания не определена', 'danger'], ['noDeadline', 'Без дедлайна', 'warning'],
    ['older90', 'В работе 90+ дней', ''], ['older180', 'В работе 180+ дней', ''],
  ];
  els.quality.innerHTML = cards.map(([kind, label, cls]) => `<button class="insight insight-button ${cls}" data-quality-kind="${kind}"><strong>${fmtNum(qualityRows(kind).length)}</strong><span>${label}</span><small>Нажмите, чтобы открыть список</small></button>`).join('');
}
function renderControl() {
  renderKpis();
  const active = controlRows(state.filtered);
  renderBars(els.stageBars, countBy(active, (r) => r.stageName), 14);
  renderBars(els.topCompanies, groupCompanies(active).map((c) => ({ label: c.name, value: c.rows.length })), 10, 'red');
  renderBars(els.expertBars, countBy(active, (r) => r.expert), 12, 'green');
  renderQuality();
  renderCompanies(active);
  try { BX24.fitWindow && BX24.fitWindow(); } catch (_) {}
}

function openQuality(kind) {
  const labels = { unmatched: 'Компания не определена', noDeadline: 'Без дедлайна', older90: 'В работе 90+ дней', older180: 'В работе 180+ дней' };
  const rows = qualityRows(kind);
  els.qualityTitle.textContent = labels[kind] || 'Контроль качества базы';
  els.qualityMeta.textContent = `${fmtNum(rows.length)} задач · период создания: ${currentPeriodText()}`;
  els.qualityContent.innerHTML = rows.length ? `<div class="quality-table-wrap"><table class="docs-table quality-table"><thead><tr><th>Компания</th><th>Документ / задача</th><th>Стадия</th><th>Создан</th><th>Дедлайн</th><th>Эксперт</th><th></th></tr></thead><tbody>
    ${rows.map((row) => `<tr><td class="${row.companyId ? '' : 'danger-text'}">${escapeHtml(row.companyId ? row.companyName : 'Не определена')}</td><td class="doc-title">${escapeHtml(row.title)}</td><td><span class="stage-chip">${escapeHtml(row.stageName)}</span></td><td>${fmtDate(row.createdAt)}</td><td>${fmtDate(row.deadline)}</td><td>${escapeHtml(row.expert)}</td><td><div class="doc-actions"><button class="link-btn task-edit-btn" data-task="${row.taskId}">Определить / изменить</button><button class="link-btn open-task" data-url="${escapeHtml(row.taskUrl)}">Открыть задачу</button></div></td></tr>`).join('')}
  </tbody></table></div>` : '<div class="empty-state">Нет задач в этой категории</div>';
  els.qualityDialog.showModal();
}

function fastHistoryRows() {
  const year = Number(els.year && els.year.value !== 'all' ? els.year.value : 2026);
  const now = new Date();
  const maxMonth = year === now.getFullYear() ? now.getMonth() + 1 : 12;
  const rows = [];
  for (let month = 1; month <= maxMonth; month++) {
    const cohort = state.raw.filter((r) => {
      const d = new Date(r.createdAt || 0);
      return Number.isFinite(d.getTime()) && d.getFullYear() === year && d.getMonth() + 1 === month && (String(r.stageId) === '1132' || r.stageGroup === 'control' || r.stageGroup === 'returned');
    });
    const sent = cohort.length;
    const returned = cohort.filter((r) => r.stageGroup === 'returned').length;
    rows.push({ year, month, sentNew: sent, returnedNew: returned, outstanding: Math.max(0, sent - returned), returnRate: sent ? Number((returned / sent * 100).toFixed(1)) : 0 });
  }
  return rows;
}
function renderFastHistoryChart(rows) {
  if (!rows.length) return '';
  const W=980,H=280,L=48,R=18,T=20,B=38;
  const max=Math.max(1,...rows.flatMap(r=>[r.sentNew,r.returnedNew,r.outstanding]));
  const x=(i)=>L+(rows.length===1?0:i*(W-L-R)/(rows.length-1));
  const y=(v)=>T+(H-T-B)*(1-v/max);
  const line=(key)=>rows.map((r,i)=>`${i?'L':'M'} ${x(i).toFixed(1)} ${y(r[key]).toFixed(1)}`).join(' ');
  const grid=[0,.25,.5,.75,1].map(fr=>{const yy=y(max*fr);return `<line x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}" stroke="#e8edf5"/><text x="${L-7}" y="${yy+4}" text-anchor="end" font-size="11" fill="#78869d">${Math.round(max*fr)}</text>`;}).join('');
  const labels=rows.map((r,i)=>`<text x="${x(i)}" y="${H-10}" text-anchor="middle" font-size="11" fill="#78869d">${monthLabel(r.month).slice(0,3)}</text>`).join('');
  return `<div class="fast-chart-wrap"><div class="fast-chart-legend"><span>● Отправлено</span><span>● Вернулось</span><span>● Не вернулось</span></div><svg viewBox="0 0 ${W} ${H}" class="fast-chart-svg">${grid}${labels}<path d="${line('sentNew')}" fill="none" stroke="#2f80ed" stroke-width="4"/><path d="${line('returnedNew')}" fill="none" stroke="#34a875" stroke-width="4"/><path d="${line('outstanding')}" fill="none" stroke="#e45c72" stroke-width="4"/></svg></div>`;
}
async function loadHistoryIndex() {
  state.history.loaded = true;
  state.history.ready = true;
  state.history.scanning = false;
  state.history.error = '';
  state.history.months = fastHistoryRows();
  renderHistoryMonths();
}
function renderHistoryMonths() {
  const rows = fastHistoryRows();
  state.history.months = rows;
  if (els.historyStatus) els.historyStatus.textContent = 'График строится сразу по текущему снимку — без 10-минутного расчёта истории.';
  if (!els.historyMonths) return;
  els.historyMonths.innerHTML = renderFastHistoryChart(rows) + (rows.length ? `<table class="summary-table"><thead><tr><th>Месяц</th><th>Отправлено</th><th>Вернулось</th><th>Не вернулось</th><th>% возврата</th></tr></thead><tbody>${rows.map((r)=>`<tr><td>${monthLabel(r.month)}</td><td>${fmtNum(r.sentNew)}</td><td>${fmtNum(r.returnedNew)}</td><td class="strong-cell">${fmtNum(r.outstanding)}</td><td>${String(r.returnRate).replace('.', ',')}%</td></tr>`).join('')}</tbody></table>` : '<div class="empty-state">Нет данных</div>');
}

function mailingPeriodFilter(dateValue) {
  if (!dateValue) return false;
  const d = new Date(dateValue); if (!Number.isFinite(d.getTime())) return false;
  const y = els.mailingYear.value; const m = els.mailingMonth.value;
  if (y !== 'all' && String(d.getFullYear()) !== y) return false;
  if (m !== 'all' && String(d.getMonth() + 1) !== m) return false;
  return true;
}
function filteredMailingEvents() { return state.mailing.events.filter((e) => mailingPeriodFilter(e.sentAt)); }
function filteredResponses(ignoreCategory = false) {
  const cat = els.mailingCategory.value;
  return state.mailing.responses.filter((r) => mailingPeriodFilter(r.responseDate) && (ignoreCategory || cat === 'all' || r.category === cat));
}
function mailingCounts() {
  const events = filteredMailingEvents(); const responses = filteredResponses(true);
  const uniqueDocs = new Set(events.map((e) => String(e.taskId)).filter(Boolean)).size;
  const countCat = (name) => responses.filter((r) => r.category === name).length;
  return {
    uniqueDocs, emails: events.length, responses: responses.length,
    soon: countCat('Вышлет в ближайшее время'), error: countCat('Ошибка / переотправить документ'),
    noService: countCat('Услуга не оказана'), refund: countCat('Возврат'), other: countCat('Другое'),
  };
}
function mailingCard(title, value, total, cls = '') {
  const share = total != null ? fmtPct(value, total) : '';
  return `<article class="mailing-kpi ${cls}"><span>${escapeHtml(title)}</span><strong>${fmtNum(value)}</strong>${total != null ? `<small>${share} от отправленных документов</small>` : ''}</article>`;
}
function renderMailingKpis() {
  const c = mailingCounts();
  els.mailingKpis.innerHTML = [
    mailingCard('Отправлено документов', c.uniqueDocs, null, 'blue'),
    mailingCard('Писем отправлено всего', c.emails, null, 'purple'),
    mailingCard('Ответило всего', c.responses, c.uniqueDocs, 'teal'),
    mailingCard('Вышлют в ближайшее время', c.soon, c.uniqueDocs, 'green'),
    mailingCard('Ошибка / переотправка', c.error, c.uniqueDocs, 'amber'),
    mailingCard('Услуга не оказана', c.noService, c.uniqueDocs, 'red'),
    mailingCard('Запросили возврат', c.refund, c.uniqueDocs, 'pink'),
    mailingCard('Другое', c.other, c.uniqueDocs, 'gray'),
  ].join('');
}
function renderMailingMonthly() {
  const events = state.mailing.events; const responses = state.mailing.responses;
  const keys = new Set();
  for (const e of events) { const d = new Date(e.sentAt); if (Number.isFinite(d.getTime())) keys.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`); }
  for (const r of responses) { const d = new Date(r.responseDate); if (Number.isFinite(d.getTime())) keys.add(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`); }
  const rows = [...keys].sort().map((key) => {
    const [y, m] = key.split('-').map(Number); const ev = events.filter((e) => { const d = new Date(e.sentAt); return d.getFullYear() === y && d.getMonth()+1 === m; });
    const rr = responses.filter((r) => { const d = new Date(r.responseDate); return Number.isFinite(d.getTime()) && d.getFullYear() === y && d.getMonth()+1 === m; });
    const docs = new Set(ev.map((e) => String(e.taskId))).size; const cat = (x) => rr.filter((r) => r.category === x).length;
    return { y, m, docs, emails: ev.length, answers: rr.length, soon:cat('Вышлет в ближайшее время'), error:cat('Ошибка / переотправить документ'), noService:cat('Услуга не оказана'), refund:cat('Возврат'), other:cat('Другое') };
  });
  els.mailingMonthly.innerHTML = rows.length ? `<table class="summary-table"><thead><tr><th>Месяц</th><th>Отправлено документов</th><th>Писем</th><th>Ответило</th><th>% ответов</th><th>Вышлют</th><th>Ошибка</th><th>Услуга не оказана</th><th>Возврат</th><th>Другое</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${monthLabel(r.m)} ${r.y}</td><td>${fmtNum(r.docs)}</td><td>${fmtNum(r.emails)}</td><td>${fmtNum(r.answers)}</td><td>${fmtPct(r.answers,r.docs)}</td><td>${fmtNum(r.soon)}</td><td>${fmtNum(r.error)}</td><td>${fmtNum(r.noService)}</td><td>${fmtNum(r.refund)}</td><td>${fmtNum(r.other)}</td></tr>`).join('')}
  </tbody></table>` : '<div class="empty-state">Пока нет данных по рассылке</div>';
}
function inputCell(value, field, type = 'text', extra = '') { return `<input class="sheet-input" data-field="${field}" type="${type}" value="${escapeHtml(value || '')}" ${extra}>`; }
function renderResponsesTable() {
  const rows = filteredResponses(false); const categories = state.mailing.categories;
  if (!rows.length) { els.responsesTable.innerHTML = '<div class="empty-state">Нет ответов по выбранным фильтрам</div>'; return; }
  els.responsesTable.innerHTML = `<table class="sheet-table"><thead><tr><th>Дата</th><th>Компания</th><th>ID задачи</th><th>Документ</th><th>Категория</th><th>Статья услуги</th><th>Уточнение</th><th>Комментарий</th><th>Статус</th><th>Эксперт</th><th></th></tr></thead><tbody>
    ${rows.map((r) => `<tr data-response-id="${escapeHtml(r.id)}">
      <td>${inputCell(r.responseDate,'responseDate','date')}</td><td>${inputCell(r.companyName,'companyName')}</td><td>${inputCell(r.taskId || r.suggestedTaskId || '','taskId')}</td><td>${inputCell(r.documentTitle,'documentTitle')}</td>
      <td><select class="sheet-select" data-field="category">${categories.map((c) => `<option value="${escapeHtml(c)}" ${c===r.category?'selected':''}>${escapeHtml(c)}</option>`).join('')}</select></td>
      <td>${inputCell(r.serviceArticle,'serviceArticle')}</td><td>${inputCell(r.detail,'detail')}</td><td><textarea class="sheet-textarea" data-field="comment">${escapeHtml(r.comment||'')}</textarea></td><td>${inputCell(r.status,'status')}</td><td>${escapeHtml(r.expert||'—')}</td>
      <td><div class="sheet-actions"><button class="link-btn response-save-btn">Сохранить</button><button class="link-btn danger-link response-delete-btn">Удалить</button></div></td>
    </tr>`).join('')}
  </tbody></table>`;
}
function renderMailing() {
  if (!state.mailing.loaded) return;
  renderMailingKpis(); renderMailingMonthly(); renderResponsesTable();
  const scanText = state.mailing.scanError ? `Ошибка подсчёта рассылки: ${state.mailing.scanError}` : state.mailing.scanReady ? `Рассылка посчитана строго по подтверждённым служебным сообщениям: ${fmtNum(state.mailing.events.length)} email.` : state.mailing.scanScanning ? 'Считаю только подтверждённую рассылку по служебным сообщениям в задачах…' : 'Рассылка ещё не рассчитана.';
  els.mailingStatus.textContent = scanText;
  renderReturns();
}
function provisionalMailingEvents() {
  // v117: стадия НЕ считается фактом рассылки. Нужна подтверждающая служебная запись в задаче.
  return [];
}

async function loadMailing(force = false) {
  if (state.mailing.loading) return; state.mailing.loading = true;
  try {
    if (force) await apiFetch('/api/doc-return-report/mailing/refresh', { method:'POST', body:'{}' });
    const data = await apiFetch('/api/doc-return-report/mailing');
    state.mailing.loaded = true; state.mailing.responses = Array.isArray(data.responses) ? data.responses : []; state.mailing.categories = Array.isArray(data.categories) ? data.categories : [];
    const scan = data.scan || {}; state.mailing.events = Array.isArray(scan.events) ? scan.events : []; state.mailing.scanReady = Boolean(scan.ready); state.mailing.scanScanning = Boolean(scan.scanning); state.mailing.scanError = scan.error || ''; if (!state.mailing.scanReady) state.mailing.events = [];
    populateMailingCategories(); renderMailing();
    if (!state.mailing.scanReady && state.mailing.scanScanning) setTimeout(() => loadMailing(false), 5000);
  } catch (e) { els.mailingStatus.textContent = `Ошибка: ${e.message || e}`; }
  finally { state.mailing.loading = false; }
}
async function saveResponseRow(tr) {
  const id = tr.dataset.responseId; const data = {};
  tr.querySelectorAll('[data-field]').forEach((el) => { data[el.dataset.field] = el.value; });
  data.deleted = false;
  const result = await apiFetch('/api/doc-return-report/record', { method:'POST', body:JSON.stringify({ kind:'response', key:id, data }) });
  const idx = state.mailing.responses.findIndex((r) => r.id === id); if (idx >= 0) state.mailing.responses[idx] = { ...state.mailing.responses[idx], ...data, id: result.key || id };
  renderMailing();
}
async function deleteResponseRow(tr) {
  if (!confirm('Удалить эту строку из отчёта?')) return;
  const id = tr.dataset.responseId; const old = state.mailing.responses.find((r) => r.id === id) || {};
  await apiFetch('/api/doc-return-report/record', { method:'POST', body:JSON.stringify({ kind:'response', key:id, data:{ ...old, deleted:true } }) });
  state.mailing.responses = state.mailing.responses.filter((r) => r.id !== id); renderMailing();
}

function renderReturns() {
  if (!els.returnsTable) return;
  const taskCases = state.raw.filter((r) => String(r.stageId) === '1588' || /потенциальный возврат/i.test(r.stageName) || /возврат/i.test(r.returnStatus || ''));
  const responseCases = state.mailing.loaded ? state.mailing.responses.filter((r) => r.category === 'Возврат') : [];
  const total = taskCases.length + responseCases.length;
  els.returnsSummary.innerHTML = `<div class="mini-kpi"><span>Потенциальные по стадии</span><strong>${fmtNum(taskCases.length)}</strong></div><div class="mini-kpi"><span>Ответили «Возврат»</span><strong>${fmtNum(responseCases.length)}</strong></div><div class="mini-kpi"><span>Всего к разбору</span><strong>${fmtNum(total)}</strong></div>`;
  const taskRows = taskCases.map((r) => `<tr><td>${escapeHtml(r.companyName)}</td><td>${escapeHtml(r.title)}</td><td>Стадия: ${escapeHtml(r.stageName)}</td><td>${escapeHtml(r.returnStatus || 'Потенциальный возврат')}</td><td>${escapeHtml(r.returnAnalysis || r.reportNote || '')}</td><td>${escapeHtml(r.expert)}</td><td><button class="link-btn task-edit-btn" data-task="${r.taskId}">Редактировать разбор</button></td></tr>`);
  const responseRows = responseCases.map((r) => `<tr><td>${escapeHtml(r.companyName)}</td><td>${escapeHtml(r.documentTitle || '—')}</td><td>Ответ клиента</td><td>${escapeHtml(r.status || 'Новый')}</td><td>${escapeHtml(r.comment || '')}${r.detail ? `<div class="muted-small">${escapeHtml(r.detail)}</div>` : ''}</td><td>${escapeHtml(r.expert || '—')}</td><td><button class="link-btn switch-mailing-btn">Открыть в рассылке</button></td></tr>`);
  els.returnsTable.innerHTML = total ? `<table class="summary-table"><thead><tr><th>Компания</th><th>Документ</th><th>Источник</th><th>Статус</th><th>Комментарий / разбор</th><th>Эксперт</th><th></th></tr></thead><tbody>${taskRows.join('')}${responseRows.join('')}</tbody></table>` : '<div class="empty-state">Возвратных и потенциально возвратных случаев пока нет</div>';
}

function inferResponseCategory(text) {
  const v = normalize(text);
  if (/возврат|вернем деньги|вернём деньги/.test(v)) return 'Возврат';
  if (/не выполн|не оказан|не будут подпис|не хочет подпис|отказыва/.test(v)) return 'Услуга не оказана';
  if (/поменя|передел|переотправ|ошиб|неверн|перепровер|не актуальн/.test(v)) return 'Ошибка / переотправить документ';
  if (/вышл|отправил|отправили|подпиш|подъед|приедет|привез/.test(v)) return 'Вышлет в ближайшее время';
  return 'Другое';
}

async function showHistory(taskId, title) {
  els.historyTitle.textContent = title || `Задача ${taskId}`; els.historyLoading.classList.remove('hidden'); els.historyContent.innerHTML = ''; els.historyDialog.showModal();
  try {
    const data = await apiFetch(`/api/doc-return-report/task-history/${encodeURIComponent(taskId)}`); const rows = Array.isArray(data.rows) ? data.rows : [];
    els.historyContent.innerHTML = rows.length ? `<div class="history-list">${rows.map((row) => `<div class="history-item"><div class="history-date">${fmtDateTime(row.createdAt)}</div><div><div class="history-transition">${escapeHtml(row.from || '—')} → ${escapeHtml(row.to || '—')}</div>${row.user ? `<div class="history-user">${escapeHtml(row.user)}</div>` : ''}</div></div>`).join('')}</div>` : '<div class="empty-state">История переходов по стадиям не найдена</div>';
  } catch (e) { els.historyContent.innerHTML = `<div class="error-card">${escapeHtml(e.message || String(e))}</div>`; }
  finally { els.historyLoading.classList.add('hidden'); }
}
function openTaskUrl(url) {
  try { const parsed = new URL(url); if (BX24.openPath) return BX24.openPath(parsed.pathname); } catch (_) {}
  window.open(url, '_blank', 'noopener');
}
function openTaskEditor(taskId) {
  const row = state.raw.find((r) => String(r.taskId) === String(taskId)); if (!row) return;
  state.editingTaskId = String(taskId); els.taskEditTitle.textContent = row.title; els.taskCompanyId.value = row.companyId || ''; els.taskCompanySearch.value = row.companyId ? row.companyName : '';
  els.taskExpert.value = row.expert || ''; els.taskService.value = row.serviceArticle || ''; els.taskNote.value = row.reportNote || ''; els.taskReturnStatus.value = row.returnStatus || ''; els.taskReturnAnalysis.value = row.returnAnalysis || ''; els.taskCompanySuggestions.innerHTML = '';
  els.taskEditDialog.showModal();
}
async function searchCompanies(q) {
  if (q.trim().length < 2) { els.taskCompanySuggestions.innerHTML = ''; return; }
  try {
    const data = await apiFetch(`/api/doc-return-report/company-search?q=${encodeURIComponent(q.trim())}`); const rows = Array.isArray(data.rows) ? data.rows : [];
    els.taskCompanySuggestions.innerHTML = rows.length ? rows.map((c) => `<button class="company-suggestion" data-id="${c.id}" data-title="${escapeHtml(c.title)}">${escapeHtml(c.title)}</button>`).join('') : '<div class="muted-small">Совпадений не найдено</div>';
  } catch (e) { els.taskCompanySuggestions.innerHTML = `<div class="muted-small">${escapeHtml(e.message || String(e))}</div>`; }
}
async function saveTaskEdit() {
  const row = state.raw.find((r) => String(r.taskId) === state.editingTaskId); if (!row) return;
  const companyId = els.taskCompanyId.value.trim(); const companyName = els.taskCompanySearch.value.trim();
  if (companyName && !companyId && !row.companyId) { alert('Выбери компанию из выпадающего списка, чтобы сохранить правильную CRM-компанию.'); return; }
  const data = { companyId: companyId || row.companyId || '', companyName: companyName || row.companyName || '', expert: els.taskExpert.value.trim(), serviceArticle: els.taskService.value.trim(), reportNote: els.taskNote.value.trim(), returnStatus: els.taskReturnStatus.value.trim(), returnAnalysis: els.taskReturnAnalysis.value.trim() };
  await apiFetch('/api/doc-return-report/record', { method:'POST', body:JSON.stringify({ kind:'taskOverride', key:row.taskId, data }) });
  Object.assign(row, { companyId:data.companyId, companyName:data.companyName || row.companyName, expert:data.expert || row.expert, serviceArticle:data.serviceArticle, reportNote:data.reportNote, returnStatus:data.returnStatus, returnAnalysis:data.returnAnalysis, companySource:'Ручная правка в отчёте' });
  populateDynamicFilters(); applyFilters(); renderReturns(); els.taskEditDialog.close();
}

function cachedSnapshotLoad() {
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (!cached || !Array.isArray(cached.rows)) return false;
    state.raw = cached.rows; state.stages = Array.isArray(cached.stages) ? cached.stages : []; state.loadedAt = cached.generatedAt || null;
    populateDynamicFilters(); applyFilters(); els.loading.classList.add('hidden'); els.content.classList.remove('hidden'); els.sync.textContent = `Показываю сохранённые данные на ${fmtDateTime(state.loadedAt)} · обновляю в фоне…`; return true;
  } catch (_) { return false; }
}
function saveSnapshot(data) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ rows:data.rows, stages:data.stages, generatedAt:data.generatedAt })); } catch (_) {} }
async function loadData(force = false) {
  const hasData = state.raw.length > 0;
  if (!hasData) { els.loading.classList.remove('hidden'); els.content.classList.add('hidden'); }
  els.error.classList.add('hidden'); els.refresh.disabled = true; els.sync.textContent = force ? 'Обновляю данные из Bitrix24…' : (hasData ? 'Проверяю свежие данные в фоне…' : 'Загружаю данные…');
  try {
    const data = await apiFetch(`/api/doc-return-report/data${force ? '?force=1' : ''}`);
    state.raw = Array.isArray(data.rows) ? data.rows : []; state.stages = Array.isArray(data.stages) ? data.stages : []; state.loadedAt = data.generatedAt || new Date().toISOString();
    saveSnapshot(data); populateDynamicFilters(); applyFilters(); els.loading.classList.add('hidden'); els.content.classList.remove('hidden');
    const suffix = data.refreshing ? ' · обновление в фоне' : ` · обновление ≤ ${Math.round((data.cacheSeconds || 300) / 60)} мин`;
    els.sync.textContent = `Данные на ${fmtDateTime(state.loadedAt)}${suffix}`;
  } catch (e) {
    if (!hasData) { els.loading.classList.add('hidden'); els.error.classList.remove('hidden'); els.error.textContent = e.message || String(e); }
    els.sync.textContent = hasData ? `Показаны сохранённые данные · обновление не удалось: ${e.message || e}` : 'Ошибка загрузки';
  } finally { els.refresh.disabled = false; }
}
function resetFilters() {
  els.year.value='2026'; els.month.value='all'; els.from.value=''; els.to.value=''; els.company.value='all'; els.expert.value='all'; els.stage.value='all'; els.type.value='all'; els.overdue.value='all'; els.search.value=''; state.expandedCompany=''; applyFilters();
}
function csvEscape(value) { const text=String(value??''); return /[;"\n]/.test(text) ? `"${text.replace(/"/g,'""')}"` : text; }
function exportCsv() {
  const header=['Компания','Эксперт','Документ','Тип','Статья услуги','Стадия','Дата создания','Дедлайн','Просрочено дней','Ссылка']; const lines=[header.join(';')];
  for(const row of state.filtered) lines.push([row.companyName,row.expert,row.title,row.documentType,row.serviceArticle,row.stageName,fmtDate(row.createdAt),fmtDate(row.deadline),row.overdue?row.overdueDays:0,row.taskUrl].map(csvEscape).join(';'));
  const blob=new Blob(['\ufeff'+lines.join('\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`Возврат_оригиналов_${todayIso()}.csv`;a.click();URL.revokeObjectURL(url);
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.report-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab}`));
  if (tab === 'mailing' && !state.mailing.loaded) loadMailing(false);
  if (tab === 'returns') { if (!state.mailing.loaded) loadMailing(false); else renderReturns(); }
  // Историю по месяцам больше НЕ считаем автоматически: это самый тяжёлый запрос.
  // Она запускается только по кнопке «Обновить динамику».
  if (tab === 'control' && !state.history.loaded) {
    els.historyStatus.textContent = 'Динамика по месяцам считается отдельно — нажми «Обновить динамику», когда она нужна.';
  }
  try { BX24.fitWindow && BX24.fitWindow(); } catch (_) {}
}

function bindEvents() {
  document.querySelectorAll('.report-tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  const filterIds=['year-filter','month-filter','date-from','date-to','company-filter','expert-filter','stage-filter','type-filter','overdue-filter'];
  for(const id of filterIds) qs(id).addEventListener('change',()=>{state.expandedCompany='';applyFilters();if(id==='year-filter'&&state.history.ready)renderHistoryMonths();});
  let searchTimer=null;els.search.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{state.expandedCompany='';applyFilters();},180);});
  els.reset.addEventListener('click',resetFilters);els.refresh.addEventListener('click',()=>loadData(true));els.export.addEventListener('click',exportCsv);
  els.historyRefresh.addEventListener('click',()=>loadHistoryIndex(true));
  els.quality.addEventListener('click',(event)=>{const card=event.target.closest('[data-quality-kind]');if(card)openQuality(card.dataset.qualityKind);});
  els.qualityClose.addEventListener('click',()=>els.qualityDialog.close());
  els.qualityContent.addEventListener('click',(event)=>{const edit=event.target.closest('.task-edit-btn');if(edit){els.qualityDialog.close();return openTaskEditor(edit.dataset.task);}const open=event.target.closest('.open-task');if(open)return openTaskUrl(open.dataset.url);});
  els.companies.addEventListener('click',(event)=>{const edit=event.target.closest('.task-edit-btn');if(edit)return openTaskEditor(edit.dataset.task);const hist=event.target.closest('.history-btn');if(hist)return showHistory(hist.dataset.task,hist.dataset.title);const open=event.target.closest('.open-task');if(open)return openTaskUrl(open.dataset.url);const row=event.target.closest('.company-row');if(!row)return;const key=row.dataset.companyKey;state.expandedCompany=state.expandedCompany===key?'':key;renderCompanies();});
  els.historyClose.addEventListener('click',()=>els.historyDialog.close());
  els.taskEditClose.addEventListener('click',()=>els.taskEditDialog.close());els.taskEditSave.addEventListener('click',saveTaskEdit);
  els.taskCompanySearch.addEventListener('input',()=>{els.taskCompanyId.value='';clearTimeout(state.companySearchTimer);state.companySearchTimer=setTimeout(()=>searchCompanies(els.taskCompanySearch.value),250);});
  els.taskCompanySuggestions.addEventListener('click',(event)=>{const btn=event.target.closest('.company-suggestion');if(!btn)return;els.taskCompanyId.value=btn.dataset.id;els.taskCompanySearch.value=btn.dataset.title;els.taskCompanySuggestions.innerHTML='<div class="selected-company">Выбрано: '+escapeHtml(btn.dataset.title)+'</div>';});
  for(const dlg of [els.historyDialog,els.qualityDialog,els.taskEditDialog,els.responseAddDialog]) dlg.addEventListener('click',(e)=>{if(e.target===dlg)dlg.close();});

  els.mailingYear.addEventListener('change',renderMailing);els.mailingMonth.addEventListener('change',renderMailing);els.mailingCategory.addEventListener('change',renderResponsesTable);
  els.mailingRefresh.addEventListener('click',()=>loadMailing(true));els.mailingAdd.addEventListener('click',()=>{state.responseCategoryTouched=false;els.responseAddDate.value=todayIso();els.responseAddTask.value='';els.responseAddCompany.value='';els.responseAddDocument.value='';els.responseAddService.value='';els.responseAddDetail.value='';els.responseAddComment.value='';els.responseAddStatus.value='Новый';populateMailingCategories();els.responseAddCategory.value='Другое';els.responseAddDialog.showModal();});
  els.responseAddClose.addEventListener('click',()=>els.responseAddDialog.close());
  els.responseAddCategory.addEventListener('change',()=>{state.responseCategoryTouched=true;});
  els.responseAddComment.addEventListener('input',()=>{if(!state.responseCategoryTouched)els.responseAddCategory.value=inferResponseCategory(els.responseAddComment.value);});
  els.responseAddSave.addEventListener('click',async()=>{const data={responseDate:els.responseAddDate.value||todayIso(),companyName:els.responseAddCompany.value.trim(),taskId:els.responseAddTask.value.trim(),documentTitle:els.responseAddDocument.value.trim(),category:els.responseAddCategory.value,serviceArticle:els.responseAddService.value.trim(),detail:els.responseAddDetail.value.trim(),comment:els.responseAddComment.value.trim(),status:els.responseAddStatus.value.trim()||'Новый',deleted:false,source:'Добавлено вручную'};if(!data.companyName&&!data.taskId){alert('Укажи компанию или ID задачи.');return;}const result=await apiFetch('/api/doc-return-report/record',{method:'POST',body:JSON.stringify({kind:'response',key:'',data})});state.mailing.responses.unshift({...data,id:result.key});els.responseAddDialog.close();renderMailing();});
  els.responsesTable.addEventListener('click',async(event)=>{const tr=event.target.closest('tr[data-response-id]');if(!tr)return;if(event.target.closest('.response-save-btn')){event.target.disabled=true;try{await saveResponseRow(tr);}finally{event.target.disabled=false;}}if(event.target.closest('.response-delete-btn'))await deleteResponseRow(tr);});
  els.returnsTable.addEventListener('click',(event)=>{const edit=event.target.closest('.task-edit-btn');if(edit)return openTaskEditor(edit.dataset.task);if(event.target.closest('.switch-mailing-btn'))switchTab('mailing');});
}

async function boot() {
  Object.assign(els, {
    year:qs('year-filter'),month:qs('month-filter'),from:qs('date-from'),to:qs('date-to'),company:qs('company-filter'),expert:qs('expert-filter'),stage:qs('stage-filter'),type:qs('type-filter'),overdue:qs('overdue-filter'),search:qs('search-filter'),
    reset:qs('reset-btn'),refresh:qs('refresh-btn'),export:qs('export-btn'),sync:qs('sync-label'),loading:qs('loading-card'),error:qs('error-card'),content:qs('report-content'),periodLabel:qs('period-label'),
    kpiEarly:qs('kpi-early'),kpiControl:qs('kpi-control'),kpiReturned:qs('kpi-returned'),kpiNotReturnedShare:qs('kpi-not-returned-share'),kpiNotReturnedCount:qs('kpi-not-returned-count'),kpiReturnedShare:qs('kpi-returned-share'),kpiSentBase:qs('kpi-sent-base'),kpiOverdue:qs('kpi-overdue'),kpiOverdueShare:qs('kpi-overdue-share'),kpiEmail:qs('kpi-email'),kpiCall:qs('kpi-call'),kpiCompanies:qs('kpi-companies'),
    stageBars:qs('stage-bars'),topCompanies:qs('top-companies'),expertBars:qs('expert-bars'),quality:qs('quality-insights'),companies:qs('companies-list'),companySummary:qs('company-summary'),
    historyRefresh:qs('history-refresh-btn'),historyStatus:qs('history-status'),historyMonths:qs('history-months'),
    qualityDialog:qs('quality-dialog'),qualityTitle:qs('quality-title'),qualityMeta:qs('quality-meta'),qualityContent:qs('quality-content'),qualityClose:qs('quality-close'),
    historyDialog:qs('history-dialog'),historyTitle:qs('history-title'),historyLoading:qs('history-loading'),historyContent:qs('history-content'),historyClose:qs('history-close'),
    taskEditDialog:qs('task-edit-dialog'),taskEditTitle:qs('task-edit-title'),taskEditClose:qs('task-edit-close'),taskEditSave:qs('task-edit-save'),taskCompanySearch:qs('task-company-search'),taskCompanyId:qs('task-company-id'),taskCompanySuggestions:qs('task-company-suggestions'),taskExpert:qs('task-expert'),taskService:qs('task-service'),taskNote:qs('task-note'),taskReturnStatus:qs('task-return-status'),taskReturnAnalysis:qs('task-return-analysis'),
    mailingYear:qs('mailing-year'),mailingMonth:qs('mailing-month'),mailingCategory:qs('mailing-category'),mailingAdd:qs('mailing-add-btn'),mailingRefresh:qs('mailing-refresh-btn'),mailingStatus:qs('mailing-status'),mailingKpis:qs('mailing-kpis'),mailingMonthly:qs('mailing-monthly'),responsesTable:qs('responses-table'),
    returnsSummary:qs('returns-summary'),returnsTable:qs('returns-table'),
    responseAddDialog:qs('response-add-dialog'),responseAddClose:qs('response-add-close'),responseAddSave:qs('response-add-save'),responseAddDate:qs('response-add-date'),responseAddTask:qs('response-add-task'),responseAddCompany:qs('response-add-company'),responseAddDocument:qs('response-add-document'),responseAddCategory:qs('response-add-category'),responseAddService:qs('response-add-service'),responseAddDetail:qs('response-add-detail'),responseAddComment:qs('response-add-comment'),responseAddStatus:qs('response-add-status'),
  });
  populateStaticFilters(); populateMailingCategories(); bindEvents();
  const hadCache = cachedSnapshotLoad();
  try {
    await initBitrix();
    if (!hadCache) await loadData(false); else loadData(false);
    state.history.loaded = true;
    loadHistoryIndex(false);
  } catch (e) {
    if (!hadCache) { els.loading.classList.add('hidden');els.error.classList.remove('hidden');els.error.innerHTML=`<strong>Не удалось открыть локальное приложение.</strong><br>${escapeHtml(e.message||String(e))}`; }
  }
}

document.addEventListener('DOMContentLoaded', boot);
