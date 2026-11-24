// logger.js — request logger middleware + log() for everything else
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §9–§10
// One JSON line per entry, so CloudWatch metric filters can match fields. Never bodies, headers or tokens.

const fnName = () => process.env.AWS_LAMBDA_FUNCTION_NAME || 'local';

// For the error handler and other one-off lines. Callers pass only safe fields (no bodies, tokens, presigned URLs).
function log(level, message, fields = {}) {
  const line = JSON.stringify({ level, fn: fnName(), message, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

// Registered first in app.js. Writes the line when the response finishes, so status and req.user are known.
function requestLogger(req, res, next) {
  res.on('finish', () => {
    const status = res.statusCode;
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
    const line = JSON.stringify({
      level,
      fn: fnName(),
      method: req.method,
      path: req.originalUrl.split('?')[0], // query strings can carry search text, so they are left out
      status,
      userId: req.user ? req.user.userId : null,
      action: res.locals.action || null, // set by controllers, e.g. res.locals.action = 'login_failed'
    });
    if (level === 'error') console.error(line);
    else console.log(line);
  });
  next();
}

module.exports = { requestLogger, log };
