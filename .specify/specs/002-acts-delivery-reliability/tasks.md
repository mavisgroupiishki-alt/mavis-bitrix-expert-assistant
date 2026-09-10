# Задачи: Надёжная отправка актов и чистая CRM лента

## Группа 1: Дубликаты доставки

- [x] T001 Написать unit-тесты порядка каналов и lock (файл: `test/acts-delivery.test.js`) | balanced/medium | скилл: systematic-debugging | агент: —
- [x] T002 Выделить testable delivery helpers и заменить email-copy на fallback-цепочку (файл: `acts-delivery.js`, `server.js`) | balanced/medium | скилл: verification-before-completion | агент: —
- [x] T003 Добавить процессный lock task/deal в обработчик акта (файл: `server.js`) | balanced/medium | скилл: systematic-debugging | агент: —

## Контрольная точка 1

Проверить: подтверждённый Telegram/Viber не вызывает email, неуспех вызывает следующий канал, второй конкурентный вызов не отправляет акт.

## Группа 2: CRM шум и историческая очистка

- [x] T004 Сохранить устойчивый признак итогового отчёта автопилота и не писать повторяющийся transport-error как комментарий (файл: `server.js`) | balanced/medium | скилл: systematic-debugging | агент: —
- [x] T005 Добавить защищённый dry-run/execute cleanup с фильтром category 28 и allowlist технических комментариев (файл: `server.js`) | balanced/medium | скилл: verification-before-completion | агент: —

## Контрольная точка 2

Проверить: cleanup без execute ничего не меняет; execute требует токен; обычный комментарий не попадает в кандидаты.

## Группа 3: Проверка

- [x] T006 Запустить `node --test`, `node --check server.js`, просмотреть git diff (файлы: все изменённые) | fast/low | скилл: verification-before-completion | агент: —
