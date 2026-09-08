#!/usr/bin/env node
'use strict';

/*
  Создаёт изолированный контур найма в Bitrix24.
  По умолчанию только читает конфигурацию. Любое создание требует --apply.
  Секрет хранится только в BITRIX_WEBHOOK_URL на сервере и никогда не выводится.
*/

const APPLY = process.argv.includes('--apply');
const WEBHOOK = String(process.env.BITRIX_WEBHOOK_URL || '').replace(/\/+$/, '');
const CATEGORY_NAME = 'Найм';

// Bitrix создаёт эти стадии автоматически. Их нельзя ставить после «Успеха»,
// поэтому они переименовываются, а не дублируются.
const defaultStageNames = [
  ['NEW', 'Новый отклик', '#4A90E2'],
  ['PREPARATION', 'Проверка рекрутером', '#4A90E2'],
  ['PREPAYMENT_INVOIC', 'Нужно уточнение', '#4A90E2'],
  ['EXECUTING', 'Запись на интервью', '#4A90E2'],
  ['FINAL_INVOICE', 'Интервью проведено', '#4A90E2'],
  ['WON', 'Нанят', '#7BD500'],
  ['LOSE', 'Не выбран', '#FF5752'],
  ['APOLOGY', 'Кандидат отказался', '#FF5752'],
];

const addedStages = [
  ['HR_DECISION', 'Решение руководителя', 51, ''],
  ['HR_OFFER', 'Оффер', 52, ''],
  ['HR_RESERVE', 'Резерв', 53, ''],
  ['HR_NO_RESPONSE', 'Нет связи', 90, 'F'],
];

const fields = [
  ['HR_ROLE', 'Роль', 'enumeration', ['Менеджер по продажам', 'Эксперт', 'Прораб']],
  ['HR_SOURCE', 'Источник кандидата', 'enumeration', ['rabota.by', 'Kufar', 'Рекомендация', 'Ручной']],
  ['HR_SOURCE_VACANCY_ID', 'ID вакансии в источнике', 'string'],
  ['HR_SOURCE_APPLICATION_ID', 'ID отклика в источнике', 'string'],
  ['HR_SOURCE_URL', 'Ссылка на отклик', 'url'],
  ['HR_RECEIVED_AT', 'Отклик получен', 'datetime'],
  ['HR_DEDUP_KEY', 'Ключ поиска дубля', 'string'],
  ['HR_CANDIDATE_FULL_NAME', 'ФИО кандидата', 'string'],
  ['HR_CANDIDATE_PHONE', 'Телефон кандидата', 'string'],
  ['HR_CANDIDATE_EMAIL', 'E-mail кандидата', 'string'],
  ['HR_RESUME_URL', 'Ссылка на резюме', 'url'],
  ['HR_CONDITIONS', 'Подтверждённые условия', 'string'],
  ['HR_SCORE_VERSION', 'Версия scorecard', 'string'],
  ['HR_TOTAL_SCORE', 'Итоговый балл', 'double'],
  ['HR_B2B_SCORE', 'Балл: B2B-полный цикл', 'double'],
  ['HR_COLD_SCORE', 'Балл: активные продажи', 'double'],
  ['HR_DISCOVERY_SCORE', 'Балл: потребность и КП', 'double'],
  ['HR_CRM_SCORE', 'Балл: CRM и воронка', 'double'],
  ['HR_COMPLEX_SCORE', 'Балл: сложные продажи', 'double'],
  ['HR_METRICS_SCORE', 'Балл: результаты', 'double'],
  ['HR_LEARNING_SCORE', 'Балл: обучение продукту', 'double'],
  ['HR_EVIDENCE', 'Доказательства оценки', 'string'],
  ['HR_STRENGTHS', 'Сильные стороны', 'string'],
  ['HR_RISKS', 'Риски', 'string'],
  ['HR_MISSING_INFO', 'Что уточнить', 'string'],
  ['HR_RECOMMENDATION', 'Рекомендованное действие', 'enumeration', ['Ручная проверка', 'Уточнить', 'Рекомендовать интервью']],
  ['HR_INTERVIEW_AT', 'Дата и время интервью', 'datetime'],
  ['HR_INTERVIEW_NOTES', 'Заметки интервью', 'string'],
  ['HR_INTERVIEW_SCORE', 'Итоговый балл интервью', 'double'],
  ['HR_DECISION_OWNER', 'Согласующий', 'employee'],
  ['HR_FINAL_DECISION', 'Финальное решение', 'enumeration', ['Нанять', 'Резерв', 'Не выбрать']],
  ['HR_AUTOMATION_STATUS', 'Статус автоматизации', 'enumeration', ['Включена', 'На паузе', 'Только вручную', 'Ошибка']],
  ['HR_CORRELATION_ID', 'Correlation ID', 'string'],
  ['HR_LAST_SYNC_AT', 'Последняя синхронизация', 'datetime'],
  ['HR_SYNC_ERROR', 'Ошибка синхронизации', 'string'],
];

