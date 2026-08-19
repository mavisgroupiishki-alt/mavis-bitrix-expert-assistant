# v72 — диагностика входящих Wazzup

- Логирует каждый POST Wazzup до фильтрации: число messages, status/type/chatType, известность channelId, наличие contentUri и состояние Authorization без вывода секретов.
- Исправляет молчаливое отбрасывание входящих файлов при несовпадении WAZZUP_CRM_KEY.
- При несовпадении Authorization разрешает обработку только безопасного inbound image/document с настроенного channelId и contentUri на домене wazzup24.com.
- Остальная логика v71 сохранена.
