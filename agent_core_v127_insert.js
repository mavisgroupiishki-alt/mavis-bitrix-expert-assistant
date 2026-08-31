
// ============================================================================
// MAVIS_AGENT_CORE_V127
// ИИгорь Agent Core — ситуационный агент с реальными действиями.
// Пилот: ТОЛЬКО тестовая сделка Бобик #38072.
// Код собирает контекст и исполняет инструменты; бизнес-решение принимает модель.
// ============================================================================

const AGENT_CORE_VERSION = 'v127-agent-core-actions-1';
const AGENT_CORE_TEST_DEAL_ID = String(process.env.AGENT_CORE_TEST_DEAL_ID || (config && config.cjmTestDealId) || '38072');
const AGENT_CORE_ALLOW_EXECUTE =
  String(process.env.AGENT_CORE_ALLOW_EXECUTE || 'true').toLowerCase() !== 'false';
const AGENT_CORE_ALLOW_CLIENT_SEND =
  String(process.env.AGENT_CORE_ALLOW_CLIENT_SEND || 'true').toLowerCase() !== 'false';
const AGENT_CORE_MIN_CONFIDENCE = Math.max(0, Math.min(1, Number(process.env.AGENT_CORE_MIN_CONFIDENCE || 0.72)));
const AGENT_CORE_ACTION_MARKER = '[MAVIS_AGENT_ACTION]';
const AGENT_CORE_THOUGHT_MARKER = '[MAVIS_AGENT_DECISION]';

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
function agentCoreHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 18);
}
function agentCoreSafeActivity(a) {
  return {
    id: String((a && (a.ID || a.id)) || ''),
    typeId: String((a && (a.TYPE_ID || a.typeId)) || ''),
    providerId: agentCoreText(a && (a.PROVIDER_ID || a.providerId), 200),
    providerTypeId: agentCoreText(a && (a.PROVIDER_TYPE_ID || a.providerTypeId), 200),
    subject: agentCoreText(a && (a.SUBJECT || a.subject), 700),
    description: agentCoreText(a && (a.DESCRIPTION || a.description), 3500),
    completed: String((a && (a.COMPLETED || a.completed)) || ''),
    startTime: String((a && (a.START_TIME || a.startTime)) || ''),
    endTime: String((a && (a.END_TIME || a.endTime)) || ''),
    created: String((a && (a.CREATED || a.created)) || ''),
    lastUpdated: String((a && (a.LAST_UPDATED || a.lastUpdated)) || ''),
    responsibleId: String((a && (a.RESPONSIBLE_ID || a.responsibleId)) || ''),
    direction: String((a && (a.DIRECTION || a.direction)) || ''),
    hasFiles: Boolean(a && (
      (Array.isArray(a.FILES) && a.FILES.length) ||
      (Array.isArray(a.STORAGE_ELEMENT_IDS) && a.STORAGE_ELEMENT_IDS.length)
    )),
  };
}
function agentCoreSafeComment(c) {
  return {
    id: String((c && (c.ID || c.id)) || ''),
    created: String((c && (c.CREATED || c.created || c.DATE_CREATE || c.dateCreate)) || ''),
    authorId: String((c && (c.AUTHOR_ID || c.authorId)) || ''),
    comment: agentCoreText(c && (c.COMMENT || c.comment), 4500),
  };
}
function agentCoreSafeTask(t) {
  return {
    id: String((t && (t.ID || t.id)) || ''),
    title: agentCoreText(t && (t.TITLE || t.title), 800),
    description: agentCoreText(t && (t.DESCRIPTION || t.description), 3000),
    status: String((t && (t.STATUS || t.status)) || ''),
    stageId: String((t && (t.STAGE_ID || t.stageId)) || ''),
    responsibleId: String((t && (t.RESPONSIBLE_ID || t.responsibleId)) || ''),
    createdDate: String((t && (t.CREATED_DATE || t.createdDate)) || ''),
    changedDate: String((t && (t.CHANGED_DATE || t.changedDate)) || ''),
    deadline: String((t && (t.DEADLINE || t.deadline)) || ''),
  };
}

