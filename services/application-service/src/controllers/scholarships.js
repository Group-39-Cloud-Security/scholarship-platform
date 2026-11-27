// scholarships.js — browse published scholarships (list + search, and one by id)
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §6 Applying, §8
// Controller: validates input, applies the visibility rule, picks the status code. AWS calls are in services/.

const { validationError, notFound } = require('../../shared/errors');
const { getScholarship, listPublished } = require('../services/scholarshipReadService');
const { isDeadlinePassed } = require('../services/eligibility');

const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

// Only the fields a student needs. Never createdBy or acceptedCount (internal admin data).
// The rubric is shown so students know how they will be scored (transparency against reviewer bias).
function toPublicScholarship(s) {
  const e = s.eligibility || {};
  return {
    scholarshipId: s.scholarshipId,
    title: s.title,
    description: s.description,
    deadline: s.deadline,
    awards: s.awards,
    isOpen: !isDeadlinePassed(s.deadline), // published but past the deadline = visible, can't apply
    eligibility: { allowedDomains: e.allowedDomains || [], minGpa: e.minGpa ?? null, years: e.years || [] },
    rubric: (s.rubric || []).map((c) => ({ name: c.name, description: c.description, weight: c.weight })),
  };
}

// GET /api/scholarships?search=  → 200 [] even when nothing matches (never 404 for an empty list, §8)
async function list(req, res, next) {
  try {
    let search = req.query.search;
    if (search !== undefined) {
      // ?search=a&search=b arrives as an array: reject instead of crashing on .toLowerCase()
      if (typeof search !== 'string' || search.length > 100) {
        throw validationError('search must be text of at most 100 characters.');
      }
      search = search.trim().toLowerCase();
    }
    let items = await listPublished();
    if (search) {
      items = items.filter((s) =>
        String(s.title || '').toLowerCase().includes(search) ||
        String(s.description || '').toLowerCase().includes(search));
    }
    res.status(200).json(items.map(toPublicScholarship));
  } catch (err) {
    next(err);
  }
}

// GET /api/scholarships/{id} → 200, or 404 for unknown ids AND for drafts/closed ones (they are not public).
async function getOne(req, res, next) {
  try {
    const { id } = req.params;
    if (!ID_RE.test(id)) throw notFound('Scholarship');
    const scholarship = await getScholarship(id);
    if (!scholarship || scholarship.status !== 'published') throw notFound('Scholarship');
    res.status(200).json(toPublicScholarship(scholarship));
  } catch (err) {
    next(err);
  }
}

module.exports = { list, getOne, toPublicScholarship, ID_RE };
