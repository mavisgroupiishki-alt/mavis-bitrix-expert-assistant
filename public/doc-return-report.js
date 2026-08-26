/* global BX24 */

const state = {
  auth: null,
  user: null,
  raw: [],
  filtered: [],
  stages: [],
  expandedCompany: '',
  loadedAt: null,
};

const MONTHS = [
  [1, 'Январь'], [2, 'Февраль'], [3, 'Март'], [4, 'Апрель'], [5, 'Май'], [6, 'Июнь'],
  [7, 'Июль'], [8, 'Август'], [9, 'Сентябрь'], [10, 'Октябрь'], [11, 'Ноябрь'], [12, 'Декабрь'],
];

const els = {};

const BROWSER_CACHE_VERSION = 'v112';
const BROWSER_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
let autoRefreshTimer = null;

function browserCacheKey() {
  const domain = state.auth && state.auth.domain ? state.auth.domain : 'portal';
  return `mavis-doc-return-report:${BROWSER_CACHE_VERSION}:${domain}`;
}

function saveBrowserCache(data) {
  try {
    localStorage.setItem(browserCacheKey(), JSON.stringify({
      savedAt: Date.now(),
      generatedAt: data.generatedAt || state.loadedAt || new Date().toISOString(),
      rows: Array.isArray(data.rows) ? data.rows : state.raw,
      stages: Array.isArray(data.stages) ? data.stages : state.stages,
      cacheSeconds: data.cacheSeconds || 300,
    }));
  } catch (_) {}
}

function restoreBrowserCache() {
  try {
    const raw = localStorage.getItem(browserCacheKey());
    if (!raw) return false;
    const cached = JSON.parse(raw);
    if (!cached || !Array.isArray(cached.rows) || !cached.rows.length) return false;
    if (cached.savedAt && Date.now() - Number(cached.savedAt) > BROWSER_CACHE_MAX_AGE_MS) return false;
    state.raw = cached.rows;
    state.stages = Array.isArray(cached.stages) ? cached.stages : [];
    state.loadedAt = cached.generatedAt || new Date(cached.savedAt || Date.now()).toISOString();
    populateDynamicFilters();
    applyFilters();
    els.loading.classList.add('hidden');
    els.error.classList.add('hidden');
    els.content.classList.remove('hidden');
    els.sync.textContent = `Показываю сохранённые данные на ${fmtDateTime(state.loadedAt)} · обновляю в фоне…`;
    return true;
  } catch (_) {
    return false;
  }
}

function qs(id) { return document.getElementById(id); }
function fmtNum(value) { return new Intl.NumberFormat('ru-RU').format(Number(value || 0)); }
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
function pct(part, total) { return total ? ((part / total) * 100).toFixed(1).replace('.', ',') : '0,0'; }

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
  return {
    'x-b24-domain': state.auth.domain,
    'x-b24-auth': state.auth.access_token,
    'x-b24-member': state.auth.member_id || '',
  };
}

async function apiFetch(url, options = {}, retry = true) {
  const response = await fetch(url, { ...options, headers: { ...(options.headers || {}), ...authHeaders() } });
  if (response.status === 401 && retry) {
    state.auth = await new Promise((resolve) => BX24.refreshAuth(resolve));
    return apiFetch(url, options, false);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function populateStaticFilters() {
  els.month.innerHTML = '<option value="all">Все месяцы</option>' + MONTHS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'ru'));
}

function populateDynamicFilters() {
  const current = {
    company: els.company.value,
    expert: els.expert.value,
    stage: els.stage.value,
    type: els.type.value,
  };
  const optionList = (values, allLabel) => `<option value="all">${allLabel}</option>` + values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
  els.company.innerHTML = optionList(uniqueSorted(state.raw.map((r) => r.companyName)), 'Все компании');
  els.expert.innerHTML = optionList(uniqueSorted(state.raw.map((r) => r.expert)), 'Все эксперты');
  els.stage.innerHTML = optionList(uniqueSorted(state.raw.map((r) => r.stageName)), 'Все стадии');
  els.type.innerHTML = optionList(uniqueSorted(state.raw.map((r) => r.documentType)), 'Все типы');
  for (const [key, value] of Object.entries(current)) {
    if ([...els[key].options].some((opt) => opt.value === value)) els[key].value = value;
  }
}

function readFilters() {
  return {
    year: els.year.value,
    month: els.month.value,
    from: els.from.value,
    to: els.to.value,
    company: els.company.value,
    expert: els.expert.value,
    stage: els.stage.value,
    type: els.type.value,
    overdue: els.overdue.value,
    search: els.search.value.trim().toLowerCase(),
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
      const hay = `${row.companyName} ${row.title} ${row.expert} ${row.stageName}`.toLowerCase();
      if (!hay.includes(f.search)) return false;
    }
    return true;
  });

  renderAll();
}