async function agentCoreStageName(deal) {
  const categoryId = Number((deal && deal.CATEGORY_ID) || (config && config.autopilotCategoryId) || 28);
  try {
    const raw = await bitrixRestCall('crm.dealcategory.stage.list', { id: categoryId });
    const stages = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.values(raw) : []);
    const current = stages.find((s) =>
      String(s.STATUS_ID || s.statusId || s.ID || s.id || '') === String(deal.STAGE_ID || '')
    );
    return current
      ? String(current.NAME || current.name || current.TITLE || current.title || deal.STAGE_ID || '')
      : String(deal.STAGE_ID || '');
  } catch (_) {
    return String((deal && deal.STAGE_ID) || '');
  }
}

async function agentCoreCollectContext(dealId) {
  const deal = await bitrixRestCall('crm.deal.get', { id: dealId });
  if (!deal || !deal.ID) throw new Error('Сделка ' + dealId + ' не найдена.');

  if (typeof isDealAiDisabledAsync === 'function') {
    const disabled = await isDealAiDisabledAsync(deal);
    if (disabled) throw new Error('В сделке стоит ИИ=Нет — Agent Core её не анализирует.');
  }

  const stageName = await agentCoreStageName(deal);

  const timeline = await bitrixRestList('crm.timeline.comment.list', {
    filter: { ENTITY_ID: deal.ID, ENTITY_TYPE: 'deal' },
    order: { ID: 'DESC' },
    select: ['ID', 'COMMENT', 'CREATED', 'AUTHOR_ID'],
  }, 120).catch(() => []);

  const activities = await bitrixRestList('crm.activity.list', {
    filter: { OWNER_ID: deal.ID, OWNER_TYPE_ID: 2 },
    order: { ID: 'DESC' },
    select: ['*', 'FILES'],
  }, 120).catch(() => []);

  const tasks = await bitrixRestList('tasks.task.list', {
    filter: { UF_CRM_TASK: 'D_' + deal.ID },
    order: { ID: 'DESC' },
    select: ['ID','TITLE','DESCRIPTION','STATUS','STAGE_ID','RESPONSIBLE_ID','CREATED_DATE','CHANGED_DATE','DEADLINE'],
  }, 100).catch(() => []);

  let company = null;
  let contact = null;
  if (deal.COMPANY_ID) company = await bitrixRestCall('crm.company.get', { id: deal.COMPANY_ID }).catch(() => null);
  if (deal.CONTACT_ID) contact = await bitrixRestCall('crm.contact.get', { id: deal.CONTACT_ID }).catch(() => null);

  let preferredChannel = '';
  if (typeof detectPreferredChannelResolved === 'function') {
    try { preferredChannel = await detectPreferredChannelResolved(deal); } catch (_) {}
  }

  let siblingDeals = [];
  if (deal.COMPANY_ID) {
    siblingDeals = await bitrixRestList('crm.deal.list', {
      filter: { COMPANY_ID: deal.COMPANY_ID, CLOSED: 'N' },
      order: { DATE_MODIFY: 'DESC' },
      select: ['ID','TITLE','CATEGORY_ID','STAGE_ID','ASSIGNED_BY_ID','DATE_MODIFY'],
    }, 30).catch(() => []);
  }

  const serviceFieldCode =
    (config && config.serviceFieldCode) ||
    process.env.SERVICE_FIELD_CODE ||
    'UF_CRM_1765113071';

  const t = (timeline || []).slice().reverse().map(agentCoreSafeComment);
  const a = (activities || []).slice().reverse().map(agentCoreSafeActivity);
  const ts = (tasks || []).slice().reverse().map(agentCoreSafeTask);

  const lastTimeline = t.length ? t[t.length - 1] : null;
  const lastActivity = a.length ? a[a.length - 1] : null;

  return {
    observedAt: new Date().toISOString(),
    deal: {
      id: String(deal.ID),
      title: agentCoreText(deal.TITLE, 700),
      categoryId: String(deal.CATEGORY_ID || ''),
      stageId: String(deal.STAGE_ID || ''),
      stageName,
      assignedById: String(deal.ASSIGNED_BY_ID || ''),
      companyId: String(deal.COMPANY_ID || ''),
      contactId: String(deal.CONTACT_ID || ''),
      dateCreate: String(deal.DATE_CREATE || ''),
      dateModify: String(deal.DATE_MODIFY || ''),
      movedTime: String(deal.MOVED_TIME || ''),
      closeDate: String(deal.CLOSEDATE || ''),
      opportunity: String(deal.OPPORTUNITY || ''),
      currency: String(deal.CURRENCY_ID || ''),
      service: agentCoreText(deal[serviceFieldCode] || deal.UF_CRM_1765113071 || '', 1000),
      preferredChannel,
      userFields: Object.fromEntries(
        Object.entries(deal)
          .filter(([k, v]) => /^UF_CRM_/.test(k) && v !== null && v !== '' && v !== false)
          .slice(0, 160)
          .map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 30) : v])
      ),
    },
    company: company ? {
      id: String(company.ID || ''),
      title: agentCoreText(company.TITLE, 700),
      phones: agentCoreCommValues(company, 'PHONE'),
      emails: agentCoreCommValues(company, 'EMAIL'),
    } : null,
    contact: contact ? {
      id: String(contact.ID || ''),
      name: agentCoreText(((contact.NAME || '') + ' ' + (contact.LAST_NAME || '')).trim(), 400),
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
    timeline: t,
    activities: a,
    tasks: ts,
    contextQuality: {
      directWazzupHistoryLoaded: false,
      directEmailBodyHistoryLoaded: false,
      warning:
        'Agent Core видит Bitrix timeline/CRM activities/tasks. Прямую историю Wazzup пока не загружает. ' +
        'Если важная реплика клиента есть только в мессенджере и не отражена в Bitrix, считай контекст неполным.',
    },
    freshness: {
      lastTimelineId: lastTimeline ? lastTimeline.id : '',
      lastActivityId: lastActivity ? lastActivity.id : '',
      dealModified: String(deal.DATE_MODIFY || ''),
    },
  };
}

