#!/usr/bin/env node
'use strict';

const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const serverPath = path.resolve(process.argv[2] || 'server.js');
if (!fs.existsSync(serverPath)) {
  console.error(`❌ Не найден ${serverPath}`);
  console.error('Положите этот файл рядом с актуальным server.js и запустите: node apply_v126_agent_core.js');
  process.exit(2);
}

const original = fs.readFileSync(serverPath, 'utf8');
if (original.includes('MAVIS_AGENT_CORE_V126')) {
  console.log('ℹ️ Agent Core v126 уже установлен. Повторно ничего не меняю.');
  process.exit(0);
}

const marker = 'app.listen(PORT, () => {';
const idx = original.indexOf(marker);
if (idx < 0) {
  console.error('❌ Не найден app.listen(PORT, () => {. Ничего не изменено.');
  process.exit(3);
}

const agentCore = String.raw`
// ============================================================================
// MAVIS_AGENT_CORE_V126
// ИИгорь Agent Core: ситуационный анализ сделки вместо бизнес-логики if/else.
// v1 запускается только вручную через API. По умолчанию — OBSERVE ONLY.
// Автовыполнение клиентских действий разрешается отдельно и только для test deal.
// ============================================================================

const AGENT_CORE_VERSION = 'v126-agent-core-1';
const AGENT_CORE_TEST_DEAL_ID = String(process.env.AGENT_CORE_TEST_DEAL_ID || config.cjmTestDealId || '38072');
const AGENT_CORE_ALLOW_EXECUTE =
  String(process.env.AGENT_CORE_ALLOW_EXECUTE || 'false').toLowerCase() === 'true';
const AGENT_CORE_ALLOW_CLIENT_SEND =
  String(process.env.AGENT_CORE_ALLOW_CLIENT_SEND || 'false').toLowerCase() === 'true';
const AGENT_CORE_MAX_TIMELINE = Math.max(20, Number(process.env.AGENT_CORE_MAX_TIMELINE || 80));
const AGENT_CORE_MAX_ACTIVITIES = Math.max(20, Number(process.env.AGENT_CORE_MAX_ACTIVITIES || 80));
const AGENT_CORE_MAX_TASKS = Math.max(20, Number(process.env.AGENT_CORE_MAX_TASKS || 80));

function agentCoreText(v, max = 4000) {
  const s = String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function agentCoreArray(v) {
  return Array.isArray(v) ? v : (v ? [v] : []);
}

function agentCoreCommValues(entity, key) {
  return agentCoreArray(entity && entity[key])
    .map((x) => typeof x === 'object' ? x.VALUE : x)
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function agentCoreSafeActivity(a) {
  return {
    id: String(a && (a.ID || a.id) || ''),
    typeId: String(a && (a.TYPE_ID || a.typeId) || ''),
    providerId: agentCoreText(a && (a.PROVIDER_ID || a.providerId), 200),
    providerTypeId: agentCoreText(a && (a.PROVIDER_TYPE_ID || a.providerTypeId), 200),
    subject: agentCoreText(a && (a.SUBJECT || a.subject), 500),
    description: agentCoreText(a && (a.DESCRIPTION || a.description), 2500),
    completed: String(a && (a.COMPLETED || a.completed) || ''),
    startTime: String(a && (a.START_TIME || a.startTime) || ''),
    endTime: String(a && (a.END_TIME || a.endTime) || ''),
    created: String(a && (a.CREATED || a.created) || ''),
    lastUpdated: String(a && (a.LAST_UPDATED || a.lastUpdated) || ''),
    responsibleId: String(a && (a.RESPONSIBLE_ID || a.responsibleId) || ''),
    direction: String(a && (a.DIRECTION || a.direction) || ''),
    hasFiles: Boolean(a && (
      (Array.isArray(a.FILES) && a.FILES.length) ||
      (Array.isArray(a.STORAGE_ELEMENT_IDS) && a.STORAGE_ELEMENT_IDS.length)
    )),
  };
}

function agentCoreSafeComment(c) {
  return {
    id: String(c && (c.ID || c.id) || ''),
    created: String(c && (c.CREATED || c.created || c.DATE_CREATE || c.dateCreate) || ''),
    authorId: String(c && (c.AUTHOR_ID || c.authorId) || ''),
    comment: agentCoreText(c && (c.COMMENT || c.comment), 3500),
  };
}

function agentCoreSafeTask(t) {
  return {
    id: String(t && (t.ID || t.id) || ''),
    title: agentCoreText(t && (t.TITLE || t.title), 600),
    description: agentCoreText(t && (t.DESCRIPTION || t.description), 2200),
    status: String(t && (t.STATUS || t.status) || ''),
    stageId: String(t && (t.STAGE_ID || t.stageId) || ''),
    responsibleId: String(t && (t.RESPONSIBLE_ID || t.responsibleId) || ''),
    createdDate: String(t && (t.CREATED_DATE || t.createdDate) || ''),
    changedDate: String(t && (t.CHANGED_DATE || t.changedDate) || ''),
    deadline: String(t && (t.DEADLINE || t.deadline) || ''),
  };
}

async function agentCoreStageName(deal) {
  const categoryId = Number(deal && deal.CATEGORY_ID || config.autopilotCategoryId || 28);
  try {
    const raw = await bitrixRestCall('crm.dealcategory.stage.list', { id: categoryId });
    const stages = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    const current = stages.find((s) => String(s.STATUS_ID || s.statusId || s.ID || s.id || '') === String(deal.STAGE_ID || ''));
    return current ? String(current.NAME || current.name || current.TITLE || current.title || deal.STAGE_ID || '') : String(deal.STAGE_ID || '');
  } catch (_) {
    return String(deal && deal.STAGE_ID || '');
  }
}

async function agentCoreCollectContext(dealId) {
  const deal = await bitrixRestCall('crm.deal.get', { id: dealId });
  if (!deal || !deal.ID) throw new Error(`Сделка ${dealId} не найдена.`);
  if (await isDealAiDisabledAsync(deal)) throw new Error('В сделке стоит ИИ=Нет — Agent Core не работает с ней.');

  const [stageName, timeline, activities, tasks] = await Promise.all([
    agentCoreStageName(deal),
    bitrixRestList('crm.timeline.comment.list', {
      filter: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal' },
      order: { ID: 'DESC' },
      select: ['ID','COMMENT','CREATED','AUTHOR_ID'],
    }, AGENT_CORE_MAX_TIMELINE).catch(() => []),
    bitrixRestList('crm.activity.list', {
      filter: { OWNER_ID: deal.ID, OWNER_TYPE_ID: 2 },
      order: { ID: 'DESC' },
      select: ['*','FILES'],
    }, AGENT_CORE_MAX_ACTIVITIES).catch(() => []),
    bitrixRestList('tasks.task.list', {
      filter: { UF_CRM_TASK: `D_${deal.ID}` },
      order: { ID: 'DESC' },
      select: ['ID','TITLE','DESCRIPTION','STATUS','STAGE_ID','RESPONSIBLE_ID','CREATED_DATE','CHANGED_DATE','DEADLINE'],
    }, AGENT_CORE_MAX_TASKS).catch(() => []),
  ]);

  let company = null;
  let contact = null;

  if (deal.COMPANY_ID) {
    company = await bitrixRestCall('crm.company.get', { id: deal.COMPANY_ID }).catch(() => null);
  }
  if (deal.CONTACT_ID) {
    contact = await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID }).catch(() => null);
  }

  let preferredChannel = null;
  try { preferredChannel = await detectPreferredChannelResolved(deal); } catch (_) {}

  let siblingDeals = [];
  if (deal.COMPANY_ID) {
    siblingDeals = await bitrixRestList('crm.deal.list', {
      filter: { COMPANY_ID: deal.COMPANY_ID, CLOSED: 'N' },
      order: { DATE_MODIFY: 'DESC' },
      select: ['ID','TITLE','CATEGORY_ID','STAGE_ID','ASSIGNED_BY_ID','DATE_MODIFY'],
    }, 30).catch(() => []);
  }

  const chatMarkers = (timeline || []).filter((c) =>
    /\[MAVIS_LIVE_CHAT\]|\[MAVIS_CLIENT_DOCS\]|\[MAVIS_DOCS_WAIT_START\]|\[MAVIS_AGENT_CORE\]/i
      .test(String(c && (c.COMMENT || c.comment) || ''))
  );

  return {
    observedAt: new Date().toISOString(),
    deal: {
      id: String(deal.ID),
      title: agentCoreText(deal.TITLE, 600),
      categoryId: String(deal.CATEGORY_ID || ''),
      stageId: String(deal.STAGE_ID || ''),
      stageName,
      assignedById: String(deal.ASSIGNED_BY_ID || ''),
      companyId: String(deal.COMPANY_ID || ''),
      contactId: String(deal.CONTACT_ID || ''),
      dateCreate: String(deal.DATE_CREATE || ''),
      dateModify: String(deal.DATE_MODIFY || ''),
      closeDate: String(deal.CLOSEDATE || ''),
      opportunity: String(deal.OPPORTUNITY || ''),
      currency: String(deal.CURRENCY_ID || ''),
      service: agentCoreText(
        deal[config.serviceFieldCode || process.env.SERVICE_FIELD_CODE || 'UF_CRM_1765113071'] ||
        deal.UF_CRM_1765113071 || '',
        800
      ),
      preferredChannel,
      userFields: Object.fromEntries(
        Object.entries(deal)
          .filter(([k, v]) => /^UF_CRM_/.test(k) && v !== null && v !== '' && v !== false)
          .slice(0, 120)
          .map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 20) : v])
      ),
    },
    company: company ? {
      id: String(company.ID || ''),
      title: agentCoreText(company.TITLE, 600),
      phones: agentCoreCommValues(company, 'PHONE'),
      emails: agentCoreCommValues(company, 'EMAIL'),
    } : null,
    contact: contact ? {
      id: String(contact.ID || ''),
      name: agentCoreText(`${contact.NAME || ''} ${contact.LAST_NAME || ''}`, 300),
      phones: agentCoreCommValues(contact, 'PHONE'),
      emails: agentCoreCommValues(contact, 'EMAIL'),
    } : null,
    siblingDeals: siblingDeals
      .filter((d) => String(d.ID) !== String(deal.ID))
      .map((d) => ({
        id: String(d.ID || ''),
        title: agentCoreText(d.TITLE, 500),
        categoryId: String(d.CATEGORY_ID || ''),
        stageId: String(d.STAGE_ID || ''),
        assignedById: String(d.ASSIGNED_BY_ID || ''),
        dateModify: String(d.DATE_MODIFY || ''),
      })),
    timeline: (timeline || []).slice().reverse().map(agentCoreSafeComment),
    activities: (activities || []).slice().reverse().map(agentCoreSafeActivity),
    tasks: (tasks || []).slice().reverse().map(agentCoreSafeTask),
    contextQuality: {
      bitrixTimelineLoaded: true,
      activitiesLoaded: true,
      tasksLoaded: true,
      directWazzupHistoryLoaded: false,
      storedChatMarkersFound: chatMarkers.length,
      warning: chatMarkers.length
        ? 'В контексте есть сохранённые chat-маркеры из Bitrix.'
        : 'Прямая история Wazzup пока не загружается Agent Core. Если ключевой ответ клиента есть только в Wazzup и не попал в Bitrix, модель обязана считать контекст неполным.',
    },
  };
}

function agentCoreSystemPrompt() {
  return `Ты — ИИгорь, автономный операционный ассистент экспертного отдела MAVIS GROUP.

