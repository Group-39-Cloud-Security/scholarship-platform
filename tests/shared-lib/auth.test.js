// Tests for shared-lib/auth.js. Run from the repo root:  node --test "tests/shared-lib/*.test.js"
// Needs services/auth-service/node_modules (npm install there) for jsonwebtoken, which isn't installed at the root.
// SSM, DynamoDB and audit.js are replaced with fakes, so these tests never touch Floci.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');

const jwtPath = require.resolve('jsonwebtoken', { paths: [path.join(__dirname, '../../services/auth-service')] });
const jwt = require(jwtPath);

const SECRET = 'test-secret-only-for-unit-tests';
let ssmCalls = 0;
const users = {}; // the fake Users table: userId → item
const gets = []; // every GetItem input auth.js sent
const audits = [];

const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'jsonwebtoken') return jwt;
  if (request === '@aws-sdk/client-ssm') {
    return {
      SSMClient: class { async send() { ssmCalls += 1; return { Parameter: { Value: SECRET } }; } },
      GetParameterCommand: class { constructor(input) { this.input = input; } },
    };
  }
  if (request === '@aws-sdk/lib-dynamodb') return { GetCommand: class { constructor(input) { this.input = input; } } };
  if (request === './dynamo') {
    return {
      docClient: {
        async send(cmd) {
          gets.push(cmd.input);
          const item = users[cmd.input.Key.userId];
          return { Item: item ? { ...item } : undefined };
        },
      },
    };
  }
  // Finishes a tick later, like a real DynamoDB call, so the tests can see whether the caller waits for it.
  if (request === './audit') {
    return { writeAudit: async (entry) => { await new Promise((r) => setImmediate(r)); audits.push(entry); } };
  }
  return realLoad.call(this, request, ...rest);
};
const { authenticate, requireRole, getJwtSecret } = require('../../shared-lib/auth');
Module._load = realLoad;

users.s1 = { userId: 's1', email: 'student1@example-university.edu', role: 'student', status: 'active', mustChangePassword: false, passwordHash: 'x' };
users.r1 = { userId: 'r1', email: 'reviewer@example-university.edu', role: 'reviewer', status: 'active', mustChangePassword: true };
users.d1 = { userId: 'd1', email: 'gone@example-university.edu', role: 'admin', status: 'disabled' };

const sign = (claims, opts = {}) => jwt.sign(claims, opts.secret || SECRET, { algorithm: 'HS256', expiresIn: '1h', ...opts.jwt });

function fakeReq(authorization, method = 'GET', url = '/api/scholarships') {
  return { method, originalUrl: url, get: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined) };
}
// Both middlewares are async: resolve with what they pass to next().
const run = (middleware, req) => new Promise((resolve) => middleware(req, {}, resolve));

test('a valid token sets req.user from Users, with the agreed shape', async () => {
  const req = fakeReq(`Bearer ${sign({ sub: 's1', role: 'admin' })}`); // the role in the token is a lie
  assert.strictEqual(await run(authenticate, req), undefined);
  assert.deepStrictEqual(req.user, { userId: 's1', email: 'student1@example-university.edu', role: 'student', status: 'active' });
});

test('the Users read never asks for passwordHash', async () => {
  gets.length = 0;
  await run(authenticate, fakeReq(`Bearer ${sign({ sub: 's1' })}`));
  assert.strictEqual(gets.length, 1);
  assert.ok(!gets[0].ProjectionExpression.includes('passwordHash'));
});

test('the old test tokens and malformed headers give 401', async () => {
  for (const header of [undefined, '', 'test-admin', 'Bearer test-admin', 'Bearer test-student-1', 'Bearer test-reviewer',
    'Basic abc', 'Bearer ', 'Bearer a.b', `Bearer ${sign({ sub: 's1' })} extra`]) {
    const req = fakeReq(header);
    const err = await run(authenticate, req);
    assert.strictEqual(err && err.status, 401, `header: ${header}`);
    assert.strictEqual(err.code, 'UNAUTHENTICATED');
    assert.strictEqual(req.user, undefined);
  }
});

test('wrong secret, expired, alg none and another algorithm are refused', async () => {
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"s1"}').toString('base64url')}.x`;
  const tokens = {
    'wrong secret': sign({ sub: 's1' }, { secret: 'another-secret' }),
    expired: jwt.sign({ sub: 's1', exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { algorithm: 'HS256' }),
    'alg none': none,
    HS512: jwt.sign({ sub: 's1' }, SECRET, { algorithm: 'HS512' }),
    'no sub': sign({ role: 'admin' }),
  };
  for (const [name, token] of Object.entries(tokens)) {
    const err = await run(authenticate, fakeReq(`Bearer ${token}`));
    assert.strictEqual(err && err.status, 401, name);
  }
  const expired = await run(authenticate, fakeReq(`Bearer ${tokens.expired}`));
  assert.match(expired.message, /expired/);
});

test('unknown or disabled user gives 401 even with a valid token', async () => {
  for (const sub of ['nobody', 'd1']) {
    const err = await run(authenticate, fakeReq(`Bearer ${sign({ sub })}`));
    assert.strictEqual(err && err.status, 401, sub);
  }
});

test('mustChangePassword: only GET /me and PUT /password pass, anything else 403 + audit', async () => {
  const token = `Bearer ${sign({ sub: 'r1' })}`;
  assert.strictEqual(await run(authenticate, fakeReq(token, 'GET', '/api/auth/me')), undefined);
  assert.strictEqual(await run(authenticate, fakeReq(token, 'PUT', '/api/auth/password')), undefined);
  audits.length = 0;
  const err = await run(authenticate, fakeReq(token, 'GET', '/api/reviews/queue?x=1'));
  assert.strictEqual(err.status, 403);
  assert.deepStrictEqual(audits, [{ action: 'forbidden', userId: 'r1', targetId: '/api/reviews/queue', detail: 'must change password' }]);
});

test('the secret is read from SSM once and then reused', async () => {
  const before = ssmCalls;
  await getJwtSecret();
  await run(authenticate, fakeReq(`Bearer ${sign({ sub: 's1' })}`));
  assert.ok(ssmCalls - before <= 0, 'no new SSM call after the first');
  assert.ok(ssmCalls <= 1);
});

test('requireRole: right role passes, wrong role 403 with a full-path audit row, no user 401', async () => {
  const req = fakeReq(`Bearer ${sign({ sub: 's1' })}`, 'GET', '/api/admin/stats?since=2026-11-01');
  await run(authenticate, req);
  assert.strictEqual(await run(requireRole('student'), req), undefined);
  assert.strictEqual(await run(requireRole('reviewer', 'student'), req), undefined);

  audits.length = 0;
  const err = await run(requireRole('admin'), req);
  assert.strictEqual(err.status, 403);
  assert.strictEqual(err.code, 'FORBIDDEN');
  // The fake writeAudit records a tick later, so the row is only there if requireRole waited for it.
  assert.deepStrictEqual(audits, [{ action: 'forbidden', userId: 's1', targetId: '/api/admin/stats', detail: 'needed admin' }]);

  assert.strictEqual((await run(requireRole('admin'), fakeReq())).status, 401);
});
