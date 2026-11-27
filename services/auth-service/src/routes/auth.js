// auth.js — POST /api/auth/register, POST /api/auth/login, PUT /api/auth/password, GET /api/auth/me
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §8. Maps routes to the controller, no logic.

const express = require('express');
const { authenticate } = require('../../shared/auth');
const controller = require('../controllers/auth');

const router = express.Router();

router.post('/register', controller.register); // anyone (no token)
router.post('/login', controller.login); // anyone (no token)
router.get('/me', authenticate, controller.me); // any logged-in user
router.put('/password', authenticate, controller.changePassword); // any logged-in user

module.exports = router;
