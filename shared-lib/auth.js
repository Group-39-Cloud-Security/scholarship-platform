// auth.js — authenticate + requireRole
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §2, §8, §10
//
// Use in routes:  router.post('/applications', authenticate, requireRole('student'), controller.apply);
// req.user is always { userId, email, role, status }, so Phase B only changes the body of authenticate.

const { unauthenticated, forbidden } = require('./errors');
const { writeAudit } = require('./audit');

// TODO remove in Phase B: temporary test users (CLAUDE.md §2), replaced by JWT verify + GetItem on Users.
const TEST_USERS = {
  'test-student-1': { userId: 'test-student-1', email: 'student1@example-university.edu', role: 'student', status: 'active' },
  'test-student-2': { userId: 'test-student-2', email: 'student2@example-university.edu', role: 'student', status: 'active' },
  'test-reviewer': { userId: 'test-reviewer', email: 'reviewer@example-university.edu', role: 'reviewer', status: 'active' },
  'test-admin': { userId: 'test-admin', email: 'admin@example-university.edu', role: 'admin', status: 'active' },
};

// Missing, malformed or unknown token → 401 UNAUTHENTICATED.
function authenticate(req, res, next) {
  const match = /^Bearer (\S+)$/.exec(req.get('authorization') || '');
  // TODO remove in Phase B: lookup in TEST_USERS
  const user = match && Object.hasOwn(TEST_USERS, match[1]) ? TEST_USERS[match[1]] : null;
  if (!user) return next(unauthenticated());
  req.user = { ...user }; // a copy, so a controller can't change the shared test user
  next();
}

// Registered after authenticate. Logged in but wrong role → 403 FORBIDDEN, recorded in AuditLog (§10).
function requireRole(...roles) {
  return function requireRoleMiddleware(req, res, next) {
    if (!req.user) return next(unauthenticated());
    if (!roles.includes(req.user.role)) {
      // Not awaited: the 403 goes out straight away. writeAudit never throws, it logs its own failures.
      void writeAudit({ action: 'forbidden', userId: req.user.userId, targetId: req.path, detail: 'needed ' + roles.join('/') });
      return next(forbidden());
    }
    next();
  };
}

module.exports = { authenticate, requireRole };
