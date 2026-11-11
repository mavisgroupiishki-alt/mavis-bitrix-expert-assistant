'use strict';

const AdmZip = require('adm-zip');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_HEADER = Buffer.from('%PDF-');
const DEFAULT_ANCHOR_TEXT = 'М.П.';
const STAMP_ENTRY = 'word/media/mavis-visual-signature-stamp.png';
const STAMP_REL_ID = 'rIdMavisVisualSignature';
const STAMP_WIDTH_EMU = 2172929;
const STAMP_HEIGHT_EMU = 1593606;
// Штамп из утверждённого шаблона расположен так, что «М.П.» остаётся у нижнего левого края.
const STAMP_VERTICAL_OFFSET_EMU = -750000;

function signedActError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlText(xml) {
  return String(xml || '')
    .replace(/<w:tab\b[^/>]*\/?\s*>/gi, '\t')
    .replace(/<w:br\b[^/>]*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function containsAnchor(paragraphXml, anchorText) {
  return xmlText(paragraphXml).replace(/\s+/g, ' ').includes(String(anchorText || DEFAULT_ANCHOR_TEXT));
}

function ensurePngContentType(contentTypesXml) {
  if (/Extension="png"/i.test(contentTypesXml)) return contentTypesXml;
  return contentTypesXml.replace(
    /<\/Types>\s*$/i,
    '<Default Extension="png" ContentType="image/png"/></Types>',
  );
}

function nextStampRelationshipId(relsXml) {
  const usedIds = new Set(
    [...String(relsXml || '').matchAll(/\bId\s*=\s*(["'])(.*?)\1/g)].map((match) => match[2]),
  );
  if (!usedIds.has(STAMP_REL_ID)) return STAMP_REL_ID;
  let suffix = 1;
  while (usedIds.has(`${STAMP_REL_ID}${suffix}`)) suffix++;
  return `${STAMP_REL_ID}${suffix}`;
}

function addStampRelationship(relsXml, relationshipId) {
  const relationship = `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${path.basename(STAMP_ENTRY)}"/>`;
  return relsXml.replace(/<\/Relationships>\s*$/i, `${relationship}</Relationships>`);
}

function docxLeftMarginEmu(documentXml) {
  const margin = String(documentXml || '').match(/<w:pgMar\b[^>]*\bw:left="(\d+)"/i);
  const twips = Number(margin && margin[1]);
  return Number.isFinite(twips) && twips > 0 ? twips * 635 : 914400;
}

function stampDrawingXml(horizontalOffsetEmu, relationshipId) {
  return [
    '<w:r><w:rPr><w:noProof/></w:rPr><w:drawing>',
    `<wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="251658240" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">`,
    '<wp:simplePos x="0" y="0"/>',
    `<wp:positionH relativeFrom="page"><wp:posOffset>${horizontalOffsetEmu}</wp:posOffset></wp:positionH>`,
    `<wp:positionV relativeFrom="paragraph"><wp:posOffset>${STAMP_VERTICAL_OFFSET_EMU}</wp:posOffset></wp:positionV>`,
    `<wp:extent cx="${STAMP_WIDTH_EMU}" cy="${STAMP_HEIGHT_EMU}"/>`,
    '<wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>',
    '<wp:docPr id="9001" name="Mavis visual signature and stamp" descr="Визуальная печать и подпись Мавис Групп"/>',
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>',
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>',
    '<pic:nvPicPr><pic:cNvPr id="9001" name="mavis-signature-stamp.png"/><pic:cNvPicPr/></pic:nvPicPr>',
    `<pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`,
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${STAMP_WIDTH_EMU}" cy="${STAMP_HEIGHT_EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`,
    '</pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>',
  ].join('');
}

function addVisualStampToDocx({ sourceBuffer, stampBuffer, anchorText = DEFAULT_ANCHOR_TEXT }) {
  if (!Buffer.isBuffer(sourceBuffer) || !sourceBuffer.length) {
    throw signedActError('ACTS_SIGNATURE_SOURCE_INVALID', 'исходный DOCX пуст или не прочитан');
  }
  if (!Buffer.isBuffer(stampBuffer) || !stampBuffer.length) {
    throw signedActError('ACTS_SIGNATURE_STAMP_MISSING', 'не найден файл визуальной печати и подписи');
  }

  let zip;
  try {
    zip = new AdmZip(sourceBuffer);
  } catch (_) {
    throw signedActError('ACTS_SIGNATURE_SOURCE_INVALID', 'файл не является корректным DOCX');
  }
  const documentEntry = zip.getEntry('word/document.xml');
  const relationshipsEntry = zip.getEntry('word/_rels/document.xml.rels');
  const contentTypesEntry = zip.getEntry('[Content_Types].xml');
  if (!documentEntry || !relationshipsEntry || !contentTypesEntry) {
    throw signedActError('ACTS_SIGNATURE_SOURCE_INVALID', 'в DOCX отсутствует обязательная структура Word');
  }

  const documentXml = documentEntry.getData().toString('utf8');
  const relationshipsXml = relationshipsEntry.getData().toString('utf8');
  const relationshipId = nextStampRelationshipId(relationshipsXml);
  const horizontalOffsetEmu = docxLeftMarginEmu(documentXml);
  const paragraphs = documentXml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g) || [];
  const anchorIndexes = paragraphs
    .map((paragraph, index) => (containsAnchor(paragraph, anchorText) ? index : -1))
    .filter((index) => index >= 0);
  if (!anchorIndexes.length) {
    throw signedActError('ACTS_SIGNATURE_ANCHOR_NOT_FOUND', `в акте не найдена строка подписи «${escapeXml(anchorText)}»`);
  }
  if (anchorIndexes.length > 1) {
    throw signedActError('ACTS_SIGNATURE_ANCHOR_AMBIGUOUS', `в акте найдено несколько строк «${escapeXml(anchorText)}»; место штампа неоднозначно`);
  }
  const anchorIndex = anchorIndexes[0];
  const nearbySignatureGraphic = paragraphs
    .slice(Math.max(0, anchorIndex - 4), anchorIndex + 5)
    .some((paragraph) => /<w:(?:drawing|pict)\b/i.test(paragraph));
  if (nearbySignatureGraphic) {
    throw signedActError('ACTS_SIGNATURE_ALREADY_STAMPED', 'рядом с местом подписи уже есть графика; повторный штамп заблокирован');
  }

  let currentParagraph = -1;
  const stampedDocumentXml = documentXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraph) => {
    currentParagraph++;
    if (currentParagraph !== anchorIndex) return paragraph;
    return paragraph.replace(/<\/w:p>$/, `${stampDrawingXml(horizontalOffsetEmu, relationshipId)}</w:p>`);
  });

  zip.updateFile('word/document.xml', Buffer.from(stampedDocumentXml, 'utf8'));
  zip.updateFile(
    'word/_rels/document.xml.rels',
    Buffer.from(addStampRelationship(relationshipsXml, relationshipId), 'utf8'),
  );
  zip.updateFile(
    '[Content_Types].xml',
    Buffer.from(ensurePngContentType(contentTypesEntry.getData().toString('utf8')), 'utf8'),
  );
  zip.addFile(STAMP_ENTRY, stampBuffer);
  return zip.toBuffer();
}

async function convertDocxToPdf(signedDocxBuffer, sofficePath = 'soffice') {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mavis-acts-sign-'));
  const docxPath = path.join(workDir, 'signed-act.docx');
  const pdfPath = path.join(workDir, 'signed-act.pdf');
  const profileDir = path.join(workDir, 'lo-profile');
  try {
    await fs.mkdir(profileDir);
    await fs.writeFile(docxPath, signedDocxBuffer, { mode: 0o600 });
    try {
      await execFileAsync(sofficePath, [
        '--headless',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to', 'pdf',
        '--outdir', workDir,
        docxPath,
      ], { timeout: 60000, maxBuffer: 1024 * 1024 });
    } catch (error) {
      const reason = error && (error.code === 'ENOENT' ? 'LibreOffice не найден' : (error.stderr || error.message));
      throw signedActError('ACTS_SIGNATURE_PDF_CONVERSION_FAILED', String(reason || 'не удалось преобразовать DOCX в PDF').trim());
    }
    let pdf;
    try {
      pdf = await fs.readFile(pdfPath);
    } catch (_) {
      throw signedActError('ACTS_SIGNATURE_PDF_CONVERSION_FAILED', 'LibreOffice не создал PDF');
    }
    if (pdf.length < PDF_HEADER.length || !pdf.subarray(0, PDF_HEADER.length).equals(PDF_HEADER)) {
      throw signedActError('ACTS_SIGNATURE_PDF_INVALID', 'созданный файл не является PDF');
    }
    return pdf;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function createSignedActPdf({ sourceBuffer, sourceFileName, stampBuffer, sofficePath, anchorText }) {
  if (!/\.docx$/i.test(String(sourceFileName || ''))) {
    throw signedActError('ACTS_SIGNATURE_DOCX_REQUIRED', 'для автоматического штампа нужен акт в формате DOCX');
  }
  const signedDocx = addVisualStampToDocx({ sourceBuffer, stampBuffer, anchorText });
  const buffer = await convertDocxToPdf(signedDocx, sofficePath);
  return {
    buffer,
    fileName: String(sourceFileName).replace(/\.docx$/i, '.pdf'),
    contentType: 'application/pdf',
  };
}

module.exports = {
  DEFAULT_ANCHOR_TEXT,
  DOCX_MIME,
  addVisualStampToDocx,
  convertDocxToPdf,
  createSignedActPdf,
};