function currentPeriodText() {
  const f = readFilters();
  const parts = [];
  if (f.year !== 'all') parts.push(f.year);
  if (f.month !== 'all') parts.push(MONTHS.find(([id]) => String(id) === f.month)?.[1] || f.month);
  if (f.from || f.to) parts.push(`${f.from ? fmtDate(f.from) : '…'} — ${f.to ? fmtDate(f.to) : '…'}`);
  return parts.length ? parts.join(' · ') : 'Все время';
}

function renderKpis() {
  const rows = state.filtered;
  const total = rows.length;
  const overdue = rows.filter((r) => r.overdue).length;
  const email = rows.filter((r) => String(r.stageId) === '1126' || /эл\.\s*почта/i.test(r.stageName)).length;
  const call = rows.filter((r) => String(r.stageId) === '1128' || /^звонок$/i.test(r.stageName)).length;
  const companies = new Set(rows.map((r) => r.companyId || `name:${r.companyName}`)).size;
  els.kpiTotal.textContent = fmtNum(total);
  els.kpiOverdue.textContent = fmtNum(overdue);
  els.kpiEmail.textContent = fmtNum(email);
  els.kpiCall.textContent = fmtNum(call);
  els.kpiCompanies.textContent = fmtNum(companies);
  els.kpiOverdueShare.textContent = `${pct(overdue, total)}% от остатка`;
  els.periodLabel.textContent = `Текущий остаток · период создания: ${currentPeriodText()}`;
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row) || 'Не определено';
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, 'ru'));
}

function renderBars(container, data, maxItems = 10, className = '') {
  const rows = data.slice(0, maxItems);
  const max = Math.max(1, ...rows.map((r) => r.value));
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
    const item = map.get(key);
    item.rows.push(row);
    if (row.overdue) item.overdue++;
    if (String(row.stageId) === '1126' || /эл\.\s*почта/i.test(row.stageName)) item.email++;
    if (String(row.stageId) === '1128' || /^звонок$/i.test(row.stageName)) item.call++;
    if ((!item.oldest && row.createdAt) || (row.createdAt && new Date(row.createdAt) < new Date(item.oldest))) item.oldest = row.createdAt;
    if (row.expert && row.expert !== 'Не определён') item.expert = row.expert;
  }
  return [...map.values()].sort((a, b) => b.rows.length - a.rows.length || b.overdue - a.overdue || a.name.localeCompare(b.name, 'ru'));
}

