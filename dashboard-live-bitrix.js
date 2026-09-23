'use strict';

function searchText(value) {
  return String(value || '')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/giu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function categoryForQuestion(question, productionCategoryId = 28) {
  const text = searchText(question);
  if (/(^|\s)(источник|источника|источники|партнер|партнерка|партнеры)/.test(text)) return { id: null, label: 'Все воронки' };
  if (/(^|\s)завис/.test(text)) return { id: 30, label: 'Зависшие' };
  if (/(^|\s)(продаж|лид|менеджер|холодн|входящ|повторн)/.test(text)) return { id: 0, label: 'Продажи' };
  return { id: Number(productionCategoryId) || 28, label: 'Производство' };
}

function isSourceQuestion(question) {
  return /(^|\s)(источник|источника|источники|партнер|партнерка|партнеры)/.test(searchText(question));
}

function sourceOptionName(option) {
  return String(option && (option.NAME || option.name || option.VALUE || option.value || option.STATUS_ID || option.id) || '').trim();
}

function matchingSourceOptions(question, options = []) {
  const text = searchText(question);
  const terms = text.split(' ').filter((term) => term.length >= 4 && ![
    'источник', 'источника', 'источники',
    'битрикс', 'посмотри', 'смотри', 'есть', 'мне', 'чтобы', 'сколько', 'сделок',
  ].includes(term));
  return options.filter((option) => {
    const name = searchText(sourceOptionName(option));
    if (!name) return false;
    return terms.some((term) => name.includes(term) || term.includes(name) || (
      term.length >= 5 && name.split(' ').some((word) => word.startsWith(term.slice(0, -1)))
    ));
  });
}

function stageId(stage) {
  return String(stage && (stage.STATUS_ID || stage.STAGE_ID || stage.ID) || '');
}

function stageName(stage) {
  return String(stage && (stage.NAME || stage.TITLE || stage.STATUS_ID || stage.STAGE_ID) || '').trim();
}

function personName(user) {
  return [user && user.NAME, user && user.LAST_NAME].filter(Boolean).join(' ').trim() || String(user && user.ID || '');
}

function stageQuestionName(value) {
  return searchText(String(value || '').replace(/^\s*\d+[.)]?\s*/, ''));
}

function matchedNames(question, values, getName) {
  const text = searchText(question);
  return values.filter((value) => {
    const name = searchText(getName(value));
    if (!name || name.length < 4) return false;
    if (text.includes(name)) return true;
    const questionWords = text.split(' ');
    const words = name.split(' ').filter((word) => word.length >= 4);
    return words.length >= 2 && words.every((word) => {
      const stem = word.slice(0, Math.max(4, word.length - 2));
      return questionWords.some((candidate) => candidate.startsWith(stem));
    });
  });
}

function numberValue(value) {
  const numeric = Number(String(value || 0).replace(',', '.'));
  return Number.isFinite(numeric) ? numeric : 0;
}

function selectLiveDeals({ question, category, stages = [], users = [], deals = [], portalUrl = '' }) {
  const selectedStages = matchedNames(question, stages, stage => stageQuestionName(stageName(stage)));
  const selectedUsers = matchedNames(question, users, personName);
  const stageIds = new Set(selectedStages.map(stageId));
  const userIds = new Set(selectedUsers.map(user => String(user.ID || user.id || '')));
  const stageById = new Map(stages.map(stage => [stageId(stage), stageName(stage)]));
  const userById = new Map(users.map(user => [String(user.ID || user.id || ''), personName(user)]));

  const matching = deals.filter((deal) => (
    (!stageIds.size || stageIds.has(String(deal.STAGE_ID || '')))
    && (!userIds.size || userIds.has(String(deal.ASSIGNED_BY_ID || '')))
  ));
  const amount = matching.reduce((total, deal) => total + numberValue(deal.OPPORTUNITY), 0);
  const portal = String(portalUrl || '').replace(/\/+$/, '');
  const includeDeals = /(^|\s)(покажи|показать|список|перечис|ссылк)/.test(searchText(question));

  return {
    source: 'live_bitrix',
    category,
    query_scope: 'Открытые сделки на момент запроса',
    filters: {
      stages: selectedStages.map(stageName),
      experts: selectedUsers.map(personName),
    },
    category_active_count: deals.length,
    matching_count: matching.length,
    matching_amount: Math.round(amount * 100) / 100,
    deals: includeDeals ? matching.slice(0, 60).map((deal) => ({
      id: String(deal.ID || ''),
      title: String(deal.TITLE || ''),
      stage: stageById.get(String(deal.STAGE_ID || '')) || String(deal.STAGE_ID || ''),
      expert: userById.get(String(deal.ASSIGNED_BY_ID || '')) || String(deal.ASSIGNED_BY_ID || ''),
      amount: numberValue(deal.OPPORTUNITY),
      url: deal.ID && portal ? `${portal}/crm/deal/details/${deal.ID}/` : '',
    })) : [],
    deals_truncated: includeDeals && matching.length > 60,
  };
}

