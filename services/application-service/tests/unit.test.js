// unit.test.js — pure business rules, no AWS needed.   Run: npm test   (node --test)
// Owner: Mohamed Khalil

const test = require('node:test');
const assert = require('node:assert');
const { checkEligibility, checkApplicationLimits, isDeadlinePassed, emailDomain } = require('../src/services/eligibility');
const { decodePdf } = require('../src/services/pdfCheck');
const { buildTimeline, toStudentView } = require('../src/controllers/applications');

const sch = { eligibility: { allowedDomains: ['uni.edu'], minGpa: 3, years: [2, 3] } };

test('eligible student passes', () => {
  assert.strictEqual(checkEligibility({ email: 'a@UNI.edu', gpa: 3, yearOfStudy: 2 }, sch), null);
});
test('wrong email domain is rejected', () => {
  assert.match(checkEligibility({ email: 'a@other.edu', gpa: 4, yearOfStudy: 2 }, sch), /only open to students with an email/);
});
test('a lookalike domain is rejected (a@uni.edu.evil.com)', () => {
  assert.notStrictEqual(checkEligibility({ email: 'a@uni.edu.evil.com', gpa: 4, yearOfStudy: 2 }, sch), null);
});
test('GPA below minimum is rejected', () => {
  assert.match(checkEligibility({ email: 'a@uni.edu', gpa: 2.9, yearOfStudy: 2 }, sch), /GPA/);
});
test('year not allowed is rejected', () => {
  assert.match(checkEligibility({ email: 'a@uni.edu', gpa: 4, yearOfStudy: 1 }, sch), /year/);
});
test('empty rules mean no restriction', () => {
  assert.strictEqual(checkEligibility({ email: 'x@y.z', gpa: 0, yearOfStudy: 1 }, { eligibility: {} }), null);
});
test('emailDomain uses the last @', () => {
  assert.strictEqual(emailDomain('a@b@Uni.EDU'), 'uni.edu');
});

test('deadline: past, future, missing, garbage', () => {
  const now = Date.parse('2026-01-10T00:00:00Z');
  assert.strictEqual(isDeadlinePassed('2026-01-09T00:00:00Z', now), true);
  assert.strictEqual(isDeadlinePassed('2026-01-11T00:00:00Z', now), false);
  assert.strictEqual(isDeadlinePassed(undefined, now), true);
  assert.strictEqual(isDeadlinePassed('soon', now), true);
});

test('one application per scholarship', () => {
  assert.match(checkApplicationLimits([{ scholarshipId: 's1', status: 'rejected' }], 's1'), /already applied/);
});
test('max 3 active, final ones do not count', () => {
  const three = ['submitted', 'under_review', 'reviewed'].map((status, i) => ({ scholarshipId: `x${i}`, status }));
  assert.match(checkApplicationLimits(three, 'new'), /3 active/);
  const withFinal = [...three.slice(0, 2), { scholarshipId: 'x9', status: 'accepted' }];
  assert.strictEqual(checkApplicationLimits(withFinal, 'new'), null);
});

test('PDF: valid file decodes', () => {
  const b64 = Buffer.from('%PDF-1.7 hello').toString('base64');
  assert.strictEqual(decodePdf(b64).subarray(0, 5).toString(), '%PDF-');
});
test('PDF: renamed exe is rejected by content', () => {
  assert.throws(() => decodePdf(Buffer.from('MZ....').toString('base64')), (e) => e.status === 400);
});
test('PDF: invalid base64 is rejected', () => {
  assert.throws(() => decodePdf('%%%%'), (e) => e.status === 400);
});
test('PDF: over 2 MB is 413', () => {
  const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(2 * 1024 * 1024)]).toString('base64');
  assert.throws(() => decodePdf(big), (e) => e.status === 413);
});
test('PDF: missing is 400', () => {
  assert.throws(() => decodePdf(undefined), (e) => e.status === 400);
});

test('timeline follows the status', () => {
  const t = buildTimeline({ status: 'reviewed', submittedAt: 'a' });
  assert.deepStrictEqual(t.map((s) => s.done), [true, true, true, false]);
  const d = buildTimeline({ status: 'accepted', submittedAt: 'a', decidedAt: 'b' });
  assert.strictEqual(d[3].label, 'Decision: accepted');
  assert.strictEqual(d[3].at, 'b');
});
test('student view never contains reviewer, flag or essay', () => {
  const v = toStudentView({ applicationId: '1', status: 'reviewed', reviewerId: 'r', flagged: true, flagReason: 'plagiarism_suspected', essay: 'e', submittedAt: 'a' }, { title: 't', deadline: '2999-01-01T00:00:00Z' });
  for (const k of ['reviewerId', 'flagged', 'flagReason', 'essay', 'studentId', 'pdfKey']) assert.ok(!(k in v), k);
});

// ---------- year of study: 1 to 6 ----------
// apply() checks the year before any AWS call, so a wrong year fails here without a network.
const { apply } = require('../src/controllers/applications');
const essay200 = Array.from({ length: 200 }, (_, i) => `w${i}`).join(' ');
function applyWithYear(yearOfStudy, pdfBase64 = 'not-a-pdf') {
  const req = {
    is: () => true,
    user: { userId: 'test-student-1', email: 'student1@example-university.edu', role: 'student' },
    body: { scholarshipId: 'test-open', essay: essay200, gpa: 3, yearOfStudy, pdfBase64 },
  };
  return new Promise((resolve) => { apply(req, {}, resolve); }); // next(err) resolves with the error
}

test('year of study 0 is rejected with 400', async () => {
  const err = await applyWithYear(0);
  assert.strictEqual(err.status, 400);
  assert.strictEqual(err.message, 'Year of study must be between 1 and 6.');
});
test('year of study 7 is rejected with 400', async () => {
  const err = await applyWithYear(7);
  assert.strictEqual(err.status, 400);
  assert.strictEqual(err.message, 'Year of study must be between 1 and 6.');
});
test('years 1 and 6 pass the year check (the request stops later, at the PDF)', async () => {
  for (const year of [1, 6]) {
    const err = await applyWithYear(year); // invalid PDF on purpose: fails after the year check, before AWS
    assert.match(err.message, /pdfBase64/, `year ${year}`);
  }
});
