'use strict';

// Base64 увеличивает тело запроса примерно на треть. Этот предел оставляет
// запас для JSON-пакета и не допускает 413 от AI-шлюза.
const VISION_MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;

function visionInputPolicy(buffer, fileName, contentType) {
  const ext = String(fileName || '').split('.').pop().toLowerCase();
  const type = String(contentType || '').split(';')[0].toLowerCase();
  const size = Buffer.isBuffer(buffer) ? buffer.length : Buffer.byteLength(buffer || '');
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) || /^image\//.test(type);
  const isPdf = ext === 'pdf' || type === 'application/pdf' || (Buffer.isBuffer(buffer) && buffer.subarray(0, 4).toString() === '%PDF');
  if (!isImage && !isPdf) return { allowed: false, reason: 'unsupported-type', isImage, isPdf, size };
  if (size > VISION_MAX_DOCUMENT_BYTES) return { allowed: false, reason: 'file-too-large', isImage, isPdf, size };
  return { allowed: true, reason: '', isImage, isPdf, size };
}

module.exports = { VISION_MAX_DOCUMENT_BYTES, visionInputPolicy };
