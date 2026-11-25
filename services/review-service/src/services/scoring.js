// scoring.js — pure rubric validation + total calculation (no AWS, no req/res, so it is easy to unit-test)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §6 Reviewing

const { validationError } = require('../../shared/errors');
const { checkInt, checkText, checkEnum } = require('../../shared/validate');

const FLAG_REASONS = ['incomplete_documents', 'ineligible', 'plagiarism_suspected', 'other'];
const MAX_FLAG_NOTE = 500;
const MAX_COMMENT = 1000;

// Every rubric criterion must get a whole number 0–10, and nothing that is not in the rubric.
// Returns a clean { criterionId: score } map built from the rubric, so extra keys can never reach the database.
function validateScores(rubric, scores) {
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)) {
    throw validationError('Scores must be an object of criterionId → score.');
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

// totalScore = Σ(score × weight) / 10 → 0–100 (weights sum to 100, scores are 0–10).
// Calculated by the server only; a total sent by the client is never read.
function totalScore(rubric, cleanScores) {
  const sum = rubric.reduce((acc, c) => acc + cleanScores[c.criterionId] * c.weight, 0);
  return Math.round((sum / 10) * 100) / 100; // keep 2 decimals, e.g. 78.5
}

// A flag replaces the scores: reason from the fixed list, optional note ≤ 500 characters.
function validateFlag(body) {
  const flagReason = checkEnum(body.flagReason, 'Flag reason', FLAG_REASONS);
  let flagNote;
  if (body.flagNote !== undefined && body.flagNote !== null && body.flagNote !== '') {
    flagNote = checkText(body.flagNote, 'Flag note', 1, MAX_FLAG_NOTE);
  }
  return { flagReason, flagNote };
}

// Optional reviewer comment shown to the admin only.
function validateComment(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return checkText(value, 'Comment', 1, MAX_COMMENT);
}

module.exports = { validateScores, totalScore, validateFlag, validateComment, FLAG_REASONS };
