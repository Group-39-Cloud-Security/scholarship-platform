// Unit tests for the scoring rules (CLAUDE.md §6 Reviewing). Run: npm test (after npm run sync-shared)
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateScores, totalScore, validateFlag, validateComment } = require('../src/services/scoring');

const rubric = [
  { criterionId: 'academic', name: 'Academic record', weight: 40 },
  { criterionId: 'essay', name: 'Essay', weight: 40 },
  { criterionId: 'need', name: 'Need', weight: 20 },
];

test('total is sum of (score * weight) / 10', () => {
  assert.equal(totalScore(rubric, { academic: 8, essay: 7, need: 5 }), 70);
  assert.equal(totalScore(rubric, { academic: 10, essay: 10, need: 10 }), 100);
  assert.equal(totalScore(rubric, { academic: 0, essay: 0, need: 0 }), 0);
  assert.equal(totalScore(rubric, { academic: 9, essay: 6, need: 3 }), 66);
});

test('every criterion needs a whole number from 0 to 10', () => {
  assert.deepEqual(validateScores(rubric, { academic: 8, essay: 7, need: 5 }), { academic: 8, essay: 7, need: 5 });
  assert.throws(() => validateScores(rubric, { academic: 8, essay: 7 }), /Missing score for "Need"/);
  assert.throws(() => validateScores(rubric, { academic: 11, essay: 7, need: 5 }), /between 0 and 10/);
  assert.throws(() => validateScores(rubric, { academic: -1, essay: 7, need: 5 }), /between 0 and 10/);
  assert.throws(() => validateScores(rubric, { academic: 7.5, essay: 7, need: 5 }), /whole number/);
  assert.throws(() => validateScores(rubric, { academic: '8', essay: 7, need: 5 }), /whole number/);
});

test('scores for criteria that are not in the rubric are rejected', () => {
  assert.throws(() => validateScores(rubric, { academic: 8, essay: 7, need: 5, bonus: 10 }), /Unknown rubric criterion: bonus/);
  // same thing when the extra key arrives in a JSON body
  const fromJson = JSON.parse('{"academic":8,"essay":7,"need":5,"__proto__":{"isAdmin":true}}');
  assert.throws(() => validateScores(rubric, fromJson), /Unknown rubric criterion/);
});

test('scores must be an object', () => {
  assert.throws(() => validateScores(rubric, [8, 7, 5]), /must be an object/);
  assert.throws(() => validateScores(rubric, null), /must be an object/);
  assert.throws(() => validateScores(rubric, 'x'), /must be an object/);
});

test('flag reason must be from the list, note is optional and max 500 characters', () => {
  assert.deepEqual(validateFlag({ flagReason: 'ineligible', flagNote: 'GPA mismatch' }), { flagReason: 'ineligible', flagNote: 'GPA mismatch' });
  assert.deepEqual(validateFlag({ flagReason: 'other', flagNote: '   ' }), { flagReason: 'other', flagNote: undefined });
  assert.throws(() => validateFlag({ flagReason: 'boring' }), /Flag reason must be one of/);
  assert.throws(() => validateFlag({ flagReason: 'other', flagNote: 'x'.repeat(501) }), /between 1 and 500/);
});

test('comment is optional and max 1000 characters', () => {
  assert.equal(validateComment(undefined), undefined);
  assert.equal(validateComment('  '), undefined);
  assert.equal(validateComment('  good  '), 'good');
  assert.throws(() => validateComment('x'.repeat(1001)), /between 1 and 1000/);
});
