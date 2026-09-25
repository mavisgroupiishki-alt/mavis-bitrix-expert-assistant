'use strict';

function isPreferredChannelFieldLabel(value) {
  const label = String(value || '').toLowerCase().trim();
  return /предпочитаем|предпочтительн/.test(label) && /(канал|способ)/.test(label) && /связ/.test(label);
}

function enumLabelForValue(userField, enumId) {
  const field = Array.isArray(userField) ? userField[0] : userField;
  const list = field && (field.LIST || field.list || field.ENUM || field.enum);
  if (!Array.isArray(list)) return '';
  const wanted = String(enumId || '');
  const item = list.find((entry) => String(entry && (entry.ID || entry.id || entry.VALUE_ID || entry.valueId || '')) === wanted);
  return item ? String(item.VALUE || item.value || item.XML_ID || item.xmlId || '') : '';
}

module.exports = { enumLabelForValue, isPreferredChannelFieldLabel };
