'use strict';

function deliveryChannelPlan(preferredChannel, options = {}) {
  const telegramEnabled = options.telegramEnabled !== false;
  const channels = ['telegram', 'viber', 'email'];
  const plan = !channels.includes(preferredChannel)
    ? channels
    : [preferredChannel, ...channels.filter((channel) => channel !== preferredChannel)];
  return telegramEnabled ? plan : plan.filter((channel) => channel !== 'telegram');
}

// Wazzup rejects a second request with the same crmMessageId only after it has
// accepted the original one. This is an idempotency acknowledgement, not a
// delivery failure that should schedule another act send.
function isWazzupRepeatedCrmMessageError(data, fallback = '') {
  const values = [
    fallback,
    data && data.error,
    data && data.description,
    data && data.error_description,
    data && data.message,
    data && data.detail,
  ];
  return values.some((value) => /REPEATED_CRM_MESSAGE_ID/i.test(String(value || '')));
}

function canUseEmailFallbackAfterWazzupError(error) {
  return !Boolean(error && error.possiblyDelivered);
}

function createInFlightLock() {
  const keys = new Set();

  return {
    acquire(key) {
      const normalizedKey = String(key || '');
      if (!normalizedKey || keys.has(normalizedKey)) return null;
      keys.add(normalizedKey);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        keys.delete(normalizedKey);
      };
    },
  };
}

function isTechnicalProductionComment(value) {
  const text = String(value || '').trim();
  if (!text) return false;

  return (
    /\[(?:WAZZUP_AI_INBOUND|WAZZUP_INBOUND(?:_MESSAGE)?|MAVIS_LIVE_CHAT|MAVIS_CLIENT_REPLY)\]/i.test(text) ||
    /\[MAVIS_AUTOPILOT_SEND_PENDING\]/i.test(text) ||
    /\[MAVIS_DOCS_REMINDER_ERROR\]/i.test(text) ||
    /и+горь\s+не\s+смог\s+отправить\s+ход\s+работы\s+клиенту/i.test(text) ||
    (/\b(?:action|confidence|task|deal|message)=/i.test(text) && /\{[\s\S]*\}/.test(text))
  );
}

module.exports = { canUseEmailFallbackAfterWazzupError, createInFlightLock, deliveryChannelPlan, isTechnicalProductionComment, isWazzupRepeatedCrmMessageError };
