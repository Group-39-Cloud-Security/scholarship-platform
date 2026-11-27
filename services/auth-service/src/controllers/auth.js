// auth.js — register · login · current user · change password
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §6 Accounts and login, §8 API, §10
//
// Controller: checks Content-Type (415), validates input (400), applies the business rules and picks the
// status code. AWS and HTTP calls are in ../services.
// Secrets: passwords and hashes are never returned, logged or audited. Only the bcrypt hash is stored.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validationError, unsupportedMediaType, conflict } = require('../../shared/errors');
const { checkText } = require('../../shared/validate');
const { writeAudit } = require('../../shared/audit');
const { log } = require('../../shared/logger');
const userService = require('../services/userService');
const pwnedService = require('../services/pwnedService');

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const BCRYPT_COST = 10; // same as admin-service (reviewer temporary passwords), so every hash is the same format
const PASSWORD_MIN = 10; // §6
const PASSWORD_MAX_BYTES = 72; // bcrypt ignores everything after 72 bytes, so longer passwords are refused, not cut

// Partner university domains (§6: students self-register only with one of these).
const allowedDomains = () => (process.env.ALLOWED_DOMAINS || '')
  .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);

function requireJson(req) {
  if (!req.is('application/json')) throw unsupportedMediaType();
}

const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

function checkEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL.test(email)) throw validationError('Email must be a valid email address.');
  return email;
}

// Never trimmed: spaces are part of a password.
function checkPassword(value, label = 'Password') {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN) {
    throw validationError(`${label} must be at least ${PASSWORD_MIN} characters.`);
  }
  if (Buffer.byteLength(value, 'utf8') > PASSWORD_MAX_BYTES) {
    throw validationError(`${label} is too long (at most ${PASSWORD_MAX_BYTES} bytes).`);
  }
  return value;
}

// Pwned Passwords (k-anonymity). Fails open: an unreachable API is logged, not blocked (docs/decisions.md).
async function rejectBreachedPassword(password, label = 'Password') {
  const pwned = await pwnedService.isPwned(password);
  if (pwned === null) log('warn', 'pwned_check_unavailable', { action: 'pwned_check_unavailable' });
  if (pwned === true) throw validationError(`${label} has appeared in a data breach. Choose a different one.`);
}

// POST /api/auth/register  { email, name, password } → 201 with the new student account (no password, no hash)
async function register(req, res, next) {
  try {
    requireJson(req);
    const body = bodyOf(req);
    const email = checkEmail(body.email);
    const name = checkText(body.name, 'Name', 2, 60);
    const password = checkPassword(body.password);
    const domain = email.split('@')[1];
    if (!allowedDomains().includes(domain)) {
      throw validationError('Registration is only open to email addresses of partner universities.');
    }
    if (await userService.emailTaken(email)) throw conflict('An account with this email already exists.');
    await rejectBreachedPassword(password);

    const user = {
      userId: crypto.randomUUID(),
      email,
      name,
      role: 'student', // self-registration is always a student; a role in the body is ignored
      status: 'active',
      mustChangePassword: false,
      createdAt: new Date().toISOString(),
    };
    await userService.createUser({ ...user, passwordHash: await bcrypt.hash(password, BCRYPT_COST) });

    res.locals.action = 'user_created';
    await writeAudit({ action: 'user_created', userId: user.userId, targetId: user.userId, detail: 'student registered' });
    res.status(201).json(user);
  } catch (err) {
    next(err);
  }
}

module.exports = { register };
