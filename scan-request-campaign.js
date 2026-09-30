'use strict';

const SCAN_REQUEST_SENT_MARKER = '[MAVIS_SCAN_REQUEST_SENT]';
const SCAN_REQUEST_PENDING_MARKER = '[MAVIS_SCAN_REQUEST_PENDING]';
const SCAN_REQUEST_BLOCKED_MARKER = '[MAVIS_SCAN_REQUEST_BLOCKED]';

function normalizeScanRequestText(value) {
  return String(value || '')
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isScanRequestSeptember2026(value) {
  const raw = String(value || '').trim();
  // Bitrix returns ISO with +03:00; UTC conversion must not drop 1 September.
  if (/^\d{4}-\d{2}-\d{2}(?:[T\s]|$)/.test(raw)) {
    return /^2026-09-\d{2}(?:[T\s]|$)/.test(raw);
  }
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return false;
  const date = new Date(ms);
  return date.getUTCFullYear() === 2026 && date.getUTCMonth() === 8;
}

function isScanRequestExcludedStage(title) {
  const normalized = normalizeScanRequestText(title);
  return normalized === 'архив' || normalized === 'скан есть';
}

function scanRequestSentMarker(taskId) {
  return `${SCAN_REQUEST_SENT_MARKER} task=${String(taskId || '').trim()}`;
}

function scanRequestPendingMarker(taskId) {
  return `${SCAN_REQUEST_PENDING_MARKER} task=${String(taskId || '').trim()}`;
}

function scanRequestBlockedMarker(taskId) {
  return `${SCAN_REQUEST_BLOCKED_MARKER} task=${String(taskId || '').trim()}`;
}

function hasScanRequestSentMarker(comments, taskId) {
  const marker = scanRequestSentMarker(taskId);
  return (comments || []).some((comment) => String(comment || '').includes(marker));
}

function scanRequestState(comments, taskId) {
  if (hasScanRequestSentMarker(comments, taskId)) return 'sent';
  const joined = (comments || []).map((comment) => String(comment || '')).join('\n');
  if (joined.includes(scanRequestPendingMarker(taskId))) return 'pending';
  if (joined.includes(scanRequestBlockedMarker(taskId))) return 'blocked';
  return 'ready';
}

function scanRequestActNumber(title) {
  const match = String(title || '').match(/(?:^|\s)акт(?:\s+выполненных\s+работ)?\s*(?:№|n\.?|no\.?)?\s*(\d+)(?=\s|$|[.,;:()\-])/iu);
  return match ? match[1] : '';
}

function selectScanRequestActFile(files, title) {
  const actFiles = (files || []).filter((file) =>
    file && file.url && /акт|act/i.test(String(file.name || ''))
  );
  if (!actFiles.length) return { file: null, reason: 'act-file-not-found-in-task' };
  if (actFiles.length === 1) return { file: actFiles[0], reason: '' };

  const number = scanRequestActNumber(title);
  if (number) {
    const exact = actFiles.filter((file) => new RegExp(`(?:акт|act)\\s*(?:выполненных\\s+работ)?\\s*(?:№|n\\.?|no\\.?)?\\s*${number}(?=\\s|$|[.,;:()\\-])`, 'iu').test(String(file.name || '')));
    if (exact.length === 1) return { file: exact[0], reason: '' };
  }
  return { file: null, reason: 'ambiguous-act-files-in-task' };
}

module.exports = {
  SCAN_REQUEST_BLOCKED_MARKER,
  SCAN_REQUEST_PENDING_MARKER,
  SCAN_REQUEST_SENT_MARKER,
  hasScanRequestSentMarker,
  isScanRequestExcludedStage,
  isScanRequestSeptember2026,
  normalizeScanRequestText,
  scanRequestBlockedMarker,
  scanRequestPendingMarker,
  scanRequestState,
  scanRequestSentMarker,
  selectScanRequestActFile,
};
