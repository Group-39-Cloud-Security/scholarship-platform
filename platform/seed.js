// seed.js — demo and test data for a fresh Floci. Run by platform/seed.sh (which reads platform/.env), never by hand.
// Owner: Mohamed Wael · Rules: CLAUDE.md §5 (data design), §6 (business rules), §10 (no secrets in code or logs)
//
// Safe to re-run: every item has a fixed id and is written with PutItem, so a re-run puts the demo data back
// to its starting state. Passwords come only from the environment (platform/.env) and are never printed.
//
//   admin       SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD
//   reviewer1-2 reviewer1@, reviewer2@<first ALLOWED_DOMAINS domain>  } SEED_TEST_PASSWORD
//   student1-4  student1@ ... student4@<same domain>                   }
// student1 and student2 have NO applications: the test runners use them. student3 and student4 hold the demo
// applications, one in each status: submitted, under_review, reviewed (scored) and reviewed (flagged).
// Every seeded account has mustChangePassword = false, so the demo flow is never blocked.

const path = require('path');
const crypto = require('crypto');
const { createRequire } = require('module');

// The SDK and bcryptjs come from auth-service's node_modules (deploy-all.sh installs them before seeding).
const need = createRequire(path.join(__dirname, '../services/auth-service/package.json'));
const bcrypt = need('bcryptjs');
const { DynamoDBClient } = need('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand } = need('@aws-sdk/lib-dynamodb');

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const env = (name) => (process.env[name] || '').trim();
const fail = (msg) => { console.error(`seed: ${msg}`); process.exit(1); };

// ---------- the same password rules as auth-service register (§6) ----------
async function checkPassword(name, value) {
  if (value.length < 10) fail(`${name} in platform/.env must be at least 10 characters.`);
  if (Buffer.byteLength(value, 'utf8') > 72) fail(`${name} in platform/.env is longer than 72 bytes.`);
  const sha1 = crypto.createHash('sha1').update(value, 'utf8').digest('hex').toUpperCase();
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`, {
      headers: { 'Add-Padding': 'true' }, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const found = (await res.text()).split('\n').some((l) => {
      const [s, n] = l.trim().split(':');
      return s === sha1.slice(5) && Number(n) > 0;
    });
    if (found) fail(`${name} in platform/.env appears in a data breach (Pwned Passwords). Choose another one.`);
  } catch {
    console.log(`seed: WARNING could not reach Pwned Passwords to check ${name}; only the length rule was checked.`);
  }
}

const ADMIN_EMAIL = env('SEED_ADMIN_EMAIL').toLowerCase();
const ADMIN_PASSWORD = env('SEED_ADMIN_PASSWORD');
const TEST_PASSWORD = env('SEED_TEST_PASSWORD');
const DOMAIN = (env('ALLOWED_DOMAINS') || 'example-university.edu').split(',')[0].trim().toLowerCase();

// Fixed ids, so re-running overwrites instead of adding. They are valid v4-style UUIDs (admin-service checks ids).
const id = (group, n) => `5eed${group}000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const U = { admin: id('0', 1), reviewer1: id('0', 2), reviewer2: id('0', 3),
  student1: id('0', 11), student2: id('0', 12), student3: id('0', 13), student4: id('0', 14) };
const S = { cloud: id('1', 1), women: id('1', 2), draft: id('1', 3) };
const A = { submitted: id('2', 1), underReview: id('2', 2), scored: id('2', 3), flagged: id('2', 4) };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
for (const v of [...Object.values(U), ...Object.values(S), ...Object.values(A)]) {
  if (!UUID.test(v)) fail(`fixed id ${v} is not a valid UUID`); // the services reject ids that aren't
}

async function findUserId(email) {
  const res = await doc.send(new QueryCommand({
    TableName: 'Users', IndexName: 'email-index', KeyConditionExpression: 'email = :e', ExpressionAttributeValues: { ':e': email },
  }));
  return res.Items && res.Items[0] ? res.Items[0].userId : null;
}

async function putUser(key, email, name, role, password) {
  // An account someone already made with this email keeps its userId (emails must stay unique).
  const userId = (await findUserId(email)) || U[key];
  U[key] = userId;
  await doc.send(new PutCommand({ TableName: 'Users', Item: {
    userId, email, name, role, status: 'active', mustChangePassword: false,
    passwordHash: await bcrypt.hash(password, 10), createdAt: new Date().toISOString(),
  } }));
}

const RUBRIC = [
  { criterionId: 'academic', name: 'Academic record', description: 'Grades and transcript', weight: 40 },
  { criterionId: 'essay', name: 'Essay', description: 'Clarity, motivation and fit', weight: 40 },
  { criterionId: 'need', name: 'Financial need', description: 'Evidence of financial need', weight: 20 },
];
const inDays = (d) => new Date(Date.now() + d * 864e5).toISOString();
const ESSAY = Array.from({ length: 230 }, (_, i) => ['I', 'want', 'to', 'study', 'cloud', 'security', 'because', 'it',
  'protects', 'people'][i % 10]).join(' ') + '.';

async function main() {
  if (!ADMIN_EMAIL || !ADMIN_EMAIL.includes('@')) fail('SEED_ADMIN_EMAIL is missing in platform/.env.');
  if (!ADMIN_PASSWORD) fail('SEED_ADMIN_PASSWORD is missing in platform/.env.');
  if (!TEST_PASSWORD) fail('SEED_TEST_PASSWORD is missing in platform/.env.');
  if (ADMIN_PASSWORD === TEST_PASSWORD) fail('SEED_ADMIN_PASSWORD and SEED_TEST_PASSWORD must be different.');
  await checkPassword('SEED_ADMIN_PASSWORD', ADMIN_PASSWORD);
  await checkPassword('SEED_TEST_PASSWORD', TEST_PASSWORD);

  // ---------- users ----------
  await putUser('admin', ADMIN_EMAIL, 'Platform Admin', 'admin', ADMIN_PASSWORD);
  await putUser('reviewer1', `reviewer1@${DOMAIN}`, 'Reviewer One', 'reviewer', TEST_PASSWORD);
  await putUser('reviewer2', `reviewer2@${DOMAIN}`, 'Reviewer Two', 'reviewer', TEST_PASSWORD);
  for (const n of [1, 2, 3, 4]) await putUser(`student${n}`, `student${n}@${DOMAIN}`, `Student ${n}`, 'student', TEST_PASSWORD);
  console.log('seed: 7 users (1 admin, 2 reviewers, 4 students)');

  // ---------- scholarships: 2 published, 1 draft ----------
  const now = new Date().toISOString();
  const scholarship = (scholarshipId, title, description, days, awards, status, eligibility) => ({
    scholarshipId, title, description, deadline: inDays(days), awards, acceptedCount: 0, status, rubric: RUBRIC,
    eligibility, createdBy: U.admin, createdAt: now,
  });
  for (const item of [
    scholarship(S.cloud, 'Cloud Excellence Award', 'For students building secure systems on the cloud.', 60, 2, 'published',
      { allowedDomains: [DOMAIN], minGpa: 2.5, years: [1, 2, 3, 4, 5, 6] }),
    scholarship(S.women, 'Women in Computing Grant', 'Supports women studying computer science or engineering.', 30, 1, 'published',
      { allowedDomains: [DOMAIN], minGpa: 3, years: [2, 3, 4] }),
    scholarship(S.draft, 'Research Assistant Fund', 'Draft: not visible to students until published.', 90, 3, 'draft',
      { allowedDomains: [DOMAIN], minGpa: 3.5, years: [3, 4, 5, 6] }),
  ]) await doc.send(new PutCommand({ TableName: 'Scholarships', Item: item }));
  console.log('seed: 3 scholarships (2 published, 1 draft)');

  // ---------- applications, one per status, with application-service's lock rows ----------
  const ago = (h) => new Date(Date.now() - h * 36e5).toISOString();
  const apps = [
    { applicationId: A.submitted, student: 'student3', scholarshipId: S.cloud, status: 'submitted', submittedAt: ago(30), slot: 1 },
    { applicationId: A.underReview, student: 'student3', scholarshipId: S.women, status: 'under_review', submittedAt: ago(28), slot: 2,
      reviewerId: U.reviewer1, claimedAt: ago(2) },
    { applicationId: A.scored, student: 'student4', scholarshipId: S.cloud, status: 'reviewed', submittedAt: ago(26), slot: 1,
      reviewerId: U.reviewer1, claimedAt: ago(20), flagged: false },
    { applicationId: A.flagged, student: 'student4', scholarshipId: S.women, status: 'reviewed', submittedAt: ago(24), slot: 2,
      reviewerId: U.reviewer2, claimedAt: ago(19), flagged: true },
  ];
  for (const a of apps) {
    const studentId = U[a.student];
    await doc.send(new PutCommand({ TableName: 'Applications', Item: {
      applicationId: a.applicationId, studentId, studentEmail: `${a.student}@${DOMAIN}`, scholarshipId: a.scholarshipId,
      essay: ESSAY, gpa: 3.4, yearOfStudy: 2, pdfKey: `applications/${a.applicationId}.pdf`, status: a.status,
      reviewerId: a.reviewerId, claimedAt: a.claimedAt, flagged: a.flagged, submittedAt: a.submittedAt,
    } }));
    // Same rows application-service writes when a student applies (one per scholarship + one active slot).
    for (const [key, lockType] of [[`lock#one#${studentId}#${a.scholarshipId}`, 'one-per-scholarship'],
      [`lock#slot#${studentId}#${a.slot}`, 'active-slot']]) {
      await doc.send(new PutCommand({ TableName: 'Applications', Item: {
        applicationId: key, lockType, holder: a.applicationId, createdAt: a.submittedAt,
      } }));
    }
  }
  await doc.send(new PutCommand({ TableName: 'Reviews', Item: {
    applicationId: A.scored, reviewerId: U.reviewer1, scores: { academic: 8, essay: 7, need: 6 },
    totalScore: 72, comment: 'Clear goals and a strong transcript.', flagged: false, submittedAt: ago(18),
  } }));
  await doc.send(new PutCommand({ TableName: 'Reviews', Item: {
    applicationId: A.flagged, reviewerId: U.reviewer2, flagged: true, flagReason: 'ineligible',
    flagNote: 'The transcript in the PDF shows year 1, not year 2.', comment: '', submittedAt: ago(17),
  } }));
  console.log('seed: 4 applications (submitted, under_review, reviewed, reviewed + flagged) and 2 reviews');

  // The PDFs seed.sh uploads to scholarship-documents (one per application).
  process.stdout.write(`PDF_KEYS=${apps.map((a) => `applications/${a.applicationId}.pdf`).join(' ')}\n`);
}

main().catch((err) => fail(`${err.name}: ${err.message}`));