function agentCoreSystemPrompt() {
  return [
    'Ты — ИИгорь, автономный операционный ассистент экспертного отдела MAVIS GROUP.',
    '',
    'Главный принцип: ты НЕ выполняешь заранее прошитый CJM. Ты сам понимаешь текущую ситуацию сделки из доступных фактов и выбираешь ОДИН следующий разумный шаг.',
    '',
    'Работай как сильный живой ассистент эксперта:',
    '- восстанови хронологию;',
    '- пойми, что сейчас ждём от клиента или от MAVIS;',
    '- учитывай обещания клиента и сотрудника;',
    '- замечай уже отправленные сообщения, документы и задачи;',
    '- не дублируй действия;',
    '- не считай стадию Bitrix приказом;',
    '- если действие сейчас не нужно, выбери wait или none;',
    '- если данных недостаточно, не фантазируй;',
    '- если есть конфликт, претензия, деньги, юридический спор или противоречивые указания, выбери escalate_human;',
    '- нерелевантный файл не считай нужным документом;',
    '- если клиент дал конкретный срок, обычно уважай его и жди до него;',
    '- клиентское сообщение должно быть естественным и коротким, без слов ИИ/алгоритм/автопилот и внутренних стадий.',
    '',
    'Важное ограничение пилота:',
    'Прямая история Wazzup пока может отсутствовать. Если без неё нельзя безопасно понять последнюю договорённость, обязательно укажи это в missing_context и не отправляй клиенту сообщение.',
    '',
    'Разрешённые action.type:',
    'none — ничего не делать;',
    'wait — ждать до осмысленного момента;',
    'send_client_message — отправить одно клиентское сообщение;',
    'add_internal_comment — оставить полезный внутренний комментарий в сделке;',
    'create_task — создать задачу ответственному эксперту;',
    'escalate_human — создать задачу руководителю.',
    '',
    'safe_to_execute=true ставь ТОЛЬКО если действие однозначно безопасно на основании доступного контекста.',
    '',
    'Верни ТОЛЬКО валидный JSON:',
    '{',
    '  "situation": "что сейчас реально происходит, 2-5 предложений",',
    '  "goal_now": "ближайшая реальная цель",',
    '  "blocker": "что мешает или пустая строка",',
    '  "evidence": ["конкретный факт 1", "конкретный факт 2"],',
    '  "missing_context": ["что важного не видно"],',
    '  "confidence": 0.0,',
    '  "safe_to_execute": false,',
    '  "action": {',
    '    "type": "none|wait|send_client_message|add_internal_comment|create_task|escalate_human",',
    '    "reason": "почему сейчас именно это",',
    '    "message": "готовый текст сообщения/комментария/описания задачи",',
    '    "wait_until": "ISO дата-время либо пустая строка",',
    '    "task_title": "название задачи либо пустая строка",',
    '    "responsible_role": "expert|leader|none"',
    '  }',
    '}',
  ].join('\n');
}

