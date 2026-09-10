# Технический план: Надёжная отправка актов и чистая CRM лента

**Спека:** [spec.md](spec.md)  **Создан:** 2026-09-10

## Технологии

Node.js 18, Express, Bitrix REST и Wazzup API. Новые зависимости не требуются.

## Архитектура

`actsHandleTaskDone` получает процессный lock по `taskId:dealId`, затем вызывает delivery. Delivery строит упорядоченную цепочку `preferred -> fallback` и завершает её после первой подтверждённой доставки. CRM cleanup использует Bitrix timeline API и только заранее определённые сигнатуры технических сообщений; route по умолчанию только показывает план.

## API / Интерфейсы

- `actsDeliveryChannelPlan(preferredChannel) -> string[]`: возвращает fallback-цепочку без дополнительной копии.
- `actsAcquireSendLock(taskId, dealId) -> (() => void) | null`: защищает конкурентные robot/poll вызовы в одном инстансе.
- `POST /api/maintenance/production-comment-cleanup`: dry-run по умолчанию; `execute=true` и `Authorization: Bearer <ACTS_MAINTENANCE_TOKEN>` удаляют только проверенные технические комментарии.

## Ресурсы по блокам

| Блок | Модель | Скиллы | Агенты | Обоснование модели |
|---|---|---|---|---|
| Анализ дублей | frontier/high | systematic-debugging, code-review | code-reviewer, architect | Риск внешних сообщений и CRM данных |
| Изменение доставки | balanced/medium | verification-before-completion | — | Изолированная Node.js логика |
| Cleanup route | balanced/medium | systematic-debugging | — | Ограниченное destructive действие с dry-run |

## Риски

- Ответ Wazzup 5xx может означать доставленное сообщение; fallback в этом случае запрещён.
- Внутренние маркеры используются для восстановления состояния, поэтому cleanup удаляет только сообщения, признанные техническими целиком, а не все маркеры.
- Процессный lock не синхронизирует несколько Render-инстансов; для мультиинстансного запуска потребуется внешнее хранилище/atomic claim.

## Проверка конституции

- [ ] Принцип I: получатели берутся только из привязок сделки.
- [ ] Принцип II: одна delivery цепочка, no fallback после неопределённой отправки.
- [ ] Принцип III: cleanup имеет preview, scope и токен.
