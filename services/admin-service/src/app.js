// app.js — builds the Express app (no listen)
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §9 pattern
// TODO:
//   - order (CLAUDE.md §9): requestLogger → securityHeaders → cors({ origin: CORS_ORIGINS }) → express.json() → fixBody() → routes → ROUTE_NOT_FOUND fallback → errorHandler
//     (requestLogger from shared/logger.js; securityHeaders, fixBody from shared/middleware.js; errorHandler from shared/errors.js)
//   - error handler: bad JSON → 400 VALIDATION_ERROR, everything else → 500 INTERNAL_ERROR (details only in the log)
//   - module.exports = app
