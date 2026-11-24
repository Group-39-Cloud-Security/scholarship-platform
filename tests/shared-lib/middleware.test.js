// Tests for shared-lib/middleware.js. Kept outside shared-lib/ so sync-shared never copies them into a Lambda zip.
// Run from the repo root:  node --test tests/shared-lib/middleware.test.js
const test = require('node:test');
const assert = require('node:assert');
const { fixBody, securityHeaders } = require('../../shared-lib/middleware');

const obj = { status: 'published' };
const json = JSON.stringify(obj);
const b64 = Buffer.from(json).toString('base64');

// Runs fixBody on a fake request; req.is mimics Express for the given content type.
function run(body, { type = 'application/json', limit } = {}) {
  const req = { body, is: (t) => (t === type ? t : false) };
  let err;
  fixBody(limit === undefined ? undefined : { limit })(req, {}, (e) => { err = e; });
  return { body: req.body, err };
}

function assertError(result, status, code) {
  assert.strictEqual(result.err.status, status);
  assert.strictEqual(result.err.code, code);
}

test('already-parsed object passes through untouched', () => {
  assert.strictEqual(run(obj).body, obj);
  assert.strictEqual(run(obj).err, undefined);
});

test('no body passes through', () => {
  assert.strictEqual(run(undefined).body, undefined);
});

test('Buffer, plain text and base64 bodies are parsed', () => {
  assert.deepStrictEqual(run(Buffer.from(json)).body, obj);
  assert.deepStrictEqual(run(json).body, obj);
  assert.deepStrictEqual(run(b64).body, obj);
  assert.deepStrictEqual(run(Buffer.from(b64)).body, obj);
});

test('leading whitespace before JSON is ignored', () => {
  assert.deepStrictEqual(run(`\n  \t${json}`).body, obj);
  assert.deepStrictEqual(run(Buffer.from(`  ${json}`)).body, obj);
});

test('empty body becomes {}', () => {
  assert.deepStrictEqual(run('').body, {});
  assert.deepStrictEqual(run(Buffer.alloc(0)).body, {});
});

test('bad JSON gives 400 VALIDATION_ERROR', () => {
  for (const bad of ['{bad', 'not base64 json!', Buffer.from('{"a":'), '"abc"']) {
    assertError(run(bad), 400, 'VALIDATION_ERROR');
  }
});

test('text/plain body is left untouched for the controller to 415', () => {
  const raw = Buffer.from('hello');
  const result = run(raw, { type: 'text/plain' });
  assert.strictEqual(result.body, raw);
  assert.strictEqual(result.err, undefined);
});

test('body just over the limit gives 413 PAYLOAD_TOO_LARGE', () => {
  const atLimit = JSON.stringify({ a: 'x'.repeat(100 * 1024 - 8) }); // exactly 100 kB ({"a":""} is 8 bytes)
  assert.strictEqual(Buffer.byteLength(atLimit), 100 * 1024);
  assert.strictEqual(run(Buffer.from(atLimit)).err, undefined);
  assertError(run(Buffer.from(atLimit + ' ')), 413, 'PAYLOAD_TOO_LARGE');
  assertError(run(atLimit + ' '), 413, 'PAYLOAD_TOO_LARGE');
});

test('base64 body is checked on its decoded size', () => {
  const ofSize = (n) => JSON.stringify({ a: 'x'.repeat(n - 8) }); // {"a":""} is 8 bytes
  const atLimit = Buffer.from(ofSize(100 * 1024)).toString('base64');
  const overLimit = Buffer.from(ofSize(100 * 1024 + 1)).toString('base64');
  assert.strictEqual(overLimit.length, atLimit.length); // same raw length, so only the decoded check can tell them apart
  assert.strictEqual(run(atLimit).err, undefined);
  assert.strictEqual(run(atLimit).body.a.length, 100 * 1024 - 8);
  assertError(run(overLimit), 413, 'PAYLOAD_TOO_LARGE');
  assertError(run(Buffer.from(overLimit)), 413, 'PAYLOAD_TOO_LARGE');
});

test('limit accepts express.json strings and numbers', () => {
  const big = Buffer.from(JSON.stringify({ a: 'x'.repeat(2 * 1024 * 1024) }));
  assertError(run(big), 413, 'PAYLOAD_TOO_LARGE');
  assert.strictEqual(run(big, { limit: '3mb' }).err, undefined);
  assertError(run(Buffer.from(json), { limit: 5 }), 413, 'PAYLOAD_TOO_LARGE');
  assert.throws(() => fixBody({ limit: 'lots' }), /invalid limit/);
});

test('securityHeaders sets the three Lab 8 headers', () => {
  const headers = {};
  let called = false;
  securityHeaders({}, { set: (h) => Object.assign(headers, h) }, () => { called = true; });
  assert.deepStrictEqual(headers, {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'",
  });
  assert.ok(called);
});
