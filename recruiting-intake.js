'use strict';

const MAX_TEXT = 5000;

const ROLE_ALIASES = new Map([
  ['manager', 'Менеджер по продажам'],
  ['менеджер', 'Менеджер по продажам'],
  ['менеджер по продажам', 'Менеджер по продажам'],
  ['expert', 'Эксперт'],
  ['эксперт', 'Эксперт'],
  ['foreman', 'Прораб'],
  ['прораб', 'Прораб'],
]);

const SOURCE_ALIASES = new Map([
  ['rabota.by', 'rabota.by'],
  ['rabota', 'rabota.by'],
  ['kufar', 'Kufar'],
  ['kufar.by', 'Kufar'],
  ['ручной', 'Ручной'],
  ['manual', 'Ручной'],
]);

function cleanText(value, max = MAX_TEXT) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validUrl(value) {
  const text = cleanText(value, 2000);
  if (!text) return '';
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch (_) {
    return '';
  }
}

function normalizeRole(value) {
  return ROLE_ALIASES.get(cleanText(value, 100).toLowerCase()) || '';
}

function normalizeSource(value) {
  return SOURCE_ALIASES.get(cleanText(value, 100).toLowerCase()) || '';
}

function normalizeRecruitingIntake(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const candidate = body.candidate && typeof body.candidate === 'object' ? body.candidate : {};
  const source = normalizeSource(body.source);
  const role = normalizeRole(body.role);
  const applicationId = cleanText(body.application_id, 200);
  if (!source) throw new Error('source должен быть одним из: rabota.by, Kufar, Ручной.');
  if (!role) throw new Error('role должен быть одним из: Менеджер по продажам, Эксперт, Прораб.');
  if (!applicationId) throw new Error('application_id обязателен для идемпотентной обработки.');

  const receivedAt = cleanText(body.received_at, 100);
  const parsedReceivedAt = receivedAt && !Number.isNaN(Date.parse(receivedAt)) ? new Date(receivedAt).toISOString() : new Date().toISOString();
  return {
    source,
    role,
    applicationId,
    vacancyId: cleanText(body.vacancy_id, 200),
    sourceUrl: validUrl(body.source_url),
    receivedAt: parsedReceivedAt,
    conditions: cleanText(body.conditions, 1000),
    candidate: {
      fullName: cleanText(candidate.full_name, 250),
      phone: cleanText(candidate.phone, 80),
      email: cleanText(candidate.email, 320),
      resumeUrl: validUrl(candidate.resume_url),
    },
  };
}

function intakeKey(intake) {
  return `${intake.source}|${intake.applicationId}`;
}

function intakeTitle(intake) {
  const name = intake.candidate.fullName || `Отклик ${intake.applicationId}`;
  return `Кандидат: ${name} — ${intake.role}`.slice(0, 250);
}

module.exports = { intakeKey, intakeTitle, normalizeRecruitingIntake };
