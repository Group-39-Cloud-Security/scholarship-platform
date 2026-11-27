// health.js — GET /api/health (no auth). Mounted at /api/health in app.js.
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §2 (Lambda settings), §8
// Proves the API reaches the Lambda (runtime: lambda) without a token. Says nothing about tables or secrets.

const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    environment: process.env.NODE_ENV || 'development',
    runtime: process.env.AWS_LAMBDA_FUNCTION_NAME ? 'lambda' : 'local',
  });
});

module.exports = router;
