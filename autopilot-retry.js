'use strict';

function createAutopilotRetryGate() {
  const deferredUntilByKey = new Map();

  function defer(key, cooldownMinutes, now = new Date()) {
    const minutes = Math.max(1, Number(cooldownMinutes) || 1);
    const until = new Date(new Date(now).getTime() + minutes * 60 * 1000);
    deferredUntilByKey.set(String(key || ''), until.getTime());
    return until;
  }

  function isDeferred(key, now = new Date()) {
    const normalizedKey = String(key || '');
    const until = deferredUntilByKey.get(normalizedKey);
    if (!until) return false;
    if (until <= new Date(now).getTime()) {
      deferredUntilByKey.delete(normalizedKey);
      return false;
    }
    return true;
  }

  function clear(key) {
    deferredUntilByKey.delete(String(key || ''));
  }

  return { clear, defer, isDeferred };
}

module.exports = { createAutopilotRetryGate };
