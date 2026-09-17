'use strict';

// Стандартный системный IMAP-флаг поддерживается mail.ru, в отличие от
// пользовательских keyword-меток. Он отделяет факт обработки от «прочитано».
const MAIL_PROCESSED_FLAG = '\\Answered';

function unreadUnprocessedMailSearch() {
  return { seen: false, answered: false };
}

async function markMailProcessedAndUnread(client, uid, { durableProcessedMarker = false } = {}) {
  try {
    const markerAdded = await client.messageFlagsAdd(uid, [MAIL_PROCESSED_FLAG]);
    if (markerAdded === false) throw new Error(`IMAP сервер не сохранил флаг ${MAIL_PROCESSED_FLAG}`);
    const unreadRestored = await client.messageFlagsRemove(uid, ['\\Seen']);
    if (unreadRestored === false) throw new Error('IMAP сервер не снял флаг \\Seen');
    return { keptUnread: true };
  } catch (error) {
    // Если даже стандартный IMAP-флаг недоступен, оставляем письмо непрочитанным
    // только при уже сохранённом CRM-маркере: он не допустит повторный импорт.
    if (durableProcessedMarker) {
      try {
        const unreadRestored = await client.messageFlagsRemove(uid, ['\\Seen']);
        if (unreadRestored === false) throw new Error('IMAP сервер не снял флаг \\Seen');
        console.warn(`[email] IMAP-флаг ${MAIL_PROCESSED_FLAG} не поддерживается; письмо оставлено непрочитанным, обработка защищена CRM-маркером.`);
        return { keptUnread: true, durableProcessedMarker: true };
      } catch (restoreError) {
        console.warn(`[email] Не удалось снять флаг \\Seen после отказа IMAP-метки: ${restoreError.message || restoreError}`);
      }
    }

    // Без устойчивой серверной метки нельзя оставлять письмо непрочитанным: polling
    // обработает его снова и создаст дубли в CRM. Сохраняем прежнее безопасное поведение.
    await client.messageFlagsAdd(uid, ['\\Seen']);
    console.warn(`[email] Не удалось сохранить IMAP-флаг ${MAIL_PROCESSED_FLAG}; письмо помечено прочитанным, чтобы не создать дубли: ${error.message || error}`);
    return { keptUnread: false };
  }
}

module.exports = {
  MAIL_PROCESSED_FLAG,
  markMailProcessedAndUnread,
  unreadUnprocessedMailSearch,
};
