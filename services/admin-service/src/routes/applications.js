// applications.js — method + path + role, nothing else (§9). Mounted at /api/admin/applications in app.js.
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §8

const express = require('express');
const { authenticate, requireRole } = require('../../shared/auth');
const c = require('../controllers/decisions');

const router = express.Router();
// Every route in this file is admin only: no token → 401, wrong role → 403 (+ forbidden in AuditLog).
router.use(authenticate, requireRole('admin'));

router.patch('/:id/decision', c.decideApplication);

module.exports = router;
