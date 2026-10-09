'use strict';

const MINSK_OFFSET_MS = 3 * 60 * 60 * 1000;

const SPK_FIRST_CONTACT_MARKER = '[MAVIS_SPK_FIRST_CONTACT]';
const SPK_FIRST_CONTACT_REMINDER_MARKER = '[MAVIS_SPK_FIRST_CONTACT_REMINDER]';
const SPK_FIRST_CONTACT_ESCALATION_MARKER = '[MAVIS_SPK_FIRST_CONTACT_ESCALATION]';

// tasks.task.* и crm.timeline.comment.* отдают поля в camelCase, хотя в
// запросах Bitrix используются верхние имена. Принимаем оба формата, чтобы
// проверка дублей не зависела от конкретного REST-метода.
function bitrixField(record, name) {
  if (!record || typeof record !== 'object') return undefined;
  const upper = String(name || '');
  const camel = upper.toLowerCase().replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
  return record[upper] ?? record[camel] ?? record[upper.toLowerCase()];
}

function minskParts(date) {
  const shifted = new Date(new Date(date).getTime() + MINSK_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function minskDate(parts) {
  return new Date(Date.UTC(parts.year, parts.month, parts.day, parts.hour || 0, parts.minute || 0, parts.second || 0) - MINSK_OFFSET_MS);
}

function isWorkingMinsk(parts) {
  return parts.weekday >= 1 && parts.weekday <= 5 && parts.hour >= 9 && parts.hour < 18;
}

function nextWorkingStart(date) {
  let parts = minskParts(date);
  if (isWorkingMinsk(parts)) return new Date(date);
  if (parts.weekday >= 1 && parts.weekday <= 5 && parts.hour < 9) {
    return minskDate({ ...parts, hour: 9, minute: 0, second: 0 });
  }
  do {
    const nextDay = new Date(Date.UTC(parts.year, parts.month, parts.day + 1));
    parts = { ...minskParts(nextDay), hour: 9, minute: 0, second: 0 };
  } while (parts.weekday === 0 || parts.weekday === 6);
  return minskDate(parts);
}

function addWorkingHours(date, hours) {
  let cursor = nextWorkingStart(date);
  let remainingMinutes = Math.max(0, Math.round(Number(hours || 0) * 60));
  while (remainingMinutes > 0) {
    const parts = minskParts(cursor);
    const availableMinutes = (18 * 60) - (parts.hour * 60 + parts.minute);
    if (availableMinutes <= 0) {
      cursor = nextWorkingStart(new Date(cursor.getTime() + 60 * 1000));
      continue;
    }
    const step = Math.min(remainingMinutes, availableMinutes);
    cursor = new Date(cursor.getTime() + step * 60 * 1000);
    remainingMinutes -= step;
    if (remainingMinutes > 0) cursor = nextWorkingStart(new Date(cursor.getTime() + 60 * 1000));
  }
  return cursor;
}

function dateAfterCalendarDays(date, days) {
  const parts = minskParts(date);
  const target = new Date(Date.UTC(parts.year, parts.month, parts.day + Number(days || 0)));
  return target.toISOString().slice(0, 10);
}

function needsLongCloseDate({ needsSelection, service }) {
  return Boolean(needsSelection) || /подбор|аттестация/i.test(String(service || ''));
}

function isSpkFirstContactService(service) {
  return /спк|свидетельств.*техн|техн.*компетент/i.test(String(service || ''));
}

function closeDateDays(context) {
  return needsLongCloseDate(context) ? 21 : 14;
}

function firstContactSchedule(assignedAt) {
  const assigned = new Date(assignedAt);
  const parts = minskParts(assigned);
  const assignedOnWorkingDay = parts.weekday >= 1 && parts.weekday <= 5;
  const startAt = assignedOnWorkingDay && parts.hour < 12
    ? nextWorkingStart(assigned)
    : nextWorkingStart(new Date(assigned.getTime() + 24 * 60 * 60 * 1000));
  return {
    startAt,
    deadlineAt: addWorkingHours(startAt, 4),
  };
}

function spkChecklist() {
  return [
    'Копии заверить: «Копия верна», подпись директора, расшифровка и печать.',
    'Компания: свидетельство о регистрации; при смене адреса — уведомление; документ на помещение; 1-я и последняя страницы устава.',
    'Специалисты: обязательно 2 специалиста по основному месту работы; трудовая/приказ/контракт, диплом и аттестат для прораба или мастера по нужным видам работ.',
    'Средства измерения: подтвердить наличие; при наличии — аренда/передача/накладные и свидетельства поверки или калибровки.',
    'Оплата: после получения счетов — копии счёта и платёжного документа за ИПС «Стройпрофи» и техкарты.',
    'Недостающие средства измерения и счета эксперт согласует с клиентом отдельно.',
  ];
}

function spkFirstContactHint({ closeDate, closeDays }) {
  return [
    'СПК — первое касание',
    'Свяжитесь с клиентом и согласуйте ход работы.',
    '',
    'Что запросить:',
    ...spkChecklist().map((line, index) => `${index + 1}. ${line}`),
    '',
    `Плановая дата закрытия: ${closeDate} (${closeDays} календарных дней).`,
  ].join('\n');
}

function firstContactAction({ completed, elapsedWorkingHours, reminderSent, escalationSent }) {
  if (completed) return 'none';
  if (Number(elapsedWorkingHours || 0) >= 9 && !escalationSent) return 'escalate';
  if (Number(elapsedWorkingHours || 0) >= 4 && !reminderSent) return 'remind';
  return 'wait';
}

module.exports = {
  SPK_FIRST_CONTACT_MARKER,
  SPK_FIRST_CONTACT_REMINDER_MARKER,
  SPK_FIRST_CONTACT_ESCALATION_MARKER,
  addWorkingHours,
  bitrixField,
  closeDateDays,
  dateAfterCalendarDays,
  firstContactAction,
  firstContactSchedule,
  isSpkFirstContactService,
  needsLongCloseDate,
  spkFirstContactHint,
  spkChecklist,
};
