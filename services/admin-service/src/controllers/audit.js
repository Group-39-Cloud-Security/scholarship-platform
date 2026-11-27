// audit.js — audit log query (?action=&since=&limit=&next=) and stats
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 (monitoring), §8 API, §10 security
//
// Controller: validates the query (400), picks the status code. AWS calls are in ../services.
// Audit rows are returned as plain data (5 named fields, JSON), never interpreted. They never hold passwords,
// hashes or tokens: writers only put short descriptions in `detail` (shared-lib/audit.js).

const { validationError } = require('../../shared/errors');
const { checkEnum } = require('../../shared/validate');
const { checkIsoDateTime } = require('../services/scholarshipRules');
const auditService = require('../services/auditQueryService');

// Every action any service writes to AuditLog. A service that adds a new action must add it here too.
const ACTIONS = [
  'login', 'login_failed', 'password_changed', 'forbidden', // auth-service and shared-lib/auth.js
  'claim', 'claim_expired', 'release', 'review', 'pdf_download', // review-service and release-expired-claims
  'scholarship_created', 'scholarship_updated', 'scholarship_published', 'scholarship_closed', // admin-service
  'decision', 'user_created', 'user_disabled', 'user_enabled', // admin-service
  'email_sent', 'email_failed', // notification-sender
];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100; // hard cap per call

const one = (v) => (Array.isArray(v) ? v[0] : v); // ?x=a&x=b → the first one

function checkLimit(value) {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > MAX_LIMIT) {
    throw validationError(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  }
  return Number(value);
}

// The paging token is the last DynamoDB key, base64url JSON. Only accepted if it is exactly { action, sortKey }
// for the action being asked for, so it can't be used to read another action or to pass other keys to DynamoDB.
function decodeNext(value, action) {
  if (value === undefined) return undefined;
  let key;
  try {
    key = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  } catch {
    key = null;
  }
  const ok = key && typeof key === 'object' && !Array.isArray(key)
    && Object.keys(key).sort().join(',') === 'action,sortKey'
    && key.action === action && typeof key.sortKey === 'string' && key.sortKey.length <= 100;
  if (!ok) throw validationError('next is not a valid paging token for this action.');
  return key;
}
const encodeNext = (key) => (key ? Buffer.from(JSON.stringify(key)).toString('base64url') : null);

// GET /api/admin/audit-log?action=&since=&limit=&next= → 200 { items: [...], next }
async function queryAuditLog(req, res, next) {
  try {
    const rawAction = one(req.query.action);
    if (rawAction === undefined) throw validationError(`action is required, one of: ${ACTIONS.join(', ')}.`);
    const action = checkEnum(rawAction, 'action', ACTIONS);
    const rawSince = one(req.query.since);
    const since = rawSince === undefined ? undefined : checkIsoDateTime(rawSince, 'since');
    const limit = checkLimit(one(req.query.limit));
    const startKey = decodeNext(one(req.query.next), action);

    const page = await auditService.queryAudit({ action, since, limit, startKey });
    const items = page.items.map((row) => ({
      action: row.action,
      createdAt: String(row.sortKey || '').split('#')[0],
      userId: row.userId ?? null,
      targetId: row.targetId ?? null,
      detail: row.detail ?? null,
    }));
    res.status(200).json({ items, next: encodeNext(page.lastKey) });
  } catch (err) {
    next(err);
  }
}

// GET /api/admin/stats → 200 { scholarships: {...}, applications: {...} }, counted live
async function getStats(req, res, next) {
  try {
    res.status(200).json(await auditService.getStats());
  } catch (err) {
    next(err);
  }
}

module.exports = { queryAuditLog, getStats, ACTIONS };
