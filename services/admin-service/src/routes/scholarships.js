// scholarships.js — method + path + role, nothing else (§9). Mounted at /api/admin/scholarships in app.js.
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §8
// Still to come: PUT /:id (draft only), PATCH /:id/status, GET /:id/applications

const express = require('express');
const { authenticate, requireRole } = require('../../shared/auth');
const c = require('../controllers/scholarships');

const router = express.Router();
// Every route in this file is admin only: no token → 401, wrong role → 403 (+ forbidden in AuditLog).
// Put on the router, not per route, so a route added later can't be left open by mistake.
router.use(authenticate, requireRole('admin'));

router.post('/', c.createScholarship);

module.exports = router;
