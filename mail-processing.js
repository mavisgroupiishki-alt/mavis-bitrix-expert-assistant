'use strict';

// IMAP keyword хранит факт обработки отдельно от флага «прочитано».
// Эксперты продолжают видеть письмо как непрочитанное, а polling не создаёт дубли.
const MAIL_PROCESSED_KEYWORD = '$MAVISProcessed';

function unreadUnprocessedMailSearch() {
  return { seen: false, unKeyword: MAIL_PROCESSED_KEYWORD };
}

async function markMailProcessedAndUnread(client, uid, { durableProcessedMarker = false } = {}) {
  try {
    const markerAdded = await client.messageFlagsAdd(uid, [MAIL_PROCESSED_KEYWORD]);
    if (markerAdded === false) throw new Error('IMAP сервер не сохранил пользовательскую метку');
    const unreadRestored = await client.messageFlagsRemove(uid, ['\\Seen']);
    if (unreadRestored === false) throw new Error('IMAP сервер не снял флаг \\Seen');
    return { keptUnread: true };
  } catch (error) {
    // Некоторые почтовые серверы (в том числе текущий) не поддерживают
    // пользовательские IMAP-метки. Если факт обработки уже сохранён в CRM,
    // оставляем письмо непрочитанным: при следующем проходе его защитит CRM-маркер.
    if (durableProcessedMarker) {
      try {
        const unreadRestored = await client.messageFlagsRemove(uid, ['\\Seen']);
        if (unreadRestored === false) throw new Error('IMAP сервер не снял флаг \\Seen');
        console.warn(`[email] IMAP-метка ${MAIL_PROCESSED_KEYWORD} не поддерживается; письмо оставлено непрочитанным, обработка защищена CRM-маркером.`);
        return { keptUnread: true, durableProcessedMarker: true };
      } catch (restoreError) {
        console.warn(`[email] Не удалось снять флаг \\Seen после отказа IMAP-метки: ${restoreError.message || restoreError}`);
      }
    }

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