Твоя задача — НЕ выполнять заранее прошитый CJM по стадиям. Ты должен понять живую ситуацию конкретной сделки и выбрать следующий разумный шаг на основании фактов.

Ты видишь: карточку сделки, стадию, компанию/контакт, историю комментариев Bitrix, активности/звонки, задачи, связанные активные сделки и доступные следы переписки.

Принципы:
1. Сначала восстанови хронологию: что обещали мы, что обещал клиент, что уже отправлено, что получено, какое последнее содержательное событие.
2. Не отправляй напоминание только потому, что прошло N минут/дней. Учитывай смысл договорённостей, обещанную клиентом дату, последнее сообщение и текущую проблему.
3. Не дублируй уже выполненное действие.
4. Если клиент дал конкретный срок — обычно жди до него, если нет отдельного серьёзного риска.
5. Если клиент прислал документы — разберись, что пришло и чего реально не хватает. Не считай случайный/нерелевантный файл выполнением требования.
6. Если видишь жалобу, конфликт, возврат денег, юридический спор, спор о цене/обязательствах, чувствительную претензию или сильную неоднозначность — клиенту автоматически не отвечай; выбери escalate_human.
7. Если контекст переписки неполный и это может изменить решение — не придумывай; выбери wait или escalate_human и укажи missing_context.
8. Стадия Bitrix — это один из сигналов, а не команда к действию.
9. Предпочитаемый канал связи соблюдай, но сам факт выбора канала не означает, что сейчас нужно писать.
10. Можно решить, что лучше вообще ничего не делать сейчас.
11. Сообщение клиенту должно быть коротким, человеческим, без слов "ИИ", "алгоритм", "автопилот", внутренних стадий и внутренних проблем компании.
12. Не обещай неподтверждённые сроки и не выдумывай документы/факты.

