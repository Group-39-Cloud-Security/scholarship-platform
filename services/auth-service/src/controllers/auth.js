// auth.js — register · login · current user · change password
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §6 Accounts and login, §8 API, §10
//
// Controller: checks Content-Type (415), validates input (400), applies the business rules and picks the
// status code. AWS and HTTP calls are in ../services.
// Secrets: passwords and hashes are never returned, logged or audited. Only the bcrypt hash is stored.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  validationError, unsupportedMediaType, conflict, unauthenticated, tooManyAttempts,
} = require('../../shared/errors');
const { checkText } = require('../../shared/validate');
const { writeAudit } = require('../../shared/audit');
const { log } = require('../../shared/logger');
const userService = require('../services/userService');
const pwnedService = require('../services/pwnedService');
const loginAttemptService = require('../services/loginAttemptService');
const tokenService = require('../services/tokenService');

const LOGIN_FAILED = 'Email or password is incorrect.'; // the same for unknown email, wrong password, disabled user

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

// The caller's IP as API Gateway saw it (requestContext.http.sourceIp, passed on by serverless-http), or the
// socket address on a local run. Never X-Forwarded-For: the client can write anything in that header (§6).
const sourceIp = (req) => (req.requestContext && req.requestContext.http && req.requestContext.http.sourceIp)
  || req.socket.remoteAddress || 'unknown';

// Unknown emails still pay for one bcrypt compare, so the reply time doesn't tell whether the email exists.
let dummyHash = null;
const getDummyHash = () => (dummyHash ||= bcrypt.hash(crypto.randomBytes(16).toString('hex'), BCRYPT_COST));

const publicUser = (u) => ({
  userId: u.userId, email: u.email, name: u.name, role: u.role, status: u.status,
  mustChangePassword: u.mustChangePassword === true,
});

// POST /api/auth/login  { email, password } → 200 { token, user }
// 401 for every wrong combination (never says whether the email exists), 429 while this email + IP is blocked.
async function login(req, res, next) {
  try {
    requireJson(req);
    const body = bodyOf(req);
    const email = checkEmail(body.email);
    const password = body.password;
    if (typeof password !== 'string' || password.length < 1 || password.length > 1000) {
      throw validationError('Password is required.');
    }
    const ip = sourceIp(req);

    // Blocked: answer 429 without checking the password, so guesses during the block are worthless.
    const attempt = await loginAttemptService.getAttempt(email, ip);
    const blockedFor = attempt && attempt.blockedUntil ? Date.parse(attempt.blockedUntil) - Date.now() : 0;
    if (blockedFor > 0) {
      res.locals.action = 'login_blocked';
      res.set('Retry-After', String(Math.ceil(blockedFor / 1000)));
      throw tooManyAttempts('Too many failed logins. Try again later.');
    }

    const user = await userService.findByEmail(email);
    const passwordOk = user && typeof user.passwordHash === 'string'
      ? await bcrypt.compare(password, user.passwordHash)
      : (await bcrypt.compare(password, await getDummyHash()), false);

    if (!passwordOk || user.status !== 'active') {
      const failures = await loginAttemptService.recordFailure(email, ip);
      const blockMinutes = loginAttemptService.blockMs(failures) / 60000;
      // The request log line gets "action":"login_failed": review-service's metric filter counts exactly that.
      res.locals.action = 'login_failed';
      await writeAudit({
        action: 'login_failed',
        userId: user ? user.userId : undefined,
        targetId: email,
        detail: `failure ${failures} from ${ip}` + (blockMinutes ? `, blocked ${blockMinutes} min` : ''),
      });
      throw unauthenticated(LOGIN_FAILED);
    }

    if (attempt && attempt.failures) await loginAttemptService.reset(email, ip);
    const token = await tokenService.signToken(user);
    res.locals.action = 'login';
    await writeAudit({ action: 'login', userId: user.userId, targetId: user.userId, detail: `from ${ip}` });
    res.status(200).json({ token, user: publicUser(user) });
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login };
