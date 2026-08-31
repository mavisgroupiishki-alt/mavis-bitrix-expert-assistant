#!/usr/bin/env node
'use strict';

const fs = require('fs');
const cp = require('child_process');
const path = require('path');

const serverPath = path.resolve(process.argv[2] || 'server.js');
const insertPath = path.join(__dirname, 'agent_core_v127_insert.js');

function fail(msg, code = 3) {
  console.error(msg);
  process.exit(code);
}

if (!fs.existsSync(serverPath)) fail('❌ Не найден server.js: ' + serverPath, 2);
if (!fs.existsSync(insertPath)) fail('❌ Не найден agent_core_v127_insert.js рядом с patcher.', 2);

const diskOriginal = fs.readFileSync(serverPath, 'utf8');
let work = diskOriginal;

if (work.includes('MAVIS_AGENT_CORE_V127')) {
  console.log('ℹ️ Agent Core v127 уже установлен. Повторно ничего не меняю.');
  process.exit(0);
}

// 1) Удаляем старый v126/v126b только в рабочей копии.
// При любой ошибке исходный server.js вообще не трогаем.
if (work.includes('MAVIS_AGENT_CORE_V126')) {
  const oldMarker = work.indexOf('// MAVIS_AGENT_CORE_V126');
  const sectionStart = work.lastIndexOf('// ============================================================================', oldMarker);
  const listenIndex = work.indexOf('app.listen(PORT, () => {', oldMarker);

  if (sectionStart >= 0 && listenIndex > sectionStart) {
    work = work.slice(0, sectionStart) + work.slice(listenIndex);
    console.log('ℹ️ Старый Agent Core v126 найден и будет заменён на v127.');
  } else {
    fail('❌ Нашёл v126, но не смог безопасно определить его границы. server.js не изменён.');
  }
}

// 2) Добавляем Agent Core tasks в существующий safety-gate.
// ВАЖНО: здесь реальные переводы строк, а не текст "\\n".
const agentTaskLine = "const isAgentCoreTask = /^\\[MAVIS_AGENT_CORE\\]/i.test(title);";
if (!work.includes(agentTaskLine)) {
  const anchor = "const isCoreAssistantTask = /^Распредели сделку:/i.test(title)";
  const anchorIndex = work.indexOf(anchor);
  if (anchorIndex < 0) {
    fail('❌ Не найден isCoreAssistantTask в текущем server.js. server.js не изменён.');
  }

  const lineStart = work.lastIndexOf('\n', anchorIndex) + 1;
  const indentMatch = work.slice(lineStart, anchorIndex).match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : '';

  work =
    work.slice(0, lineStart) +
    indent + agentTaskLine + '\n' +
    work.slice(lineStart);

  const oldGate = "if (!isForemanTask && !isActsTask && !isCoreAssistantTask) {";
  const gateIndex = work.indexOf(oldGate, anchorIndex);
  if (gateIndex < 0) {
    fail('❌ Не найден safety-gate tasks.task.add. server.js не изменён.');
  }

  const newGate =
    "if (!isForemanTask && !isActsTask && !isCoreAssistantTask && !isAgentCoreTask) {";

  work =
    work.slice(0, gateIndex) +
    newGate +
    work.slice(gateIndex + oldGate.length);
}

// 3) Вставляем v127 перед app.listen.
const marker = 'app.listen(PORT, () => {';
const idx = work.indexOf(marker);
if (idx < 0) fail('❌ Не найден app.listen(PORT, () => {. server.js не изменён.');

const insert = fs.readFileSync(insertPath, 'utf8');
work = work.slice(0, idx) + '\n' + insert + '\n' + work.slice(idx);

// 4) Сначала проверяем ВРЕМЕННЫЙ файл. Реальный server.js ещё не изменён.
const tempPath = serverPath + '.v127b.syntax-test.tmp.js';
fs.writeFileSync(tempPath, work, 'utf8');

const syntax = cp.spawnSync(process.execPath, ['--check', tempPath], { encoding: 'utf8' });
try { fs.unlinkSync(tempPath); } catch (_) {}

if (syntax.status !== 0) {
  console.error('❌ Проверка будущего server.js не прошла. Текущий server.js НЕ ИЗМЕНЁН.');
  console.error(syntax.stderr || syntax.stdout || '');
  process.exit(4);
}

// 5) Только после успешной проверки создаём backup и заменяем server.js.
const backupPath = serverPath + '.before_agent_core_v127b.bak';
fs.writeFileSync(backupPath, diskOriginal, 'utf8');
fs.writeFileSync(serverPath, work, 'utf8');

// 6) Финальная проверка уже фактического файла.
const finalCheck = cp.spawnSync(process.execPath, ['--check', serverPath], { encoding: 'utf8' });
if (finalCheck.status !== 0) {
  fs.writeFileSync(serverPath, diskOriginal, 'utf8');
  console.error('❌ Финальная проверка неожиданно не прошла. Исходный server.js восстановлен.');
  console.error(finalCheck.stderr || finalCheck.stdout || '');
  process.exit(5);
}

console.log('✅ Agent Core v127 установлен.');
console.log('✅ Старый v126 заменён, если он был.');
console.log('✅ Safety-gate задач Agent Core подключён.');
console.log('✅ Backup: ' + backupPath);
console.log('✅ node --check server.js: OK');
console.log('');
console.log('Теперь проверь:');
console.log('grep -n "MAVIS_AGENT_CORE_V127" server.js');
console.log('grep -n "isAgentCoreTask" server.js');
console.log('grep -n "api/agent-core/status" server.js');
