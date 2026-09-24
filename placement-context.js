'use strict';

function parsePlacementOptions(body = {}) {
  const raw = body && body.PLACEMENT_OPTIONS;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function injectPlacementOptions(html, options) {
  const marker = 'window.BITRIX_PLACEMENT_OPTIONS = {};';
  const serialized = JSON.stringify(options || {}).replace(/</g, '\\u003c');
  if (!html.includes(marker)) throw new Error('Placement options marker is missing from the app page.');
  return html.replace(marker, `window.BITRIX_PLACEMENT_OPTIONS = ${serialized};`);
}

module.exports = { injectPlacementOptions, parsePlacementOptions };
