'use strict';

function bitrixEmailSenderSettings({ staff, emailFrom, emailSenderName }) {
  const configuredFrom = String(emailFrom || '').trim();
  const staffEmail = String((staff && staff.EMAIL) || '').trim();
  const from = configuredFrom || staffEmail;
  if (!from) return null;

  const staffName = staff
    ? `${staff.NAME || ''} ${staff.LAST_NAME || ''}`.trim()
    : '';
  const configuredName = String(emailSenderName || '').trim();
  const senderName = configuredFrom
    ? (configuredName || staffName || 'MAVIS GROUP')
    : (staffName || configuredName || 'MAVIS GROUP');
  return { MESSAGE_FROM: `${senderName} <${from}>` };
}

function bitrixOutgoingEmailActivityFields({
  ownerId,
  responsibleId,
  contactId,
  recipientEntityType = 3,
  toEmail,
  subject,
  description,
  settings,
  storageElementIds = [],
}) {
  if (!settings || !settings.MESSAGE_FROM) {
    throw new Error('Не задан отправитель письма.');
  }

  const fields = {
    TYPE_ID: 4,
    SUBJECT: subject,
    DESCRIPTION: description,
    DESCRIPTION_TYPE: 1,
    DIRECTION: 2,
    OWNER_TYPE_ID: 2,
    OWNER_ID: Number(ownerId),
    RESPONSIBLE_ID: Number(responsibleId),
    COMPLETED: 'Y',
    SETTINGS: settings,
    COMMUNICATIONS: [{
      VALUE: toEmail,
      ENTITY_ID: Number(contactId || 0),
      ENTITY_TYPE_ID: Number(recipientEntityType || 3),
      TYPE: 'EMAIL',
    }],
  };
  if (Array.isArray(storageElementIds) && storageElementIds.length) {
    fields.STORAGE_TYPE_ID = 3;
    fields.STORAGE_ELEMENT_IDS = storageElementIds;
  }
  return fields;
}

module.exports = { bitrixEmailSenderSettings, bitrixOutgoingEmailActivityFields };
