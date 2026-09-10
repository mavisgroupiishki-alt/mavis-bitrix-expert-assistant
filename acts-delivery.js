'use strict';

function deliveryChannelPlan(preferredChannel) {
  const channels = ['telegram', 'viber', 'email'];
  if (!channels.includes(preferredChannel)) return channels;
  return [preferredChannel, ...channels.filter((channel) => channel !== preferredChannel)];
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

module.exports = { createInFlightLock, deliveryChannelPlan, isTechnicalProductionComment };
