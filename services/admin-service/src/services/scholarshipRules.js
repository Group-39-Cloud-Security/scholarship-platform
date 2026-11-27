// scholarshipRules.js — validates a scholarship's fields (no AWS and no req/res). Used by create and, in draft, edit.
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §5 (Scholarships), §6 (rubric and eligibility)
//
// Builds the clean object from an explicit list of fields, so anything else in the body (status, acceptedCount,
// createdBy, ...) never reaches the database. Throws a 400 VALIDATION_ERROR with one clear message.

const { validationError } = require('../../shared/errors');
const { checkText, checkNumber, checkInt } = require('../../shared/validate');

const CRITERION_ID = /^[a-z][a-z0-9_-]{1,29}$/; // short slug like "academic": stable key for review scores
// Date AND time AND zone are required: a bare "2027-01-15" would silently mean midnight UTC.
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|([+-])(\d{2}):(\d{2}))$/;

// Deadline as a full ISO 8601 date-time with a zone (Z or ±hh:mm). Every part is range-checked by hand because
// Date.parse rolls impossible dates over (2027-02-30 would become 2 March) instead of rejecting them.
// May be in the past on a draft: §6 only requires a future deadline at publish.
// Stored in one format (UTC, toISOString) so the status-deadline-index sorts correctly.
function checkDeadline(value) {
  const bad = () => validationError('Deadline must be a real ISO 8601 date and time with a zone, for example 2027-01-15T23:59:00Z.');
  const m = typeof value === 'string' ? ISO_DATE_TIME.exec(value) : null;
  if (!m) throw bad();
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of the next month = last day of this one
  const zoneOk = m[7] === 'Z' || (Number(m[9]) <= 14 && Number(m[10]) <= 59);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > daysInMonth
      || hour > 23 || minute > 59 || second > 59 || !zoneOk) {
    throw bad();
  }
  return new Date(value).toISOString();
}

// 2–6 criteria, unique slug ids, whole-number weights that add up to exactly 100 (§6).
// The weights must sum to 100 because review-service calculates totalScore = Σ(score × weight) / 10 → 0–100.
function checkRubric(value) {
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) {
    throw validationError('Rubric must have between 2 and 6 criteria.');
  }
  const seen = new Set();
  const rubric = value.map((c, i) => {
    const label = `Rubric criterion ${i + 1}`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) throw validationError(`${label} must be an object.`);
    if (typeof c.criterionId !== 'string' || !CRITERION_ID.test(c.criterionId)) {
      throw validationError(`${label}: criterionId must be 2-30 lowercase letters, digits, - or _, starting with a letter.`);
    }
    if (seen.has(c.criterionId)) throw validationError(`Rubric criterionId "${c.criterionId}" is used twice.`);
    seen.add(c.criterionId);
    return {
      criterionId: c.criterionId,
      name: checkText(c.name, `${label} name`, 2, 60),
      description: checkText(c.description, `${label} description`, 2, 300),
      weight: checkInt(c.weight, `${label} weight`, 1, 100),
    };
  });
  const total = rubric.reduce((sum, c) => sum + c.weight, 0);
  if (total !== 100) throw validationError(`Rubric weights must sum to 100 (they sum to ${total}).`);
  return rubric;
}

// allowedDomains must be a subset of the platform's ALLOWED_DOMAINS; minGpa 0–4; years of study 1–6.
function checkEligibility(value, platformDomains) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('Eligibility must be an object.');
  const { allowedDomains, minGpa, years } = value;

  if (!Array.isArray(allowedDomains) || allowedDomains.length < 1 || allowedDomains.length > 10) {
    throw validationError('Eligibility allowedDomains must list 1 to 10 email domains.');
  }
  const domains = [...new Set(allowedDomains.map((d) => (typeof d === 'string' ? d.trim().toLowerCase() : d)))];
  for (const d of domains) {
    if (typeof d !== 'string' || !platformDomains.includes(d)) {
      throw validationError(`Email domain "${d}" is not a partner university (allowed: ${platformDomains.join(', ')}).`);
    }
  }

  if (!Array.isArray(years) || years.length < 1 || years.length > 6) {
    throw validationError('Eligibility years must list 1 to 6 years of study.');
  }
  const cleanYears = [...new Set(years.map((y) => checkInt(y, 'Year of study', 1, 6)))].sort((a, b) => a - b);

  return { allowedDomains: domains, minGpa: checkNumber(minGpa, 'Minimum GPA', 0, 4), years: cleanYears };
}

// The fields an admin may set. Everything else is set by the server.
function validateScholarship(body, platformDomains) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw validationError('Request body must be a JSON object.');
  return {
    title: checkText(body.title, 'Title', 3, 100),
    description: checkText(body.description, 'Description', 10, 2000),
    deadline: checkDeadline(body.deadline),
    awards: checkInt(body.awards, 'Awards', 1, 1000),
    rubric: checkRubric(body.rubric),
    eligibility: checkEligibility(body.eligibility, platformDomains),
  };
}

module.exports = { validateScholarship };