Разрешённые типы следующего действия:
- "none" — ничего не делать;
- "wait" — подождать до осмысленного момента;
- "send_client_message" — отправить клиенту одно сообщение;
- "add_internal_comment" — оставить полезный внутренний комментарий;
- "create_task" — создать задачу человеку;
- "escalate_human" — передать ситуацию человеку.

Верни ТОЛЬКО валидный JSON:
{
  "situation": "что происходит сейчас, 2-5 предложений",
  "goal_now": "ближайшая реальная цель",
  "blocker": "что мешает или пустая строка",
  "evidence": ["конкретные факты из контекста"],
  "missing_context": ["что критично не видно"],
  "confidence": 0.0,
  "safe_to_execute": false,
  "action": {
    "type": "none|wait|send_client_message|add_internal_comment|create_task|escalate_human",
    "reason": "почему именно это действие сейчас",
    "message": "текст клиенту или внутренний комментарий/описание задачи",
    "wait_until": "ISO-дата/понятный срок или пустая строка",
    "task_title": "если нужна задача",
    "responsible_role": "expert|leader|sales|none"
  }
}`;
}

function agentCoreNormalizeDecision(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const allowed = new Set(['none','wait','send_client_message','add_internal_comment','create_task','escalate_human']);
  const action = p.action && typeof p.action === 'object' ? p.action : {};
  const type = allowed.has(String(action.type || '')) ? String(action.type) : 'none';
  const confidence = Math.max(0, Math.min(1, Number(p.confidence || 0)));
  return {
    situation: agentCoreText(p.situation, 3000),
    goal_now: agentCoreText(p.goal_now, 1200),
    blocker: agentCoreText(p.blocker, 1200),
    evidence: agentCoreArray(p.evidence).map((x) => agentCoreText(x, 1200)).slice(0, 12),
    missing_context: agentCoreArray(p.missing_context).map((x) => agentCoreText(x, 1200)).slice(0, 12),
    confidence,
    safe_to_execute: Boolean(p.safe_to_execute),
    action: {
      type,
      reason: agentCoreText(action.reason, 2000),
      message: agentCoreText(action.message, 6000),
      wait_until: agentCoreText(action.wait_until, 300),
      task_title: agentCoreText(action.task_title, 700),
      responsible_role: ['expert','leader','sales','none'].includes(String(action.responsible_role || ''))
        ? String(action.responsible_role)
        : 'none',
    },
  };
}

async function agentCoreThink(context) {
  if (!config.aiEnabled) throw new Error('AI_ENABLED=false — Agent Core не может принять решение.');
  const rawText = await callAiChatCompletion({
    model: config.aiModel,
    temperature: 0.15,
    messages: [
      { role: 'system', content: agentCoreSystemPrompt() },
      {
        role: 'user',
        content:
          `Текущее локальное время сервера: ${new Date().toISOString()}\n` +
          `Проанализируй сделку целиком и выбери только ОДИН следующий шаг.\n\n` +
          `КОНТЕКСТ:\n${clipText(JSON.stringify(context, null, 2), 50000)}`,
      },
    ],
  });
  const parsed = safeJsonParse(rawText);
  if (!parsed) throw new Error('Agent Core: модель вернула невалидный JSON.');
  return agentCoreNormalizeDecision(parsed);
}

async function agentCoreAddTimelineComment(dealId, text) {
  return bitrixRestCall('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: `[MAVIS_AGENT_CORE] ${text}`,
    },
  });
}

async function agentCoreResolveRecipient(context) {
  const contactPhones = context.contact && Array.isArray(context.contact.phones) ? context.contact.phones : [];
  const companyPhones = context.company && Array.isArray(context.company.phones) ? context.company.phones : [];
  const contactEmails = context.contact && Array.isArray(context.contact.emails) ? context.contact.emails : [];
  const companyEmails = context.company && Array.isArray(context.company.emails) ? context.company.emails : [];
  return {
    phone: contactPhones[0] || companyPhones[0] || '',
    email: contactEmails[0] || companyEmails[0] || '',
    channel: context.deal.preferredChannel || '',
  };
}

async function agentCoreExecute(dealId, context, decision) {
  if (!AGENT_CORE_ALLOW_EXECUTE) {
    return { executed: false, reason: 'AGENT_CORE_ALLOW_EXECUTE=false' };
  }
  if (String(dealId) !== String(AGENT_CORE_TEST_DEAL_ID)) {
    return { executed: false, reason: `execute разрешён только test deal ${AGENT_CORE_TEST_DEAL_ID}` };
  }
  if (!decision.safe_to_execute || decision.confidence < 0.72) {
    return { executed: false, reason: `модель не разрешила безопасное выполнение (safe=${decision.safe_to_execute}; confidence=${decision.confidence})` };
  }

  const a = decision.action || {};
  if (a.type === 'none' || a.type === 'wait') {
    return { executed: false, reason: `действие ${a.type} не требует внешнего выполнения` };
  }

  if (a.type === 'add_internal_comment') {
    if (!a.message) return { executed: false, reason: 'пустой внутренний комментарий' };
    await agentCoreAddTimelineComment(dealId, a.message);
    return { executed: true, action: 'add_internal_comment' };
  }

  if (a.type === 'escalate_human' || a.type === 'create_task') {
    const responsibleId =
      a.responsible_role === 'leader'
        ? (config.executorLeaderId || config.actsIncomingLeaderId || '2182')
        : (context.deal.assignedById || config.executorExpertId || '');
    if (!responsibleId) return { executed: false, reason: 'не найден ответственный для задачи' };

    const title = a.task_title || (
      a.type === 'escalate_human'
        ? `ИИгорь: нужна помощь по сделке ${dealId}`
        : `ИИгорь: следующий шаг по сделке ${dealId}`
    );

    const created = await bitrixRestCall('tasks.task.add', {
      fields: {
        TITLE: title,
        DESCRIPTION: a.message || a.reason || decision.situation,
        RESPONSIBLE_ID: Number(responsibleId),
        UF_CRM_TASK: [`D_${dealId}`],
        PRIORITY: a.type === 'escalate_human' ? 2 : 1,
      },
    });

    await agentCoreAddTimelineComment(
      dealId,
      `Создана задача человеку. Причина: ${a.reason || decision.situation}`
    ).catch(() => {});

    return {
      executed: true,
      action: a.type,
      taskId: created && (created.task && (created.task.id || created.task.ID) || created.id || created.ID) || null,
    };
  }

  if (a.type === 'send_client_message') {
    if (!AGENT_CORE_ALLOW_CLIENT_SEND) {
      return { executed: false, reason: 'AGENT_CORE_ALLOW_CLIENT_SEND=false' };
    }
    if (!a.message) return { executed: false, reason: 'модель не сформировала сообщение клиенту' };

    const recipient = await agentCoreResolveRecipient(context);
    if (!recipient.channel) return { executed: false, reason: 'не определён предпочитаемый канал связи' };

    if (recipient.channel === 'email') {
      return {
        executed: false,
        reason: 'v126: автоматическая email-отправка Agent Core пока не включена; решение сохранено для проверки',
      };
    }

    if (!['viber','telegram'].includes(recipient.channel)) {
      return { executed: false, reason: `неподдерживаемый канал ${recipient.channel}` };
    }
    if (!recipient.phone) {
      return { executed: false, reason: `для ${recipient.channel} не найден телефон клиента` };
    }

    await sendWazzupMessageInternal({
      channelKey: recipient.channel,
      text: a.message,
      phone: recipient.phone,
      dealId,
    });

    await agentCoreAddTimelineComment(
      dealId,
      `Отправлено клиенту через ${recipient.channel}. Причина решения: ${a.reason}`
    ).catch(() => {});

    return { executed: true, action: 'send_client_message', channel: recipient.channel };
  }

  return { executed: false, reason: `действие ${a.type} не поддерживается исполнителем v126` };
}

async function agentCoreRun(dealId, executeRequested = false) {
  const context = await agentCoreCollectContext(dealId);
  const decision = await agentCoreThink(context);
  const execution = executeRequested
    ? await agentCoreExecute(dealId, context, decision)
    : { executed: false, reason: 'observe-only request' };

  console.log(
    `[agent-core] deal=${dealId}; action=${decision.action.type}; ` +
    `safe=${decision.safe_to_execute}; confidence=${decision.confidence}; executed=${execution.executed}`
  );

  return {
    ok: true,
    version: AGENT_CORE_VERSION,
    mode: executeRequested ? 'execute-requested' : 'observe',
    testDealId: AGENT_CORE_TEST_DEAL_ID,
    context,
    decision,
    execution,
  };
}

// Первый тест: POST /api/agent-core/run/38072
// Исполнение: POST /api/agent-core/run/38072?execute=1
// Для фактической отправки клиенту нужны ОБЕ переменные:
// AGENT_CORE_ALLOW_EXECUTE=true
// AGENT_CORE_ALLOW_CLIENT_SEND=true
app.post('/api/agent-core/run/:dealId', async (req, res) => {
  try {
    const dealId = String(req.params.dealId || '').replace(/\D/g, '');
    if (!dealId) return res.status(400).json({ ok: false, error: 'dealId не указан' });

    // v126 pilot: анализировать можно только тестовую сделку, чтобы новый агент случайно
    // не пошёл по боевой воронке до завершения испытаний.
    if (dealId !== String(AGENT_CORE_TEST_DEAL_ID)) {
      return res.status(403).json({
        ok: false,
        error: `Agent Core v126 пока разрешён только для test deal ${AGENT_CORE_TEST_DEAL_ID}.`,
      });
    }

    const executeRequested =
      ['1','true','yes'].includes(String(req.query.execute || req.body && req.body.execute || '').toLowerCase());

    const result = await agentCoreRun(dealId, executeRequested);
    res.json(result);
  } catch (e) {
    console.error(`[agent-core] ${e.message || e}`);
    res.status(500).json({ ok: false, version: AGENT_CORE_VERSION, error: e.message || String(e) });
  }
});

app.get('/api/agent-core/status', (_req, res) => {
  res.json({
    ok: true,
    version: AGENT_CORE_VERSION,
    testDealId: AGENT_CORE_TEST_DEAL_ID,
    allowExecute: AGENT_CORE_ALLOW_EXECUTE,
    allowClientSend: AGENT_CORE_ALLOW_CLIENT_SEND,
    philosophy: 'AI decides from deal context; code only gathers context, enforces safety and executes tools.',
  });
});

console.log(
  `[agent-core] ${AGENT_CORE_VERSION}; testDeal=${AGENT_CORE_TEST_DEAL_ID}; ` +
  `allowExecute=${AGENT_CORE_ALLOW_EXECUTE}; allowClientSend=${AGENT_CORE_ALLOW_CLIENT_SEND}`
);

`;

