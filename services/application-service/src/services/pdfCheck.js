// pdfCheck.js — turns the base64 text from the apply request into PDF bytes, or rejects it.
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §6 Applying, §8 PDFs
// The file is checked by its CONTENT (first bytes "%PDF-"), never by a file name or extension,
// because both of those are chosen by the client and can lie (Seif marked other groups down for this).

const { validationError, AppError } = require('../../shared/errors');

const MAX_PDF_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_BASE64_CHARS = 4 * Math.ceil(MAX_PDF_BYTES / 3); // base64 length of a file exactly at the limit
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const pdfTooLarge = () => new AppError(413, 'PAYLOAD_TOO_LARGE', 'The PDF must be at most 2 MB.');

function decodePdf(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw validationError('pdfBase64 is required (the PDF file as base64 text).');
  }
  const text = value.replace(/\s+/g, ''); // some encoders add line breaks every 76 characters

  // Size first, on the text itself, so we never decode something that is obviously too big.
  if (text.length > MAX_BASE64_CHARS) throw pdfTooLarge();

  // Buffer.from(x, 'base64') silently skips invalid characters, so the format is checked explicitly.
  if (text.length % 4 !== 0 || !BASE64_RE.test(text)) {
    throw validationError('pdfBase64 is not valid base64.');
  }

  const bytes = Buffer.from(text, 'base64');
  if (bytes.length > MAX_PDF_BYTES) throw pdfTooLarge();
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw validationError('The file must be a PDF (its content does not start with %PDF-).');
  }
  return bytes;
}

module.exports = { decodePdf, MAX_PDF_BYTES };