function agentCoreNormalizeDecision(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const allowed = new Set(['none','wait','send_client_message','add_internal_comment','create_task','escalate_human']);
  const action = p.action && typeof p.action === 'object' ? p.action : {};
  const type = allowed.has(String(action.type || '')) ? String(action.type) : 'none';
  const confidence = Math.max(0, Math.min(1, Number(p.confidence || 0)));
  return {
    situation: agentCoreText(p.situation, 3500),
    goal_now: agentCoreText(p.goal_now, 1500),
    blocker: agentCoreText(p.blocker, 1500),
    evidence: agentCoreArray(p.evidence).map((x) => agentCoreText(x, 1400)).slice(0, 15),
    missing_context: agentCoreArray(p.missing_context).map((x) => agentCoreText(x, 1400)).slice(0, 15),
    confidence,
    safe_to_execute: Boolean(p.safe_to_execute),
    action: {
      type,
      reason: agentCoreText(action.reason, 2500),
      message: agentCoreText(action.message, 6500),
      wait_until: agentCoreText(action.wait_until, 300),
      task_title: agentCoreText(action.task_title, 800),
      responsible_role: ['expert','leader','none'].includes(String(action.responsible_role || ''))
        ? String(action.responsible_role)
        : 'none',
    },
  };
}

async function agentCoreThink(context) {
  if (config && config.aiEnabled === false) {
    throw new Error('AI_ENABLED=false — Agent Core не может принять решение.');
  }
  if (typeof callAiChatCompletion !== 'function') {
    throw new Error('В текущем server.js не найдена функция callAiChatCompletion().');
  }

  const rawText = await callAiChatCompletion({
    model: (config && config.aiModel) || process.env.AI_MODEL,
    temperature: 0.12,
    messages: [
      { role: 'system', content: agentCoreSystemPrompt() },
      {
        role: 'user',
        content:
          'Сейчас: ' + new Date().toISOString() + '\n' +
          'Проанализируй сделку целиком. Не следуй таймерам старого CJM. Выбери только ОДИН следующий шаг.\n\n' +
          'КОНТЕКСТ:\n' + clipText(JSON.stringify(context, null, 2), 60000),
      },
    ],
  });

  const parsed = safeJsonParse(rawText);
  if (!parsed) throw new Error('Agent Core: модель вернула невалидный JSON.');
  return agentCoreNormalizeDecision(parsed);
}

async function agentCoreAddComment(dealId, text) {
  return bitrixRestCall('crm.timeline.comment.add', {
    fields: {
      ENTITY_ID: dealId,
      ENTITY_TYPE: 'deal',
      COMMENT: text,
    },
  });
}

