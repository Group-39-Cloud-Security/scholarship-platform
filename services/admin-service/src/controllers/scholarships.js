// scholarships.js — create (this step); edit in draft, publish/close and applications with scores come next
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Scholarships, §8 API, §10 security
//
// Controller: checks Content-Type (415), validates input (400), applies the business rules and picks the
// status code. AWS calls are in ../services. The admin's id always comes from the token, never the body.

const crypto = require('crypto');
const { unsupportedMediaType } = require('../../shared/errors');
const { writeAudit } = require('../../shared/audit');
const { validateScholarship } = require('../services/scholarshipRules');
const scholarshipService = require('../services/scholarshipService');

// Partner university domains for the whole platform (§6: a scholarship's allowedDomains must be a subset).
const platformDomains = () => (process.env.ALLOWED_DOMAINS || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

function requireJson(req) {
  if (!req.is('application/json')) throw unsupportedMediaType();
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

module.exports = { createScholarship };
