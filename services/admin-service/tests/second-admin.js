// second-admin.js — TEST ONLY. Adds a second admin token, `Bearer test-admin-2`, for the race test where two admins
// disable each other at the same time (T-ADM-61). shared-lib/auth.js has only one test admin (CLAUDE.md §2) and is
// not changed. Used only by tests/api-tests.sh on the local run, as a preload:
//   node -r ./tests/second-admin.js src/server.js        (from services/admin-service)
// Never in the Lambda: npm run zip packs only src/, shared/, package.json and node_modules/, not tests/.
const path = require('path');

require('dotenv').config({ quiet: true }); // services read table names when they load

const authPath = path.resolve(__dirname, '../shared/auth.js');
const real = require(authPath);
const SECOND_ADMIN = { userId: 'test-admin-2', email: 'admin2@example-university.edu', role: 'admin', status: 'active' };

function authenticate(req, res, next) {
  if ((req.get('authorization') || '') === 'Bearer test-admin-2') {
    req.user = { ...SECOND_ADMIN };
    return next();
  }
  return real.authenticate(req, res, next);
}

// Every later require('../../shared/auth') gets this wrapped version (same module, same requireRole).
require.cache[authPath].exports = { ...real, authenticate };
