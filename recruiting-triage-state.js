'use strict';

const CLARIFICATION_PREFIX = 'Спасибо за отклик! Чтобы корректно оценить соответствие вакансии,';

function rabotaMessages(payload) {
  return Array.isArray(payload && payload.items) ? payload.items : [];
}

function rabotaMessageText(message) {
  return String(message && (message.text || message.payload && message.payload.text) || '').replace(/\s+/g, ' ').trim();
}

function rabotaAuthorType(message) {
  return String(message && message.author && message.author.participant_type || message && message.sender_display_info && message.sender_display_info.role || '').toLowerCase();
}

function rabotaAwaitingApplicantReply(payload) {
  const items = rabotaMessages(payload);
  let lastQuestion = -1;
  for (let index = 0; index < items.length; index++) {
    if (rabotaAuthorType(items[index]) === 'employer' && rabotaMessageText(items[index]).startsWith(CLARIFICATION_PREFIX)) lastQuestion = index;
  }
  return lastQuestion >= 0 && !items.slice(lastQuestion + 1).some((message) => rabotaAuthorType(message) === 'applicant');
}

function rabotaClarificationCount(payload) {
  return rabotaMessages(payload).filter((message) => rabotaAuthorType(message) === 'employer' && rabotaMessageText(message).startsWith(CLARIFICATION_PREFIX)).length;
}

module.exports = { rabotaAuthorType, rabotaAwaitingApplicantReply, rabotaClarificationCount, rabotaMessageText, rabotaMessages };
