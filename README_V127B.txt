Исправленный patcher v127b.

Причина предыдущей ошибки:
patcher записал в server.js буквальные символы \n вместо реального перевода строки рядом с isAgentCoreTask.
Node поэтому увидел `;\n const...` как недопустимый JavaScript.

v127b:
- сначала собирает будущий server.js только в памяти;
- проверяет временную копию через `node --check`;
- только если всё успешно — создаёт backup и меняет настоящий server.js;
- при ошибке текущий server.js вообще не трогает.

Запуск:

cd ~/Downloads
unzip -o v127b_agent_core_actions_bobik.zip
node --check apply_v127b_agent_core.js
node apply_v127b_agent_core.js server.js

После успеха:
grep -n "MAVIS_AGENT_CORE_V127" server.js
grep -n "isAgentCoreTask" server.js
grep -n "api/agent-core/status" server.js
node --check server.js
