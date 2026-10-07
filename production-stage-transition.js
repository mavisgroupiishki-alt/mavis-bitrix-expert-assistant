'use strict';

function normalizeDate(value) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const date = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text) return '';
  return text;
}

function stageId(stage) {
  return String(stage && (stage.STATUS_ID || stage.statusId || stage.ID || stage.id) || '').trim();
}

function validateProductionTransition({ deal, categoryId, dateFieldCode, targetStageId, expectedCloseDate, stages }) {
  if (!deal || !String(deal.ID || '').match(/^\d+$/)) throw new Error('Сделка не найдена.');
  if (String(deal.CATEGORY_ID) !== String(categoryId)) throw new Error('Сделка не относится к воронке Производства.');
  if (!String(dateFieldCode || '').trim()) throw new Error('Не найдено поле «Предполагаемая дата закрытия продукта».');
  const date = normalizeDate(expectedCloseDate);
  if (!date) throw new Error('Укажите корректную предполагаемую дату закрытия.');
  const target = String(targetStageId || '').trim();
  if (!target || !stages.some((stage) => stageId(stage) === target)) throw new Error('Выберите корректную стадию этой воронки.');
  if (String(deal.STAGE_ID || '') === target) throw new Error('Выберите другую стадию. Дату без перехода можно изменить прямо в карточке сделки.');
  return { expectedCloseDate: date, targetStageId: target };
}

function transitionFields({ targetStageId, expectedCloseDate, dateFieldCode }) {
  return { STAGE_ID: String(targetStageId), [String(dateFieldCode)]: normalizeDate(expectedCloseDate) };
}

module.exports = { normalizeDate, stageId, transitionFields, validateProductionTransition };
