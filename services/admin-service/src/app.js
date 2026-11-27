// app.js — builds the Express app (no listen). server.js runs it locally, lambda.js wraps it for Lambda.
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §9 pattern
// Order matters (§9): requestLogger, securityHeaders, cors, express.json, fixBody, routes, 404, errorHandler

const express = require('express');
const cors = require('cors');
const { requestLogger } = require('../shared/logger');
const { securityHeaders, fixBody } = require('../shared/middleware');
const { routeNotFound, errorHandler } = require('../shared/errors');
const healthRoutes = require('./routes/health');
const scholarshipRoutes = require('./routes/scholarships');

const app = express();
app.disable('x-powered-by'); // don't advertise Express

// Only our own website may call the API from a browser (exact origins, from the env var).
const origins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);

app.use(requestLogger);
app.use(securityHeaders);
app.use(cors({ origin: origins }));
app.use(express.json({ limit: '100kb' }));
app.use(fixBody({ limit: '100kb' })); // Floci can hand the body over as a Buffer/base64 (Lab 7)

// Admin responses carry emails, essays and scores: never let a browser or proxy keep a copy.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use('/api/health', healthRoutes); // the only route without a token
app.use('/api/admin/scholarships', scholarshipRoutes); // admin only (authenticate + requireRole in the router)

app.use(routeNotFound);
app.use(errorHandler);

module.exports = app;
