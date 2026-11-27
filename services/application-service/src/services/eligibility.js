// eligibility.js — pure business rules for applying (no AWS calls, no req/res), so they are easy to unit-test.
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §6 Applying

// Statuses that count towards the "max 3 active applications" rule (§6). accepted/rejected are final, so they don't count.
const ACTIVE_STATUSES = ['submitted', 'under_review', 'reviewed'];
const MAX_ACTIVE_APPLICATIONS = 3;

// The part after the last "@", lower-cased: "Ali@Example-University.edu" → "example-university.edu".
function emailDomain(email) {
  const text = String(email || '');
  const at = text.lastIndexOf('@');
  return at === -1 ? '' : text.slice(at + 1).toLowerCase();
}

// A deadline that is missing or not a real date counts as passed: when in doubt, the scholarship is closed.
function isDeadlinePassed(deadline, now = Date.now()) {
  const time = Date.parse(deadline);
  return !Number.isFinite(time) || time <= now;
}

// Checks the scholarship's eligibility rules (set by the admin) against the student.
// student = { email (from the token, never the body), gpa, yearOfStudy }.
// Returns null when eligible, otherwise the reason to show the student (sent as 409 CONFLICT).
// A rule the admin left empty means "no restriction" for that rule.
function checkEligibility(student, scholarship) {
  const rules = (scholarship && scholarship.eligibility) || {};

  if (Array.isArray(rules.allowedDomains) && rules.allowedDomains.length > 0) {
    const allowed = rules.allowedDomains.map((d) => String(d).toLowerCase());
    if (!allowed.includes(emailDomain(student.email))) {
      return `This scholarship is only open to students with an email from: ${rules.allowedDomains.join(', ')}.`;
    }
  }

  if (typeof rules.minGpa === 'number' && student.gpa < rules.minGpa) {
    return `This scholarship needs a GPA of at least ${rules.minGpa}.`;
  }

  if (Array.isArray(rules.years) && rules.years.length > 0 && !rules.years.map(Number).includes(student.yearOfStudy)) {
    return `This scholarship is only open to students in year ${rules.years.join(', ')}.`;
  }

  return null;
}

// "One application per scholarship" and "at most 3 active" (§6). mine = every application of this student.
// Returns null when the student may apply, otherwise the reason (409 CONFLICT).
function checkApplicationLimits(mine, scholarshipId) {
  if (mine.some((a) => a.scholarshipId === scholarshipId)) {
    return 'You have already applied for this scholarship.';
  }
  const active = mine.filter((a) => ACTIVE_STATUSES.includes(a.status)).length;
  if (active >= MAX_ACTIVE_APPLICATIONS) {
    return `You already have ${MAX_ACTIVE_APPLICATIONS} active applications. Wait for a decision or withdraw one first.`;
  }
  return null;
}

module.exports = {
  ACTIVE_STATUSES, MAX_ACTIVE_APPLICATIONS,
  emailDomain, isDeadlinePassed, checkEligibility, checkApplicationLimits,
};
