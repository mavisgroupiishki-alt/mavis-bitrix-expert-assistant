# v51 — ИИгорь через роботов Bitrix

Добавлены два endpoint для роботов CRM:

1. `/api/foreman/robot-linked` — запускать, когда в производственной сделке заполнено поле `Специалист`.
   Делает: переводит сделку прораба в `Занят`, пишет комментарий в сделку прораба, проставляет этого же прораба во все активные сделки этой компании, где поле специалист пустое.

2. `/api/foreman/robot-closed` — запускать на успешной стадии производства.
   Делает: проверяет, есть ли еще активные сделки с этим прорабом. Если нет — переводит его в `Свободен` или `Аттестат заканчивается` по дате аттестата.

Рекомендуемые env:

```
FOREMAN_CATEGORY_ID=32
FOREMAN_STAGE_FREE=C32:PREPARATION
FOREMAN_STAGE_BUSY=C32:PREPAYMENT_INVOIC
FOREMAN_STAGE_CERT_EXPIRING=C32:EXECUTING
FOREMAN_PRODUCTION_SPECIALIST_FIELD=UF_CRM_1784528226
FOREMAN_PROPAGATE_TO_COMPANY_DEALS=true
FOREMAN_AUTOMATION_ENABLED=false
```

Опционально можно добавить секрет для роботов:

```
FOREMAN_ROBOT_TOKEN=любой_секрет
```

Тогда в URL робота добавлять `?token=секрет` или передавать `token` в body.