function exactLiveAnswer(question, live) {
  if (!live || !live.available) return null;
  const text = searchText(question);
  if (isSourceQuestion(question)) {
    const sources = Array.isArray(live.source_matches) ? live.source_matches : [];
    if (sources.length) {
      const names = sources.map(sourceOptionName).filter(Boolean);
      const count = Number(live.matching_count || 0);
      const amount = Number(live.matching_amount || 0);
      return {
        answer: `В Bitrix найден источник: ${names.map((name) => `«${name}»`).join(', ')}. На текущий момент по нему ${count} сделок на сумму ${amount.toLocaleString('ru-RU')} BYN.`,
        facts: [
          'Источник и сделки проверены прямым read-only запросом в Bitrix на момент ответа.',
          `Найдено активных сделок: ${count}; сумма: ${amount.toLocaleString('ru-RU')} BYN.`,
        ],
        recommendations: [],
        links: [],
      };
    }
    return {
      answer: 'В стандартном справочнике источников Bitrix совпадение не найдено. Возможно, это значение хранится в отдельном пользовательском поле сделки.',
      facts: ['Проверен стандартный справочник источников Bitrix в реальном времени.'],
      recommendations: ['Напишите точное название поля, если «Белтехэкспертиза» хранится не в стандартном источнике — я подключу его к поиску.'],
      links: [],
    };
  }
  const asksCount = /(сколько|количество|число|кол во|колво)/.test(text) && /(сдел|шт)/.test(text);
  const asksAmount = /(сумм|выручк|денег|руб|byn)/.test(text);
  if (!asksCount && !asksAmount) return null;

  const filters = live.filters || {};
  const scope = [
    ...(filters.stages || []).map((stage) => `стадия «${stage}»`),
    ...(filters.experts || []).map((expert) => `эксперт ${expert}`),
  ];
  const suffix = scope.length ? ` по фильтру: ${scope.join(', ')}` : '';
  const count = Number(live.matching_count || 0);
  const amount = Number(live.matching_amount || 0);
  const countTail = Math.abs(count) % 100;
  const countLast = Math.abs(count) % 10;
  const dealWord = countTail >= 11 && countTail <= 14
    ? 'сделок'
    : countLast === 1
      ? 'сделка'
      : countLast >= 2 && countLast <= 4
        ? 'сделки'
        : 'сделок';
  const answerParts = [];
  if (asksCount) answerParts.push(`${count} ${dealWord}`);
  if (asksAmount) answerParts.push(`${amount.toLocaleString('ru-RU')} BYN`);
  return {
    answer: `На текущий момент${suffix}: ${answerParts.join(', ')}.`,
    facts: [
      `Источник: live-запрос Bitrix на момент ответа.`,
      `Найдено сделок: ${count}; сумма: ${amount.toLocaleString('ru-RU')} BYN.`,
    ],
    recommendations: [],
    links: [],
  };
}

module.exports = { categoryForQuestion, exactLiveAnswer, isSourceQuestion, matchingSourceOptions, personName, searchText, selectLiveDeals, sourceOptionName, stageId, stageName };