function fail(message) {
  console.error(`[recruiting] ${message}`);
  process.exit(1);
}

async function call(method, params = {}) {
  const response = await fetch(`${WEBHOOK}/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(`${method}: ${payload.error_description || payload.error || `HTTP ${response.status}`}`);
  }
  return payload.result;
}

function fieldExists(existing, code) {
  return existing.some((field) => String(field.XML_ID || '') === code || String(field.FIELD_NAME || '').endsWith(`_${code}`));
}

async function main() {
  if (!WEBHOOK) fail('BITRIX_WEBHOOK_URL не задан. Запустите на сервере Bitrix24/Render; секрет в команду не передавайте.');

  const [categories, currentFields] = await Promise.all([
    call('crm.category.list', { entityTypeId: 2 }),
    call('crm.deal.userfield.list'),
  ]);
  const categoryList = Array.isArray(categories?.categories) ? categories.categories : [];
  const fieldList = Array.isArray(currentFields) ? currentFields : [];
  let category = categoryList.find((item) => String(item.name || '').trim() === CATEGORY_NAME);

  console.log(`[recruiting] mode=${APPLY ? 'apply' : 'dry-run'}; category=${category ? `existing:${category.id}` : 'missing'}; fields=${fieldList.length}`);
  if (!APPLY) {
    console.log(`[recruiting] would create category=${!category}; missing_fields=${fields.filter(([code]) => !fieldExists(fieldList, code)).length}; stages=${defaultStageNames.length + addedStages.length}`);
    return;
  }

  if (!category) {
    const created = await call('crm.category.add', { entityTypeId: 2, fields: { name: CATEGORY_NAME, sort: 900, isDefault: 'N' } });
    category = created?.category;
    if (!category?.id) fail('crm.category.add не вернул ID новой воронки.');
    console.log(`[recruiting] created category=${category.id}`);
  }

  const stageEntityId = `DEAL_STAGE_${category.id}`;
  const currentStages = await call('crm.status.list', { filter: { ENTITY_ID: stageEntityId }, order: { SORT: 'ASC' } });
  const stageList = Array.isArray(currentStages) ? currentStages : [];
  for (const [suffix, name, color] of defaultStageNames) {
    const stage = stageList.find((item) => String(item.STATUS_ID || '').endsWith(`:${suffix}`));
    if (!stage) fail(`Не найдена стандартная стадия ${suffix} в воронке ${category.id}.`);
    if (String(stage.NAME || '') !== name || String(stage.COLOR || '') !== color) {
      await call('crm.status.update', { id: Number(stage.ID), fields: { NAME: name, COLOR: color } });
      console.log(`[recruiting] configured stage=${suffix}`);
    }
  }
  for (const [statusId, name, sort, semantics] of addedStages) {
    if (stageList.some((item) => String(item.STATUS_ID || '').endsWith(`:${statusId}`))) continue;
    await call('crm.status.add', { fields: { ENTITY_ID: stageEntityId, STATUS_ID: `C${category.id}:${statusId}`, NAME: name, SORT: sort, SEMANTICS: semantics, COLOR: '#4A90E2' } });
    console.log(`[recruiting] created stage=${statusId}`);
  }

  for (const [code, label, type, options] of fields) {
    if (fieldExists(fieldList, code)) continue;
    const definition = {
      FIELD_NAME: code,
      XML_ID: code,
      LABEL: label,
      USER_TYPE_ID: type,
      MULTIPLE: 'N',
      MANDATORY: 'N',
      SHOW_FILTER: 'Y',
      EDIT_IN_LIST: 'Y',
      SORT: 9000,
      EDIT_FORM_LABEL: { ru: label },
      LIST_COLUMN_LABEL: { ru: label },
    };
    if (type === 'enumeration') {
      definition.LIST = options.map((value, index) => ({ VALUE: value, XML_ID: `${code}_${index + 1}`, SORT: (index + 1) * 100 }));
      definition.SETTINGS = { DISPLAY: 'UI', LIST_HEIGHT: 4 };
    }
    await call('crm.deal.userfield.add', { fields: definition });
    console.log(`[recruiting] created field=${code}`);
  }
  console.log('[recruiting] completed. Verify category, stage semantics and field placement in Bitrix24 before activating integrations.');
}

main().catch((error) => fail(error.message));
