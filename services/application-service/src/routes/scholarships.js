// scholarships.js — GET /api/scholarships (published, ?search=), GET /api/scholarships/:id
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §8
// Routes only: method + path + who may call it. Any logged-in user may browse (students, reviewers, admins).

const express = require('express');
const { authenticate } = require('../../shared/auth');
const controller = require('../controllers/scholarships');

const router = express.Router();

router.get('/', authenticate, controller.list);
router.get('/:id', authenticate, controller.getOne);

module.exports = router;
