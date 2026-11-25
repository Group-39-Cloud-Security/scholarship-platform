// reviews.js - queue, claim, score/flag, my reviews, release, pdf
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §6 Reviewing, §8 API, §10 security
//
// Controller: checks Content-Type (415), validates input (400), applies the business rules and picks the
// status code. AWS calls are in ../services. The reviewer id always comes from the token, never the body.

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

// Ids are UUIDs made by the server, so anything else is rejected before it reaches DynamoDB.
function checkId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw validationError('applicationId is missing or invalid.');
  return value;
}

function requireJson(req) {
  if (!req.is('application/json')) throw unsupportedMediaType();
}

// Used by every /{applicationId} route. A missing application and someone else's claim both give 404,
// so a reviewer can't find out which ids exist.
async function getOwnApplication(applicationId, reviewerId) {
  const app = await statusService.getApplication(applicationId);
  if (!app || app.reviewerId !== reviewerId) throw notFound('Application');
  return app;
}

const expiresAt = (claimedAt) => new Date(Date.parse(claimedAt) + CLAIM_HOURS * 3600 * 1000).toISOString();

// GET /api/reviews/queue
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

// POST /api/reviews  { applicationId }  (claim)
async function claimApplication(req, res, next) {
  try {
    requireJson(req);
    const applicationId = checkId(req.body.applicationId);
    const reviewerId = req.user.userId;

    const active = await statusService.listActiveClaims(reviewerId);
    if (active.length >= MAX_ACTIVE_CLAIMS) {
      throw conflict(`You already have ${MAX_ACTIVE_CLAIMS} applications under review. Submit or release one first.`);
    }

    // The update only works while the status is still "submitted", so if two reviewers claim the
    // same application at the same time only one of them gets it and the other gets 409.
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

// GET /api/reviews/mine  (open claims + submitted reviews)
async function myReviews(req, res, next) {
  try {
    const reviewerId = req.user.userId;
    const [claims, reviews] = await Promise.all([
      statusService.listActiveClaims(reviewerId),
      reviewService.listByReviewer(reviewerId),
    ]);
    // Reviews don't store the scholarship id, so get it from each reviewed application to show the title.
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

// GET /api/reviews/{applicationId}  (claimer only)
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

// PUT /api/reviews/{applicationId}  (claimer only, final)
//   scores: { "scores": { "<criterionId>": 0-10, ... }, "comment": "optional" }
//   flag:   { "flagged": true, "flagReason": "ineligible", "flagNote": "optional" }
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
      // Scores are checked against this scholarship's rubric and the total is calculated here.
      const scholarship = await scholarshipService.getScholarship(app.scholarshipId);
      const rubric = scholarship && Array.isArray(scholarship.rubric) ? scholarship.rubric : [];
      if (rubric.length === 0) throw conflict('This scholarship has no rubric to score against.');
      const scores = scoring.validateScores(rubric, body.scores);
      const totalScore = scoring.totalScore(rubric, scores);
      review = { applicationId, reviewerId, scores, totalScore, flagged: false, comment, submittedAt };
    }

    // 1. under_review -> reviewed, only if I still hold the claim (it may have expired or been released).
    const updated = await statusService.markReviewed(applicationId, reviewerId, review.flagged);
    if (!updated) throw conflict('Your claim on this application is no longer active (released or expired).');

    // 2. Save the review once. If that fails, put the application back to under_review.
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

// DELETE /api/reviews/{applicationId}  (release: the claimer, or any admin)
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

// GET /api/reviews/{applicationId}/pdf  (claimer only, while under review)
// Opening a student's document is logged in AuditLog. The link itself is never logged.
async function downloadPdf(req, res, next) {
  try {
    const applicationId = checkId(req.params.applicationId);
    const app = await getOwnApplication(applicationId, req.user.userId);
    if (app.status !== 'under_review') throw conflict('The PDF is only available while you are reviewing this application.');
    if (!app.pdfKey) throw conflict('This application has no PDF.');

    const link = await documentService.presignPdf(app.pdfKey);
    res.locals.action = 'pdf_download';
    await writeAudit({ action: 'pdf_download', userId: req.user.userId, targetId: applicationId, detail: 'presigned link (5 min)' });
    res.status(200).json(link);
  } catch (err) {
    next(err);
  }
}

module.exports = { viewQueue, claimApplication, myReviews, getForReview, submitReview, releaseClaim, downloadPdf };
