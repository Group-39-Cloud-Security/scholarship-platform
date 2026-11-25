// reviews.js — queue · claim · score/flag · my reviews · release · PDF
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §6 Reviewing, §8 API, §10 security
//
// Controller job (§9): check Content-Type (415), validate input (400), apply the business rules,
// pick the status code, and next(error) on failure. All AWS calls live in ../services.
// The reviewer's id always comes from the token (req.user), never from the body.

const { validationError, unsupportedMediaType, notFound, conflict } = require('../../shared/errors');
const { writeAudit } = require('../../shared/audit');
const statusService = require('../services/applicationStatusService');
const reviewService = require('../services/reviewService');
const scholarshipService = require('../services/scholarshipReadService');
const documentService = require('../services/documentService');
const scoring = require('../services/scoring');

const MAX_ACTIVE_CLAIMS = 5;
const CLAIM_HOURS = 48;
const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

// Ids are server-made UUIDs; anything else is rejected before it reaches DynamoDB.
function checkId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw validationError('applicationId is missing or invalid.');
  return value;
}

function requireJson(req) {
  if (!req.is('application/json')) throw unsupportedMediaType();
}

// The claimer check used by every /{applicationId} route. Someone else's (or a missing) application → 404,
// the same answer for both, so a reviewer can't probe which ids exist.
async function getOwnApplication(applicationId, reviewerId) {
  const app = await statusService.getApplication(applicationId);
  if (!app || app.reviewerId !== reviewerId) throw notFound('Application');
  return app;
}

const expiresAt = (claimedAt) => new Date(Date.parse(claimedAt) + CLAIM_HOURS * 3600 * 1000).toISOString();

// GET /api/reviews/queue — every submitted application, oldest first. No essays, names or emails in the list.
async function viewQueue(req, res, next) {
  try {
    const items = await statusService.listQueue();
    const titles = await scholarshipService.getTitles(items.map((a) => a.scholarshipId));
    res.status(200).json(items.map((a) => ({
      applicationId: a.applicationId,
      scholarshipId: a.scholarshipId,
      scholarshipTitle: titles[a.scholarshipId],
      submittedAt: a.submittedAt,
    })));
  } catch (err) {
    next(err);
  }
}

// POST /api/reviews  { applicationId } — claim one application from the queue.
async function claimApplication(req, res, next) {
  try {
    requireJson(req);
    const applicationId = checkId(req.body.applicationId);
    const reviewerId = req.user.userId;

    // Rule: at most 5 applications under review per reviewer at once.
    const active = await statusService.listActiveClaims(reviewerId);
    if (active.length >= MAX_ACTIVE_CLAIMS) {
      throw conflict(`You already have ${MAX_ACTIVE_CLAIMS} applications under review. Submit or release one first.`);
    }

    // Rule: atomic claim. The conditional update only succeeds while the status is still `submitted`,
    // so if two reviewers click at the same moment exactly one wins and the other gets 409.
    const claimedAt = new Date().toISOString();
    const won = await statusService.claim(applicationId, reviewerId, claimedAt);
    if (!won) {
      const app = await statusService.getApplication(applicationId);
      if (!app) throw notFound('Application');
      throw conflict('This application is no longer in the queue (already claimed or reviewed).');
    }

    res.locals.action = 'claim';
    await writeAudit({ action: 'claim', userId: reviewerId, targetId: applicationId, detail: 'claimed' });
    res.status(201).json({ applicationId, status: 'under_review', claimedAt, expiresAt: expiresAt(claimedAt) });
  } catch (err) {
    next(err);
  }
}

