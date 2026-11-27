// decisions.js — accept or reject a reviewed application, then queue the email
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Deciding, §8 API, §10 security
//
// Controller: checks Content-Type (415), validates input (400), applies the business rules and picks the
// status code. AWS calls are in ../services. The admin's id always comes from the token, never the body.

const { validationError, unsupportedMediaType, notFound, conflict } = require('../../shared/errors');
const { checkEnum } = require('../../shared/validate');
const { writeAudit } = require('../../shared/audit');
const { log } = require('../../shared/logger');
const decisionService = require('../services/decisionService');
const scholarshipService = require('../services/scholarshipService');
const { queueDecisionEmail } = require('../services/notificationQueue');

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // ids are server-made UUIDs

function requireJson(req) {
  if (!req.is('application/json')) throw unsupportedMediaType();
}

function checkId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw validationError('Application id is missing or invalid.');
  return value;
}

// Why this application can't get this decision right now, or null if it can.
function decisionProblem(app, decision) {
  if (app.status !== 'reviewed') {
    return ['accepted', 'rejected'].includes(app.status)
      ? `This application is already ${app.status}. A decision is final.`
      : `Only a reviewed application can be decided (this one is ${app.status}).`;
  }
  if (decision === 'accepted' && app.flagged === true) return 'A flagged application can only be rejected.';
  return null;
}

// Rollback of reserveAward. If even that fails the counter is one too high: never silent, it goes to the log.
async function giveAwardBack(app) {
  try {
    if (!(await decisionService.releaseAward(app.scholarshipId))) {
      log('error', 'acceptedCount rollback found nothing to give back', { applicationId: app.applicationId, scholarshipId: app.scholarshipId });
    }
  } catch (err) {
    log('error', 'acceptedCount rollback failed', { applicationId: app.applicationId, scholarshipId: app.scholarshipId, error: err.name });
  }
}

// PATCH /api/admin/applications/{id}/decision  { "decision": "accepted" | "rejected" } → 200
async function decideApplication(req, res, next) {
  try {
    const applicationId = checkId(req.params.id);
    requireJson(req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const decision = checkEnum(body.decision, 'Decision', ['accepted', 'rejected']);

    const app = await decisionService.getApplication(applicationId);
    if (!app) throw notFound('Application');
    const problem = decisionProblem(app, decision);
    if (problem) throw conflict(problem);

    const scholarship = await scholarshipService.getScholarship(app.scholarshipId);
    if (!scholarship) throw conflict('The scholarship for this application no longer exists.');

    const adminId = req.user.userId;
    const decidedAt = new Date().toISOString();

    if (decision === 'accepted') {
      // Step 1: take an award (atomic, never above awards). Step 2: the conditional status update.
      if (!(await decisionService.reserveAward(app.scholarshipId))) {
        throw conflict(`All ${scholarship.awards} awards for this scholarship have already been given.`);
      }
      let decided;
      try {
        decided = await decisionService.decide(applicationId, decision, adminId, decidedAt);
      } catch (err) {
        await giveAwardBack(app); // DynamoDB error after the award was taken: give it back, then fail
        throw err;
      }
      if (!decided) {
        await giveAwardBack(app); // someone else decided it first: give the award back
        const latest = await decisionService.getApplication(applicationId);
        throw conflict((latest && decisionProblem(latest, decision)) || 'The application changed while deciding. Try again.');
      }
    } else if (!(await decisionService.decide(applicationId, decision, adminId, decidedAt))) {
      const latest = await decisionService.getApplication(applicationId);
      throw conflict((latest && decisionProblem(latest, decision)) || 'The application changed while deciding. Try again.');
    }

    res.locals.action = 'decision';
    await writeAudit({ action: 'decision', userId: adminId, targetId: applicationId, detail: decision });

    // The email. A failure here never undoes the decision (§6): emailStatus = failed, visible to the admin.
    const flagReason = app.flagged === true ? await decisionService.getFlagReason(applicationId) : undefined;
    let emailStatus = 'queued';
    try {
      await queueDecisionEmail({
        applicationId,
        studentEmail: app.studentEmail,
        scholarshipTitle: scholarship.title,
        decision,
        ...(flagReason ? { flagReason } : {}),
      });
    } catch (err) {
      emailStatus = 'failed';
      log('error', 'decision email could not be queued', { applicationId, error: err.name });
    }
    try {
      await decisionService.setEmailStatus(applicationId, emailStatus);
    } catch (err) {
      log('error', 'emailStatus could not be saved', { applicationId, emailStatus, error: err.name });
    }

    res.status(200).json({
      applicationId, scholarshipId: app.scholarshipId, status: decision, decidedBy: adminId, decidedAt, emailStatus,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { decideApplication };
