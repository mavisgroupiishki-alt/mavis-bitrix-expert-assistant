# v55 — пушинг задач на сбор оригиналов актов

Что исправлено:

1. Добавлен отдельный обработчик:
   - GET/POST `/api/acts/robot-closed?deal_id={{ID}}`
2. Когда сделка производства закрыта успешно, ИИ создаёт задачу в проекте `Акты счета`.
3. Задача привязывается к CRM-сделке через `UF_CRM_TASK = D_<deal_id>`.
4. В задаче фиксируются компания, услуга, сумма, эксперт и ссылка на сделку.
5. Добавлена защита от дублей: по одной закрытой сделке повторную задачу не создаёт.
6. Если `SERVER_TASKS_ENABLED=false`, задачи на акты всё равно разрешены через `ACTS_TASKS_ENABLED=true`.

## Render Environment

Минимально:

```text
ACTS_TASKS_ENABLED=true
ACTS_PROJECT_ID=36
ACTS_RESPONSIBLE_ID=2182
PRODUCTION_CATEGORY_ID=28
SERVICE_FIELD_CODE=UF_CRM_1765113071
```

Необязательно:

```text
ACTS_COLLECTION_STAGE_ID=ID_стадии_сбора_если_знаем
ACTS_TASK_TITLE_PREFIX=СОБРАТЬ АКТ
ACTS_AUDITOR_IDS=2110,14
```

Если `ACTS_COLLECTION_STAGE_ID` пустой, задача просто создаётся в проекте. Потом можно вручную проверить, в какую колонку проекта Bitrix её кладёт.

## Bitrix business process / outgoing webhook

В воронке Производство создать БП/робота при изменении сделки:

Условие:
- Сделка закрыта = Да
- желательно стадия = Успешно

Исходящий вебхук / хендлер:

```text
https://mavis-bitrix-expert-assistant.onrender.com/api/acts/robot-closed?deal_id={{ID}}
```

## Проверка вручную

Открыть в браузере, подставив ID закрытой сделки:

```text
https://mavis-bitrix-expert-assistant.onrender.com/api/acts/robot-closed?deal_id=12345
```

Успешный ответ:

```json
{"ok":true,"event":"acts_collection_task_created","taskId":"..."}
```

Если задача уже была:

```json
{"ok":true,"duplicate":true,"message":"Задача на сбор акта уже есть, дубль не создаю."}
```
