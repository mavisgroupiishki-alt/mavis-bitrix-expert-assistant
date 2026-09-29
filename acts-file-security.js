'use strict';

function trustedBitrixFileUrl(rawUrl, { portalUrl, additionalHosts = '' } = {}) {
  try {
    const parsed = new URL(rawUrl);
    const portalHost = new URL(portalUrl).hostname.toLowerCase();
    const configuredHosts = String(additionalHosts)
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean);
    const host = parsed.hostname.toLowerCase();

    // Bitrix24 Disk can redirect a portal download to another HTTPS subdomain
    // of the same Bitrix24 zone. Keep the trust boundary inside bitrix24.by;
    // arbitrary redirect hosts still require explicit configuration.
    const isBitrix24BelarusHost = host === 'bitrix24.by' || host.endsWith('.bitrix24.by');
    return parsed.protocol === 'https:' && (
      host === portalHost ||
      isBitrix24BelarusHost ||
      configuredHosts.includes(host)
    );
  } catch (_) {
    return false;
  }
}

module.exports = { trustedBitrixFileUrl };
