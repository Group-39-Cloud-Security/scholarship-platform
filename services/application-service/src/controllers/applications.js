// applications.js — apply · my applications + timeline · own PDF download · withdraw
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §6 Applying, §8, §10
// Controller: 415 → 400 validation → business rules (409) → AWS calls through services/ → status code.
// Every route here already passed authenticate + requireRole('student') (routes/applications.js).

const crypto = require('crypto');
const {
  validationError, notFound, conflict, unsupportedMediaType,
} = require('../../shared/errors');
const { checkWords, checkNumber, checkInt } = require('../../shared/validate');
const { writeAudit } = require('../../shared/audit');
const { log } = require('../../shared/logger');
const { getScholarship } = require('../services/scholarshipReadService');
const {
  createApplication, getApplication, listByStudent, deleteIfSubmitted,
} = require('../services/applicationService');
const {
  pdfKey, putPdf, deletePdf, presignPdf, PRESIGN_SECONDS,
} = require('../services/documentService');
const { decodePdf } = require('../services/pdfCheck');
const { isDeadlinePassed, checkEligibility, checkApplicationLimits } = require('../services/eligibility');

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const YEAR_MIN = 1; // year of study: 1 to 6 (API contract)
const YEAR_MAX = 6;

// ---------- helpers ----------

// Loads an application and checks it belongs to the logged-in student.
// Unknown id, badly formed id and SOMEONE ELSE'S application all give the same 404,
// so a student can't find out which ids exist by trying them (§8, ownership check §10).
async function loadOwnApplication(id, studentId) {
  if (!ID_RE.test(id)) throw notFound('Application');
  const application = await getApplication(id);
  if (!application || application.studentId !== studentId) throw notFound('Application');
  return application;
}

// Status timeline for the student, built from the status and the timestamps already in the item.
const STAGE = { submitted: 0, under_review: 1, reviewed: 2, accepted: 3, rejected: 3 };
function buildTimeline(a) {
  const stage = STAGE[a.status] ?? 0;
  const final = a.status === 'accepted' || a.status === 'rejected';
  return [
    { step: 'submitted', label: 'Application submitted', done: true, at: a.submittedAt },
    { step: 'under_review', label: 'Being reviewed', done: stage >= 1, at: a.status === 'under_review' ? a.claimedAt : undefined },
    { step: 'reviewed', label: 'Review finished', done: stage >= 2 },
    { step: 'decision', label: final ? `Decision: ${a.status}` : 'Decision', done: final, at: final ? a.decidedAt : undefined },
  ];
}

// What a student may see about their own application: an explicit allow-list of fields.
// reviewerId, flagged, flagReason and scores are never copied, so they can't leak by accident (§6).
function toStudentView(a, scholarship) {
  const deadline = scholarship ? scholarship.deadline : undefined;
  return {
    applicationId: a.applicationId,
    scholarshipId: a.scholarshipId,
    scholarshipTitle: scholarship ? scholarship.title : '(scholarship no longer available)',
    deadline,
    status: a.status,
    gpa: a.gpa,
    yearOfStudy: a.yearOfStudy,
    submittedAt: a.submittedAt,
    decidedAt: a.status === 'accepted' || a.status === 'rejected' ? a.decidedAt : undefined,
    timeline: buildTimeline(a),
    canWithdraw: a.status === 'submitted' && !isDeadlinePassed(deadline),
  };
}

