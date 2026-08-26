const path = require('path');
const fs = require('fs');
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
  const VERSION = 'v113 FULL_REPORT_EDITABLE';
  const PROJECT_ID = Number(process.env.DOC_RETURN_REPORT_PROJECT_ID || (config && config.actsProjectId) || 36);
  const PORTAL_DOMAIN = String(process.env.DOC_RETURN_REPORT_PORTAL_DOMAIN || 'mavisgroup.bitrix24.by').toLowerCase().trim();
  const CACHE_MS = Math.max(60_000, Number(process.env.DOC_RETURN_REPORT_CACHE_SECONDS || 300) * 1000);
  const AUTH_CACHE_MS = 5 * 60 * 1000;
  const HISTORY_START = String(process.env.DOC_RETURN_REPORT_HISTORY_START || '2026-01-01T00:00:00+03:00');
  const STORAGE_TASK_TITLE = '[MAVIS_REPORT_STORAGE] Возврат оригиналов — служебные данные';
  const STORAGE_MARKER = '[MAVIS_RETURN_REPORT_RECORD]';
  const STORAGE_STAGE_ID = '1744'; // стадия РАСПЕЧАТАНО исключена из отчёта и используется только как технический карман

  const STAGES = {
    new: '252', done: '256', paid: '610', printed: '1130', envelope: '1350', sent: '1132',
    willCome: '270', email: '1126', call: '1128', potentialReturn: '1588', inventoryPrepare: '1068', inventorySent: '1572',
    ignoredPrinted: '1744', scan: '1480', archive: '264',
  };
  const EARLY_STAGE_IDS = new Set([STAGES.new, STAGES.done, STAGES.paid, STAGES.printed, STAGES.envelope, STAGES.sent]);
  const CONTROL_STAGE_IDS = new Set([STAGES.willCome, STAGES.email, STAGES.call, STAGES.potentialReturn, STAGES.inventoryPrepare, STAGES.inventorySent]);
  const RETURNED_STAGE_IDS = new Set([STAGES.scan, STAGES.archive]);

  const ALLOWED_USER_IDS = new Set(
    String(process.env.DOC_RETURN_REPORT_ALLOWED_USER_IDS || '')
      .split(',').map((x) => x.trim()).filter(Boolean)
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

  const CATEGORIES = [
    'Вышлет в ближайшее время',
    'Ошибка / переотправить документ',
    'Услуга не оказана',
    'Возврат',
    'Другое',
  ];

  // Стартовые ответы пользователя. Любую строку можно отредактировать в приложении — правка сохранится в Bitrix.
  const SEED_RESPONSES = [
    ['Оконный трест', 'поменялся юр адрес', 'Ошибка / переотправить документ', 'Изменились реквизиты'],
    ['Гомельагрокомплект', 'попросили поменять дату акта', 'Ошибка / переотправить документ', 'Изменить дату акта'],
    ['ВитТехноСистемы', 'сегодня отправим', 'Вышлет в ближайшее время', ''],
    ['МасКомпани', 'сегодня отправим', 'Вышлет в ближайшее время', ''],
    ['Сити-Лад плюс', 'возврат', 'Возврат', ''],
    ['Центр строительства и обслуживания', 'был возврат, договор не актуальный', 'Возврат', 'Договор не актуальный'],
    ['Айслагом', 'за пределами РБ, позвонит как приедет', 'Другое', 'Отложено / клиент за пределами РБ'],
    ['ЭлектроНаМи', 'говорит что подписывал в офисе', 'Другое', 'Нужно проверить оригинал в офисе'],
    ['БелИнжПлан', 'отправили во вт', 'Вышлет в ближайшее время', 'Уже отправили'],
    ['ПинскСпецПроект', 'не выполнена работа, подписывать не хотят', 'Услуга не оказана', 'Отказ от подписания'],
    ['Дорастрой', 'переотправила во вт', 'Вышлет в ближайшее время', 'Уже отправили'],
    ['Геоплан', 'вышлют на этой неделе', 'Вышлет в ближайшее время', ''],
    ['АЛДЕН-КОРП', 'отправят на этой неделе', 'Вышлет в ближайшее время', ''],
    ['ЭкспертПроект', 'сумму в акте поменять (была не верная)', 'Ошибка / переотправить документ', 'Неверная сумма в акте'],
    ['Дуалекс', 'попросил переотправить договор, подпишет', 'Ошибка / переотправить документ', 'Переотправить договор'],
    ['ЮниКлимат', 'вышлют сегодня', 'Вышлет в ближайшее время', ''],
    ['Немстрой', 'не будут подписывать, работа не выполнена', 'Услуга не оказана', 'Отказ от подписания'],
    ['ВипАльпБел', 'подпишут, попросили скинуть на электронку', 'Ошибка / переотправить документ', 'Переотправить электронно'],
    ['Гуларстрой', 'выслали скан, на неделе вышлют почту', 'Вышлет в ближайшее время', 'Скан уже получен'],
    ['ТехноИнвестСтрой', 'попросили переотправить акт', 'Ошибка / переотправить документ', 'Переотправить акт'],
    ['ЮВС Энерго', 'попросили переотправить', 'Ошибка / переотправить документ', 'Переотправить документ'],
    ['РууфсСтройКомпани', 'попросили перепроверить, говорит в офисе подписывал', 'Другое', 'Проверить оригинал в офисе'],
    ['ПромСтройЭкспресс', 'просят переделать акт и переотправить', 'Ошибка / переотправить документ', 'Переделать акт'],
    ['СтройСантехМонтаж', 'вышлет договор как только мы вернем деньги', 'Возврат', 'Возврат денег — условие подписания'],
    ['Кастом-Инвес', 'распечатали и вышлют на этой неделе', 'Вышлет в ближайшее время', ''],
    ['Лапехо', 'вышлет почтой на неделе', 'Вышлет в ближайшее время', ''],
    ['Гуларстрой', 'вышлют на неделе', 'Вышлет в ближайшее время', 'Повторный ответ — проверить, тот ли документ'],
    ['Сезон комфорта', 'не хочет подписывать, услуги не выполнены', 'Услуга не оказана', 'Отказ от подписания'],
    ['ЕвроВидеоМонтаж', 'отправили на неделе', 'Вышлет в ближайшее время', 'Уже отправили'],
    ['Бешенковичская ПМК-41', 'услуга не выполнена, акт подписывать отказываются', 'Услуга не оказана', 'Отказ от подписания'],
    ['Этерния', 'приехала лично в офис, все с ней подписали', 'Другое', 'Оригинал получен лично'],
    ['ЭнергоГлайд', 'позвонил, все ок, вышлет', 'Вышлет в ближайшее время', ''],
    ['Велес-Эксперт', 'позвонил, все подпишет и вышлет', 'Вышлет в ближайшее время', ''],
    ['АнПрофСервис', 'позвонил, договоримся, он подъедет в Минск подпишет', 'Вышлет в ближайшее время', 'Привезёт лично'],
    ['Биллион-Строй', 'попросили распечатать, директор подъедет лично', 'Вышлет в ближайшее время', 'Привезёт лично'],
    ['Байруз', 'приехал лично, привез акт', 'Другое', 'Оригинал получен лично'],
    ['ЭкспертПожСервис', 'Рома ходил к ним лично подписывать акт и потерял, сходим к ним снова', 'Другое', 'Внутренняя проблема — документ потерян'],
    ['СК Молоток', 'вышлет в 2-х экземплярах', 'Вышлет в ближайшее время', ''],
    ['Види-Арх', 'пока вопрос не закрыт не сможем акт подписать, большой объем ошибок', 'Другое', 'Претензия к результату услуги'],
    ['Дом завтрашнего дня', 'прислал скан', 'Другое', 'Скан получен'],
    ['Белсетьмонтаж', 'возврат', 'Возврат', ''],
    ['Гефлис', 'прислали скан', 'Другое', 'Скан получен'],
  ].map((row, index) => ({
    id: `seed-${String(index + 1).padStart(3, '0')}`,
    responseDate: '2026-08-26',
    companyName: row[0],
    taskId: '',
    documentTitle: '',
    category: row[2],
    serviceArticle: '',
    detail: row[3],
    comment: row[1],
    status: 'Новый',
    deleted: false,
    source: 'Стартовый список',
  }));

  const reportCache = { at: 0, data: null, promise: null };
  const authCache = new Map();
  const manualNameCache = new Map();
  const storageCache = { at: 0, taskId: '', records: new Map() };
  const mailingScanCache = { at: 0, ready: false, scanning: false, events: [], error: '', promise: null };
  const historyIndexCache = { at: 0, ready: false, scanning: false, months: [], items: [], error: '', promise: null };
  const SNAPSHOT_FILE = '/tmp/mavis_doc_return_report_snapshot.json';

  function clean(value) {
    if (typeof actsCleanText === 'function') return actsCleanText(value || '');
    return String(value || '').replace(/\s+/g, ' ').trim();
  }
  function taskField(task, names) {
    if (typeof actsTaskField === 'function') return actsTaskField(task, names);
    if (!task) return undefined;
    for (const name of names) if (Object.prototype.hasOwnProperty.call(task, name)) return task[name];
    const lower = Object.fromEntries(Object.keys(task).map((key) => [key.toLowerCase(), key]));
    for (const name of names) { const real = lower[String(name).toLowerCase()]; if (real) return task[real]; }
    return undefined;
  }
  function normalize(value) {
    return String(value || '').replace(/&quot;/gi, ' ').replace(/&amp;/gi, '&').toLowerCase().replace(/ё/g, 'е')
      .replace(/[«»"'`]/g, ' ')
      .replace(/\b(ооо|одо|оао|зао|чуп|уп|ип|общество с ограниченной ответственностью|частное предприятие|частное транспортное унитарное предприятие)\b/gi, ' ')
      .replace(/[^a-zа-я0-9№]+/gi, '').trim();
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
  function inferServiceArticle(title) {
    const value = String(title || '').toLowerCase().replace(/ё/g, 'е');
    const tests = [
      [/\bспк\b/, 'СПК'], [/аттестаци|\bатт\b/, 'Аттестация'], [/суот|iso\s*45001/, 'СУОТ / ISO 45001'],
      [/iso\s*9001|\bисо\b/, 'ISO 9001'], [/мчс/, 'Лицензия МЧС'], [/мвд/, 'Лицензия МВД'],
      [/подбор/, 'Подбор специалиста'], [/сертификац|\bтр\b|тр\s*тс/, 'Сертификация / ТР'],
      [/\bту\b|техническ.*услов/, 'ТУ'], [/осп|свар/, 'ОСП / сварка'], [/периодик/, 'Периодика'],
    ];
    for (const [re, label] of tests) if (re.test(value)) return label;
    return '';
  }
  function classifyResponse(text) {
    const v = String(text || '').toLowerCase().replace(/ё/g, 'е');
    if (/возврат|вернем деньги|вернём деньги/.test(v)) return 'Возврат';
    if (/не выполн|не оказан|не будут подпис|не будет подпис|не хочет подпис|подписывать отказыва/.test(v)) return 'Услуга не оказана';
    if (/поменя|передел|переотправ|ошиб|неверн|перепровер|не актуальн/.test(v)) return 'Ошибка / переотправить документ';
    if (/вышл|отправил|отправили|подпиш|подъед|приедет|привез/.test(v)) return 'Вышлет в ближайшее время';
    return 'Другое';
  }
  function chunk(items, size = 50) { const result = []; for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size)); return result; }
  async function mapLimit(items, limit, worker) {
    const output = new Array(items.length); let cursor = 0;
    const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
      for (;;) { const index = cursor++; if (index >= items.length) break; output[index] = await worker(items[index], index); }
    });
    await Promise.all(workers); return output;
  }
  function asIso(value) { const raw = String(value || '').trim(); if (!raw) return ''; const d = new Date(raw); return Number.isFinite(d.getTime()) ? d.toISOString() : raw; }
  function daysSince(value) { if (!value) return 0; const d = new Date(value); return Number.isFinite(d.getTime()) ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000)) : 0; }
  function secureDomain(domain) { return String(domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
  function toBase64Url(obj) { return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url'); }
  function fromBase64Url(text) { try { return JSON.parse(Buffer.from(String(text || ''), 'base64url').toString('utf8')); } catch (_) { return null; } }

  async function oauthRaw(domain, accessToken, method, params = {}) {
    const safeDomain = secureDomain(domain);
    if (!safeDomain || safeDomain !== PORTAL_DOMAIN) throw new Error('Неверный домен Bitrix24.');
    const response = await fetch(`https://${safeDomain}/rest/${method}.json`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ ...params, auth: accessToken }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.error) throw new Error(data.error_description || data.error || `HTTP ${response.status}`);
    return data;
  }
  async function oauthCall(domain, accessToken, method, params = {}) { return (await oauthRaw(domain, accessToken, method, params)).result; }
  async function oauthList(domain, accessToken, method, params = {}, limit = 1000) {
    const out = []; let start = 0;
    for (;;) {
      const data = await oauthRaw(domain, accessToken, method, { ...params, start });
      const r = data.result;
      const items = Array.isArray(r) ? r : (r && Array.isArray(r.items) ? r.items : (r && Array.isArray(r.tasks) ? r.tasks : []));
      out.push(...items);
      if (out.length >= limit || data.next == null || !items.length) break;
      start = Number(data.next);
      if (!Number.isFinite(start)) break;
    }
    return out.slice(0, limit);
  }
  function readAuth(req) { return { domain: secureDomain(req.headers['x-b24-domain'] || ''), accessToken: String(req.headers['x-b24-auth'] || '').trim(), memberId: String(req.headers['x-b24-member'] || '').trim() }; }
  async function authorize(req) {
    const auth = readAuth(req);
    if (!auth.domain || auth.domain !== PORTAL_DOMAIN || !auth.accessToken) { const e = new Error('Откройте отчёт из Bitrix24. Авторизация приложения не получена.'); e.statusCode = 401; throw e; }
    const hash = crypto.createHash('sha256').update(`${auth.domain}|${auth.accessToken}`).digest('hex');
    const cached = authCache.get(hash); if (cached && Date.now() - cached.at < AUTH_CACHE_MS) return { ...auth, user: cached.user };
    let user;
    try { user = await oauthCall(auth.domain, auth.accessToken, 'user.current', {}); } catch (err) { const e = new Error(`Сессия Bitrix24 истекла: ${err.message || err}`); e.statusCode = 401; throw e; }
    const userId = String(user && (user.ID || user.id) || '');
    if (ALLOWED_USER_IDS.size && !ALLOWED_USER_IDS.has(userId)) { const e = new Error('У вас нет доступа к отчёту «Возврат оригиналов».'); e.statusCode = 403; throw e; }
    authCache.set(hash, { at: Date.now(), user }); return { ...auth, user };
  }

  function unwrapStages(raw) { return Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []); }
  async function loadStages() {
    const raw = await bitrixRestCall('task.stages.get', { entityId: PROJECT_ID });
    return unwrapStages(raw).map((s) => ({ id: String(s && (s.ID || s.id) || ''), title: clean(s && (s.TITLE || s.title) || ''), sort: Number(s && (s.SORT || s.sort) || 0), color: String(s && (s.COLOR || s.color) || '') }))
      .filter((s) => s.id).sort((a, b) => a.sort - b.sort || Number(a.id) - Number(b.id));
  }

  async function loadReportTasks(stages) {
    const ids = stages.map((s) => s.id).filter((id) => id && id !== STAGES.ignoredPrinted);
    if (!ids.includes('0')) ids.push('0');
    const lists = await mapLimit(ids, 8, async (stageId) => {
      try {
        const filter = { GROUP_ID: PROJECT_ID, STAGE_ID: Number(stageId) };
        // Архив огромный. Для отчёта 2026 берём архивные задачи, которые менялись в отчётном периоде.
        if (stageId === STAGES.archive) filter['>=CHANGED_DATE'] = HISTORY_START;
        return await bitrixRestList('tasks.task.list', {
          order: { ID: 'ASC' }, filter,
          select: ['ID','TITLE','GROUP_ID','STAGE_ID','STATUS','REAL_STATUS','RESPONSIBLE_ID','RESPONSIBLE_NAME','CREATED_DATE','CHANGED_DATE','STATUS_CHANGED_DATE','DEADLINE','UF_CRM_TASK','CHAT_ID'],
        }, stageId === STAGES.archive ? 5000 : 3000);
      } catch (e) { console.warn(`[doc-return-local] stage=${stageId}: ${e.message || e}`); return []; }
    });
    const byId = new Map();
    for (const list of lists) for (const task of list || []) {
      const id = String(taskField(task, ['id','ID']) || ''); const title = clean(taskField(task, ['title','TITLE']) || '');
      if (!id || title === STORAGE_TASK_TITLE) continue; byId.set(id, task);
    }
    return [...byId.values()];
  }

  function extractCrmBindings(task) {
    const raw = taskField(task, ['ufCrmTask','UF_CRM_TASK','uf_crm_task','crm','CRM']);
    const text = Array.isArray(raw) ? raw.join(' ') : JSON.stringify(raw || '');
    const dealMatch = String(text).match(/(?:^|[^A-Z])D[_:]?(\d+)/i);
    // В задачах Bitrix компания в «Элементах CRM» обычно хранится как CO_12345.
    // Важно: C_ — это контакт, поэтому его намеренно не считаем компанией.
    const companyMatch = String(text).match(/(?:^|[^A-Z])CO[_:]?(\d+)/i) || String(text).match(/COMPANY[_:]?(\d+)/i);
    return {
      dealId: dealMatch ? dealMatch[1] : '',
      companyId: companyMatch ? companyMatch[1] : '',
    };
  }
  function extractDealId(task) {
    if (typeof actsExtractDealIdsFromTask === 'function') {
      try {
        const ids = actsExtractDealIdsFromTask(task) || [];
        if (ids.length) return String(ids[0]);
      } catch (_) {}
    }
    return extractCrmBindings(task).dealId;
  }
  function extractDirectCompanyId(task) {
    return extractCrmBindings(task).companyId;
  }
  async function loadDeals(dealIds) {
    const unique = [...new Set(dealIds.map(String).filter(Boolean))]; const lists = await mapLimit(chunk(unique, 50), 5, (ids) => bitrixRestList('crm.deal.list', { order: { DATE_MODIFY: 'DESC' }, filter: { '@ID': ids }, select: ['ID','TITLE','COMPANY_ID','ASSIGNED_BY_ID','DATE_MODIFY'] }, 500));
    const map = new Map(); for (const list of lists) for (const d of list || []) { const id = String(d && (d.ID || d.id) || ''); if (id) map.set(id, d); } return map;
  }
  async function loadCompaniesByIds(companyIds) {
    const unique = [...new Set(companyIds.map(String).filter((id) => id && id !== '0'))]; const lists = await mapLimit(chunk(unique, 50), 5, (ids) => bitrixRestList('crm.company.list', { order: { ID: 'ASC' }, filter: { '@ID': ids }, select: ['ID','TITLE','ASSIGNED_BY_ID'] }, 500));
    const map = new Map(); for (const list of lists) for (const c of list || []) { const id = String(c && (c.ID || c.id) || ''); if (id) map.set(id, { id, title: clean(c.TITLE || c.title || ''), assignedById: String(c.ASSIGNED_BY_ID || c.assignedById || '') }); } return map;
  }
  async function resolveManualCompanyName(searchName) {
    const key = normalize(searchName); if (!key) return null; if (manualNameCache.has(key)) return manualNameCache.get(key);
    const variants = [searchName]; if (searchName.includes(' ')) variants.push(searchName.split(/\s+/).slice(0, 2).join(' ')); let candidates = [];
    for (const variant of variants) { const rows = await bitrixRestList('crm.company.list', { order: { ID:'ASC' }, filter: { '%TITLE': variant }, select: ['ID','TITLE','ASSIGNED_BY_ID'] }, 100).catch(() => []); candidates.push(...rows); if (rows.length) break; }
    let best = null; for (const c of candidates) { const title = clean(c.TITLE || c.title || ''); const norm = normalize(title); let score = 0; if (norm === key) score=1000; else if (norm.includes(key)) score=800; else if (key.includes(norm) && norm.length>=5) score=700; if (!score) continue; const x={id:String(c.ID||c.id||''),title,assignedById:String(c.ASSIGNED_BY_ID||c.assignedById||''),score,len:norm.length}; if (!best || x.score>best.score || (x.score===best.score && x.len<best.len)) best=x; }
    const result = best ? { id:best.id,title:best.title,assignedById:best.assignedById } : null; manualNameCache.set(key,result); return result;
  }
  async function loadUsers(ids) {
    const unique = [...new Set(ids.map(String).filter(Boolean))]; const map = new Map();
    const lists = await mapLimit(chunk(unique,50),5,(part)=>bitrixRestList('user.get',{filter:{ID:part}},500).catch(()=>[]));
    for (const list of lists) for (const u of list || []) { const id=String(u&&(u.ID||u.id)||''); if(id) map.set(id, clean(`${u.NAME||u.name||''} ${u.LAST_NAME||u.lastName||''}`)||`ID ${id}`); } return map;
  }
  function pickLatestDealByCompany(dealsById) { const latest=new Map(); for(const d of dealsById.values()){const cid=String(d.COMPANY_ID||d.companyId||'');if(!cid||cid==='0')continue;const date=Date.parse(String(d.DATE_MODIFY||d.dateModify||''))||0;const x=latest.get(cid);if(!x||date>x.date)latest.set(cid,{deal:d,date});} return latest; }
  function fallbackMatchCompanyByTitle(title, companyMap) { const hay=normalize(title); if(!hay)return null; let best=null; for(const c of companyMap.values()){const norm=normalize(c.title);if(!norm||norm.length<5||/^(подбор|аттестация|спк|периодика|исо|iso|суот|сантехник|электрик)/i.test(norm)||!hay.includes(norm))continue;if(!best||norm.length>best.norm.length)best={company:c,norm};} return best?best.company:null; }

  async function findStorageTaskServer() {
    if (storageCache.taskId) return storageCache.taskId;
    const rows = await bitrixRestList('tasks.task.list', { order:{ID:'DESC'}, filter:{GROUP_ID:PROJECT_ID,'%TITLE':'MAVIS_REPORT_STORAGE'}, select:['ID','TITLE'] }, 50).catch(()=>[]);
    const found = rows.find((t)=>clean(taskField(t,['title','TITLE']))===STORAGE_TASK_TITLE);
    storageCache.taskId = found ? String(taskField(found,['id','ID'])||'') : '';
    return storageCache.taskId;
  }
  function parseStorageComment(text) {
    const value = String(text || ''); const index = value.indexOf(STORAGE_MARKER); if (index < 0) return null;
    const payload = value.slice(index + STORAGE_MARKER.length).trim().split(/\s+/)[0]; return fromBase64Url(payload);
  }
  async function loadStorageRecords(force=false) {
    if (!force && storageCache.at && Date.now()-storageCache.at<30_000) return storageCache.records;
    const taskId = await findStorageTaskServer(); const records = new Map();
    if (taskId) {
      const comments = await bitrixRestList('task.commentitem.getlist',{TASKID:Number(taskId),ORDER:{ID:'ASC'}},2000).catch(()=>[]);
      for(const c of comments){const text=String(c.POST_MESSAGE||c.postMessage||c.MESSAGE||c.message||'');const rec=parseStorageComment(text);if(!rec||!rec.kind||!rec.key)continue;records.set(`${rec.kind}:${rec.key}`,rec);}
    }
    storageCache.at=Date.now();storageCache.records=records;return records;
  }
  async function ensureStorageTask(auth) {
    let taskId = await findStorageTaskServer(); if (taskId) return taskId;
    const userId = String(auth.user && (auth.user.ID || auth.user.id) || '');
    const created = await oauthCall(auth.domain,auth.accessToken,'tasks.task.add',{fields:{TITLE:STORAGE_TASK_TITLE,GROUP_ID:PROJECT_ID,RESPONSIBLE_ID:Number(userId),DESCRIPTION:'Служебная задача локального отчёта. Не удалять. В отчёте не учитывается.'}});
    taskId=String(created && (created.task && (created.task.id||created.task.ID) || created.id || created.ID) || '');
    if(!taskId) throw new Error('Не удалось создать служебное хранилище отчёта в Bitrix.');
    try{await oauthCall(auth.domain,auth.accessToken,'task.stages.movetask',{id:Number(taskId),stageId:Number(STORAGE_STAGE_ID)});}catch(e){console.warn(`[doc-return-local] storage stage move: ${e.message||e}`);}
    storageCache.taskId=taskId; return taskId;
  }
  async function saveStorageRecord(auth, kind, key, data) {
    const taskId=await ensureStorageTask(auth); const record={kind:String(kind),key:String(key),at:new Date().toISOString(),data};
    const message=`${STORAGE_MARKER} ${toBase64Url(record)}`;
    await oauthCall(auth.domain,auth.accessToken,'task.commentitem.add',{TASKID:Number(taskId),FIELDS:{POST_MESSAGE:message}});
    storageCache.records.set(`${record.kind}:${record.key}`,record);storageCache.at=Date.now();
    if(kind==='taskOverride'){reportCache.at=0;reportCache.data=null;historyIndexCache.ready=false;historyIndexCache.at=0;}
    return record;
  }

  function stageGroup(stageId, stageName='') {
    const id=String(stageId||''); const title=String(stageName||'');
    if(id===STAGES.ignoredPrinted) return 'ignored';
    if(RETURNED_STAGE_IDS.has(id)) return 'returned';
    if(CONTROL_STAGE_IDS.has(id) || /ручная отправка/i.test(title)) return 'control';
    if(EARLY_STAGE_IDS.has(id)) return 'early';
    return 'other';
  }

  async function buildReport(force=false) {
    if(!force && reportCache.data && Date.now()-reportCache.at<CACHE_MS) return reportCache.data;
    if(reportCache.promise) return reportCache.promise;
    reportCache.promise=(async()=>{
      const started=Date.now(); const [stages,storage]=await Promise.all([loadStages(),loadStorageRecords(force)]); const stageMap=new Map(stages.map(s=>[String(s.id),s])); const tasks=await loadReportTasks(stages);
      const dealIdByTask=new Map();const directCompanyIdByTask=new Map();const dealIds=[];
      for(const task of tasks){
        const tid=String(taskField(task,['id','ID'])||'');
        const did=extractDealId(task);
        const directCompanyId=extractDirectCompanyId(task);
        if(tid&&did)dealIdByTask.set(tid,did);
        if(tid&&directCompanyId)directCompanyIdByTask.set(tid,directCompanyId);
        if(did)dealIds.push(did);
      }
      const dealsById=await loadDeals(dealIds);
      const companyIds=[];
      for(const id of directCompanyIdByTask.values())companyIds.push(id);
      for(const d of dealsById.values()){const id=String(d.COMPANY_ID||d.companyId||'');if(id&&id!=='0')companyIds.push(id);}for(const id of MANUAL_COMPANY_BY_TASK.values())companyIds.push(id);
      for(const rec of storage.values()){if(rec.kind==='taskOverride'&&rec.data&&rec.data.companyId)companyIds.push(String(rec.data.companyId));}
      const companyMap=await loadCompaniesByIds(companyIds);
      const nameOverrides=[...new Set([...MANUAL_COMPANY_NAME_BY_TASK.values()])];const nameCompanies=await mapLimit(nameOverrides,8,async(name)=>[name,await resolveManualCompanyName(name)]);const manualNameCompany=new Map();for(const [name,c] of nameCompanies){manualNameCompany.set(name,c);if(c&&c.id)companyMap.set(c.id,c);}
      const latestDealByCompany=pickLatestDealByCompany(dealsById);const rows=[];const userIds=[];
      for(const task of tasks){
        const taskId=String(taskField(task,['id','ID'])||'');if(!taskId)continue;const title=clean(taskField(task,['title','TITLE'])||'');const stageId=String(taskField(task,['stageId','STAGE_ID','stage_id'])??'0');if(stageId===STAGES.ignoredPrinted)continue;
        const stageName=(stageMap.get(stageId)&&stageMap.get(stageId).title)||(stageId==='0'?'Без стадии':`Стадия ${stageId}`);const group=stageGroup(stageId,stageName);if(group==='ignored')continue;
        const dealId=dealIdByTask.get(taskId)||'';const deal=dealId?dealsById.get(dealId):null;const overrideRec=storage.get(`taskOverride:${taskId}`);const override=(overrideRec&&overrideRec.data)||{};
        let company=null;let companySource='Не определено';
        if(override.companyId){company=companyMap.get(String(override.companyId))||{id:String(override.companyId),title:clean(override.companyName||`Компания ${override.companyId}`),assignedById:''};companySource='Ручная правка в отчёте';}
        const directCompanyId=directCompanyIdByTask.get(taskId)||'';
        if(!company&&directCompanyId){company=companyMap.get(String(directCompanyId))||null;if(company)companySource='Компания из элементов CRM задачи';}
        const manualId=MANUAL_COMPANY_BY_TASK.get(taskId);if(!company&&manualId){company=companyMap.get(String(manualId))||null;if(company)companySource='Ручное соответствие';}
        if(!company&&deal){const cid=String(deal.COMPANY_ID||deal.companyId||'');if(cid&&cid!=='0'){company=companyMap.get(cid)||null;if(company)companySource='CRM-связь сделки';}}
        if(!company){const manualName=MANUAL_COMPANY_NAME_BY_TASK.get(taskId);if(manualName){company=manualNameCompany.get(manualName)||null;if(company)companySource='Ручное название';}}
        if(!company){company=fallbackMatchCompanyByTitle(title,companyMap);if(company)companySource='Название задачи';}
        const latest=company&&latestDealByCompany.get(String(company.id));const latestDeal=latest&&latest.deal;
        const expertId=String((latestDeal&&(latestDeal.ASSIGNED_BY_ID||latestDeal.assignedById))||(company&&company.assignedById)||taskField(task,['responsibleId','RESPONSIBLE_ID','responsible_id'])||'');if(expertId)userIds.push(expertId);
        const createdAt=asIso(taskField(task,['createdDate','CREATED_DATE','created_date']));const changedAt=asIso(taskField(task,['changedDate','CHANGED_DATE','changed_date']));const statusChangedAt=asIso(taskField(task,['statusChangedDate','STATUS_CHANGED_DATE','status_changed_date']));const deadline=asIso(taskField(task,['deadline','DEADLINE']));const overdue=Boolean(deadline&&new Date(deadline).getTime()<Date.now());
        rows.push({taskId,taskUrl:`https://mavisgroup.bitrix24.by/workgroups/group/${PROJECT_ID}/tasks/task/view/${taskId}/`,title,documentType:classifyDocument(title),serviceArticle:clean(override.serviceArticle||inferServiceArticle(title)),stageId,stageName,stageGroup:group,taskStatus:String(taskField(task,['status','STATUS','realStatus','REAL_STATUS'])||''),companyId:company?String(company.id):'',companyName:company?company.title:'Компания не определена',companySource,expertId,expertSource:latestDeal?'Последняя связанная сделка':(company&&company.assignedById?'Карточка компании':'Ответственный задачи'),dealId,chatId:String(taskField(task,['chatId','CHAT_ID','chat_id'])||''),createdAt,changedAt,statusChangedAt,deadline,overdue,overdueDays:overdue?daysSince(deadline):0,ageDays:createdAt?daysSince(createdAt):0,createdYear:createdAt?new Date(createdAt).getFullYear():null,createdMonth:createdAt?new Date(createdAt).getMonth()+1:null,reportNote:clean(override.reportNote||''),returnAnalysis:clean(override.returnAnalysis||''),returnStatus:clean(override.returnStatus||'')});
      }
      const users=await loadUsers(userIds);for(const row of rows){const rec=storage.get(`taskOverride:${row.taskId}`);const o=rec&&rec.data||{};row.expert=clean(o.expert)||users.get(row.expertId)||'Не определён';}
      rows.sort((a,b)=>a.companyName.localeCompare(b.companyName,'ru')||String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
      const data={ok:true,version:VERSION,generatedAt:new Date().toISOString(),projectId:PROJECT_ID,historyStart:HISTORY_START,durationMs:Date.now()-started,cacheSeconds:Math.round(CACHE_MS/1000),stages,rows,unmatchedCount:rows.filter(r=>!r.companyId).length,categories:CATEGORIES};
      reportCache.at=Date.now();reportCache.data=data;try{fs.writeFileSync(SNAPSHOT_FILE,JSON.stringify(data));}catch(_){}
      console.log(`[doc-return-local] ${VERSION} built rows=${rows.length}; unmatched=${data.unmatchedCount}; ${data.durationMs}ms`);return data;
    })().finally(()=>{reportCache.promise=null;});
    return reportCache.promise;
  }

  async function batchCommands(commands) {
    const output={};const entries=Object.entries(commands);for(const part of chunk(entries,50)){const cmd=Object.fromEntries(part);const raw=await bitrixRestCall('batch',{halt:0,cmd});const result=raw&&raw.result?raw.result:{};for(const [key,value] of Object.entries(result||{}))output[key]=value;}
    return output;
  }
  function commentText(item){return String(item&&(item.POST_MESSAGE||item.postMessage||item.MESSAGE||item.message||item.TEXT||item.text)||'');}
  function commentDate(item){return asIso(item&&(item.POST_DATE||item.postDate||item.DATE_CREATE||item.dateCreate||item.date)||'');}
  function parseReminderEvents(items,taskId,source='comment'){
    const events=[];for(const item of items||[]){const text=commentText(item);if(!text.includes('Отправка подтверждена почтовым сервером.'))continue;let sequence=0;if(text.includes('Автоматическое напоминание №1 о возврате оригинала отправлено.'))sequence=1;else if(text.includes('Автоматическое напоминание №2 о возврате оригинала отправлено.'))sequence=2;if(!sequence)continue;const email=(text.match(/Email:\s*([^\s<>"']+@[^\s<>"']+)/i)||[])[1]||'';events.push({taskId:String(taskId),sequence,sentAt:commentDate(item),email:String(email).toLowerCase(),source});}return events;
  }
  async function buildMailingScan(force=false){
    if(!force&&mailingScanCache.ready&&Date.now()-mailingScanCache.at<10*60*1000)return mailingScanCache;
    if(mailingScanCache.promise)return mailingScanCache.promise;
    mailingScanCache.scanning=true;mailingScanCache.error='';
    mailingScanCache.promise=(async()=>{try{
      const report=await buildReport(false);const rows=report.rows.filter(r=>r.stageGroup==='control'||r.stageGroup==='returned'||r.stageId===STAGES.sent);const commands={};for(const r of rows)commands[`c${r.taskId}`]=`task.commentitem.getlist?TASKID=${encodeURIComponent(r.taskId)}&ORDER[ID]=asc`;
      const results=await batchCommands(commands);const events=[];const needChat=[];
      for(const r of rows){const raw=results[`c${r.taskId}`];const items=Array.isArray(raw)?raw:(raw&&Array.isArray(raw.items)?raw.items:[]);const found=parseReminderEvents(items,r.taskId,'comment');events.push(...found);if(!found.length&&r.chatId)needChat.push(r);}
      // Fallback: некоторые старые версии писали служебное сообщение в чат задачи.
      if(needChat.length){const chatCmd={};for(const r of needChat)chatCmd[`m${r.taskId}`]=`im.dialog.messages.get?DIALOG_ID=${encodeURIComponent(`chat${r.chatId}`)}`;const chatResults=await batchCommands(chatCmd).catch(()=>({}));for(const r of needChat){const raw=chatResults[`m${r.taskId}`];const items=raw&&Array.isArray(raw.messages)?raw.messages:(Array.isArray(raw)?raw:[]);events.push(...parseReminderEvents(items,r.taskId,'chat'));}}
      events.sort((a,b)=>String(a.sentAt).localeCompare(String(b.sentAt)));mailingScanCache.at=Date.now();mailingScanCache.ready=true;mailingScanCache.events=events;mailingScanCache.error='';return mailingScanCache;
    }catch(e){mailingScanCache.error=e.message||String(e);mailingScanCache.ready=false;return mailingScanCache;}finally{mailingScanCache.scanning=false;mailingScanCache.promise=null;}})();return mailingScanCache.promise;
  }

  function historyEventList(raw){return Array.isArray(raw)?raw:(raw&&Array.isArray(raw.list)?raw.list:(raw&&Array.isArray(raw.items)?raw.items:[]));}
  function historyEventValue(event){return event&&(event.value||event.VALUE)||{};}
  function historyEventDate(event){return asIso(event&&(event.createdDate||event.CREATED_DATE)||'');}
  async function buildHistoryIndex(force=false){
    if(!force&&historyIndexCache.ready&&Date.now()-historyIndexCache.at<30*60*1000)return historyIndexCache;
    if(historyIndexCache.promise)return historyIndexCache.promise;historyIndexCache.scanning=true;historyIndexCache.error='';
    historyIndexCache.promise=(async()=>{try{
      const report=await buildReport(false);const relevant=report.rows.filter(r=>r.stageId===STAGES.sent||r.stageGroup==='control'||r.stageGroup==='returned');const commands={};for(const r of relevant)commands[`h${r.taskId}`]=`tasks.task.history.list?taskId=${encodeURIComponent(r.taskId)}&filter[FIELD]=STAGE_ID&order[createdDate]=ASC`;
      const results=await batchCommands(commands);const items=[];
      const controlOrReturned=new Set([STAGES.sent,...CONTROL_STAGE_IDS,...RETURNED_STAGE_IDS]);
      for(const row of relevant){const list=historyEventList(results[`h${row.taskId}`]).slice().sort((a,b)=>String(historyEventDate(a)).localeCompare(String(historyEventDate(b))));let sentAt='';let returnedAt='';let approximate=false;
        for(const e of list){const v=historyEventValue(e);const to=String(v.to??v.TO??'');const at=historyEventDate(e);if(!sentAt&&to===STAGES.sent)sentAt=at;if(!returnedAt&&RETURNED_STAGE_IDS.has(to))returnedAt=at;}
        if(!sentAt){for(const e of list){const v=historyEventValue(e);const to=String(v.to??v.TO??'');if(controlOrReturned.has(to)){sentAt=historyEventDate(e);approximate=true;break;}}}
        if(!sentAt&&(row.stageId===STAGES.sent||row.stageGroup==='control'||row.stageGroup==='returned')){sentAt=row.createdAt;approximate=true;}
        if(!returnedAt&&row.stageGroup==='returned'){returnedAt=row.statusChangedAt||row.changedAt||row.createdAt;approximate=true;}
        items.push({taskId:row.taskId,sentAt,returnedAt,approximate});
      }
      const start=new Date(HISTORY_START);const startYear=Number.isFinite(start.getTime())?start.getFullYear():2026;const endYear=new Date().getFullYear();const months=[];
      for(let year=startYear;year<=endYear;year++){for(let month=1;month<=12;month++){const monthStart=new Date(Date.UTC(year,month-1,1));if(monthStart>Date.now())break;const monthEnd=new Date(Date.UTC(year,month,1)-1);let sentNew=0,returnedNew=0,outstanding=0,sentCumulative=0,returnedCumulative=0;for(const item of items){const s=item.sentAt?new Date(item.sentAt):null;const r=item.returnedAt?new Date(item.returnedAt):null;if(!s||!Number.isFinite(s.getTime()))continue;if(s<=monthEnd){sentCumulative++;if(s>=monthStart&&s<=monthEnd)sentNew++;if(!r||r>monthEnd)outstanding++;}if(r&&Number.isFinite(r.getTime())&&r<=monthEnd){returnedCumulative++;if(r>=monthStart&&r<=monthEnd)returnedNew++;}}
        months.push({year,month,sentNew,returnedNew,outstanding,sentCumulative,returnedCumulative,returnRate:sentCumulative?Number(((returnedCumulative/sentCumulative)*100).toFixed(1)):0});}}
      historyIndexCache.at=Date.now();historyIndexCache.ready=true;historyIndexCache.months=months;historyIndexCache.items=items;historyIndexCache.error='';return historyIndexCache;
    }catch(e){historyIndexCache.error=e.message||String(e);historyIndexCache.ready=false;return historyIndexCache;}finally{historyIndexCache.scanning=false;historyIndexCache.promise=null;}})();return historyIndexCache.promise;
  }

  function mergeResponses(storageRecords, reportRows) {
    const map=new Map(SEED_RESPONSES.map(r=>[r.id,{...r}]));
    for(const rec of storageRecords.values())if(rec.kind==='response'&&rec.data){const base=map.get(rec.key)||{id:rec.key,source:'Добавлено вручную'};map.set(rec.key,{...base,...rec.data,id:rec.key});}
    const byTask=new Map(reportRows.map(r=>[String(r.taskId),r]));
    const rows=[...map.values()].filter(r=>!r.deleted).map(r=>{const linked=r.taskId?byTask.get(String(r.taskId)):null;let suggested=null;if(!linked&&r.companyName){const n=normalize(r.companyName);suggested=reportRows.find(x=>{const cn=normalize(x.companyName);return cn&&(cn===n||cn.includes(n)||n.includes(cn));})||null;}
      const row={...r};row.category=CATEGORIES.includes(row.category)?row.category:classifyResponse(row.comment);row.documentTitle=row.documentTitle||(linked&&linked.title)||(suggested&&suggested.title)||'';row.suggestedTaskId=!row.taskId&&suggested?suggested.taskId:'';row.expert=(linked&&linked.expert)||(suggested&&suggested.expert)||'';row.serviceArticle=row.serviceArticle||(linked&&linked.serviceArticle)||(suggested&&suggested.serviceArticle)||'';return row;});
    rows.sort((a,b)=>String(b.responseDate||'').localeCompare(String(a.responseDate||''))||String(a.companyName||'').localeCompare(String(b.companyName||''),'ru'));return rows;
  }

  async function loadTaskStageHistory(taskId) {
    const raw=await bitrixRestCall('tasks.task.history.list',{taskId:Number(taskId),filter:{FIELD:'STAGE_ID'},order:{createdDate:'DESC'}});const list=historyEventList(raw);const stages=await loadStages();const stageMap=new Map(stages.map(s=>[String(s.id),s.title]));return list.map(event=>{const value=historyEventValue(event);const fromId=String(value.from??value.FROM??'');const toId=String(value.to??value.TO??'');return{id:String(event&&(event.id||event.ID)||''),createdAt:String(event&&(event.createdDate||event.CREATED_DATE)||''),fromId,toId,from:stageMap.get(fromId)||fromId||'—',to:stageMap.get(toId)||toId||'—',user:clean(`${event&&event.user&&(event.user.name||event.user.NAME)||''} ${event&&event.user&&(event.user.lastName||event.user.LAST_NAME)||''}`)};});
  }

  app.all('/doc-return-report',(_req,res)=>res.sendFile(path.join(__dirname,'public','doc-return-report.html')));
  async function getReportFast(force=false) {
    if (force) return buildReport(true);
    // Если есть хотя бы один готовый снимок — отдаём его сразу, даже если TTL уже истёк.
    // Обновление запускаем в фоне, чтобы пользователь не ждал 1–2 минуты при открытии отчёта.
    if (reportCache.data) {
      const stale = Date.now() - reportCache.at >= CACHE_MS;
      if (stale && !reportCache.promise) {
        buildReport(true).catch((e) => console.warn(`[doc-return-local] background refresh: ${e.message || e}`));
      }
      return { ...reportCache.data, stale, refreshing: Boolean(reportCache.promise) || stale };
    }
    return buildReport(false);
  }

  app.get('/api/doc-return-report/data',async(req,res)=>{try{const auth=await authorize(req);const force=['1','true','yes'].includes(String(req.query.force||'').toLowerCase());const data=await getReportFast(force);res.json({...data,currentUser:auth.user});}catch(e){res.status(Number(e.statusCode||500)).json({ok:false,error:e.message||String(e)});}});
  app.get('/api/doc-return-report/mailing',async(req,res)=>{try{await authorize(req);const [report,storage]=await Promise.all([buildReport(false),loadStorageRecords(false)]);const responses=mergeResponses(storage,report.rows);if(!mailingScanCache.ready&&!mailingScanCache.scanning)buildMailingScan(false).catch(()=>{});res.json({ok:true,responses,categories:CATEGORIES,scan:{ready:mailingScanCache.ready,scanning:mailingScanCache.scanning,error:mailingScanCache.error,events:mailingScanCache.ready?mailingScanCache.events:[]}});}catch(e){res.status(Number(e.statusCode||500)).json({ok:false,error:e.message||String(e)});}});
  app.post('/api/doc-return-report/mailing/refresh',async(req,res)=>{try{await authorize(req);buildMailingScan(true).catch(()=>{});res.json({ok:true,started:true});}catch(e){res.status(Number(e.statusCode||500)).json({ok:false,error:e.message||String(e)});}});
  app.get('/api/doc-return-report/history-index',async(req,res)=>{try{await authorize(req);if(!historyIndexCache.ready&&!historyIndexCache.scanning)buildHistoryIndex(false).catch(()=>{});res.json({ok:true,ready:historyIndexCache.ready,scanning:historyIndexCache.scanning,error:historyIndexCache.error,months:historyIndexCache.ready?historyIndexCache.months:[]});}catch(e){res.status(Number(e.statusCode||500)).json({ok:false,error:e.message||String(e)});}});
  app.post('/api/doc-return-report/history-index/refresh',async(req,res)=>{try{await authorize(req);buildHistoryIndex(true).catch(()=>{});res.json({ok:true,started:true});}catch(e){res.status(Number(e.statusCode||500)).json({ok:false,error:e.message||String(e)});}});
  app.post('/api/doc-return-report/record',async(req,res)=>{try{const auth=await authorize(req);const kind=String(req.body&&req.body.kind||'');let key=String(req.body&&req.body.key||'');const data=req.body&&req.body.data&&typeof req.body.data==='object'?req.body.data:{};if(!['response','taskOverride'].includes(kind))return res.status(400).json({ok:false,error:'Неверный тип записи.'});if(!key)key=kind==='response'?`resp-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`:'';if(!key)return res.status(400).json({ok:false,error:'Не указан ключ записи.'});if(kind==='response'&&!data.category)data.category=classifyResponse(data.comment);const record=await saveStorageRecord(auth,kind,key,data);res.json({ok:true,key:record.key,record});}catch(e){res.status(Number(e.statusCode||500)).json({ok:false,error:e.message||String(e)});}});
  app.get('/api/doc-return-report/company-search',async(req,res)=>{try{const auth=await authorize(req);const q=clean(req.query.q||'');if(q.length<2)return res.json({ok:true,rows:[]});const rows=await oauthList(auth.domain,auth.accessToken,'crm.company.list',{order:{TITLE:'ASC'},filter:{'%TITLE':q},select:['ID','TITLE','ASSIGNED_BY_ID']},50);res.json({ok:true,rows:rows.map(c=>({id:String(c.ID||c.id||''),title:clean(c.TITLE||c.title||''),assignedById:String(c.ASSIGNED_BY_ID||c.assignedById||'')})).filter(c=>c.id&&c.title).slice(0,30)});}catch(e){res.status(Number(e.statusCode||500)).json({ok:false,error:e.message||String(e)});}});
  app.get('/api/doc-return-report/task-history/:taskId',async(req,res)=>{try{await authorize(req);const taskId=String(req.params.taskId||'').replace(/\D/g,'');if(!taskId)return res.status(400).json({ok:false,error:'taskId не указан'});res.json({ok:true,taskId,rows:await loadTaskStageHistory(taskId)});}catch(e){res.status(Number(e.statusCode||500)).json({ok:false,error:e.message||String(e)});}});

  // Тёплый кэш: после старта сервера данные начинают собираться сами, не дожидаясь открытия отчёта.
  try { if (fs.existsSync(SNAPSHOT_FILE)) { const snap=JSON.parse(fs.readFileSync(SNAPSHOT_FILE,'utf8')); if(snap&&Array.isArray(snap.rows)){reportCache.data=snap;reportCache.at=Date.now();console.log(`[doc-return-local] loaded instant snapshot rows=${snap.rows.length}`);} } } catch(_) {}
  // Сразу после старта обновляем снимок в фоне. Наличие старого снимка не блокирует открытие отчёта.
  setTimeout(()=>buildReport(true).catch(e=>console.warn(`[doc-return-local] warmup: ${e.message||e}`)),2500);
  setInterval(()=>buildReport(true).catch(e=>console.warn(`[doc-return-local] refresh: ${e.message||e}`)),Math.max(CACHE_MS,5*60*1000)).unref?.();

  console.log(`[doc-return-local] ${VERSION}; route=/doc-return-report; project=${PROJECT_ID}; historyStart=${HISTORY_START}`);
}

module.exports = { registerDocReturnLocalApp };
