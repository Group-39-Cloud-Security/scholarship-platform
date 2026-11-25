// scoring.js - rubric validation and the total score (no AWS and no req/res, so it is easy to unit test)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §6 Reviewing

const { validationError } = require('../../shared/errors');
const { checkInt, checkText, checkEnum } = require('../../shared/validate');

const FLAG_REASONS = ['incomplete_documents', 'ineligible', 'plagiarism_suspected', 'other'];
const MAX_FLAG_NOTE = 500;
const MAX_COMMENT = 1000;

// Every rubric criterion needs a whole number from 0 to 10, and nothing that isn't in the rubric.
// The result is built from the rubric, so extra keys from the client never reach the database.
function validateScores(rubric, scores) {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    throw validationError('Scores must be an object of criterionId to score.');
  }
  const known = new Set(rubric.map((c) => c.criterionId));
  const extra = Object.keys(scores).filter((id) => !known.has(id));
  if (extra.length > 0) throw validationError(`Unknown rubric criterion: ${extra[0]}.`);

  const clean = {};
  for (const criterion of rubric) {
    if (!Object.hasOwn(scores, criterion.criterionId)) {
      throw validationError(`Missing score for "${criterion.name}".`);
    }
    clean[criterion.criterionId] = checkInt(scores[criterion.criterionId], `Score for "${criterion.name}"`, 0, 10);
  }
  return clean;
}

// total = sum of (score * weight) / 10, so it is out of 100 because the weights add up to 100.
// Only the server calculates it; a total sent by the client is never read.
function totalScore(rubric, cleanScores) {
  const sum = rubric.reduce((acc, c) => acc + cleanScores[c.criterionId] * c.weight, 0);
  return Math.round((sum / 10) * 100) / 100;
}

// Empty or only spaces counts as "not given" for the optional text fields.
const isBlank = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

// A flag replaces the scores: a reason from the fixed list and an optional note (max 500 characters).
function validateFlag(body) {
  const flagReason = checkEnum(body.flagReason, 'Flag reason', FLAG_REASONS);
  const flagNote = isBlank(body.flagNote) ? undefined : checkText(body.flagNote, 'Flag note', 1, MAX_FLAG_NOTE);
  return { flagReason, flagNote };
}

// Optional comment for the admin (max 1000 characters).
function validateComment(value) {
  return isBlank(value) ? undefined : checkText(value, 'Comment', 1, MAX_COMMENT);
}

module.exports = { validateScores, totalScore, validateFlag, validateComment, FLAG_REASONS };
