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

module.exports = { bitrixEmailSenderSettings };
