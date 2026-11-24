// Tests for shared-lib/logger.js. Run from the repo root:  node --test "tests/shared-lib/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { requestLogger, log } = require('../../shared-lib/logger');

// Captures console.log/console.error lines for one test.
function capture(t) {
  const lines = [];
  t.mock.method(console, 'log', (l) => lines.push({ stream: 'out', entry: JSON.parse(l) }));
  t.mock.method(console, 'error', (l) => lines.push({ stream: 'err', entry: JSON.parse(l) }));
  return lines;
}

// Runs the request through requestLogger and finishes the response with the given status.
function finish(status, req = {}, locals = {}) {
  const res = new EventEmitter();
  res.statusCode = status;
  res.locals = locals;
  const fullReq = { method: 'GET', originalUrl: '/api/scholarships?search=secret', ...req };
  let nextCalled = false;
  requestLogger(fullReq, res, () => { nextCalled = true; });
  assert.ok(nextCalled);
  res.emit('finish');
}

test('one line per request with exactly the agreed fields, no query string', (t) => {
  const lines = capture(t);
  delete process.env.AWS_LAMBDA_FUNCTION_NAME;
  finish(200, {
    user: { userId: 'test-admin' },
    body: { password: 'hunter2' },
    headers: { authorization: 'Bearer test-admin' },
  }, { action: 'decision' });
  assert.strictEqual(lines.length, 1);
  assert.deepStrictEqual(lines[0].entry, {
    level: 'info', fn: 'local', method: 'GET', path: '/api/scholarships', status: 200, userId: 'test-admin', action: 'decision',
  });
  assert.strictEqual(lines[0].stream, 'out');
});

test('level is warn for 4xx and error for 5xx; userId and action null when not set', (t) => {
  const lines = capture(t);
  finish(404);
  finish(500);
  assert.strictEqual(lines[0].entry.level, 'warn');
  assert.strictEqual(lines[0].entry.userId, null);
  assert.strictEqual(lines[0].entry.action, null);
  assert.strictEqual(lines[1].entry.level, 'error');
  assert.strictEqual(lines[1].stream, 'err');
});

test('fn comes from AWS_LAMBDA_FUNCTION_NAME', (t) => {
  const lines = capture(t);
  process.env.AWS_LAMBDA_FUNCTION_NAME = 'admin-service';
  t.after(() => { delete process.env.AWS_LAMBDA_FUNCTION_NAME; });
  finish(201);
  log('error', 'boom', { error: 'TypeError' });
  assert.strictEqual(lines[0].entry.fn, 'admin-service');
  assert.deepStrictEqual(lines[1].entry, { level: 'error', fn: 'admin-service', message: 'boom', error: 'TypeError' });
  assert.strictEqual(lines[1].stream, 'err');
});
