# Signed Act PDF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send only a PDF that contains the supplied visual Mavis stamp and signature when an act task reaches «Сделано».

**Architecture:** A focused module edits an in-memory DOCX package by adding the approved stamp as a floating drawing near a mandatory `М.П.` anchor. It converts the edited DOCX to PDF in a unique temporary directory using LibreOffice. `server.js` sends that PDF through the existing SMTP plus Sent-mail flow; a failed transformation never falls back to the unsigned DOCX.

**Tech Stack:** Node.js 18+, `adm-zip`, built-in `child_process`, LibreOffice `soffice`, nodemailer, imapflow, node:test.

## Global Constraints

- The visual mark is not a cryptographic electronic signature.
- Only a DOCX act with the exact `М.П.` anchor is eligible.
- The original Bitrix document is never modified.
- No recipient email or production deployment is exercised without the user’s explicit authorization.

---

### Task 1: Implement DOCX to signed PDF transformation

**Files:**
- Create: `acts-signed-pdf.js`
- Create: `assets/mavis-signature-stamp.png`

**Interfaces:**
- Produces: `createSignedActPdf({ sourceBuffer, sourceFileName, stampBuffer, sofficePath, anchorText })` returning `{ buffer: Buffer, fileName: string }`.
- Fails: throws `ACTS_SIGNATURE_*` error codes before returning an output if source type, anchor, stamp, conversion, or output is invalid.

- [ ] **Step 1: Write the failing test**

```js
await assert.rejects(
  () => createSignedActPdf({ sourceBuffer: docxWithoutAnchor, sourceFileName: 'акт.docx', stampBuffer, sofficePath }),
  /ACTS_SIGNATURE_ANCHOR_NOT_FOUND/,
);
```

- [ ] **Step 2: Implement the minimal OOXML edit**

```js
const signedDocx = addStampToDocx({ sourceBuffer, stampBuffer, anchorText: 'М.П.' });
const pdfBuffer = await convertDocxToPdf(signedDocx, sofficePath);
return { buffer: pdfBuffer, fileName: sourceFileName.replace(/\.docx$/i, '.pdf') };
```

- [ ] **Step 3: Verify the success fixture and render it**

Run: `node --test test/acts-signed-pdf.test.js`

Expected: a PDF is non-empty, a missing anchor fails, and a rendered fixture visibly places the stamp by `М.П.`.

### Task 2: Require signed PDF in client delivery

**Files:**
- Modify: `server.js:13478-13660`
- Test: `test/acts-delivery.test.js`

**Interfaces:**
- Consumes: `createSignedActPdf(...)` result.
- Produces: SMTP delivery result with `file.name` ending `.pdf` and no Bitrix-Disk fallback to the unsigned DOCX.

- [ ] **Step 1: Write the failing test**

```js
assert.match(result.file.name, /\.pdf$/i);
assert.equal(result.smtp, true);
```

- [ ] **Step 2: Implement the guarded branch**

```js
const signedPdf = await actsCreateSignedPdfForDelivery(file);
return sendActEmailThroughSmtp({ ..., file: signedPdf.file, downloaded: signedPdf.downloaded });
```

- [ ] **Step 3: Verify no unsigned fallback exists**

Run: `npm test`

Expected: existing act-delivery tests and the new conversion tests pass.

### Task 3: Document production dependency

**Files:**
- Create: `README_V152_SIGNED_ACT_PDF.md`

- [ ] **Step 1: Document exact environment flags**

```text
ACTS_SIGNATURE_ENABLED=true
ACTS_SIGNATURE_SOFFICE_PATH=/usr/bin/soffice
```

- [ ] **Step 2: Document the safe failure mode**

```text
If LibreOffice or the «М.П.» anchor is missing, the service logs the cause in the deal and sends nothing to the client.
```

- [ ] **Step 3: Verify the documented local command**

Run: `ACTS_SIGNATURE_ENABLED=true ACTS_SIGNATURE_SOFFICE_PATH=$(command -v soffice) node --test test/acts-signed-pdf.test.js`

Expected: PASS.
