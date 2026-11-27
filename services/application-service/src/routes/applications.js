// applications.js — POST /api/applications, GET /api/applications/mine, GET /api/applications/:id/pdf, DELETE /api/applications/:id
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §8
// Routes only: method + path + role. Every route is student-only; ownership is checked in the controller.

const express = require('express');
const { authenticate, requireRole } = require('../../shared/auth');
const { fixBody } = require('../../shared/middleware');
const controller = require('../controllers/applications');

const router = express.Router();
const student = [authenticate, requireRole('student')];

// Apply: the only route with a big body (essay + PDF as base64). Login and role are checked BEFORE the
// 3 MB body is parsed, so anonymous callers can't make us parse large bodies.
router.post('/', ...student, express.json({ limit: '3mb' }), fixBody({ limit: '3mb' }), controller.apply);
router.get('/mine', ...student, controller.listMine);
router.get('/:id/pdf', ...student, controller.downloadPdf);
router.delete('/:id', ...student, controller.withdraw);

module.exports = router;