// GET /api/reviews/mine — my open claims (with when they expire) + my submitted reviews.
async function myReviews(req, res, next) {
  try {
    const reviewerId = req.user.userId;
    const [claims, reviews] = await Promise.all([
      statusService.listActiveClaims(reviewerId),
      reviewService.listByReviewer(reviewerId),
    ]);
    // Reviews don't store the scholarship, so look up each reviewed application once to show its title.
    const reviewedApps = await Promise.all(reviews.map((r) => statusService.getApplication(r.applicationId)));
    const scholarshipOf = {};
    reviewedApps.forEach((a) => { if (a) scholarshipOf[a.applicationId] = a.scholarshipId; });
    const titles = await scholarshipService.getTitles([
      ...claims.map((c) => c.scholarshipId),
      ...Object.values(scholarshipOf),
    ]);

    res.status(200).json({
      claims: claims.map((c) => ({
        applicationId: c.applicationId,
        scholarshipId: c.scholarshipId,
        scholarshipTitle: titles[c.scholarshipId],
        claimedAt: c.claimedAt,
        expiresAt: expiresAt(c.claimedAt),
      })),
      reviews: reviews.map((r) => ({
        applicationId: r.applicationId,
        scholarshipTitle: titles[scholarshipOf[r.applicationId]] ?? null,
        totalScore: r.totalScore ?? null,
        flagged: r.flagged,
        flagReason: r.flagReason ?? null,
        submittedAt: r.submittedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/reviews/{applicationId} — the application + the scholarship's rubric, for the claimer only.
// The student's id and email are left out on purpose: the reviewer scores the work, not the person.
async function getForReview(req, res, next) {
  try {
    const applicationId = checkId(req.params.applicationId);
    const app = await getOwnApplication(applicationId, req.user.userId);
    const [scholarship, review] = await Promise.all([
      scholarshipService.getScholarship(app.scholarshipId),
      app.status === 'under_review' ? null : reviewService.getReview(applicationId),
    ]);
    res.status(200).json({
      application: {
        applicationId: app.applicationId,
        scholarshipId: app.scholarshipId,
        status: app.status,
        essay: app.essay,
        gpa: app.gpa,
        yearOfStudy: app.yearOfStudy,
        hasPdf: Boolean(app.pdfKey),
        submittedAt: app.submittedAt,
        claimedAt: app.claimedAt ?? null,
        expiresAt: app.status === 'under_review' && app.claimedAt ? expiresAt(app.claimedAt) : null,
      },
      scholarship: scholarship && {
        scholarshipId: scholarship.scholarshipId,
        title: scholarship.title,
        deadline: scholarship.deadline,
        rubric: scholarship.rubric || [],
        eligibility: scholarship.eligibility || null,
      },
      review,
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/reviews/{applicationId} — submit scores OR a flag. Either way the application becomes `reviewed`.
//   scores: { "scores": { "<criterionId>": 0–10, ... }, "comment": "optional" }
//   flag:   { "flagged": true, "flagReason": "ineligible", "flagNote": "optional, ≤ 500 chars" }
async function submitReview(req, res, next) {
  try {
    requireJson(req);
    const applicationId = checkId(req.params.applicationId);
    const reviewerId = req.user.userId;
    const body = req.body || {};

    const isFlag = body.flagged === true;
    if (isFlag && body.scores !== undefined) throw validationError('Send either scores or a flag, not both.');
    if (!isFlag && body.scores === undefined) {
      throw validationError('Send scores for every rubric criterion, or flagged: true with a flagReason.');
    }

    const app = await getOwnApplication(applicationId, reviewerId);
    if (app.status !== 'under_review') {
      throw conflict('This application is already reviewed. A submitted review is final.');
    }

    const submittedAt = new Date().toISOString();
    const comment = scoring.validateComment(body.comment);
    let review;
    if (isFlag) {
      const { flagReason, flagNote } = scoring.validateFlag(body);
      review = { applicationId, reviewerId, flagged: true, flagReason, flagNote, comment, submittedAt };
    } else {
      // Rule: scores are checked against THIS scholarship's rubric, and the total is calculated here.
      const scholarship = await scholarshipService.getScholarship(app.scholarshipId);
      const rubric = scholarship && Array.isArray(scholarship.rubric) ? scholarship.rubric : [];
      if (rubric.length === 0) throw conflict('This scholarship has no rubric to score against.');
      const scores = scoring.validateScores(rubric, body.scores);
      const totalScore = scoring.totalScore(rubric, scores);
      review = { applicationId, reviewerId, scores, totalScore, flagged: false, comment, submittedAt };
    }

    // Step 1: under_review → reviewed, only if I still hold the claim (it may have expired or been released).
    const updated = await statusService.markReviewed(applicationId, reviewerId, review.flagged);
    if (!updated) throw conflict('Your claim on this application is no longer active (released or expired).');

    // Step 2: write the review once. If it fails, put the application back to under_review so it is never
    // `reviewed` without a review behind it.
    let created;
    try {
      created = await reviewService.createReview(review);
    } catch (err) {
      await statusService.undoReviewed(applicationId, reviewerId);
      throw err;
    }
    if (!created) {
      await statusService.undoReviewed(applicationId, reviewerId);
      throw conflict('A review for this application already exists.');
    }

    res.locals.action = 'review';
    await writeAudit({
      action: 'review',
      userId: reviewerId,
      targetId: applicationId,
      detail: review.flagged ? `flagged: ${review.flagReason}` : `scored ${review.totalScore}`,
    });
    res.status(200).json({
      applicationId,
      status: 'reviewed',
      flagged: review.flagged,
      flagReason: review.flagReason ?? null,
      scores: review.scores ?? null,
      totalScore: review.totalScore ?? null,
      submittedAt,
    });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/reviews/{applicationId} — give a claim back to the queue (the claimer, or any admin).
async function releaseClaim(req, res, next) {
  try {
    const applicationId = checkId(req.params.applicationId);
    const { userId, role } = req.user;
    const byAdmin = role === 'admin';

    const released = await statusService.release(applicationId, userId, byAdmin);
    if (!released) {
      const app = await statusService.getApplication(applicationId);
      if (!app || (!byAdmin && app.reviewerId !== userId)) throw notFound('Application');
      throw conflict('Only an application that is under review can be released.');
    }

    res.locals.action = 'release';
    await writeAudit({ action: 'release', userId, targetId: applicationId, detail: byAdmin ? 'released by admin' : 'released by reviewer' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

// GET /api/reviews/{applicationId}/pdf — a 5-minute download link, only while I am reviewing it.
// The link itself is never logged (§10).
async function downloadPdf(req, res, next) {
  try {
    const applicationId = checkId(req.params.applicationId);
    const app = await getOwnApplication(applicationId, req.user.userId);
    if (app.status !== 'under_review') throw conflict('The PDF is only available while you are reviewing this application.');
    if (!app.pdfKey) throw conflict('This application has no PDF.');
    res.status(200).json(await documentService.presignPdf(app.pdfKey));
  } catch (err) {
    next(err);
  }
}

module.exports = { viewQueue, claimApplication, myReviews, getForReview, submitReview, releaseClaim, downloadPdf };
