'use strict';

const SCORECARD_VERSION = 'manager-sales-v1';

const CRITERIA = [
  ['b2b', 'B2B-полный цикл и результаты', 25, 'Расскажите, пожалуйста, о вашем опыте полного цикла B2B-продаж: от первого контакта до оплаты.'],
  ['cold', 'Активные/холодные продажи и возражения', 15, 'Какой у вас опыт активного поиска клиентов, холодных контактов и работы с возражениями?'],
  ['discovery', 'Выявление потребностей, переговоры и КП', 15, 'Приведите пример, как вы выявляли потребность клиента и готовили коммерческое предложение.'],
  ['crm', 'CRM и воронка', 15, 'В какой CRM вы работали и какие этапы воронки вели самостоятельно?'],
  ['complex', 'Сложные консультационные продажи', 10, 'С какими сложными или техническими продуктами/услугами вы работали и как объясняли ценность клиенту?'],
  ['metrics', 'Выручка, конверсия и средний чек', 10, 'Какие результаты продаж (выручка, конверсия или средний чек) вы можете подтвердить на последнем месте работы?'],
  ['learning', 'Обучение техническому продукту', 5, 'Расскажите о случае, когда вам пришлось быстро освоить новый технический продукт для продаж.'],
  ['conditions', 'Соответствие подтверждённым условиям', 5, 'Подтвердите, пожалуйста, готовность к офисной работе в Минске, графику 5/2 с 9:00 до 18:00 и формату оплаты оклад + KPI + процент.'],
].map(([key, label, max, question]) => ({ key, label, max, question }));

function clean(value, max = 1000) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function professionalText(value, max = 1000) {
  return clean(value, max)
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\+?[\d][\d\s()\-]{7,}[\d]/g, '[телефон]')
    .replace(/(?:^|[\s,.;:])(?:мне|возраст)\s*\d{1,3}\s*(?:лет|года|год)(?=$|[\s,.;:])/gi, '[нерелевантные данные]')
    .replace(/(?:^|[\s,.;:])(?:мужчина|женщина|женат|замужем|холост|холоста|развед[её]н(?:а)?|национальность|религия)(?=$|[\s,.;:])/gi, '[нерелевантные данные]');
}

function list(value, maxItems = 8, maxItemLength = 600) {
  return (Array.isArray(value) ? value : []).map((item) => professionalText(item, maxItemLength)).filter(Boolean).slice(0, maxItems);
}

function score(value, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(max, Math.round(numeric * 10) / 10)) : 0;
}

function actionForScore(total) {
  if (total >= 60) return 'invite';
  if (total >= 40) return 'clarify';
  return 'reject';
}

function recommendationForAction(action) {
  return { invite: 'Рекомендовать интервью', clarify: 'Уточнить', reject: 'Ручная проверка' }[action] || 'Ручная проверка';
}

function questionsForScores(scores) {
  const missing = CRITERIA
    .map((criterion) => ({ ...criterion, value: Number(scores && scores[criterion.key] || 0) }))
    .filter((criterion) => criterion.value < criterion.max * 0.6)
    .sort((a, b) => (a.value / a.max) - (b.value / b.max));
  return missing.slice(0, 3).map((criterion) => criterion.question);
}

function professionalResumeContext(record, applicantMessages = []) {
  const response = record && typeof record === 'object' ? record : {};
  const resume = response.resume && typeof response.resume === 'object' ? response.resume : {};
  const experience = (Array.isArray(resume.experience) ? resume.experience : []).slice(0, 12).map((item) => ({
    position: professionalText(item && item.position, 250),
    company: professionalText(item && item.company, 250),
    description: professionalText(item && item.description, 1200),
    start: professionalText(item && (item.start || item.start_date), 50),
    end: professionalText(item && (item.end || item.end_date), 50),
  })).filter((item) => item.position || item.description);
  const skills = (Array.isArray(resume.skill_set) ? resume.skill_set : []).map((item) => professionalText(item, 120)).filter(Boolean).slice(0, 40);
  const messages = list(applicantMessages, 8, 1200)
    .map((text) => text.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]').replace(/\+?[\d][\d\s()\-]{7,}[\d]/g, '[телефон]'));
  return {
    desired_position: professionalText(resume.title, 300),
    skills,
    experience,
    employment: professionalText(resume.employment && resume.employment.name || resume.employment, 120),
    schedule: professionalText(resume.schedule && resume.schedule.name || resume.schedule, 120),
    relocation: professionalText(resume.relocation && resume.relocation.type && resume.relocation.type.name || resume.relocation, 120),
    professional_answers: messages,
  };
}

function normalizeScorecard(raw) {
  const result = raw && typeof raw === 'object' ? raw : {};
  const incoming = result.scores && typeof result.scores === 'object' ? result.scores : {};
  const scores = Object.fromEntries(CRITERIA.map((criterion) => [criterion.key, score(incoming[criterion.key], criterion.max)]));
  const total = Math.round(CRITERIA.reduce((sum, criterion) => sum + scores[criterion.key], 0) * 10) / 10;
  const action = actionForScore(total);
  const evidence = list(result.evidence, 8, 400);
  const strengths = list(result.strengths, 6, 300);
  const risks = list(result.risks, 6, 300);
  const missing = list(result.missing_info, 6, 300);
  return {
    version: SCORECARD_VERSION,
    scores,
    total,
    action,
    recommendation: recommendationForAction(action),
    evidence,
    strengths,
    risks,
    missing,
    questions: action === 'clarify' ? questionsForScores(scores) : [],
  };
}

function hasCompleteNumericScores(raw) {
  const scores = raw && raw.scores && typeof raw.scores === 'object' ? raw.scores : {};
  return CRITERIA.every((criterion) => Number.isFinite(Number(scores[criterion.key])));
}

function clarificationMessage(questions) {
  const items = list(questions, 3, 400);
  if (!items.length) return '';
  return `Спасибо за отклик! Чтобы корректно оценить соответствие вакансии, уточните, пожалуйста:\n${items.map((question, index) => `${index + 1}. ${question}`).join('\n')}\n\nПосле ответа вернёмся к вам с дальнейшими шагами.`;
}

function rejectionMessage() {
  return 'Спасибо за отклик и интерес к нашей вакансии. На данном этапе мы решили продолжить рассмотрение других кандидатов. Желаем вам успехов в поиске подходящей позиции.';
}

function analysisComment(analysis) {
  const byCriterion = CRITERIA.map((criterion) => `• ${criterion.label}: ${analysis.scores[criterion.key]}/${criterion.max}`).join('\n');
  const section = (title, values) => values && values.length ? `\n${title}:\n${values.map((value) => `• ${value}`).join('\n')}` : '';
  return `[MAVIS_RECRUITING_SCORECARD:${analysis.version}]\nИИ-анализ резюме (только профессионально релевантные сведения).\nИтог: ${analysis.total}/100. Рекомендация: ${analysis.recommendation}.\n\n${byCriterion}${section('Доказательства', analysis.evidence)}${section('Сильные стороны', analysis.strengths)}${section('Риски', analysis.risks)}${section('Что уточнить на интервью', analysis.missing)}`;
}

module.exports = {
  CRITERIA,
  SCORECARD_VERSION,
  actionForScore,
  analysisComment,
  clarificationMessage,
  hasCompleteNumericScores,
  normalizeScorecard,
  professionalText,
  professionalResumeContext,
  rejectionMessage,
};
