// reviews.js - method + path + role, nothing else (§9). Mounted at /api/reviews in app.js.
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §8
// /queue and /mine come before /:applicationId so Express doesn't read "queue" as an id.

const express = require('express');
const { authenticate, requireRole } = require('../../shared/auth');
const c = require('../controllers/reviews');

const router = express.Router();
router.use(authenticate); // every review route needs a valid token, otherwise 401

router.get('/queue', requireRole('reviewer'), c.viewQueue);
router.post('/', requireRole('reviewer'), c.claimApplication);
router.get('/mine', requireRole('reviewer'), c.myReviews);
router.get('/:applicationId', requireRole('reviewer'), c.getForReview);
router.put('/:applicationId', requireRole('reviewer'), c.submitReview);
router.delete('/:applicationId', requireRole('reviewer', 'admin'), c.releaseClaim);
router.get('/:applicationId/pdf', requireRole('reviewer'), c.downloadPdf);

module.exports = router;
