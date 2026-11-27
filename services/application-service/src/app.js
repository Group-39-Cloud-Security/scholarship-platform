// app.js — builds the Express app (no listen). server.js runs it locally, lambda.js wraps it for Lambda.
// Owner: Mohamed Khalil   ·   Rules: CLAUDE.md §9 pattern, §8 PDFs, §10

const express = require('express');
const cors = require('cors');
const { requestLogger } = require('../shared/logger');
const { securityHeaders, fixBody } = require('../shared/middleware');
const { routeNotFound, errorHandler } = require('../shared/errors');
const scholarshipRoutes = require('./routes/scholarships');
const applicationRoutes = require('./routes/applications');

const app = express();
app.disable('x-powered-by'); // don't advertise Express to attackers

// 1. One JSON log line per request (never bodies or tokens).
app.use(requestLogger);
// 2. nosniff, DENY framing, CSP default-src 'none' on every response (Lab 8).
app.use(securityHeaders);
// 3. Only our website's origin may call the API from a browser (exact match, comma-separated list).
const origins = (process.env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: origins }));

// 4. Body parsing. The apply route carries a PDF (up to 2 MB, ~2.7 MB as base64), so the global
//    100 kB parsers must skip it; otherwise they answer 413 before the route's own 3 MB parser runs (§8 PDFs).
const isApplyRoute = (req) => req.method === 'POST' && req.path.replace(/\/+$/, '') === '/api/applications';
const smallJson = express.json();   // default limit 100 kB
const smallFixBody = fixBody();     // Floci sometimes hands the body over as a Buffer/base64 text
app.use((req, res, next) => (isApplyRoute(req) ? next() : smallJson(req, res, next)));
app.use((req, res, next) => (isApplyRoute(req) ? next() : smallFixBody(req, res, next)));

// 5. Routes (method + path + role checks only).
app.use('/api/scholarships', scholarshipRoutes);
app.use('/api/applications', applicationRoutes);

// 6. Anything else → 404 ROUTE_NOT_FOUND, then the one error handler (bad JSON → 400, unknown → 500).
app.use(routeNotFound);
app.use(errorHandler);

module.exports = app;
