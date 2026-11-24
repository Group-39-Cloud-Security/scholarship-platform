// errors.js — the one error shape for every service: { error: { code, message } }
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §8–§10

function sendError(res, status, code, message) {
  return res.status(status).json({ error: { code, message } });
}

// Controllers do next(conflict('...')); errorHandler turns it into the response.
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// One helper per row of the §8 status table.
const validationError = (message) => new AppError(400, 'VALIDATION_ERROR', message);
const unauthenticated = (message = 'Login required.') => new AppError(401, 'UNAUTHENTICATED', message);
const forbidden = (message = 'You do not have permission to do this.') => new AppError(403, 'FORBIDDEN', message);
// resource: 'Scholarship' | 'Application' | 'Review' | 'User'. Also used for someone else's record, so ids can't be probed.
const notFound = (resource) => new AppError(404, `${resource.toUpperCase()}_NOT_FOUND`, `${resource} not found.`);
const conflict = (message) => new AppError(409, 'CONFLICT', message);
const unsupportedMediaType = () => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
const tooManyAttempts = (message = 'Too many attempts. Try again later.') => new AppError(429, 'TOO_MANY_ATTEMPTS', message);

// Registered after all routes: any path Express doesn't know.
function routeNotFound(req, res) {
  return sendError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found.');
}

// Registered last. Express only treats it as an error handler because it has 4 parameters.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof AppError) return sendError(res, err.status, err.code, err.message);
  // Thrown by express.json() before our code runs.
  if (err.type === 'entity.parse.failed') return sendError(res, 400, 'VALIDATION_ERROR', 'Request body is not valid JSON.');
  if (err.type === 'entity.too.large') return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  // Unexpected (AWS SDK, bugs): details go to the log only, never to the client. No body, no headers.
  console.error(JSON.stringify({ level: 'error', method: req.method, path: req.path, error: err.name, message: err.message }));
  return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
}

module.exports = {
  sendError, AppError,
  validationError, unauthenticated, forbidden, notFound, conflict, unsupportedMediaType, tooManyAttempts,
  routeNotFound, errorHandler,
};
