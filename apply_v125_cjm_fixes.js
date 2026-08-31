#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const serverPath = path.resolve(process.argv[2] || 'server.js');
if (!fs.existsSync(serverPath)) {
  console.error(`❌ Не найден ${serverPath}`);
  console.error('Положите этот файл рядом с актуальным v125 server.js и запустите:');
  console.error('node apply_v125_cjm_fixes.js');
  process.exit(2);
}

const original = fs.readFileSync(serverPath, 'utf8');
let text = original;
const backupPath = serverPath + '.before_v125_cjm_fix.bak';

function replaceOnce(label, from, to) {
  const count = text.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`${label}: ожидалось ровно 1 совпадение, найдено ${count}. Ничего не записано.`);
  }
  text = text.replace(from, to);
  console.log(`✅ ${label}`);
}

function replaceAllRequired(label, from, to, minCount = 1) {
  const count = text.split(from).length - 1;
  if (count < minCount) {
    throw new Error(`${label}: ожидалось минимум ${minCount} совпадение(я), найдено ${count}. Ничего не записано.`);
  }
  text = text.split(from).join(to);
  console.log(`✅ ${label}: ${count} замен(ы)`);
}

try {
  // FIX 1: распределение — только подтверждённые эксперты.
  replaceOnce(
    'Блок 1: whitelist экспертов распределения',
    "distributionExpertIds: parseIdList(process.env.DISTRIBUTION_EXPERT_IDS),",
    "distributionExpertIds: parseIdList(process.env.DISTRIBUTION_EXPERT_IDS || '2052,1960,2192,2198'),"
  );

  // FIX 2: «Сбор информации» должен всегда входить в список стадий автопилота.
  const oldStageBlock = `  const result = [];
  if (expertStage) { result.push(expertStage.STATUS_ID); console.log(\`[autopilot] Стадия 1: "\${expertStage.NAME}" → \${expertStage.STATUS_ID}\`); }
  if (infoStage && infoStage !== prepStage) { result.push(infoStage.STATUS_ID); console.log(\`[autopilot] Стадия 2: "\${infoStage.NAME}" → \${infoStage.STATUS_ID}\`); }
  else if (prepStage && !expertStage) result.push(prepStage.STATUS_ID);`;

  const newStageBlock = `  const result = [];
  if (expertStage && !result.includes(expertStage.STATUS_ID)) {
    result.push(expertStage.STATUS_ID);
    console.log(\`[autopilot] Стадия 1: "\${expertStage.NAME}" → \${expertStage.STATUS_ID}\`);
  }
  if (infoStage && !result.includes(infoStage.STATUS_ID)) {
    result.push(infoStage.STATUS_ID);
    console.log(\`[autopilot] Стадия 2: "\${infoStage.NAME}" → \${infoStage.STATUS_ID}\`);
  } else if (prepStage && !result.includes(prepStage.STATUS_ID)) {
    result.push(prepStage.STATUS_ID);
    console.log(\`[autopilot] Стадия 2/fallback: "\${prepStage.NAME}" → \${prepStage.STATUS_ID}\`);
  }`;

  replaceOnce(
    'Блок 3/5: исправлена регистрация стадии «Сбор информации»',
    oldStageBlock,
    newStageBlock
  );

  // FIX 3: руководитель — не 7, а минимум 14 дней.
  replaceOnce(
    'Блок 5: эскалация руководителю минимум через 14 дней',
    "collectionLeaderDays: Number(process.env.COLLECTION_LEADER_DAYS || 7),",
    "collectionLeaderDays: Math.max(14, Number(process.env.COLLECTION_LEADER_DAYS || 14)),"
  );

  replaceOnce(
    'Блок 5: постоянная подпись 14 дней',
    "const COLLECTION_7D_TEXT = 'ИИгорь — контроль сбора информации: 7 дней.';",
    "const COLLECTION_14D_TEXT = 'ИИгорь — контроль сбора информации: 14 дней.';"
  );

  replaceAllRequired(
    'Блок 5: ссылки на подпись 14 дней',
    'COLLECTION_7D_TEXT',
    'COLLECTION_14D_TEXT',
    1
  );

  // Меняем только пользовательский текст в новом CJM-контуре, если он есть.
  if (text.includes('Сделка зависла на «Сбор информации» 7 дней.')) {
    replaceAllRequired(
      'Блок 5: текст эскалации 14 дней',
      'Сделка зависла на «Сбор информации» 7 дней.',
      'Сделка зависла на «Сбор информации» 14 дней.',
      1
    );
  }

  if (text.includes('3 дня клиенту / 7 дней руководителю')) {
    replaceAllRequired(
      'Блок 5: комментарий в коде 14 дней',
      '3 дня клиенту / 7 дней руководителю',
      '3 дня клиенту / 14 дней руководителю',
      1
    );
  }

  // Контроль, что критические изменения действительно присутствуют.
  const requiredChecks = [
    ["whitelist экспертов", "DISTRIBUTION_EXPERT_IDS || '2052,1960,2192,2198'"],
    ["Сбор информации добавляется в result", "if (infoStage && !result.includes(infoStage.STATUS_ID))"],
    ["14 дней", "Math.max(14, Number(process.env.COLLECTION_LEADER_DAYS || 14))"],
    ["подпись 14 дней", "COLLECTION_14D_TEXT"],
  ];
  for (const [label, needle] of requiredChecks) {
    if (!text.includes(needle)) throw new Error(`Контроль не пройден: ${label}`);
  }

  fs.writeFileSync(backupPath, original, 'utf8');
  fs.writeFileSync(serverPath, text, 'utf8');

  const syntax = cp.spawnSync(process.execPath, ['--check', serverPath], {
    encoding: 'utf8'
  });

  if (syntax.status !== 0) {
    fs.writeFileSync(serverPath, original, 'utf8');
    console.error('❌ node --check не прошёл. Исходный server.js восстановлен.');
    console.error(syntax.stderr || syntax.stdout || '');
    process.exit(3);
  }

  console.log('');
  console.log('✅ PATCH ПРИМЕНЁН УСПЕШНО');
  console.log(`✅ Backup: ${backupPath}`);
  console.log('✅ node --check: OK');
  console.log('');
  console.log('Что изменено:');
  console.log('1) Распределение рекомендует только whitelist 2052,1960,2192,2198.');
  console.log('2) «Сбор информации» теперь реально входит в polling автопилота.');
  console.log('3) Эскалация руководителю возвращена на минимум 14 дней.');
  console.log('4) Wazzup, акты, отчёт возврата оригиналов и остальные v125-блоки не изменялись.');
} catch (err) {
  console.error(`❌ ${err.message || err}`);
  console.error('Файл server.js НЕ изменён.');
  process.exit(1);
}
