const path = require('path');
const crypto = require('crypto');

function registerDocReturnLocalApp({
  app,
  bitrixRestCall,
  bitrixRestList,
  actsExtractDealIdsFromTask,
  actsTaskField,
  actsCleanText,
  config,
}) {
  const PROJECT_ID = Number(process.env.DOC_RETURN_REPORT_PROJECT_ID || (config && config.actsProjectId) || 36);
  const ARCHIVE_STAGE_ID = String(process.env.DOC_RETURN_REPORT_ARCHIVE_STAGE_ID || '264');
  const PORTAL_DOMAIN = String(process.env.DOC_RETURN_REPORT_PORTAL_DOMAIN || 'mavisgroup.bitrix24.by').toLowerCase().trim();
  const CACHE_MS = Math.max(30_000, Number(process.env.DOC_RETURN_REPORT_CACHE_SECONDS || 300) * 1000);
  const AUTH_CACHE_MS = 5 * 60 * 1000;
  const ALLOWED_USER_IDS = new Set(
    String(process.env.DOC_RETURN_REPORT_ALLOWED_USER_IDS || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  );

  const MANUAL_COMPANY_BY_TASK = new Map([
    ['5850', '510'], ['16020', '4938'], ['17076', '3604'], ['21866', '3534'],
    ['22498', '3604'], ['25380', '6078'], ['29056', '6652'], ['30464', '6080'],
    ['37800', '8148'], ['38080', '2514'], ['38152', '8130'], ['38314', '4946'],
    ['39054', '4250'], ['39176', '4060'], ['39208', '3038'], ['39416', '344'],
    ['40204', '8362'], ['40374', '6032'], ['40722', '8946'], ['42776', '956'],
    ['46242', '5388'], ['5334', '1174'], ['44684', '8946'], ['45724', '5388'],
  ]);

  const MANUAL_COMPANY_NAME_BY_TASK = new Map([
    ['46414', 'Ваш Строительный Партнер'], ['46428', 'БАКСДИК'], ['46472', 'БЕЛТЯЖМАШ'],
    ['46524', 'Элекмо'], ['46530', 'АС-БилдингГрупп'], ['46558', 'РичЭнерго'],
    ['46578', 'ПолимерЭксперт'], ['46644', 'НОРДМИС'], ['46656', 'Фобос Секьюрити'],
    ['46748', 'Диптера'], ['46750', 'Ньюхаусинвест'], ['47018', 'ВитФорестСтрой'],
    ['47022', 'Лавреврострой'], ['47052', 'М350'], ['47212', 'ВиДпромэнерго'],
    ['40266', 'Маг воды'], ['40336', 'Сантехэлектросервис'], ['40666', 'ЮниКлимат'],
    ['43220', 'АЛДЕН-КОРП'], ['44442', 'Дом завтрашнего дня'], ['44676', 'БЕЛТИМ СБ'],
    ['45120', 'СанТехГазСервис'],
  ]);

  const reportCache = { at: 0, data: null, promise: null };
  const authCache = new Map();
  const manualNameCache = new Map();

  function clean(value) {
    if (typeof actsCleanText === 'function') return actsCleanText(value || '');
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function taskField(task, names) {
    if (typeof actsTaskField === 'function') return actsTaskField(task, names);
    if (!task) return undefined;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(task, name)) return task[name];
    }
    const lower = Object.fromEntries(Object.keys(task).map((key) => [key.toLowerCase(), key]));
    for (const name of names) {
      const real = lower[String(name).toLowerCase()];
      if (real) return task[real];
    }
    return undefined;
  }

  function normalize(value) {
    return String(value || '')
      .replace(/&quot;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[«»"'`]/g, ' ')
      .replace(/\b(ооо|одо|оао|зао|чуп|уп|ип|общество с ограниченной ответственностью|частное предприятие|частное транспортное унитарное предприятие)\b/gi, ' ')
      .replace(/[^a-zа-я0-9№]+/gi, '')
      .trim();
  }

  function classifyDocument(title) {
    const value = String(title || '').toLowerCase().replace(/ё/g, 'е');
    if (/доп\.?\s*соглаш/.test(value)) return 'Доп. соглашение';
    if (/договор/.test(value) && /счет/.test(value)) return 'Договор + счёт';
    if (/договор/.test(value)) return 'Договор';
    if (/акт/.test(value)) return 'Акт';
    if (/счет/.test(value)) return 'Счёт';
    return 'Другое';
  }

  function chunk(items, size = 50) {
    const result = [];
    for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
    return result;
  }

  async function mapLimit(items, limit, worker) {
    const output = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= items.length) break;
        output[index] = await worker(items[index], index);
      }
    });
    await Promise.all(workers);
    return output;
  }

  function asIso(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : raw;
  }

  function daysSince(value) {
    if (!value) return 0;
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return 0;
    return Math.max(0, Math.floor((Date.now() - parsed.getTime()) / 86400000));
  }

  function secureDomain(domain) {
    const value = String(domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    return value;
  }

  async function oauthCall(domain, accessToken, method, params = {}) {
    const safeDomain = secureDomain(domain);
    if (!safeDomain || safeDomain !== PORTAL_DOMAIN) throw new Error('Неверный домен Bitrix24.');
    const response = await fetch(`https://${safeDomain}/rest/${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...params, auth: accessToken }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) {
      throw new Error(data.error_description || data.error || `HTTP ${response.status}`);
    }
    return data.result;
  }

  function readAuth(req) {
    return {
      domain: secureDomain(req.headers['x-b24-domain'] || ''),
      accessToken: String(req.headers['x-b24-auth'] || '').trim(),
      memberId: String(req.headers['x-b24-member'] || '').trim(),
    };
  }

  async function authorize(req) {
    const auth = readAuth(req);
    if (!auth.domain || auth.domain !== PORTAL_DOMAIN || !auth.accessToken) {
      const error = new Error('Откройте отчёт из Bitrix24. Авторизация приложения не получена.');
      error.statusCode = 401;
      throw error;
    }

    const tokenHash = crypto.createHash('sha256').update(`${auth.domain}|${auth.accessToken}`).digest('hex');
    const cached = authCache.get(tokenHash);
    if (cached && Date.now() - cached.at < AUTH_CACHE_MS) return { ...auth, user: cached.user };

    let user;
    try {
      user = await oauthCall(auth.domain, auth.accessToken, 'user.current', {});
    } catch (e) {
      const error = new Error(`Сессия Bitrix24 истекла: ${e.message || e}`);
      error.statusCode = 401;
      throw error;
    }

    const userId = String(user && (user.ID || user.id) || '');
    if (ALLOWED_USER_IDS.size && !ALLOWED_USER_IDS.has(userId)) {
      const error = new Error('У вас нет доступа к отчёту «Возврат оригиналов».');
      error.statusCode = 403;
      throw error;
    }

    authCache.set(tokenHash, { at: Date.now(), user });
    return { ...auth, user };
  }

  function unwrapStages(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') return Object.values(raw);
    return [];
  }

  async function loadStages() {
    const raw = await bitrixRestCall('task.stages.get', { entityId: PROJECT_ID });
    const rows = unwrapStages(raw)
      .map((stage) => ({
        id: String(stage && (stage.ID || stage.id) || ''),
        title: clean(stage && (stage.TITLE || stage.title) || ''),
        sort: Number(stage && (stage.SORT || stage.sort) || 0),
        color: String(stage && (stage.COLOR || stage.color) || ''),
      }))
      .filter((stage) => stage.id);
    return rows.sort((a, b) => a.sort - b.sort || Number(a.id) - Number(b.id));
  }

  async function loadCurrentTasks(stages) {
    const stageIds = stages.map((stage) => stage.id).filter((id) => id && id !== ARCHIVE_STAGE_ID);
    if (!stageIds.includes('0')) stageIds.push('0');

    const lists = await mapLimit(stageIds, 4, async (stageId) => {
      try {
        return await bitrixRestList('tasks.task.list', {
          order: { ID: 'ASC' },
          filter: { GROUP_ID: PROJECT_ID, STAGE_ID: Number(stageId) },
          select: [
            'ID', 'TITLE', 'GROUP_ID', 'STAGE_ID', 'STATUS', 'REAL_STATUS',
            'RESPONSIBLE_ID', 'RESPONSIBLE_NAME', 'CREATED_DATE', 'CHANGED_DATE',
            'STATUS_CHANGED_DATE', 'DEADLINE', 'UF_CRM_TASK',
          ],
        }, 3000);
      } catch (e) {
        console.warn(`[doc-return-local] stage=${stageId}: ${e.message || e}`);
        return [];
      }
    });

    const byId = new Map();
    for (const list of lists) {
      for (const task of list || []) {
        const id = String(taskField(task, ['id', 'ID']) || '');
        if (id) byId.set(id, task);
      }
    }
    return [...byId.values()];
  }

  function extractDealId(task) {
    if (typeof actsExtractDealIdsFromTask === 'function') {
      try {
        const ids = actsExtractDealIdsFromTask(task) || [];
        if (ids.length) return String(ids[0]);
      } catch (_) {}
    }
    const raw = taskField(task, ['ufCrmTask', 'UF_CRM_TASK', 'uf_crm_task', 'crm', 'CRM']);
    const text = Array.isArray(raw) ? raw.join(' ') : JSON.stringify(raw || '');
    const match = String(text).match(/D[_:]?(\d+)/i);
    return match ? match[1] : '';
  }

  async function loadDeals(dealIds) {
    const unique = [...new Set(dealIds.map(String).filter(Boolean))];
    const lists = await mapLimit(chunk(unique, 50), 3, async (ids) => {
      return bitrixRestList('crm.deal.list', {
        order: { DATE_MODIFY: 'DESC' },
        filter: { '@ID': ids },
        select: ['ID', 'TITLE', 'COMPANY_ID', 'ASSIGNED_BY_ID', 'DATE_MODIFY'],
      }, 500);
    });
    const map = new Map();
    for (const list of lists) {
      for (const deal of list || []) {
        const id = String(deal && (deal.ID || deal.id) || '');
        if (id) map.set(id, deal);
      }
    }
    return map;
  }

  async function loadCompaniesByIds(companyIds) {
    const unique = [...new Set(companyIds.map(String).filter((id) => id && id !== '0'))];
    const lists = await mapLimit(chunk(unique, 50), 3, async (ids) => {
      return bitrixRestList('crm.company.list', {
        order: { ID: 'ASC' },
        filter: { '@ID': ids },
        select: ['ID', 'TITLE', 'ASSIGNED_BY_ID'],
      }, 500);
    });
    const map = new Map();
    for (const list of lists) {
      for (const company of list || []) {
        const id = String(company && (company.ID || company.id) || '');
        if (!id) continue;
        map.set(id, {
          id,
          title: clean(company.TITLE || company.title || ''),
          assignedById: String(company.ASSIGNED_BY_ID || company.assignedById || ''),
        });
      }
    }
    return map;
  }

  async function resolveManualCompanyName(searchName) {
    const cacheKey = normalize(searchName);
    if (!cacheKey) return null;
    if (manualNameCache.has(cacheKey)) return manualNameCache.get(cacheKey);

    const variants = [searchName];
    if (searchName.includes(' ')) variants.push(searchName.split(/\s+/).slice(0, 2).join(' '));
    let candidates = [];
    for (const variant of variants) {
      const rows = await bitrixRestList('crm.company.list', {
        order: { ID: 'ASC' },
        filter: { '%TITLE': variant },
        select: ['ID', 'TITLE', 'ASSIGNED_BY_ID'],
      }, 100).catch(() => []);
      candidates.push(...rows);
      if (rows.length) break;
    }

    const target = normalize(searchName);
    let best = null;
    for (const company of candidates) {
      const title = clean(company.TITLE || company.title || '');
      const norm = normalize(title);
      if (!norm) continue;
      let score = 0;
      if (norm === target) score = 1000;
      else if (norm.includes(target)) score = 800;
      else if (target.includes(norm) && norm.length >= 5) score = 700;
      if (!score) continue;
      const candidate = {
        id: String(company.ID || company.id || ''),
        title,
        assignedById: String(company.ASSIGNED_BY_ID || company.assignedById || ''),
        score,
        len: norm.length,
      };
      if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.len < best.len)) best = candidate;
    }
    const result = best ? { id: best.id, title: best.title, assignedById: best.assignedById } : null;
    manualNameCache.set(cacheKey, result);
    return result;
  }

  async function loadUsers(ids) {
    const unique = [...new Set(ids.map(String).filter(Boolean))];
    const map = new Map();
    if (!unique.length) return map;
    const lists = await mapLimit(chunk(unique, 50), 3, async (part) => {
      return bitrixRestList('user.get', { filter: { ID: part } }, 500).catch(() => []);
    });
    for (const list of lists) {
      for (const user of list || []) {
        const id = String(user && (user.ID || user.id) || '');
        if (!id) continue;
        const fullName = clean(`${user.NAME || user.name || ''} ${user.LAST_NAME || user.lastName || ''}`) || `ID ${id}`;
        map.set(id, fullName);
      }
    }
    return map;
  }

  function pickLatestDealByCompany(dealsById) {
    const latest = new Map();
    for (const deal of dealsById.values()) {
      const companyId = String(deal.COMPANY_ID || deal.companyId || '');
      if (!companyId || companyId === '0') continue;
      const date = Date.parse(String(deal.DATE_MODIFY || deal.dateModify || '')) || 0;
      const existing = latest.get(companyId);
      if (!existing || date > existing.date) latest.set(companyId, { deal, date });
    }
    return latest;
  }

  function fallbackMatchCompanyByTitle(title, companyMap) {
    const hay = normalize(title);
    if (!hay) return null;
    let best = null;
    for (const company of companyMap.values()) {
      const norm = normalize(company.title);
      if (!norm || norm.length < 5) continue;
      if (/^(подбор|аттестация|спк|периодика|исо|iso|суот|сантехник|электрик)/i.test(norm)) continue;
      if (!hay.includes(norm)) continue;
      if (!best || norm.length > best.norm.length) best = { company, norm };
    }
    return best ? best.company : null;
  }

  async function buildReport(force = false) {
    if (!force && reportCache.data && Date.now() - reportCache.at < CACHE_MS) return reportCache.data;
    if (reportCache.promise) return reportCache.promise;

    reportCache.promise = (async () => {
      const started = Date.now();
      const stages = await loadStages();
      const stageMap = new Map(stages.map((stage) => [String(stage.id), stage]));
      const tasks = await loadCurrentTasks(stages);

      const dealIdByTask = new Map();
      const dealIds = [];
      for (const task of tasks) {
        const taskId = String(taskField(task, ['id', 'ID']) || '');
        const dealId = extractDealId(task);
        if (taskId && dealId) dealIdByTask.set(taskId, dealId);
        if (dealId) dealIds.push(dealId);
      }
      const dealsById = await loadDeals(dealIds);

      const companyIds = [];
      for (const deal of dealsById.values()) {
        const companyId = String(deal.COMPANY_ID || deal.companyId || '');
        if (companyId && companyId !== '0') companyIds.push(companyId);
      }
      for (const id of MANUAL_COMPANY_BY_TASK.values()) companyIds.push(id);

      const companyMap = await loadCompaniesByIds(companyIds);

      const nameOverrides = [...new Set([...MANUAL_COMPANY_NAME_BY_TASK.values()])];
      const nameCompanies = await mapLimit(nameOverrides, 4, async (name) => [name, await resolveManualCompanyName(name)]);
      const manualNameCompany = new Map();
      for (const [name, company] of nameCompanies) {
        manualNameCompany.set(name, company);
        if (company && company.id) companyMap.set(company.id, company);
      }

      const latestDealByCompany = pickLatestDealByCompany(dealsById);

      const resolvedRows = [];
      const userIds = [];
      for (const task of tasks) {
        const taskId = String(taskField(task, ['id', 'ID']) || '');
        if (!taskId) continue;
        const title = clean(taskField(task, ['title', 'TITLE']) || '');
        const stageId = String(taskField(task, ['stageId', 'STAGE_ID', 'stage_id']) ?? '0');
        if (stageId === ARCHIVE_STAGE_ID) continue;
        const dealId = dealIdByTask.get(taskId) || '';
        const deal = dealId ? dealsById.get(dealId) : null;

        let company = null;
        let companySource = 'Не определено';
        const manualId = MANUAL_COMPANY_BY_TASK.get(taskId);
        if (manualId) {
          company = companyMap.get(String(manualId)) || null;
          if (company) companySource = 'Ручное соответствие';
        }
        if (!company && deal) {
          const dealCompanyId = String(deal.COMPANY_ID || deal.companyId || '');
          if (dealCompanyId && dealCompanyId !== '0') {
            company = companyMap.get(dealCompanyId) || null;
            if (company) companySource = 'CRM-связь';
          }
        }
        if (!company) {
          const manualName = MANUAL_COMPANY_NAME_BY_TASK.get(taskId);
          if (manualName) {
            company = manualNameCompany.get(manualName) || null;
            if (company) companySource = 'Ручное название';
          }
        }
        if (!company) {
          company = fallbackMatchCompanyByTitle(title, companyMap);
          if (company) companySource = 'Название задачи';
        }

        const latest = company && latestDealByCompany.get(String(company.id));
        const latestDeal = latest && latest.deal;
        const expertId = String(
          (latestDeal && (latestDeal.ASSIGNED_BY_ID || latestDeal.assignedById)) ||
          (company && company.assignedById) ||
          taskField(task, ['responsibleId', 'RESPONSIBLE_ID', 'responsible_id']) ||
          ''
        );
        if (expertId) userIds.push(expertId);

        const createdAt = asIso(taskField(task, ['createdDate', 'CREATED_DATE', 'created_date']));
        const changedAt = asIso(taskField(task, ['changedDate', 'CHANGED_DATE', 'changed_date']));
        const statusChangedAt = asIso(taskField(task, ['statusChangedDate', 'STATUS_CHANGED_DATE', 'status_changed_date']));
        const deadline = asIso(taskField(task, ['deadline', 'DEADLINE']));
        const overdue = Boolean(deadline && new Date(deadline).getTime() < Date.now());

        resolvedRows.push({
          taskId,
          taskUrl: `https://mavisgroup.bitrix24.by/workgroups/group/${PROJECT_ID}/tasks/task/view/${taskId}/`,
          title,
          documentType: classifyDocument(title),
          stageId,
          stageName: (stageMap.get(stageId) && stageMap.get(stageId).title) || (stageId === '0' ? 'Без стадии' : `Стадия ${stageId}`),
          taskStatus: String(taskField(task, ['status', 'STATUS', 'realStatus', 'REAL_STATUS']) || ''),
          companyId: company ? String(company.id) : '',
          companyName: company ? company.title : 'Компания не определена',
          companySource,
          expertId,
          expertSource: latestDeal ? 'Последняя связанная сделка' : (company && company.assignedById ? 'Карточка компании' : 'Ответственный задачи'),
          dealId,
          createdAt,
          changedAt,
          statusChangedAt,
          deadline,
          overdue,
          overdueDays: overdue ? daysSince(deadline) : 0,
          ageDays: createdAt ? daysSince(createdAt) : 0,
          createdYear: createdAt ? new Date(createdAt).getFullYear() : null,
          createdMonth: createdAt ? new Date(createdAt).getMonth() + 1 : null,
        });
      }

      const users = await loadUsers(userIds);
      for (const row of resolvedRows) {
        row.expert = users.get(row.expertId) || 'Не определён';
      }

      resolvedRows.sort((a, b) => {
        const companySort = a.companyName.localeCompare(b.companyName, 'ru');
        if (companySort) return companySort;
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });

      const data = {
        ok: true,
        generatedAt: new Date().toISOString(),
        projectId: PROJECT_ID,
        archiveStageId: ARCHIVE_STAGE_ID,
        archiveStageName: (stageMap.get(ARCHIVE_STAGE_ID) && stageMap.get(ARCHIVE_STAGE_ID).title) || 'Архив',
        durationMs: Date.now() - started,
        cacheSeconds: Math.round(CACHE_MS / 1000),
        stages,
        rows: resolvedRows,
        unmatchedCount: resolvedRows.filter((row) => !row.companyId).length,
      };
      reportCache.at = Date.now();
      reportCache.data = data;
      console.log(`[doc-return-local] built rows=${resolvedRows.length}; unmatched=${data.unmatchedCount}; ${data.durationMs}ms`);
      return data;
    })().finally(() => {
      reportCache.promise = null;
    });

    return reportCache.promise;
  }

  async function loadTaskStageHistory(taskId) {
    const raw = await bitrixRestCall('tasks.task.history.list', {
      taskId: Number(taskId),
      filter: { FIELD: 'STAGE_ID' },
      order: { createdDate: 'DESC' },
    });
    const list = raw && Array.isArray(raw.list) ? raw.list : (raw && Array.isArray(raw.items) ? raw.items : []);
    const stages = await loadStages();
    const stageMap = new Map(stages.map((stage) => [String(stage.id), stage.title]));
    return list.map((event) => {
      const value = event && (event.value || event.VALUE) || {};
      const fromId = String(value.from ?? value.FROM ?? '');
      const toId = String(value.to ?? value.TO ?? '');
      return {
        id: String(event && (event.id || event.ID) || ''),
        createdAt: String(event && (event.createdDate || event.CREATED_DATE) || ''),
        fromId,
        toId,
        from: stageMap.get(fromId) || fromId || '—',
        to: stageMap.get(toId) || toId || '—',
        user: clean(`${event && event.user && (event.user.name || event.user.NAME) || ''} ${event && event.user && (event.user.lastName || event.user.LAST_NAME) || ''}`),
      };
    });
  }

  app.all('/doc-return-report', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'doc-return-report.html'));
  });

  app.get('/api/doc-return-report/data', async (req, res) => {
    try {
      const auth = await authorize(req);
      const force = ['1', 'true', 'yes'].includes(String(req.query.force || '').toLowerCase());
      const data = await buildReport(force);
      res.json({ ...data, currentUser: auth.user });
    } catch (e) {
      res.status(Number(e.statusCode || 500)).json({ ok: false, error: e.message || String(e) });
    }
  });

  app.get('/api/doc-return-report/task-history/:taskId', async (req, res) => {
    try {
      await authorize(req);
      const taskId = String(req.params.taskId || '').replace(/\D/g, '');
      if (!taskId) return res.status(400).json({ ok: false, error: 'taskId не указан' });
      const rows = await loadTaskStageHistory(taskId);
      res.json({ ok: true, taskId, rows });
    } catch (e) {
      res.status(Number(e.statusCode || 500)).json({ ok: false, error: e.message || String(e) });
    }
  });

  console.log(`[doc-return-local] route=/doc-return-report; project=${PROJECT_ID}; archive=${ARCHIVE_STAGE_ID}; portal=${PORTAL_DOMAIN}`);
}

module.exports = { registerDocReturnLocalApp };
