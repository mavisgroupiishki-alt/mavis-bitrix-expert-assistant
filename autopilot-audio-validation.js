'use strict';

function normalizedContentType(contentType) {
  return String(contentType || '').split(';', 1)[0].trim().toLowerCase();
}

function hasAudioContainerSignature(buffer) {
  const bytes = Buffer.from(buffer || []);
  if (bytes.length < 4) return false;
  if (bytes.subarray(0, 3).toString('ascii') === 'ID3') return true;
  if (bytes[0] === 0xff && [0xfb, 0xf3, 0xf2].includes(bytes[1])) return true;
  if (bytes.subarray(0, 4).toString('ascii') === 'OggS') return true;
  if (bytes.subarray(0, 4).toString('ascii') === 'fLaC') return true;
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WAVE') return true;
  if (bytes.subarray(4, 8).toString('ascii') === 'ftyp') return true;
  return false;
}

function nonAudioPayloadReason(buffer) {
  const bytes = Buffer.from(buffer || []);
  const head = bytes.subarray(0, 512);
  const text = head.toString('utf8').trimStart().toLowerCase();
  if (/^(?:<!doctype|<html|<\?xml|\{\s*\"|\[\s*\")/.test(text)) return 'текстовое содержимое';
  if (head.subarray(0, 4).toString('ascii') === '%PDF') return 'PDF-документ';
  if (head.subarray(0, 4).toString('ascii') === 'PK\x03\x04') return 'архив или офисный документ';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'изображение PNG';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'изображение JPEG';
  return '';
}

function inspectAudioPayload(contentType, buffer) {
  const type = normalizedContentType(contentType);
  if (/^(?:text\/|image\/|application\/(?:json|pdf|zip|x-zip-compressed|msword|vnd\.openxmlformats-officedocument\.)|multipart\/)/.test(type)) {
    return { ok: false, reason: `content-type=${type || 'unknown'}` };
  }
  const nonAudioReason = nonAudioPayloadReason(buffer);
  if (nonAudioReason) return { ok: false, reason: nonAudioReason };
  if (/^(?:audio\/|video\/)/.test(type) || hasAudioContainerSignature(buffer)) return { ok: true };
  return { ok: false, reason: `неизвестный формат (${type || 'без content-type'})` };
}

// A successful STT request, even one with an empty transcript, proves that the
// current URL was an audio candidate. Do not fan out to alternate download URLs:
// Bitrix may expose the same file through several links and multiply STT calls.
function shouldTryAlternateAudioUrl(sttRequestSucceeded) {
  return !sttRequestSucceeded;
}

module.exports = { inspectAudioPayload, shouldTryAlternateAudioUrl };
