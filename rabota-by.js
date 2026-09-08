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

  async function get(pathOrUrl) {
    const response = await fetchImpl(apiUrl(pathOrUrl).toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'HH-User-Agent': userAgent,
        Accept: 'application/json',
      },
    });
    if (!response || !response.ok) throw new Error(`Rabota.by API вернул ошибку ${response && response.status ? response.status : 'сети'}.`);
    return response.json();
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
    getResponse(urlOrId) {
      const reference = clean(urlOrId, 2000);
      return get(/^\d+$/.test(reference) ? `/negotiations/${reference}` : reference);
    },
  };
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

module.exports = { apiUrl, createRabotaByClient, rabotaResponseToIntake };
