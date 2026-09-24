(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SigningDocuments = api;
})(typeof window === 'undefined' ? null : window, function () {
  'use strict';

  // JavaScript \b does not recognise Cyrillic letters as word characters, so use
  // explicit Unicode letter/number boundaries for legal forms in Russian names.
  const LEGAL_FORMS = /(^|[^\p{L}\p{N}])(?:ооо|оао|зао|чуп|уп|ип|одо|общество с ограниченной ответственностью|частное предприятие|индивидуальный предприниматель)(?=$|[^\p{L}\p{N}])/giu;
  const GENERIC_TITLE_WORDS = new Set(['акт', 'акта', 'договор', 'договора', 'счет', 'счёт', 'счета', 'счёта', 'документ', 'документы', 'подписать', 'подписание', 'оригинал', 'оригиналы', 'мавис']);

  function valueOf(record, names) {
    if (!record) return undefined;
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(record, name)) return record[name];
    }
    const byLowerCase = Object.fromEntries(Object.keys(record).map((key) => [key.toLowerCase(), key]));
    for (const name of names) {
      const key = byLowerCase[String(name).toLowerCase()];
      if (key) return record[key];
    }
    return undefined;
  }

  function text(value) {
    if (Array.isArray(value)) return value.map(text).join(' ');
    if (value && typeof value === 'object') return Object.values(value).map(text).join(' ');
    return String(value || '');
  }

  function normalizeCompanyName(value) {
    return text(value)
      .toLocaleLowerCase('ru-RU')
      .replace(LEGAL_FORMS, '$1')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function companyTokens(value) {
    return normalizeCompanyName(value)
      .split(' ')
      .filter((part) => part.length >= 3 && !GENERIC_TITLE_WORDS.has(part));
  }

  function companySearchTerms(value) {
    const normalized = normalizeCompanyName(value);
    const terms = new Set();
    const addVariants = (term) => {
      if (term.length < 5 || terms.size >= 8) return;
      terms.add(term);
      if (term.includes(' ') && terms.size < 8) terms.add(term.replace(/\s+/g, '-'));
      if (term.includes(' ') && terms.size < 8) terms.add(term.replace(/\s+/g, ''));
    };
    addVariants(normalized);
    const parts = companyTokens(value);
    for (let left = 0; left < parts.length && terms.size < 8; left += 1) {
      for (let right = left + 1; right < parts.length && terms.size < 8; right += 1) {
        addVariants(`${parts[left]} ${parts[right]}`);
      }
    }
    return [...terms];
  }

  function companyReviewSearchTerms(companyName, companyUnp) {
    const terms = [];
    const add = (term) => {
      const value = String(term || '');
      if (value && !terms.includes(value) && terms.length < 4) terms.push(value);
    };
    add(normalizeUnp(companyUnp));
    const nameTerms = companySearchTerms(companyName);
    add(normalizeCompanyName(companyName));
    nameTerms.filter((term) => term.includes(' ')).forEach(add);
    nameTerms.forEach(add);
    return terms;
  }

  function normalizeUnp(value) {
    const match = text(value).match(/(?<!\d)(\d{9})(?!\d)/);
    return match ? match[1] : '';
  }

  function extractUnps(value) {
    return [...new Set((text(value).match(/(?<!\d)\d{9}(?!\d)/g) || []))];
  }

  function unpFromCompany(company, companyFields) {
    const entries = Object.entries(company || {});
    const labels = companyFields || {};
    const preferred = entries
      .filter(([key]) => /унп|unp|учетн|учётн|налогоплатель/i.test(`${key} ${text(labels[key])}`))
      .map(([, value]) => normalizeUnp(value))
      .find(Boolean);
    if (preferred) return preferred;
    return '';
  }

  function taskText(task) {
    return [
      valueOf(task, ['TITLE', 'title']),
      valueOf(task, ['DESCRIPTION', 'description']),
      valueOf(task, ['UF_CRM_TASK', 'ufCrmTask', 'crm', 'CRM']),
    ].map(text).join('\n');
  }

  function extractDealIds(task) {
    const found = new Set();
    const source = taskText(task);
    for (const match of source.matchAll(/\bD_(\d+)\b/gi)) found.add(match[1]);
    for (const match of source.matchAll(/\bdeal=(\d+)\b/gi)) found.add(match[1]);
    for (const match of source.matchAll(/deal\/details\/(\d+)/gi)) found.add(match[1]);
    return [...found];
  }

  function extractCrmDealIds(task) {
    const found = new Set();
    const crm = valueOf(task, ['UF_CRM_TASK', 'ufCrmTask', 'UF_CRM_TASKS', 'crm', 'CRM']);
    for (const match of text(crm).matchAll(/\bD_(\d+)\b/gi)) found.add(match[1]);
    return [...found];
  }

  function scoreCompanyTitle(companyName, task) {
    const company = normalizeCompanyName(companyName);
    const title = normalizeCompanyName(valueOf(task, ['TITLE', 'title']));
    if (!company || !title) return { score: 0, reason: '' };
    if (company.length >= 5 && (title.includes(company) || company.includes(title))) {
      return { score: 1, reason: 'название компании в названии задачи' };
    }
    const companyParts = companyTokens(company);
    const titleParts = new Set(companyTokens(title));
    if (!companyParts.length) return { score: 0, reason: '' };
    const common = companyParts.filter((part) => titleParts.has(part));
    const score = common.length / companyParts.length;
    if (common.length >= 2 && score >= 0.67) {
      return { score, reason: `совпадают части названия: ${common.join(', ')}` };
    }
    if (companyParts.length === 1 && companyParts[0].length >= 6 && titleParts.has(companyParts[0])) {
      return { score: 0.8, reason: `совпадает название: ${companyParts[0]}` };
    }
    if (common.length) return { score, reason: `частично совпадает: ${common.join(', ')}` };
    return { score: 0, reason: '' };
  }

  function matchTaskToDeal({ task, dealId, companyName, companyUnp, companyFields }) {
    const taskId = String(valueOf(task, ['ID', 'id']) || '');
    const linkedDealIds = extractCrmDealIds(task);
    if (linkedDealIds.includes(String(dealId))) {
      return { taskId, kind: 'crm-link', confidence: 'confirmed', reason: 'задача прямо связана со сделкой', score: 1 };
    }
    // A task already tied to another deal must never leak into this card through
    // the same company UNP or a similar company name.
    if (linkedDealIds.length) {
      return { taskId, kind: 'other-deal', confidence: 'none', reason: 'задача связана с другой сделкой', score: 0 };
    }

    const resolvedUnp = normalizeUnp(companyUnp) || unpFromCompany(companyFields && companyFields.company, companyFields && companyFields.labels);
    const taskUnps = extractUnps(taskText(task));
    if (resolvedUnp && taskUnps.includes(resolvedUnp)) {
      return { taskId, kind: 'unp', confidence: 'review', reason: `совпадает УНП ${resolvedUnp}, но CRM-связь со сделкой не заполнена`, score: 1 };
    }

    const textDealIds = extractDealIds(task);
    if (textDealIds.includes(String(dealId))) {
      return { taskId, kind: 'deal-id-in-text', confidence: 'review', reason: 'ID сделки указан в тексте задачи, но CRM-связь не заполнена', score: 0.5 };
    }
    const titleScore = scoreCompanyTitle(companyName, task);
    if (titleScore.score > 0) {
      return { taskId, kind: 'company-name', confidence: 'review', reason: titleScore.reason, score: titleScore.score };
    }
    return { taskId, kind: 'none', confidence: 'none', reason: '', score: 0 };
  }

  function splitTasksForDeal({ tasks, dealId, companyName, companyUnp, companyFields, archiveStageId, knownStageIds = [] }) {
    const pending = [];
    const archived = [];
    const review = [];
    const knownStages = new Set([...knownStageIds].map(String));
    (tasks || []).forEach((task) => {
      const match = matchTaskToDeal({ task, dealId, companyName, companyUnp, companyFields });
      if (match.confidence === 'none') return;
      const stageId = String(valueOf(task, ['STAGE_ID', 'stageId']) || '');
      const row = { task, match, stageId };
      if (!stageId || (knownStages.size && !knownStages.has(stageId))) {
        review.push({ ...row, match: { ...match, reason: `${match.reason || 'совпадение найдено'}; стадия задачи не определена` } });
      } else if (stageId === String(archiveStageId)) archived.push(row);
      else if (match.confidence === 'review') review.push(row);
      else pending.push(row);
    });
    return { pending, archived, review };
  }

  return {
    companySearchTerms,
    companyReviewSearchTerms,
    extractDealIds,
    extractCrmDealIds,
    extractUnps,
    matchTaskToDeal,
    normalizeCompanyName,
    normalizeUnp,
    scoreCompanyTitle,
    splitTasksForDeal,
    unpFromCompany,
  };
});
