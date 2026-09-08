'use strict';

const API_ORIGIN = 'https://api.hh.ru';

function clean(value, max = 1000) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function optionalText(value) {
  if (typeof value === 'object' && value) return clean(value.formatted || value.number || value.value || '');
  return clean(value);
}

function apiUrl(pathOrUrl) {
  const url = new URL(pathOrUrl, `${API_ORIGIN}/`);
  if (url.origin !== API_ORIGIN) throw new Error('Rabota.by API URL должен принадлежать api.hh.ru.');
  url.searchParams.set('host', 'rabota.by');
  return url;
}

function createRabotaByClient({ accessToken, userAgent, fetchImpl = global.fetch } = {}) {
  if (!clean(accessToken, 10000)) throw new Error('Не задан RABOTA_BY_ACCESS_TOKEN.');
  if (!clean(userAgent, 500)) throw new Error('Не задан RABOTA_BY_USER_AGENT.');
  if (typeof fetchImpl !== 'function') throw new Error('Для Rabota.by API требуется fetch.');

  async function request(method, pathOrUrl, { body, headers = {} } = {}) {
    const response = await fetchImpl(apiUrl(pathOrUrl).toString(), {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'HH-User-Agent': userAgent,
        Accept: 'application/json',
        ...headers,
      },
      body,
    });
    if (!response || !response.ok) {
      const error = new Error(`Rabota.by API вернул ошибку ${response && response.status ? response.status : 'сети'}.`);
      error.status = response && response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const contentType = String(response.headers && response.headers.get && response.headers.get('content-type') || '');
    if (contentType.includes('application/json') || typeof response.text !== 'function') return response.json();
    return response.text();
  }

  function get(pathOrUrl) {
    return request('GET', pathOrUrl);
  }

  function negotiationId(responseOrId) {
    const id = typeof responseOrId === 'object' ? responseOrId && responseOrId.id : responseOrId;
    const value = clean(id, 200);
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Отклик Rabota.by не содержит безопасный ID переговоров.');
    return value;
  }

  return {
    listCollections(vacancyId) {
      const url = apiUrl('/negotiations');
      url.searchParams.set('vacancy_id', clean(vacancyId, 200));
      url.searchParams.set('with_generated_collections', 'true');
      url.searchParams.set('per_page', '20');
      return get(url);
    },
    listResponses(collectionUrl) {
      return get(collectionUrl);
    },
    listResponsePage(collectionUrl, { page = 0, perPage = 20 } = {}) {
      const url = apiUrl(collectionUrl);
      url.searchParams.set('page', String(Math.max(0, Number(page) || 0)));
      url.searchParams.set('per_page', String(Math.max(1, Math.min(100, Number(perPage) || 20))));
      return get(url);
    },
    getResponse(urlOrId) {
      const reference = clean(urlOrId, 2000);
      return get(/^\d+$/.test(reference) ? `/negotiations/${reference}` : reference);
    },
    getMessages(responseOrId) {
      return get(`/negotiations/${negotiationId(responseOrId)}/messages?with_text_only=true&per_page=100`);
    },
    getResume(response) {
      const url = response && response.resume && response.resume.url;
      if (!url) return response;
      return get(url);
    },
    sendMessage(responseOrId, message) {
      const text = clean(message, 4000);
      if (!text) throw new Error('Нельзя отправить пустое сообщение Rabota.by.');
      return request('POST', `/negotiations/${negotiationId(responseOrId)}/messages`, {
        body: new URLSearchParams({ message: text }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    },
    performAvailableAction(action, message) {
      const url = action && clean(action.url, 2000);
      const id = clean(action && action.id, 100).toLowerCase();
      const method = clean(action && action.method, 20).toUpperCase();
      const enabled = Boolean(action && action.enabled);
      const argumentsList = Array.isArray(action && action.arguments) ? action.arguments : [];
      const messageAllowed = argumentsList.some((argument) => clean(argument && argument.id, 100) === 'message');
      const text = clean(message, 4000);
      if (!['discard', 'discard_by_employer'].includes(id) || !url || !enabled || method !== 'PUT' || !messageAllowed || !text) {
        throw new Error('Rabota.by не подтвердила доступное действие отказа для этого отклика.');
      }
      return request(method, url, {
        body: new URLSearchParams({ message: text }).toString(),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    },
  };
}

function availableRejectAction(response) {
  const actions = Array.isArray(response && response.actions) ? response.actions : [];
  return actions.find((action) =>
    ['discard', 'discard_by_employer'].includes(String(action && action.id || '').toLowerCase()) &&
    action && action.enabled === true &&
    String(action.method || '').toUpperCase() === 'PUT' &&
    clean(action.url, 2000) &&
    Array.isArray(action.arguments) && action.arguments.some((argument) => clean(argument && argument.id, 100) === 'message'),
  ) || null;
}

function rabotaResponseToIntake(response, { vacancyId, role } = {}) {
  const record = response && typeof response === 'object' ? response : {};
  const resume = record.resume && typeof record.resume === 'object' ? record.resume : {};
  const fullName = [resume.first_name, resume.middle_name, resume.last_name].map((part) => clean(part, 100)).filter(Boolean).join(' ');
  return {
    source: 'rabota.by',
    role,
    application_id: clean(record.id, 200),
    vacancy_id: clean(vacancyId, 200),
    source_url: clean(resume.alternate_url, 2000),
    received_at: clean(record.created_at, 100),
    conditions: clean(resume.title, 1000),
    candidate: {
      full_name: fullName,
      phone: optionalText(resume.phone),
      email: clean(resume.email, 320),
      resume_url: clean(resume.alternate_url, 2000),
    },
  };
}

module.exports = { apiUrl, availableRejectAction, createRabotaByClient, rabotaResponseToIntake };
