// scholarships.js — create, edit (draft only), publish/close. Applications with scores come in a later step.
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Scholarships, §8 API, §10 security
//
// Controller: checks Content-Type (415), validates input (400), applies the business rules and picks the
// status code. AWS calls are in ../services. The admin's id always comes from the token, never the body.

const crypto = require('crypto');
const { validationError, unsupportedMediaType, notFound, conflict } = require('../../shared/errors');
const { checkEnum } = require('../../shared/validate');
const { writeAudit } = require('../../shared/audit');
const { validateScholarship, checkRubric } = require('../services/scholarshipRules');
const scholarshipService = require('../services/scholarshipService');

// Partner university domains for the whole platform (§6: a scholarship's allowedDomains must be a subset).
const platformDomains = () => (process.env.ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // ids are server-made UUIDs

function requireJson(req) {
  if (!req.is('application/json')) throw unsupportedMediaType();
}

function checkId(value) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw validationError('Scholarship id is missing or invalid.');
  return value;
}

// Why a status change can't happen, from the item as it is now. Used before the write (clear message)
// and after a failed conditional write (someone else changed it in between).
function publishProblem(s, now) {
  if (s.status !== 'draft') return `Only a draft can be published (this scholarship is ${s.status}).`;
  if (!(s.deadline > now)) return 'The deadline has passed. Set a future deadline before publishing.';
  if (!(s.awards >= 1)) return 'Awards must be at least 1 to publish.';
  try { checkRubric(s.rubric); } catch (err) { return `The rubric is not valid: ${err.message}`; }
  return null;
}

// POST /api/admin/scholarships → 201 with the new draft
async function createScholarship(req, res, next) {
  try {
    requireJson(req);
    const fields = validateScholarship(req.body, platformDomains());
    const scholarship = {
      scholarshipId: crypto.randomUUID(),
      ...fields,
      status: 'draft', // §6: draft → published → closed; rubric and eligibility editable only in draft
      acceptedCount: 0, // atomic counter for the awards limit (§6 Deciding)
      createdBy: req.user.userId,
      createdAt: new Date().toISOString(),
    };
    await scholarshipService.createScholarship(scholarship);

    res.locals.action = 'scholarship_created';
    await writeAudit({ action: 'scholarship_created', userId: req.user.userId, targetId: scholarship.scholarshipId, detail: 'draft created' });
    res.status(201).json(scholarship);
  } catch (err) {
    next(err);
  }
}

// PUT /api/admin/scholarships/{id} → 200 with the edited draft. Replaces all editable fields (PUT, Lab 3).
async function updateScholarship(req, res, next) {
  try {
    const scholarshipId = checkId(req.params.id);
    requireJson(req);
    const fields = validateScholarship(req.body, platformDomains());

    const updated = await scholarshipService.updateDraft(scholarshipId, fields);
    if (!updated) {
      const current = await scholarshipService.getScholarship(scholarshipId);
      if (!current) throw notFound('Scholarship');
      throw conflict(`Only a draft can be edited (this scholarship is ${current.status}). Rubric, eligibility and deadline are locked after publishing.`);
    }

    res.locals.action = 'scholarship_updated';
    await writeAudit({ action: 'scholarship_updated', userId: req.user.userId, targetId: scholarshipId, detail: 'draft edited' });
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/scholarships/{id}/status  { "status": "published" | "closed" } → 200 with the scholarship
async function changeStatus(req, res, next) {
  try {
    const scholarshipId = checkId(req.params.id);
    requireJson(req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const target = checkEnum(body.status, 'Status', ['published', 'closed']);

    const current = await scholarshipService.getScholarship(scholarshipId);
    if (!current) throw notFound('Scholarship');

    let updated;
    if (target === 'published') {
      const now = new Date().toISOString();
      const problem = publishProblem(current, now);
      if (problem) throw conflict(problem);
      updated = await scholarshipService.publish(scholarshipId, now);
      // The write re-checks status, deadline and awards, so a parallel publish or edit can't slip through.
      if (!updated) {
        const latest = await scholarshipService.getScholarship(scholarshipId);
        throw conflict((latest && publishProblem(latest, now)) || 'The scholarship changed while publishing. Try again.');
      }
    } else {
      if (current.status !== 'published') {
        throw conflict(`Only a published scholarship can be closed (this one is ${current.status}).`);
      }
      updated = await scholarshipService.close(scholarshipId);
      if (!updated) throw conflict('The scholarship changed while closing. Try again.');
    }

    const action = target === 'published' ? 'scholarship_published' : 'scholarship_closed';
    res.locals.action = action;
    await writeAudit({ action, userId: req.user.userId, targetId: scholarshipId, detail: `status ${current.status} -> ${target}` });
    res.status(200).json(updated);
  } catch (err) {
    next(err);
  }
}

module.exports = { createScholarship, updateScholarship, changeStatus };
