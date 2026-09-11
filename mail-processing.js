'use strict';

// IMAP keyword хранит факт обработки отдельно от флага «прочитано».
// Эксперты продолжают видеть письмо как непрочитанное, а polling не создаёт дубли.
const MAIL_PROCESSED_KEYWORD = '$MAVISProcessed';

function unreadUnprocessedMailSearch() {
  return { seen: false, unKeyword: MAIL_PROCESSED_KEYWORD };
}

async function markMailProcessedAndUnread(client, uid) {
  try {
    const markerAdded = await client.messageFlagsAdd(uid, [MAIL_PROCESSED_KEYWORD]);
    if (markerAdded === false) throw new Error('IMAP сервер не сохранил пользовательскую метку');
    const unreadRestored = await client.messageFlagsRemove(uid, ['\\Seen']);
    if (unreadRestored === false) throw new Error('IMAP сервер не снял флаг \\Seen');
    return { keptUnread: true };
  } catch (error) {
    // Без устойчивой серверной метки нельзя оставлять письмо непрочитанным: polling
    // обработает его снова и создаст дубли в CRM. Сохраняем прежнее безопасное поведение.
    await client.messageFlagsAdd(uid, ['\\Seen']);
    console.warn(`[email] Не удалось сохранить IMAP-метку ${MAIL_PROCESSED_KEYWORD}; письмо помечено прочитанным, чтобы не создать дубли: ${error.message || error}`);
    return { keptUnread: false };
  }
}

module.exports = {
  MAIL_PROCESSED_KEYWORD,
  markMailProcessedAndUnread,
  unreadUnprocessedMailSearch,
};