function agentCoreActionKey(context, decision) {
  const a = decision.action || {};
  const source =
    String(context.deal.id) + '|' +
    String(a.type || '') + '|' +
    String(a.message || '') + '|' +
    String(a.wait_until || '') + '|' +
    String(context.freshness.lastTimelineId || '') + '|' +
    String(context.freshness.lastActivityId || '') + '|' +
    String(context.freshness.dealModified || '');
  return agentCoreHash(source);
}

async function agentCoreWasActionExecuted(dealId, actionKey) {
  const rows = await bitrixRestList('crm.timeline.comment.list', {
    filter: { ENTITY_ID: dealId, ENTITY_TYPE: 'deal' },
    order: { ID: 'DESC' },
    select: ['ID','COMMENT','CREATED'],
  }, 100).catch(() => []);
  const needle = AGENT_CORE_ACTION_MARKER + ' key=' + actionKey;
  return rows.some((r) => String(r && (r.COMMENT || r.comment) || '').includes(needle));
}

async function agentCoreCreateTask(deal, decision, role) {
  const a = decision.action || {};
  const responsibleId =
    role === 'leader'
      ? String(
          process.env.AGENT_CORE_LEADER_ID ||
          config.executorLeaderId ||
          config.clientDocsLeaderId ||
          config.actsIncomingLeaderId ||
          '2182'
        )
      : String(deal.ASSIGNED_BY_ID || '');

  if (!responsibleId) throw new Error('Agent Core: не найден ответственный для задачи.');

  const titleBase = a.task_title || (
    role === 'leader'
      ? 'Нужна помощь по сделке ' + deal.ID
      : 'Следующий шаг по сделке ' + deal.ID
  );

  const deadline = a.wait_until && !Number.isNaN(Date.parse(a.wait_until))
    ? new Date(a.wait_until).toISOString()
    : undefined;

  const fields = {
    TITLE: '[MAVIS_AGENT_CORE] ' + titleBase,
    DESCRIPTION:
      (a.message || a.reason || decision.situation) +
      '\n\nРешение ИИгоря: ' + (a.reason || '') +
      '\nСделка: #' + deal.ID,
    RESPONSIBLE_ID: Number(responsibleId),
    UF_CRM_TASK: ['D_' + deal.ID],
    PRIORITY: role === 'leader' ? 2 : 1,
  };
  if (deadline) fields.DEADLINE = deadline;

  return bitrixRestCall('tasks.task.add', { fields });
}

