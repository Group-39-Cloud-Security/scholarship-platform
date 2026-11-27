// concurrency-tests.js — the apply limits must hold when requests arrive at the same moment.
// Owner: Mohamed Khalil.   Usage (from services/application-service, after npm run test-data):
//   API_URL=http://localhost:3000 node tests/concurrency-tests.js      (or the Floci API URL)
// Uses test-student-1 and cleans up ONLY the applications this run created (tests/testRun.js): first through
// the API (withdraw releases the lock rows), then directly for any it could not withdraw.
// If test-student-1 already has applications this run did not create, the run is SKIPPED and nothing is deleted.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { createTestRun } = require('./testRun');

const API = (process.env.API_URL || 'http://localhost:3000').replace(/\/$/, '');
const APPS = process.env.APPLICATIONS_TABLE || 'Applications';
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' }));
const STUDENT = 'test-student-1';

const essay = Array.from({ length: 250 }, (_, i) => `word${i}`).join(' ');
const pdf = Buffer.from('%PDF-1.4\n%%EOF\n').toString('base64');
const run = createTestRun([STUDENT]); // remembers every applicationId this run created: the only rows it may remove

const results = [];
function check(id, name, ok, detail = '') {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id.padEnd(10)} ${name}${ok ? '' : `   <-- ${detail}`}`);
}

async function apply(scholarshipId) {
  const res = await fetch(`${API}/api/applications`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STUDENT}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ scholarshipId, essay, gpa: 3.2, yearOfStudy: 2, pdfBase64: pdf }),
  });
  const json = await res.json().catch(() => null);
  if (res.status === 201) run.track(json?.applicationId);
  return { status: res.status, json };
}

async function withdraw(applicationId) {
  const res = await fetch(`${API}/api/applications/${applicationId}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${STUDENT}` },
  });
  if (res.status === 204) run.forget(applicationId);
  return res.status;
}

async function studentApplications() {
  const { Items = [] } = await doc.send(new QueryCommand({
    TableName: APPS, IndexName: 'studentId-index',
    KeyConditionExpression: 'studentId = :s', ExpressionAttributeValues: { ':s': STUDENT },
  }));
  return Items;
}

const ACTIVE = ['submitted', 'under_review', 'reviewed'];

(async () => {
  console.log(`Concurrency tests against ${API}\n`);
  const foreign = await run.foreignRows();
  if (foreign.length > 0) {
    console.log(`SKIP  all tests: ${STUDENT} already has ${foreign.length} application(s) this run did not create:`);
    for (const a of foreign) console.log(`        ${a.applicationId} (${a.scholarshipId}, ${a.status})`);
    console.log('      Nothing was deleted. Withdraw or remove them, then run again.');
    process.exit(0);
  }

  try {
    // T-APP-44: the same scholarship twice at the same moment → exactly one 201.
    const [a, b] = await Promise.all([apply('test-open'), apply('test-open')]);
    const statuses = [a.status, b.status].sort();
    const loser = a.status === 201 ? b : a;
    check('T-APP-44', 'same scholarship, 2 requests at once → exactly one 201',
      statuses[0] === 201 && statuses[1] === 409 && /already applied/.test(loser.json?.error?.message || ''),
      `${a.status} ${b.status} ${loser.json?.error?.message || ''}`);
    const sameScholarship = (await studentApplications()).filter((x) => x.scholarshipId === 'test-open');
    check('T-APP-45', 'only one application stored for that scholarship', sameScholarship.length === 1, `${sameScholarship.length} stored`);

    // T-APP-46: 2 active, then 2 different scholarships at the same moment → exactly one 201 (limit is 3).
    const second = await apply('test-open-2');
    const [c, d] = await Promise.all([apply('test-open-3'), apply('test-open-4')]);
    const pair = [c.status, d.status].sort();
    const lost = c.status === 201 ? d : c;
    check('T-APP-46', 'with 2 active, 2 requests at once for different scholarships → exactly one 201',
      second.status === 201 && pair[0] === 201 && pair[1] === 409 && /3 active/.test(lost.json?.error?.message || ''),
      `${second.status} | ${c.status} ${d.status} ${lost.json?.error?.message || ''}`);
    const active = (await studentApplications()).filter((x) => ACTIVE.includes(x.status));
    check('T-APP-47', 'never more than 3 active applications stored', active.length === 3, `${active.length} active`);

    // T-APP-48: withdrawing releases the scholarship and the slot: the same scholarship can be applied to again.
    const firstId = (a.status === 201 ? a : b).json.applicationId;
    const w = await withdraw(firstId);
    const again = await apply('test-open');
    check('T-APP-48', 'after a withdraw, the same scholarship can be applied to again → 204 then 201',
      w === 204 && again.status === 201, `${w} ${again.status} ${again.json?.error?.message || ''}`);
  } finally {
    // Clean up only what this run created. Withdraw also deletes the PDF and the lock rows;
    // anything that can't be withdrawn is removed directly (still only this run's rows).
    for (const id of [...run.created]) await withdraw(id);
    const removedDirectly = await run.cleanup();
    const left = await studentApplications();
    console.log(`\ncleanup: ${removedDirectly} removed directly, ${left.length} application(s) left for ${STUDENT}`);
  }

  const failed = results.filter((x) => !x.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('test run crashed:', err.name, err.message);
  process.exit(1);
});
