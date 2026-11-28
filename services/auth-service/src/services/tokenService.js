// tokenService.js — signs the login JWT
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §2 (JWT HS256, 1 hour), §4, §10
//
// The secret comes from SSM through shared/auth.js (the same code that verifies tokens in every service), so signing
// and checking can't drift apart. It is never in code, env vars or logs.

const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../../shared/auth');

// sub = userId. The role is in the token only for the frontend; the backend re-reads role and status from Users.
async function signToken(user) {
  return jwt.sign({ sub: user.userId, role: user.role }, await getJwtSecret(), { algorithm: 'HS256', expiresIn: '1h' });
}

module.exports = { signToken };
