'use strict';

const STAGE_RULES = new Map([
  ['NEW', ['Проверить новый отклик', 'Проверьте карточку кандидата и определите следующий внутренний шаг.']],
  ['PREPARATION', ['Провести первичную проверку кандидата', 'Проверьте резюме и заполните недостающие данные в карточке.']],
  ['PREPAYMENT_INVOIC', ['Уточнить недостающую информацию', 'Зафиксируйте, какие сведения нужно получить или подтвердить вручную.']],
  ['EXECUTING', ['Подготовить запись на интервью', 'Согласуйте время интервью вручную и внесите его в поле карточки.']],
  ['FINAL_INVOICE', ['Зафиксировать итоги интервью', 'Внесите заметки и итог интервью в карточку перед передачей на решение.']],
  ['HR_OFFER', ['Подготовить оффер к ручному согласованию', 'Подготовьте внутренний черновик; кандидату ничего автоматически не отправляется.']],
  ['HR_RESERVE', ['Зафиксировать резерв кандидата', 'Заполните условия резерва и дату следующего ручного контакта.']],
  ['HR_NO_RESPONSE', ['Проверить следующий ручной шаг', 'Проверьте карточку и определите дальнейшие действия без автоматических сообщений.']],
]);

function stageSuffix(stageId) {
  return String(stageId || '').split(':').pop();
}

function employeeId(value) {
  if (Array.isArray(value)) return employeeId(value[0]);
  if (value && typeof value === 'object') return employeeId(value.ID || value.id || value.VALUE || value.value);
  return String(value || '').trim();
}

function isRecruitingAutomationPaused(status, pausedValue, manualValue) {
  return [pausedValue, manualValue].filter(Boolean).map(String).includes(String(status || ''));
}

function recruitingStageTaskPlan({ stageId, role, decisionOwner, recruiterId }) {
  const recruiter = employeeId(recruiterId);
  if (!recruiter) return null;
  const suffix = stageSuffix(stageId);
  if (suffix === 'HR_DECISION') {
    if (role === 'Прораб') {
      return {
        responsibleId: recruiter,
        title: 'Принять решение по кандидату-прорабу',
        description: 'Примите решение вручную. Scorecard, AI-анализ и автоматический отсев для прораба не применяются.',
      };
    }
    const owner = employeeId(decisionOwner);
    if (!owner) {
      return {
        responsibleId: recruiter,
        title: 'Выбрать согласующего для решения',
        description: 'Заполните поле «Согласующий», затем передайте карточку РОПу или руководителю экспертного отдела вручную.',
      };
    }
    return {
      responsibleId: owner,
      title: 'Принять решение по кандидату',
      description: 'Примите решение вручную и зафиксируйте его в карточке кандидата.',
    };
  }
  const rule = STAGE_RULES.get(suffix);
  return rule && { responsibleId: recruiter, title: rule[0], description: rule[1] };
}

function recruitingStageTaskMarker({ dealId, stageId, movedTime }) {
  const id = String(dealId || '').trim();
  const stage = String(stageId || '').trim();
  const moved = String(movedTime || '').trim();
  if (!id || !stage || !moved) return '';
  return `[MAVIS_RECRUITING_STAGE_TASK:${id}:${stage}:${moved}]`;
}

module.exports = { employeeId, isRecruitingAutomationPaused, recruitingStageTaskMarker, recruitingStageTaskPlan };