const updated = original.slice(0, idx) + agentCore + '\n' + original.slice(idx);
const backupPath = serverPath + '.before_agent_core_v126.bak';

fs.writeFileSync(backupPath, original, 'utf8');
fs.writeFileSync(serverPath, updated, 'utf8');

const syntax = cp.spawnSync(process.execPath, ['--check', serverPath], { encoding: 'utf8' });
if (syntax.status !== 0) {
  fs.writeFileSync(serverPath, original, 'utf8');
  console.error('❌ node --check не прошёл. Исходный server.js восстановлен.');
  console.error(syntax.stderr || syntax.stdout || '');
  process.exit(4);
}

console.log('✅ Agent Core v126 установлен.');
console.log(`✅ Backup: ${backupPath}`);
console.log('✅ node --check: OK');
console.log('');
console.log('Render Environment для первого теста:');
console.log('AGENT_CORE_TEST_DEAL_ID=38072');
console.log('AGENT_CORE_ALLOW_EXECUTE=false');
console.log('AGENT_CORE_ALLOW_CLIENT_SEND=false');
console.log('');
console.log('После deploy: POST /api/agent-core/run/38072');
console.log('Это observe-only: ИИгорь сам прочитает контекст Бобика и решит следующий шаг, но ничего клиенту не отправит.');