function renderCompanyDocuments(company) {
  const sorted = [...company.rows].sort((a, b) => (Number(b.overdue) - Number(a.overdue)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  return `
    <div class="docs-wrap">
      <table class="docs-table">
        <thead><tr><th>Документ</th><th>Тип</th><th>Стадия</th><th>Создан</th><th>Дедлайн</th><th>Просрочка</th><th>Эксперт</th><th></th></tr></thead>
        <tbody>
          ${sorted.map((row) => `
            <tr>
              <td class="doc-title">${escapeHtml(row.title)}</td>
              <td><span class="type-chip">${escapeHtml(row.documentType)}</span></td>
              <td><span class="stage-chip">${escapeHtml(row.stageName)}</span></td>
              <td>${fmtDate(row.createdAt)}</td>
              <td>${fmtDate(row.deadline)}</td>
              <td>${row.deadline ? `<span class="deadline-chip ${row.overdue ? 'overdue' : 'ok'}">${row.overdue ? `${fmtNum(row.overdueDays)} дн.` : 'В срок'}</span>` : '<span class="deadline-chip empty">Без дедлайна</span>'}</td>
              <td>${escapeHtml(row.expert)}</td>
              <td><div class="doc-actions"><button class="link-btn open-task" data-url="${escapeHtml(row.taskUrl)}">Открыть</button><button class="link-btn history-btn" data-task="${row.taskId}" data-title="${escapeHtml(row.title)}">История стадий</button></div></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderCompanies() {
  const companies = groupCompanies(state.filtered);
  els.companySummary.textContent = `${fmtNum(companies.length)} компаний · ${fmtNum(state.filtered.length)} документов`;
  if (!companies.length) {
    els.companies.innerHTML = '<div class="empty-state">По выбранным фильтрам ничего не найдено</div>';
    return;
  }
  els.companies.innerHTML = companies.map((company) => {
    const open = state.expandedCompany === company.key;
    return `
      <div class="company-group" data-key="${escapeHtml(company.key)}">
        <div class="company-row ${open ? 'open' : ''}" data-company-key="${escapeHtml(company.key)}">
          <div class="company-name"><span class="chevron">›</span><span class="company-name-text">${escapeHtml(company.name)}</span></div>
          <div class="expert-name">${escapeHtml(company.expert)}</div>
          <div><span class="count-pill">${fmtNum(company.rows.length)}</span></div>
          <div><span class="count-pill overdue">${fmtNum(company.overdue)}</span></div>
          <div><span class="count-pill email">${fmtNum(company.email)}</span></div>
          <div><span class="count-pill call">${fmtNum(company.call)}</span></div>
          <div class="oldest">${fmtDate(company.oldest)}</div>
        </div>
        ${open ? renderCompanyDocuments(company) : ''}
      </div>`;
  }).join('');
}

function renderQuality() {
  const unmatched = state.filtered.filter((r) => !r.companyId).length;
  const noDeadline = state.filtered.filter((r) => !r.deadline).length;
  const older90 = state.filtered.filter((r) => Number(r.ageDays || 0) >= 90).length;
  const older180 = state.filtered.filter((r) => Number(r.ageDays || 0) >= 180).length;
  els.quality.innerHTML = `
    <button type="button" class="insight quality-clickable ${unmatched ? 'danger' : ''}" data-quality="unmatched" title="Показать задачи, где компания не определена"><strong>${fmtNum(unmatched)}</strong><span>Компания не определена</span><small>Нажмите, чтобы открыть список</small></button>
    <button type="button" class="insight quality-clickable ${noDeadline ? 'warning' : ''}" data-quality="no-deadline" title="Показать задачи без дедлайна"><strong>${fmtNum(noDeadline)}</strong><span>Без дедлайна</span><small>Нажмите, чтобы открыть список</small></button>
    <button type="button" class="insight quality-clickable" data-quality="older90" title="Показать задачи в работе 90+ дней"><strong>${fmtNum(older90)}</strong><span>В работе 90+ дней</span><small>Нажмите, чтобы открыть список</small></button>
    <button type="button" class="insight quality-clickable" data-quality="older180" title="Показать задачи в работе 180+ дней"><strong>${fmtNum(older180)}</strong><span>В работе 180+ дней</span><small>Нажмите, чтобы открыть список</small></button>`;
}

function qualityRows(kind) {
  if (kind === 'unmatched') return state.filtered.filter((r) => !r.companyId);
  if (kind === 'no-deadline') return state.filtered.filter((r) => !r.deadline);
  if (kind === 'older90') return state.filtered.filter((r) => Number(r.ageDays || 0) >= 90);
  if (kind === 'older180') return state.filtered.filter((r) => Number(r.ageDays || 0) >= 180);
  return [];
}

function qualityTitle(kind) {
  return ({
    unmatched: 'Компания не определена',
    'no-deadline': 'Задачи без дедлайна',
    older90: 'В работе 90+ дней',
    older180: 'В работе 180+ дней',
  })[kind] || 'Контроль качества базы';
}

function showQualityDetails(kind) {
  const rows = qualityRows(kind).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  els.qualityTitle.textContent = qualityTitle(kind);
  els.qualitySummary.textContent = `${fmtNum(rows.length)} задач · период создания: ${currentPeriodText()}`;
  els.qualityContent.innerHTML = rows.length ? `
    <div class="quality-table-wrap">
      <table class="docs-table quality-table">
        <thead><tr><th>Компания</th><th>Документ / задача</th><th>Стадия</th><th>Создан</th><th>Дедлайн</th><th>Эксперт</th><th></th></tr></thead>
        <tbody>${rows.map((row) => `
          <tr>
            <td>${row.companyId ? escapeHtml(row.companyName) : '<span class="quality-missing">Не определена</span>'}</td>
            <td class="doc-title">${escapeHtml(row.title)}</td>
            <td><span class="stage-chip">${escapeHtml(row.stageName)}</span></td>
            <td>${fmtDate(row.createdAt)}</td>
            <td>${row.deadline ? fmtDate(row.deadline) : '<span class="quality-missing">Нет</span>'}</td>
            <td>${escapeHtml(row.expert)}</td>
            <td><button class="link-btn quality-open-task" data-url="${escapeHtml(row.taskUrl)}">Открыть задачу</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>` : '<div class="empty-state">Здесь всё в порядке — задач нет.</div>';
  els.qualityDialog.showModal();
  try { BX24.fitWindow && BX24.fitWindow(); } catch (_) {}
}

function renderAll() {
  renderKpis();
  renderBars(els.stageBars, countBy(state.filtered, (r) => r.stageName), 12);
  const companies = groupCompanies(state.filtered).map((c) => ({ label: c.name, value: c.rows.length }));
  renderBars(els.topCompanies, companies, 10, 'red');
  renderBars(els.expertBars, countBy(state.filtered, (r) => r.expert), 12, 'green');
  renderQuality();
  renderCompanies();
  try { BX24.fitWindow && BX24.fitWindow(); } catch (_) {}
}

async function loadData(force = false, background = false) {
  const hasVisibleData = Array.isArray(state.raw) && state.raw.length > 0;
  if (!hasVisibleData) {
    els.loading.classList.remove('hidden');
    els.content.classList.add('hidden');
  }
  els.error.classList.add('hidden');
  els.refresh.disabled = true;
  els.sync.textContent = force
    ? (hasVisibleData ? 'Обновляю данные из Bitrix24 в фоне…' : 'Обновляю данные из Bitrix24…')
    : (hasVisibleData ? `Данные на ${fmtDateTime(state.loadedAt)} · проверяю обновления…` : 'Загружаю данные…');
  try {
    const data = await apiFetch(`/api/doc-return-report/data${force ? '?force=1' : ''}`);
    state.raw = Array.isArray(data.rows) ? data.rows : [];
    state.stages = Array.isArray(data.stages) ? data.stages : [];
    state.loadedAt = data.generatedAt || new Date().toISOString();
    saveBrowserCache(data);
    populateDynamicFilters();
    applyFilters();
    const freshness = data.refreshing ? ' · сервер обновляет данные в фоне' : '';
    els.sync.textContent = `Данные на ${fmtDateTime(state.loadedAt)} · автообновление ≤ ${Math.round((data.cacheSeconds || 300) / 60)} мин${freshness}`;
    els.loading.classList.add('hidden');
    els.content.classList.remove('hidden');
  } catch (e) {
    els.loading.classList.add('hidden');
    if (hasVisibleData || background) {
      // Старые данные остаются доступны — ошибка фоновой синхронизации не блокирует работу.
      els.content.classList.remove('hidden');
      els.sync.textContent = `Показываю данные на ${fmtDateTime(state.loadedAt)} · обновление временно недоступно`;
    } else {
      els.error.classList.remove('hidden');
      els.error.textContent = e.message || String(e);
      els.sync.textContent = 'Ошибка загрузки';
    }
  } finally {
    els.refresh.disabled = false;
  }
}

function resetFilters() {
  els.year.value = '2026';
  els.month.value = 'all';
  els.from.value = '';
  els.to.value = '';
  els.company.value = 'all';
  els.expert.value = 'all';
  els.stage.value = 'all';
  els.type.value = 'all';
  els.overdue.value = 'all';
  els.search.value = '';
  state.expandedCompany = '';
  applyFilters();
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[;"\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportCsv() {
  const header = ['Компания','Эксперт','Документ','Тип','Стадия','Дата создания','Дедлайн','Просрочено дней','Ссылка'];
  const lines = [header.join(';')];
  for (const row of state.filtered) {
    lines.push([
      row.companyName, row.expert, row.title, row.documentType, row.stageName,
      fmtDate(row.createdAt), fmtDate(row.deadline), row.overdue ? row.overdueDays : 0, row.taskUrl,
    ].map(csvEscape).join(';'));
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `Возврат_оригиналов_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function showHistory(taskId, title) {
  els.historyTitle.textContent = title || `Задача ${taskId}`;
  els.historyLoading.classList.remove('hidden');
  els.historyContent.innerHTML = '';
  els.historyDialog.showModal();
  try {
    const data = await apiFetch(`/api/doc-return-report/task-history/${encodeURIComponent(taskId)}`);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    els.historyContent.innerHTML = rows.length ? `<div class="history-list">${rows.map((row) => `
      <div class="history-item">
        <div class="history-date">${fmtDateTime(row.createdAt)}</div>
        <div><div class="history-transition">${escapeHtml(row.from || '—')} → ${escapeHtml(row.to || '—')}</div>${row.user ? `<div class="history-user">${escapeHtml(row.user)}</div>` : ''}</div>
      </div>`).join('')}</div>` : '<div class="empty-state">История переходов по стадиям не найдена</div>';
  } catch (e) {
    els.historyContent.innerHTML = `<div class="error-card">${escapeHtml(e.message || String(e))}</div>`;
  } finally {
    els.historyLoading.classList.add('hidden');
  }
}

function bindEvents() {
  const filterIds = ['year-filter','month-filter','date-from','date-to','company-filter','expert-filter','stage-filter','type-filter','overdue-filter'];
  for (const id of filterIds) qs(id).addEventListener('change', () => { state.expandedCompany = ''; applyFilters(); });
  let searchTimer = null;
  els.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.expandedCompany = ''; applyFilters(); }, 180);
  });
  els.reset.addEventListener('click', resetFilters);
  els.refresh.addEventListener('click', () => loadData(true));
  els.export.addEventListener('click', exportCsv);
  els.companies.addEventListener('click', (event) => {
    const historyButton = event.target.closest('.history-btn');
    if (historyButton) return showHistory(historyButton.dataset.task, historyButton.dataset.title);
    const openButton = event.target.closest('.open-task');
    if (openButton) {
      const url = openButton.dataset.url;
      try {
        const parsed = new URL(url);
        if (BX24.openPath) return BX24.openPath(parsed.pathname);
      } catch (_) {}
      window.open(url, '_blank', 'noopener');
      return;
    }
    const row = event.target.closest('.company-row');
    if (!row) return;
    const key = row.dataset.companyKey;
    state.expandedCompany = state.expandedCompany === key ? '' : key;
    renderCompanies();
    try { BX24.fitWindow && BX24.fitWindow(); } catch (_) {}
  });
  els.quality.addEventListener('click', (event) => {
    const card = event.target.closest('[data-quality]');
    if (card) showQualityDetails(card.dataset.quality);
  });
  els.qualityContent.addEventListener('click', (event) => {
    const openButton = event.target.closest('.quality-open-task');
    if (!openButton) return;
    const url = openButton.dataset.url;
    try {
      const parsed = new URL(url);
      if (BX24.openPath) return BX24.openPath(parsed.pathname);
    } catch (_) {}
    window.open(url, '_blank', 'noopener');
  });
  els.qualityClose.addEventListener('click', () => els.qualityDialog.close());
  els.qualityDialog.addEventListener('click', (event) => { if (event.target === els.qualityDialog) els.qualityDialog.close(); });
  els.historyClose.addEventListener('click', () => els.historyDialog.close());
  els.historyDialog.addEventListener('click', (event) => { if (event.target === els.historyDialog) els.historyDialog.close(); });
}

