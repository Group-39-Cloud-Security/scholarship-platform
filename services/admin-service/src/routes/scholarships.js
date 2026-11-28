// scholarships.js — method + path + role, nothing else (§9). Mounted at /api/admin/scholarships in app.js.
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §8

const express = require('express');
const { authenticate, requireRole } = require('../../shared/auth');
const c = require('../controllers/scholarships');

const router = express.Router();
// Every route in this file is admin only: no token → 401, wrong role → 403 (+ forbidden in AuditLog).
// Put on the router, not per route, so a route added later can't be left open by mistake.
router.use(authenticate, requireRole('admin'));

router.get('/', c.listScholarships); // every status, or ?status=
router.post('/', c.createScholarship);
router.get('/:id', c.getScholarship);
router.put('/:id', c.updateScholarship); // draft only
router.patch('/:id/status', c.changeStatus); // draft → published → closed
router.get('/:id/applications', c.listApplications); // with scores, highest total first

module.exports = router;
