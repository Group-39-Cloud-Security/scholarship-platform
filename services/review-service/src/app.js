// app.js — builds the Express app (no listen)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §9 pattern
// TODO:
//   - order: request logger → cors({ origin: CORS_ORIGINS }) → express.json() → routes → ROUTE_NOT_FOUND fallback → error handler
//   - error handler: bad JSON → 400 VALIDATION_ERROR, everything else → 500 INTERNAL_ERROR (details only in the log)
//   - module.exports = app