async function agentCoreExecute(context, decision) {
  const dealId = String(context.deal.id || '');

  if (!AGENT_CORE_ALLOW_EXECUTE) {
    return { executed: false, reason: 'AGENT_CORE_ALLOW_EXECUTE=false' };
  }
  if (dealId !== String(AGENT_CORE_TEST_DEAL_ID)) {
    return { executed: false, reason: 'Действия пилота разрешены только для test deal ' + AGENT_CORE_TEST_DEAL_ID };
  }
  if (!decision.safe_to_execute) {
    return { executed: false, reason: 'Модель не считает действие безопасным.' };
  }
  if (Number(decision.confidence || 0) < AGENT_CORE_MIN_CONFIDENCE) {
    return {
      executed: false,
      reason:
        'Недостаточная уверенность: ' + decision.confidence +
        ' < ' + AGENT_CORE_MIN_CONFIDENCE,
    };
  }

  const action = decision.action || {};
  const actionKey = agentCoreActionKey(context, decision);
  if (await agentCoreWasActionExecuted(dealId, actionKey)) {
    return { executed: false, duplicate: true, actionKey, reason: 'Точно такое действие уже выполнено в этом состоянии сделки.' };
  }

  const freshDeal = await bitrixRestCall('crm.deal.get', { id: dealId });
  if (!freshDeal || !freshDeal.ID) throw new Error('Перед выполнением действия сделка исчезла/недоступна.');

  // Защита от гонки: если сделка поменялась после анализа — внешнее действие не выполняем.
  if (
    context.freshness.dealModified &&
    freshDeal.DATE_MODIFY &&
    String(context.freshness.dealModified) !== String(freshDeal.DATE_MODIFY)
  ) {
    return {
      executed: false,
      stale: true,
      actionKey,
      reason: 'Сделка изменилась после анализа. Нужен новый запуск Agent Core.',
    };
  }

  let result = null;

  if (action.type === 'none') {
    return { executed: false, actionKey, reason: 'Agent Core решил ничего не делать.' };
  }

  if (action.type === 'wait') {
    const marker =
      AGENT_CORE_ACTION_MARKER + ' key=' + actionKey + '\n' +
      'Решение: ждать.' +
      (action.wait_until ? '\nВернуться к ситуации: ' + action.wait_until : '') +
      '\nПричина: ' + (action.reason || decision.situation);
    await agentCoreAddComment(dealId, marker);
    return {
      executed: true,
      action: 'wait',
      actionKey,
      waitUntil: action.wait_until || '',
      note: 'v127 фиксирует план ожидания в Bitrix. Автоматическое пробуждение по wait_until подключим после теста решений.',
    };
  }

  if (action.type === 'add_internal_comment') {
    if (!action.message) throw new Error('Agent Core выбрал add_internal_comment, но текст пуст.');
    await agentCoreAddComment(
      dealId,
      AGENT_CORE_ACTION_MARKER + ' key=' + actionKey + '\n' + action.message
    );
    return { executed: true, action: 'add_internal_comment', actionKey };
  }

  if (action.type === 'create_task') {
    result = await agentCoreCreateTask(freshDeal, decision, 'expert');
    await agentCoreAddComment(
      dealId,
      AGENT_CORE_ACTION_MARKER + ' key=' + actionKey + '\n' +
      'Создана задача ответственному эксперту.\nПричина: ' + (action.reason || decision.situation)
    ).catch(() => {});
    return {
      executed: true,
      action: 'create_task',
      actionKey,
      taskId:
        result && result.task && (result.task.id || result.task.ID)
          ? String(result.task.id || result.task.ID)
          : '',
    };
  }

  if (action.type === 'escalate_human') {
    result = await agentCoreCreateTask(freshDeal, decision, 'leader');
    await agentCoreAddComment(
      dealId,
      AGENT_CORE_ACTION_MARKER + ' key=' + actionKey + '\n' +
      'Ситуация передана руководителю.\nПричина: ' + (action.reason || decision.situation)
    ).catch(() => {});
    return {
      executed: true,
      action: 'escalate_human',
      actionKey,
      taskId:
        result && result.task && (result.task.id || result.task.ID)
          ? String(result.task.id || result.task.ID)
          : '',
    };
  }

  if (action.type === 'send_client_message') {
    if (!AGENT_CORE_ALLOW_CLIENT_SEND) {
      return { executed: false, actionKey, reason: 'AGENT_CORE_ALLOW_CLIENT_SEND=false' };
    }
    if (!action.message) throw new Error('Agent Core решил написать клиенту, но сообщение пустое.');

    if (typeof sendClientTextByPreferredChannel !== 'function') {
      throw new Error('В server.js не найдена sendClientTextByPreferredChannel().');
    }

    const sent = await sendClientTextByPreferredChannel(
      freshDeal,
      action.message,
      'Сообщение по услуге'
    );

    if (sent && sent.ok === false) {
      throw new Error('Отправка клиенту не выполнена: ' + (sent.error || sent.message || 'неизвестная причина'));
    }

    await agentCoreAddComment(
      dealId,
      AGENT_CORE_ACTION_MARKER + ' key=' + actionKey + '\n' +
      'ИИгорь самостоятельно отправил клиенту сообщение через предпочитаемый канал.\n' +
      'Причина решения: ' + (action.reason || decision.situation)
    );

    return {
      executed: true,
      action: 'send_client_message',
      actionKey,
      channel: context.deal.preferredChannel || '',
      sendResult: sent || null,
    };
  }

  return { executed: false, actionKey, reason: 'Неизвестное действие ' + String(action.type || '') };
}

