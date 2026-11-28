// auth.js — authenticate + requireRole (+ getJwtSecret, used by auth-service to sign tokens)
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §2, §6, §8, §10
//
// Use in routes:  router.post('/applications', authenticate, requireRole('student'), controller.apply);
// req.user is always { userId, email, role, status }.
//
// Phase B: the four hard-coded test users are gone. A token is a JWT signed by auth-service (HS256, 1 hour).
// authenticate checks the signature and expiry, then re-reads the user from Users on every request, so a role
// change or a disabled account takes effect on the next request (the role inside the token is never trusted).
// Needs in the service: env USERS_TABLE and JWT_SECRET_PARAM, and in its IAM role dynamodb:GetItem on Users and
// ssm:GetParameter on /scholarship/jwt-secret (§7). Every service already has both.

const jwt = require('jsonwebtoken');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');
const { GetCommand } = require('@aws-sdk/lib-dynamodb');
const { docClient } = require('./dynamo');
const { unauthenticated, forbidden } = require('./errors');
const { writeAudit } = require('./audit');

const ssm = new SSMClient({});
let secretPromise = null;

// The signing secret from SSM (SecureString), read once per Lambda container and kept in memory only.
function getJwtSecret() {
  if (!secretPromise) {
    secretPromise = ssm.send(new GetParameterCommand({ Name: process.env.JWT_SECRET_PARAM, WithDecryption: true }))
      .then((res) => res.Parameter.Value)
      .catch((err) => { secretPromise = null; throw err; }); // try again on the next request, don't cache a failure
  }
  return secretPromise;
}

// While mustChangePassword is true (a reviewer's temporary password), only these two routes work (decided 28 Nov).
const ALLOWED_BEFORE_PASSWORD_CHANGE = ['GET /api/auth/me', 'PUT /api/auth/password'];

// Missing, malformed, badly signed or expired token, unknown or disabled user → 401 UNAUTHENTICATED.
async function authenticate(req, res, next) {
  try {
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(req.get('authorization') || '');
    if (!match) return next(unauthenticated());

    let claims;
    try {
      // algorithms pinned: a token claiming "none" or another algorithm is refused.
      claims = jwt.verify(match[1], await getJwtSecret(), { algorithms: ['HS256'] });
    } catch (err) {
      if (err.name === 'TokenExpiredError') return next(unauthenticated('Your session has expired. Log in again.'));
      if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') return next(unauthenticated());
      throw err; // SSM failure etc. → 500
    }
    if (typeof claims.sub !== 'string' || claims.sub === '') return next(unauthenticated());

    const found = await docClient.send(new GetCommand({
      TableName: process.env.USERS_TABLE,
      Key: { userId: claims.sub },
      ProjectionExpression: 'userId, email, #r, #s, mustChangePassword', // never passwordHash
      ExpressionAttributeNames: { '#r': 'role', '#s': 'status' },
    }));
    const user = found.Item;
    if (!user || user.status !== 'active') return next(unauthenticated());

    req.user = { userId: user.userId, email: user.email, role: user.role, status: user.status };

    const route = `${req.method} ${req.originalUrl.split('?')[0]}`;
    if (user.mustChangePassword === true && !ALLOWED_BEFORE_PASSWORD_CHANGE.includes(route)) {
      await writeAudit({
        action: 'forbidden', userId: user.userId, targetId: req.originalUrl.split('?')[0], detail: 'must change password',
      });
      return next(forbidden('Change your temporary password first.'));
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Registered after authenticate. Logged in but wrong role → 403 FORBIDDEN, recorded in AuditLog (§10).
function requireRole(...roles) {
  return async function requireRoleMiddleware(req, res, next) {
    if (!req.user) return next(unauthenticated());
    if (!roles.includes(req.user.role)) {
      // Awaited so Lambda can't freeze before the write lands. writeAudit never throws, it logs its own failures.
      await writeAudit({
        action: 'forbidden',
        userId: req.user.userId,
        targetId: req.originalUrl.split('?')[0], // full path, same as the request log
        detail: 'needed ' + roles.join('/'),
      });
      return next(forbidden());
    }
    next();
  };
}

module.exports = { authenticate, requireRole, getJwtSecret };
