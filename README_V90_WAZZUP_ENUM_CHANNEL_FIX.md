# v90 — исправление SEND_PENDING для Хода работы

Причина: поле «Предпочитаемый канал связи» в Bitrix хранится как enum ID. Внешняя логика правильно расшифровывала его через `detectPreferredChannelResolved()`, но внутренняя проверка `sendWazzupMessageInternal()` повторно использовала сырой `detectPreferredChannel()` и блокировала отправку Viber/Telegram как «канал не распознан».

Исправлено:
- строгая проверка канала теперь тоже использует `detectPreferredChannelResolved()`;
- явный Viber больше никогда не подменяется Telegram и наоборот;
- `SEND_PENDING` по Бобику должен уйти при следующем цикле без ручного движения сделки.
