'use strict';

function isPreferredChannelFieldLabel(value) {
  const label = String(value || '').toLowerCase().trim();
  return /предпочитаем|предпочтительн/.test(label) && /(канал|способ)/.test(label) && /связ/.test(label);
}

module.exports = { isPreferredChannelFieldLabel };
