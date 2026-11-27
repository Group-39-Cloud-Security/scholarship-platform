// audit.js — method + path + role, nothing else (§9). Mounted at /api/admin in app.js.
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §8
//
// The admin guard is on each route here, not router.use(): this router sits on /api/admin, and a router-wide
// guard would answer 401 for every unknown /api/admin/... path instead of the 404 fallback.

const express = require('express');
const { authenticate, requireRole } = require('../../shared/auth');
const c = require('../controllers/audit');

const router = express.Router();
const adminOnly = [authenticate, requireRole('admin')]; // no token → 401, wrong role → 403 (+ forbidden in AuditLog)

router.get('/audit-log', adminOnly, c.queryAuditLog);
router.get('/stats', adminOnly, c.getStats);

module.exports = router;
