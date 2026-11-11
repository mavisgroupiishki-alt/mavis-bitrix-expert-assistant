'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const AdmZip = require('adm-zip');
const { addVisualStampToDocx, createSignedActPdf } = require('../acts-signed-pdf');

const stampBuffer = fs.readFileSync(path.join(__dirname, '..', 'assets', 'mavis-signature-stamp.png'));

function sourceDocx(bodyText) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '</Types>',
  ].join('')));
  zip.addFile('_rels/.rels', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>',
    '</Relationships>',
  ].join('')));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
  ].join('')));
  zip.addFile('word/document.xml', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
    `<w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p><w:sectPr/></w:body>`,
    '</w:document>',
  ].join('')));
  return zip.toBuffer();
}

function docxWithDrawingNearSignature() {
  const zip = new AdmZip(sourceDocx('М.П.'));
  const xml = zip.readAsText('word/document.xml').replace(
    '<w:body>',
    '<w:body><w:p><w:r><w:drawing/></w:r></w:p>',
  );
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

function docxWithDrawingAfterSignature() {
  const zip = new AdmZip(sourceDocx('М.П.'));
  const xml = zip.readAsText('word/document.xml').replace(
    '<w:sectPr/>',
    '<w:p><w:r><w:drawing/></w:r></w:p><w:sectPr/>',
  );
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

function docxWithStampRelationshipIdAlreadyUsed() {
  const zip = new AdmZip(sourceDocx('М.П.'));
  zip.updateFile('word/_rels/document.xml.rels', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '<Relationship Id="rIdMavisVisualSignature" Type="urn:unrelated" Target="unrelated.xml"/>',
    '</Relationships>',
  ].join(''), 'utf8'));
  return zip.toBuffer();
}

function docxWithSingleQuotedStampRelationshipIdAlreadyUsed() {
  const zip = new AdmZip(sourceDocx('М.П.'));
  zip.updateFile('word/_rels/document.xml.rels', Buffer.from([
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<Relationships xmlns='http://schemas.openxmlformats.org/package/2006/relationships'>",
    "<Relationship Id = 'rIdMavisVisualSignature' Type='urn:unrelated' Target='unrelated.xml'/>",
    '</Relationships>',
  ].join(''), 'utf8'));
  return zip.toBuffer();
}

test('adds the visual stamp as a floating image to the М.П. paragraph', () => {
  const stamped = addVisualStampToDocx({
    sourceBuffer: sourceDocx('М.П.'),
    stampBuffer,
  });
  const zip = new AdmZip(stamped);
  const xml = zip.readAsText('word/document.xml');
  const rels = zip.readAsText('word/_rels/document.xml.rels');

  assert.match(xml, /Mavis visual signature and stamp/);
  assert.match(xml, /relativeFrom="page"/);
  assert.match(rels, /rIdMavisVisualSignature/);
  assert.ok(zip.getEntry('word/media/mavis-visual-signature-stamp.png'));
});

test('fails closed when the required signature anchor is absent', () => {
  assert.throws(
    () => addVisualStampToDocx({ sourceBuffer: sourceDocx('Подпись директора'), stampBuffer }),
    { code: 'ACTS_SIGNATURE_ANCHOR_NOT_FOUND' },
  );
});

test('fails closed instead of placing a second stamp next to an existing signature graphic', () => {
  assert.throws(
    () => addVisualStampToDocx({ sourceBuffer: docxWithDrawingNearSignature(), stampBuffer }),
    { code: 'ACTS_SIGNATURE_ALREADY_STAMPED' },
  );
});

test('fails closed when a signature graphic follows the М.П. paragraph', () => {
  assert.throws(
    () => addVisualStampToDocx({ sourceBuffer: docxWithDrawingAfterSignature(), stampBuffer }),
    { code: 'ACTS_SIGNATURE_ALREADY_STAMPED' },
  );
});

test('does not reuse an occupied DOCX relationship id', () => {
  const stamped = addVisualStampToDocx({
    sourceBuffer: docxWithStampRelationshipIdAlreadyUsed(),
    stampBuffer,
  });
  const zip = new AdmZip(stamped);
  const xml = zip.readAsText('word/document.xml');
  const rels = zip.readAsText('word/_rels/document.xml.rels');

  assert.match(xml, /r:embed="rIdMavisVisualSignature1"/);
  assert.match(rels, /Id="rIdMavisVisualSignature" Type="urn:unrelated"/);
  assert.match(rels, /Id="rIdMavisVisualSignature1"/);
});

test('does not reuse an occupied single-quoted DOCX relationship id', () => {
  const stamped = addVisualStampToDocx({
    sourceBuffer: docxWithSingleQuotedStampRelationshipIdAlreadyUsed(),
    stampBuffer,
  });
  const zip = new AdmZip(stamped);

  assert.match(zip.readAsText('word/document.xml'), /r:embed="rIdMavisVisualSignature1"/);
});

test('requires DOCX before attempting PDF conversion', async () => {
  await assert.rejects(
    () => createSignedActPdf({
      sourceBuffer: Buffer.from('not a docx'),
      sourceFileName: 'акт.pdf',
      stampBuffer,
    }),
    { code: 'ACTS_SIGNATURE_DOCX_REQUIRED' },
  );
});
