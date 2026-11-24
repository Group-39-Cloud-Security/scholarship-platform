// middleware.js — securityHeaders and fixBody, used by every service's app.js
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §9–§10

const { validationError, payloadTooLarge } = require('./errors');

// Lab 8 security headers on every API response. The API only returns JSON, so nothing may load or frame it.
function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'",
  });
  next();
}

// Same units as express.json's limit: a number of bytes, or '100kb' / '3mb' (1 kb = 1024 bytes).
function toBytes(limit) {
  if (typeof limit === 'number') return limit;
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|mb)?$/i.exec(String(limit).trim());
  if (!m) throw new Error(`fixBody: invalid limit "${limit}"`);
  return Math.floor(Number(m[1]) * { b: 1, kb: 1024, mb: 1024 * 1024 }[(m[2] || 'b').toLowerCase()]);
}

// Registered after express.json(), with the same limit: app.use(fixBody()) or, on the apply route,
// fixBody({ limit: '3mb' }). Floci's API Gateway can hand Lambda the body as a Buffer or base64 text
// (Lab 7, PATCH), which express.json() skips (and so skips its size limit), so we check, decode and parse it here.
function fixBody({ limit = '100kb' } = {}) {
  const maxBytes = toBytes(limit);
  const maxBase64Bytes = 4 * Math.ceil(maxBytes / 3); // base64 length of a body exactly at the limit
  return function fixBodyMiddleware(req, res, next) {
    // Other content types are left alone so the controller can answer 415 (§8).
    if (!req.is('application/json')) return next();
    const raw = req.body;
    if (!Buffer.isBuffer(raw) && typeof raw !== 'string') return next(); // already parsed by express.json()
    // Checked on the raw length, before any decoding or parsing work: no valid body, JSON or base64, is bigger.
    const rawBytes = Buffer.byteLength(raw);
    if (rawBytes > maxBase64Bytes) return next(payloadTooLarge());
    let text = raw.toString('utf8').trim();
    if (text === '') {
      req.body = {}; // empty body: let the controller's validation say what is missing
      return next();
    }
    // Heuristic: Lab 7 saw Floci pass PATCH bodies as a Buffer or base64 text, and the event's isBase64Encoded
    // flag can't be trusted for that case. JSON bodies start with { or [, so anything else is decoded as base64.
    // A non-object JSON body like "abc" therefore ends up as a 400, which is fine: every body in our API is an object.
    if (text[0] === '{' || text[0] === '[') {
      if (rawBytes > maxBytes) return next(payloadTooLarge());
    } else {
      const decoded = Buffer.from(text, 'base64');
      if (decoded.length > maxBytes) return next(payloadTooLarge());
      text = decoded.toString('utf8');
    }
    try {
      req.body = JSON.parse(text);
    } catch {
      return next(validationError('Request body is not valid JSON.'));
    }
    next();
  };
}

module.exports = { securityHeaders, fixBody };
