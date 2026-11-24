// validate.js — small validation helpers. Each one returns the clean value or throws a 400 VALIDATION_ERROR.
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §6, §8, §10
//
// Use in a controller:
//   try {
//     const title = checkText(req.body.title, 'Title', 3, 100);
//     const awards = checkInt(req.body.awards, 'Awards', 1, 1000);
//   } catch (err) { return next(err); }

const { validationError } = require('./errors');

// Required string, trimmed, length between min and max. The max also keeps items far below DynamoDB's 400 KB limit.
function checkText(value, label, min, max) {
  if (typeof value !== 'string') throw validationError(`${label} is required and must be text.`);
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw validationError(`${label} must be between ${min} and ${max} characters.`);
  }
  return text;
}

// Essay rule (200–1000 words). Words = runs of non-space characters.
// maxChars stops 1000 huge "words" from passing here and then failing at DynamoDB's 400 KB limit as a 500.
function checkWords(value, label, min, max, maxChars = 10000) {
  if (typeof value !== 'string') throw validationError(`${label} is required and must be text.`);
  const text = value.trim();
  if (text.length > maxChars) throw validationError(`${label} must be at most ${maxChars} characters.`);
  const words = text === '' ? 0 : text.split(/\s+/).length;
  if (words < min || words > max) {
    throw validationError(`${label} must be between ${min} and ${max} words (it has ${words}).`);
  }
  return text;
}

// A real JSON number (not the string "3.5"), finite, in range. Used for GPA 0–4.
function checkNumber(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw validationError(`${label} must be a number.`);
  if (value < min || value > max) throw validationError(`${label} must be between ${min} and ${max}.`);
  return value;
}

// Whole number in range: rubric weights, scores 0–10, awards, year of study.
function checkInt(value, label, min, max) {
  if (!Number.isInteger(value)) throw validationError(`${label} must be a whole number.`);
  return checkNumber(value, label, min, max);
}

// Value must be one of a fixed list: statuses, roles, flag reasons.
function checkEnum(value, label, allowed) {
  if (!allowed.includes(value)) throw validationError(`${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}

module.exports = { checkText, checkWords, checkNumber, checkInt, checkEnum };
