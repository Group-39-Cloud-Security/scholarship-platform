// api-tests.js — end-to-end tests for application-service: every function, every status code, every business rule.
// Owner: Mohamed Khalil.  Prints PASS/FAIL per test ID (copy the rows into docs/api-test-plan.md as evidence).
//
// Usage (from services/application-service, after node scripts/test-scholarships.js):
//   On Floci:   API_URL=http://<API_ID>.execute-api.localhost.floci.io:4566 node tests/api-tests.js
//   Locally:    npm run dev   (other terminal)   then   API_URL=http://localhost:3000 node tests/api-tests.js
// It also talks to DynamoDB directly (same AWS settings as the CLI) for two things only:
// cleaning up the test students' old applications, and pretending a reviewer claimed one (review-service isn't built yet).

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, DeleteCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const API = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }));
const APPS = process.env.APPLICATIONS_TABLE || 'Applications';
const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-1', forcePathStyle: true });
const BUCKET = process.env.DOCUMENTS_BUCKET || 'scholarship-documents';

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(10)} ${name}${ok ? '' : `   <-- ${detail}`}`);
}

async function call(method, path, { token, body, raw, type = 'application/json' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = type;
  const res = await fetch(API + path, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  return { status: res.status, json, headers: res.headers };
}

const S1 = 'test-student-1';
const S2 = 'test-student-2';
const essay = Array.from({ length: 250 }, (_, i) => `word${i}`).join(' ');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n').toString('base64');
const goodBody = (scholarshipId) => ({ scholarshipId, essay, gpa: 3.2, yearOfStudy: 2, pdfBase64: pdf });

async function cleanUp() {
  for (const studentId of [S1, S2]) {
    const { Items = [] } = await doc.send(new QueryCommand({
      TableName: APPS, IndexName: 'studentId-index',
      KeyConditionExpression: 'studentId = :s', ExpressionAttributeValues: { ':s': studentId },
    }));
    for (const a of Items) {
      await doc.send(new DeleteCommand({ TableName: APPS, Key: { applicationId: a.applicationId } }));
      if (a.pdfKey) await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: a.pdfKey })); // no orphaned test PDFs
    }
  }
}

(async () => {
  console.log(`Testing ${API}\n`);
  await cleanUp();
  let r;

  // ---------- browse scholarships ----------
  r = await call('GET', '/api/scholarships');
  check('T-APP-01', 'browse without a token → 401', r.status === 401 && r.json?.error?.code === 'UNAUTHENTICATED', r.status);

  r = await call('GET', '/api/scholarships', { token: S1 });
  const ids = (r.json || []).map((s) => s.scholarshipId);
  check('T-APP-02', 'browse → 200, only published (no draft/closed)',
    r.status === 200 && ids.includes('test-open') && !ids.includes('test-draft') && !ids.includes('test-closed'), `${r.status} ${ids}`);
  check('T-APP-03', 'list never shows createdBy/acceptedCount',
    (r.json || []).every((s) => !('createdBy' in s) && !('acceptedCount' in s)));

  r = await call('GET', '/api/scholarships?search=merit', { token: S1 });
  check('T-APP-04', 'search "merit" → only the matching one', r.status === 200 && r.json.length === 1 && r.json[0].scholarshipId === 'test-open', JSON.stringify(r.json));

  r = await call('GET', '/api/scholarships?search=a&search=b', { token: S1 });
  check('T-APP-05', 'search given twice → 400', r.status === 400, r.status);

  r = await call('GET', '/api/scholarships/test-draft', { token: S1 });
  check('T-APP-06', 'draft by id → 404 SCHOLARSHIP_NOT_FOUND', r.status === 404 && r.json?.error?.code === 'SCHOLARSHIP_NOT_FOUND', r.status);

  r = await call('GET', '/api/scholarships/test-open', { token: 'test-reviewer' });
  check('T-APP-07', 'any logged-in role may view one → 200', r.status === 200 && r.json.isOpen === true, r.status);

  // ---------- apply: format and validation ----------
  r = await call('POST', '/api/applications', { token: 'test-admin', body: goodBody('test-open') });
  check('T-APP-08', 'apply as admin → 403 FORBIDDEN', r.status === 403 && r.json?.error?.code === 'FORBIDDEN', r.status);

  r = await call('POST', '/api/applications', { body: goodBody('test-open') });
  check('T-APP-09', 'apply without a token → 401', r.status === 401, r.status);

  r = await call('POST', '/api/applications', { token: S1, raw: 'hello', type: 'text/plain' });
  check('T-APP-10', 'apply with text/plain → 415', r.status === 415 && r.json?.error?.code === 'UNSUPPORTED_MEDIA_TYPE', r.status);

  r = await call('POST', '/api/applications', { token: S1, raw: '{"essay": ' });
  check('T-APP-11', 'apply with broken JSON → 400', r.status === 400 && r.json?.error?.code === 'VALIDATION_ERROR', r.status);

  r = await call('POST', '/api/applications', { token: S1, body: { ...goodBody('test-open'), essay: 'too short' } });
  check('T-APP-12', 'essay under 200 words → 400', r.status === 400 && /200 and 1000 words/.test(r.json?.error?.message), r.json?.error?.message);

  r = await call('POST', '/api/applications', { token: S1, body: { ...goodBody('test-open'), gpa: '3.5' } });
  check('T-APP-13', 'gpa sent as a string → 400', r.status === 400, r.status);

  r = await call('POST', '/api/applications', { token: S1, body: { ...goodBody('test-open'), yearOfStudy: 9 } });
  check('T-APP-14', 'yearOfStudy 9 → 400', r.status === 400, r.status);

  r = await call('POST', '/api/applications', { token: S1, body: { ...goodBody('test-open'), pdfBase64: Buffer.from('MZ fake.exe renamed to cv.pdf').toString('base64') } });
  check('T-APP-15', 'file that is not a PDF (by content) → 400', r.status === 400 && /PDF/.test(r.json?.error?.message), r.json?.error?.message);

  r = await call('POST', '/api/applications', { token: S1, body: { ...goodBody('test-open'), pdfBase64: 'not base64!!' } });
  check('T-APP-16', 'pdfBase64 not base64 → 400', r.status === 400, r.status);

  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  r = await call('POST', '/api/applications', { token: S1, body: { ...goodBody('test-open'), pdfBase64: big } });
  check('T-APP-17', 'PDF over 2 MB → 413', r.status === 413 && r.json?.error?.code === 'PAYLOAD_TOO_LARGE', r.status);

  // ---------- apply: business rules ----------
  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-draft') });
  check('T-APP-18', 'apply to a draft → 404', r.status === 404, r.status);

  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-closed') });
  check('T-APP-19', 'apply to a closed scholarship → 409', r.status === 409 && /closed/.test(r.json?.error?.message), r.json?.error?.message);

  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-expired') });
  check('T-APP-20', 'apply after the deadline → 409', r.status === 409 && /deadline/.test(r.json?.error?.message), r.json?.error?.message);

  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-strict') });
  check('T-APP-21', 'email domain not allowed → 409 with reason', r.status === 409 && /only open to students with an email/.test(r.json?.error?.message), r.json?.error?.message);

  // Extra fields that try to set server-owned values must be ignored.
  r = await call('POST', '/api/applications', { token: S1, body: { ...goodBody('test-open'), studentId: S2, status: 'accepted' } });
  const appId = r.json?.applicationId;
  check('T-APP-22', 'valid application → 201 submitted', r.status === 201 && r.json.status === 'submitted' && !!appId, `${r.status} ${JSON.stringify(r.json)}`);

  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-open') });
  check('T-APP-23', 'second application to the same scholarship → 409', r.status === 409 && /already applied/.test(r.json?.error?.message), r.json?.error?.message);

  // ---------- my applications ----------
  r = await call('GET', '/api/applications/mine', { token: S1 });
  const mine = (r.json || []).find((a) => a.applicationId === appId);
  check('T-APP-24', 'mine → 200 with my application + timeline', r.status === 200 && !!mine && Array.isArray(mine.timeline) && mine.canWithdraw === true, r.status);
  check('T-APP-25', 'body studentId/status were ignored (still mine, still submitted)', !!mine && mine.status === 'submitted');
  check('T-APP-26', 'student view has no reviewerId/flag/essay', !!mine && !('reviewerId' in mine) && !('flagged' in mine) && !('essay' in mine));

  r = await call('GET', '/api/applications/mine', { token: S2 });
  check('T-APP-27', "student 2 doesn't see student 1's application", r.status === 200 && !r.json.some((a) => a.applicationId === appId), r.status);

  r = await call('GET', '/api/applications/mine', { token: 'test-reviewer' });
  check('T-APP-28', 'mine as reviewer → 403', r.status === 403, r.status);

  // ---------- PDF download ----------
  r = await call('GET', `/api/applications/${appId}/pdf`, { token: S1 });
  check('T-APP-29', 'own PDF → 200 presigned URL, 300 s, no-store',
    r.status === 200 && /scholarship-documents\/applications\//.test(r.json?.url) && r.json.expiresIn === 300 && r.headers.get('cache-control') === 'no-store', r.status);
  if (r.status === 200) {
    const file = await fetch(r.json.url).catch(() => null);
    const bytes = file ? Buffer.from(await file.arrayBuffer()) : Buffer.alloc(0);
    check('T-APP-30', 'presigned URL downloads the same PDF', !!file && file.status === 200 && bytes.subarray(0, 5).toString() === '%PDF-',
      file ? file.status : 'URL not reachable from this machine (see note on presigned URLs)');
  }

  r = await call('GET', `/api/applications/${appId}/pdf`, { token: S2 });
  check('T-APP-31', "another student's PDF → 404 (not 403, ids can't be probed)", r.status === 404 && r.json?.error?.code === 'APPLICATION_NOT_FOUND', r.status);

  r = await call('GET', '/api/applications/00000000-0000-0000-0000-000000000000/pdf', { token: S1 });
  check('T-APP-32', 'unknown id → 404', r.status === 404, r.status);

  // ---------- max 3 active + withdraw ----------
  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-open-2') });
  const app2 = r.json?.applicationId;
  const r3 = await call('POST', '/api/applications', { token: S1, body: goodBody('test-open-3') });
  check('T-APP-33', '2nd and 3rd active applications → 201', r.status === 201 && r3.status === 201, `${r.status} ${r3.status}`);

  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-open-4') });
  check('T-APP-34', '4th active application → 409 (max 3)', r.status === 409 && /3 active/.test(r.json?.error?.message), r.json?.error?.message);

  r = await call('DELETE', `/api/applications/${appId}`, { token: S2 });
  check('T-APP-35', "withdraw someone else's application → 404", r.status === 404, r.status);

  // Pretend a reviewer claimed app2 (what review-service will do), then try to withdraw it.
  await doc.send(new UpdateCommand({
    TableName: APPS, Key: { applicationId: app2 },
    UpdateExpression: 'SET #s = :u, reviewerId = :r, claimedAt = :t',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':u': 'under_review', ':r': 'test-reviewer', ':t': new Date().toISOString() },
  }));
  r = await call('DELETE', `/api/applications/${app2}`, { token: S1 });
  check('T-APP-36', 'withdraw after a reviewer claimed it → 409', r.status === 409, r.status);

  r = await call('GET', '/api/applications/mine', { token: S1 });
  const claimed = (r.json || []).find((a) => a.applicationId === app2);
  check('T-APP-37', 'claimed application: timeline "Being reviewed", reviewer hidden',
    !!claimed && claimed.status === 'under_review' && claimed.timeline[1].done === true && !('reviewerId' in claimed) && claimed.canWithdraw === false);

  r = await call('DELETE', `/api/applications/${appId}`, { token: S1 });
  check('T-APP-38', 'withdraw own submitted application → 204', r.status === 204, r.status);

  r = await call('GET', `/api/applications/${appId}/pdf`, { token: S1 });
  check('T-APP-39', 'withdrawn application is gone → 404', r.status === 404, r.status);

  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-open-4') });
  check('T-APP-40', 'after withdrawing, a new application fits under the limit → 201', r.status === 201, r.status);

  r = await call('POST', '/api/applications', { token: S1, body: goodBody('test-open') });
  check('T-APP-41', 're-apply to the withdrawn scholarship while 3 are active → 409 (limit)', r.status === 409, r.status);

  // ---------- general security ----------
  r = await call('GET', '/api/scholarships', { token: S1 });
  check('T-APP-42', 'security headers on every response',
    r.headers.get('x-content-type-options') === 'nosniff' && r.headers.get('x-frame-options') === 'DENY' && r.headers.get('content-security-policy') === "default-src 'none'");

  r = await call('GET', '/api/applications', { token: S1 });
  check('T-APP-43', 'route that does not exist → 404', r.status === 404, r.status);

  await cleanUp();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('test run crashed:', err.name, err.message);
  process.exit(1);
});