async function agentCoreRun(dealId, executeRequested) {
  const context = await agentCoreCollectContext(dealId);
  const decision = await agentCoreThink(context);

  // Сохраняем короткую диагностическую запись о решении, но без скрытых рассуждений.
  const decisionSummary =
    AGENT_CORE_THOUGHT_MARKER + '\n' +
    'Ситуация: ' + decision.situation + '\n' +
    'Следующий шаг: ' + decision.action.type + '\n' +
    'Причина: ' + decision.action.reason + '\n' +
    'Уверенность: ' + decision.confidence +
    (decision.missing_context.length
      ? '\nНе хватает контекста: ' + decision.missing_context.join('; ')
      : '');

  await agentCoreAddComment(dealId, decisionSummary).catch((e) => {
    console.warn('[agent-core] не смог сохранить summary решения: ' + (e.message || e));
  });

  const execution = executeRequested
    ? await agentCoreExecute(context, decision)
    : { executed: false, reason: 'observe-only request' };

  console.log(
    '[agent-core] deal=' + dealId +
    '; action=' + decision.action.type +
    '; safe=' + decision.safe_to_execute +
    '; confidence=' + decision.confidence +
    '; executeRequested=' + executeRequested +
    '; executed=' + Boolean(execution && execution.executed)
  );

  return {
    ok: true,
    version: AGENT_CORE_VERSION,
    mode: executeRequested ? 'execute' : 'observe',
    testDealId: AGENT_CORE_TEST_DEAL_ID,
    decision,
    execution,
    contextSummary: {
      deal: context.deal,
      company: context.company,
      contact: context.contact,
      contextQuality: context.contextQuality,
      freshness: context.freshness,
      timelineItems: context.timeline.length,
      activityItems: context.activities.length,
      taskItems: context.tasks.length,
    },
  };
}

app.get('/api/agent-core/status', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    ok: true,
    version: AGENT_CORE_VERSION,
    testDealId: AGENT_CORE_TEST_DEAL_ID,
    allowExecute: AGENT_CORE_ALLOW_EXECUTE,
    allowClientSend: AGENT_CORE_ALLOW_CLIENT_SEND,
    minConfidence: AGENT_CORE_MIN_CONFIDENCE,
    actions: ['none','wait','send_client_message','add_internal_comment','create_task','escalate_human'],
    note: 'Реальные действия v127 физически ограничены test deal.',
  });
});

app.post('/api/agent-core/run/:dealId', async (req, res) => {
  try {
    const dealId = String(req.params.dealId || '').replace(/\D/g, '');
    if (!dealId) return res.status(400).json({ ok: false, error: 'dealId не указан' });

    if (dealId !== String(AGENT_CORE_TEST_DEAL_ID)) {
      return res.status(403).json({
        ok: false,
        error: 'Agent Core v127 разрешён только для test deal ' + AGENT_CORE_TEST_DEAL_ID + '.',
      });
    }

    const rawExecute =
      req.query.execute !== undefined
        ? req.query.execute
        : (req.body && req.body.execute !== undefined ? req.body.execute : '1');

    const executeRequested =
      ['1','true','yes','on'].includes(String(rawExecute).toLowerCase());

    const result = await agentCoreRun(dealId, executeRequested);
    res.json(result);
  } catch (e) {
    console.error('[agent-core] ' + (e.message || e));
    res.status(500).json({
      ok: false,
      version: AGENT_CORE_VERSION,
      error: e.message || String(e),
    });
  }
});

console.log(
  '[agent-core] ' + AGENT_CORE_VERSION +
  '; testDeal=' + AGENT_CORE_TEST_DEAL_ID +
  '; allowExecute=' + AGENT_CORE_ALLOW_EXECUTE +
  '; allowClientSend=' + AGENT_CORE_ALLOW_CLIENT_SEND +
  '; minConfidence=' + AGENT_CORE_MIN_CONFIDENCE
);