// ---------- POST /api/applications ----------
// Body: { scholarshipId, essay, gpa, yearOfStudy, pdfBase64 }. Anything else in the body (studentId, status, ...) is ignored.
async function apply(req, res, next) {
  try {
    // 1. Format: JSON only (415), then every field (400 with one clear message).
    if (!req.is('application/json')) throw unsupportedMediaType();
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw validationError('Request body must be a JSON object.');
    }
    if (typeof body.scholarshipId !== 'string' || !ID_RE.test(body.scholarshipId)) {
      throw validationError('scholarshipId is required.');
    }
    const { scholarshipId } = body;
    const essay = checkWords(body.essay, 'Essay', 200, 1000, 10000);
    const gpa = checkNumber(body.gpa, 'GPA', 0, 4);
    const yearOfStudy = checkInt(body.yearOfStudy, 'Year of study', YEAR_MIN, YEAR_MAX);
    const pdfBytes = decodePdf(body.pdfBase64); // 400 not base64 / not a PDF, 413 over 2 MB

    // 2. Business rules (409), in the order a student would understand them.
    const scholarship = await getScholarship(scholarshipId);
    if (!scholarship || scholarship.status === 'draft') throw notFound('Scholarship'); // drafts are invisible
    if (scholarship.status !== 'published') throw conflict('This scholarship is closed and no longer accepts applications.');
    if (isDeadlinePassed(scholarship.deadline)) throw conflict('The deadline for this scholarship has passed.');

    // Eligibility: the email domain comes from the TOKEN (req.user), never from the body.
    const notEligible = checkEligibility({ email: req.user.email, gpa, yearOfStudy }, scholarship);
    if (notEligible) throw conflict(notEligible);

    const mine = await listByStudent(req.user.userId);
    const overLimit = checkApplicationLimits(mine, scholarshipId);
    if (overLimit) throw conflict(overLimit);

    // 3. Save: PDF first, then the item. If the item fails, the PDF is removed again (no orphaned personal files).
    //    The server sets id, owner, status and time (§5) — none of them come from the client.
    const applicationId = crypto.randomUUID();
    const key = pdfKey(applicationId);
    const submittedAt = new Date().toISOString();
    await putPdf(key, pdfBytes);
    try {
      await createApplication({
        applicationId,
        studentId: req.user.userId,
        studentEmail: req.user.email, // used later by admin-service for the decision email
        scholarshipId,
        essay,
        gpa,
        yearOfStudy,
        pdfKey: key,
        status: 'submitted',
        submittedAt,
      });
    } catch (err) {
      await deletePdf(key).catch(() => {});
      throw err;
    }

    res.locals.action = 'application_submitted';
    await writeAudit({ action: 'application_submitted', userId: req.user.userId, targetId: applicationId, detail: `scholarship ${scholarshipId}` });
    res.status(201).json({ applicationId, scholarshipId, status: 'submitted', submittedAt });
  } catch (err) {
    next(err);
  }
}

// ---------- GET /api/applications/mine ----------
async function listMine(req, res, next) {
  try {
    const mine = await listByStudent(req.user.userId);
    // Look each scholarship up once (a student has few applications, so this is a handful of GetItems).
    const ids = [...new Set(mine.map((a) => a.scholarshipId))];
    const scholarships = new Map(await Promise.all(ids.map(async (id) => [id, await getScholarship(id)])));
    const result = mine
      .sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt))) // newest first
      .map((a) => toStudentView(a, scholarships.get(a.scholarshipId)));
    res.status(200).json(result); // [] when the student has none
  } catch (err) {
    next(err);
  }
}

// ---------- GET /api/applications/{id}/pdf ----------
// Ownership check FIRST, then a presigned link valid 5 minutes. The bucket is never public.
async function downloadPdf(req, res, next) {
  try {
    const application = await loadOwnApplication(req.params.id, req.user.userId);
    const url = await presignPdf(application.pdfKey);
    res.locals.action = 'pdf_download';
    res.set('Cache-Control', 'no-store'); // the link is a temporary secret: don't let anything cache it
    res.status(200).json({ url, expiresIn: PRESIGN_SECONDS });
  } catch (err) {
    next(err);
  }
}

// ---------- DELETE /api/applications/{id} ----------
// Only while "submitted" and before the deadline; deletes the item AND its PDF; the student may then apply again.
async function withdraw(req, res, next) {
  try {
    const application = await loadOwnApplication(req.params.id, req.user.userId);
    if (application.status !== 'submitted') {
      throw conflict('Only applications that a reviewer has not picked up yet can be withdrawn.');
    }
    const scholarship = await getScholarship(application.scholarshipId);
    if (scholarship && isDeadlinePassed(scholarship.deadline)) {
      throw conflict('The deadline has passed, so this application can no longer be withdrawn.');
    }
    // Conditional delete: if a reviewer claimed it a moment ago, DynamoDB refuses and we answer 409.
    const deleted = await deleteIfSubmitted(application.applicationId, req.user.userId);
    if (!deleted) throw conflict('A reviewer has just picked up this application, so it can no longer be withdrawn.');

    try {
      await deletePdf(application.pdfKey);
    } catch (err) {
      // The withdrawal already happened; log (no personal data) so the file can be cleaned up.
      log('error', 'pdf delete failed after withdraw', { applicationId: application.applicationId, error: err.name });
    }

    res.locals.action = 'application_withdrawn';
    await writeAudit({ action: 'application_withdrawn', userId: req.user.userId, targetId: application.applicationId, detail: `scholarship ${application.scholarshipId}` });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

module.exports = { apply, listMine, downloadPdf, withdraw, buildTimeline, toStudentView };