async function boot() {
  Object.assign(els, {
    year: qs('year-filter'), month: qs('month-filter'), from: qs('date-from'), to: qs('date-to'),
    company: qs('company-filter'), expert: qs('expert-filter'), stage: qs('stage-filter'), type: qs('type-filter'), overdue: qs('overdue-filter'), search: qs('search-filter'),
    reset: qs('reset-btn'), refresh: qs('refresh-btn'), export: qs('export-btn'), sync: qs('sync-label'),
    loading: qs('loading-card'), error: qs('error-card'), content: qs('report-content'), periodLabel: qs('period-label'),
    kpiTotal: qs('kpi-total'), kpiOverdue: qs('kpi-overdue'), kpiEmail: qs('kpi-email'), kpiCall: qs('kpi-call'), kpiCompanies: qs('kpi-companies'), kpiOverdueShare: qs('kpi-overdue-share'),
    stageBars: qs('stage-bars'), topCompanies: qs('top-companies'), expertBars: qs('expert-bars'), quality: qs('quality-insights'),
    companies: qs('companies-list'), companySummary: qs('company-summary'),
    qualityDialog: qs('quality-dialog'), qualityTitle: qs('quality-title'), qualitySummary: qs('quality-summary'), qualityContent: qs('quality-content'), qualityClose: qs('quality-close'),
    historyDialog: qs('history-dialog'), historyTitle: qs('history-title'), historyLoading: qs('history-loading'), historyContent: qs('history-content'), historyClose: qs('history-close'),
  });
  populateStaticFilters();
  bindEvents();
  try {
    await initBitrix();
    const restored = restoreBrowserCache();
    // Если браузер уже видел этот отчёт — показываем его мгновенно и синхронизируемся без блокировки экрана.
    if (restored) loadData(false, true);
    else await loadData(false);
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(() => loadData(false, true), 5 * 60 * 1000);
  } catch (e) {
    els.loading.classList.add('hidden');
    els.error.classList.remove('hidden');
    els.error.innerHTML = `<strong>Не удалось открыть локальное приложение.</strong><br>${escapeHtml(e.message || String(e))}<br><br>Откройте «Возврат оригиналов» из меню Приложения внутри Bitrix24.`;
  }
}

document.addEventListener('DOMContentLoaded', boot);
