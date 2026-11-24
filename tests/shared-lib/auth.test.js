// Tests for shared-lib/auth.js. Run from the repo root:  node --test "tests/shared-lib/*.test.js"
const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

// audit.js needs the AWS SDK, which is only installed inside each service, so it is replaced with a fake
// that records the calls. Swapped back right after auth.js is loaded.
const audits = [];
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === './audit') return { writeAudit: async (entry) => { audits.push(entry); } };
  return realLoad.call(this, request, ...rest);
};
const { authenticate, requireRole } = require('../../shared-lib/auth');
Module._load = realLoad;

// Fake Express request with only the Authorization header.
function fakeReq(authorization) {
  return { get: (name) => (name.toLowerCase() === 'authorization' ? authorization : undefined) };
}

function run(middleware, req) {
  let err = 'not called';
  middleware(req, {}, (e) => { err = e; });
  return err;
}

test('each test token sets req.user with the agreed shape', () => {
  for (const [token, role] of [
    ['test-student-1', 'student'], ['test-student-2', 'student'], ['test-reviewer', 'reviewer'], ['test-admin', 'admin'],
  ]) {
    const req = fakeReq(`Bearer ${token}`);
    assert.strictEqual(run(authenticate, req), undefined);
    assert.deepStrictEqual(Object.keys(req.user).sort(), ['email', 'role', 'status', 'userId']);
    assert.strictEqual(req.user.userId, token);
    assert.strictEqual(req.user.role, role);
    assert.strictEqual(req.user.status, 'active');
  }
});

test('the two students are different users', () => {
  const a = fakeReq('Bearer test-student-1');
  const b = fakeReq('Bearer test-student-2');
  run(authenticate, a);
  run(authenticate, b);
  assert.notStrictEqual(a.user.userId, b.user.userId);
});

test('missing, malformed or unknown token gives 401 UNAUTHENTICATED', () => {
  for (const header of [undefined, '', 'test-admin', 'Basic test-admin', 'Bearer ', 'Bearer nope', 'Bearer toString', 'Bearer test-admin extra']) {
    const req = fakeReq(header);
    const err = run(authenticate, req);
    assert.strictEqual(err.status, 401, `header: ${header}`);
    assert.strictEqual(err.code, 'UNAUTHENTICATED');
    assert.strictEqual(req.user, undefined);
  }
});

test('req.user is a copy, so changing it does not change the test user', () => {
  const a = fakeReq('Bearer test-student-1');
  run(authenticate, a);
  a.user.role = 'admin';
  const b = fakeReq('Bearer test-student-1');
  run(authenticate, b);
  assert.strictEqual(b.user.role, 'student');
});

test('requireRole: right role passes, wrong role 403, no user 401', () => {
  const admin = fakeReq('Bearer test-admin');
  run(authenticate, admin);
  assert.strictEqual(run(requireRole('admin'), admin), undefined);
  assert.strictEqual(run(requireRole('reviewer', 'admin'), admin), undefined);

  const err = run(requireRole('student'), admin); // admin token on a student route (§2)
  assert.strictEqual(err.status, 403);
  assert.strictEqual(err.code, 'FORBIDDEN');

  assert.strictEqual(run(requireRole('admin'), fakeReq()).status, 401);
});

test('a 403 is written to AuditLog; passing or 401 requests are not', () => {
  audits.length = 0;
  const student = fakeReq('Bearer test-student-1');
  student.path = '/stats';
  run(authenticate, student);
  run(requireRole('reviewer', 'admin'), student);
  assert.deepStrictEqual(audits, [
    { action: 'forbidden', userId: 'test-student-1', targetId: '/stats', detail: 'needed reviewer/admin' },
  ]);

  run(requireRole('student'), student);
  run(requireRole('admin'), fakeReq());
  assert.strictEqual(audits.length, 1);
});

test('the 403 does not wait for the audit write', () => {
  const reviewer = fakeReq('Bearer test-reviewer');
  run(authenticate, reviewer);
  // run() reads the error right after the call, so this only passes if next() ran before writeAudit settled.
  assert.strictEqual(run(requireRole('admin'), reviewer).status, 403);
});
