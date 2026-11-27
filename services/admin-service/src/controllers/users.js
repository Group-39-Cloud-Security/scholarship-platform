// users.js — list users · create reviewer (temporary password, mustChangePassword) · disable/enable
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Accounts, §8 API, §10 security
//
// Controller: checks Content-Type (415), validates input (400), applies the business rules and picks the
// status code. AWS calls are in ../services. The admin's id always comes from the token, never the body.
// Secrets: the temporary password is in the 201 reply ONCE and nowhere else (not stored, not logged, not audited);
// the password hash is stored and never read back or returned.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { validationError, unsupportedMediaType, notFound, conflict } = require('../../shared/errors');
const { checkText, checkEnum } = require('../../shared/validate');
const { writeAudit } = require('../../shared/audit');
const userService = require('../services/userAdminService');

const ROLES = ['student', 'reviewer', 'admin'];
const STATUSES = ['active', 'disabled'];
const USER_ID = /^[A-Za-z0-9-]{1,64}$/; // UUIDs, and the Phase A test user ids (test-admin, ...)
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const BCRYPT_COST = 10;

function requireJson(req) {
  if (!req.is('application/json')) throw unsupportedMediaType();
}

const sortByEmail = (users) => users.sort((a, b) => String(a.email).localeCompare(String(b.email)));

// GET /api/admin/users?role=&status= → 200 [ { userId, email, name, role, status, mustChangePassword, createdAt } ]
async function listUsers(req, res, next) {
  try {
    const one = (v) => (Array.isArray(v) ? v[0] : v); // ?role=a&role=b → first one
    const role = one(req.query.role) === undefined ? undefined : checkEnum(one(req.query.role), 'role', ROLES);
    const status = one(req.query.status) === undefined ? undefined : checkEnum(one(req.query.status), 'status', STATUSES);
    res.status(200).json(sortByEmail(await userService.listUsers({ role, status })));
  } catch (err) {
    next(err);
  }
}

// POST /api/admin/users  { email, name } → 201 with the account and its temporary password (shown once)
async function createReviewer(req, res, next) {
  try {
    requireJson(req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !EMAIL.test(email)) throw validationError('Email must be a valid email address.');
    const name = checkText(body.name, 'Name', 2, 60);
    if (await userService.emailTaken(email)) throw conflict('An account with this email already exists.');

    // 12 random bytes = 16 URL-safe characters (96 bits). Only its bcrypt hash is stored.
    const temporaryPassword = crypto.randomBytes(12).toString('base64url');
    const user = {
      userId: crypto.randomUUID(),
      email,
      name,
      role: 'reviewer', // §6: admins create reviewers only; a role in the body is ignored
      status: 'active',
      mustChangePassword: true, // the reviewer must replace the temporary password at first login
      createdAt: new Date().toISOString(),
    };
    await userService.createUser({ ...user, passwordHash: await bcrypt.hash(temporaryPassword, BCRYPT_COST) });

    res.locals.action = 'user_created';
    await writeAudit({ action: 'user_created', userId: req.user.userId, targetId: user.userId, detail: 'reviewer created' });
    res.status(201).json({ ...user, temporaryPassword });
  } catch (err) {
    next(err);
  }
}

// PATCH /api/admin/users/{id}/status  { "status": "active" | "disabled" } → 200 with the account
async function changeStatus(req, res, next) {
  try {
    const userId = req.params.id;
    if (typeof userId !== 'string' || !USER_ID.test(userId)) throw validationError('User id is missing or invalid.');
    requireJson(req);
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const target = checkEnum(body.status, 'Status', STATUSES);
    const actorId = req.user.userId;
    if (userId === actorId) throw conflict('You cannot change the status of your own account.');

    const user = await userService.getUser(userId);
    if (!user) throw notFound('User');
    if (user.status === target) throw conflict(`This account is already ${target}.`);

    let outcome;
    if (target === 'disabled' && user.role === 'admin') {
      outcome = await userService.disableAdmin(userId, actorId); // atomic with the check on the acting admin
    } else {
      outcome = await userService.setStatus(userId, user.status, target);
    }
    if (outcome === 'actor') {
      throw conflict('Only an active admin can disable another admin, so at least one active admin always remains. Your account is not an active admin any more.');
    }
    if (outcome === 'target') throw conflict('This account changed while updating. Reload and try again.');
    if (outcome === 'conflict') throw conflict('Another change to these accounts happened at the same time. Try again.');

    const action = target === 'disabled' ? 'user_disabled' : 'user_enabled';
    res.locals.action = action;
    await writeAudit({ action, userId: actorId, targetId: userId, detail: `status ${user.status} -> ${target}` });
    res.status(200).json(await userService.getUser(userId));
  } catch (err) {
    next(err);
  }
}

module.exports = { listUsers, createReviewer, changeStatus };
