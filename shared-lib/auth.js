// auth.js — requireAuth + requireRole
// Owner: Shared (lead: Mohamed Wael; changes need all three to approve)   ·   Rules: CLAUDE.md §9–§10
// TODO:
//   - verify JWT (secret from SSM, cached), re-read user from Users (role, status) → 401 if missing/disabled
//   - requireRole(...roles) → 403
//   - TEMP until auth-service works: hard-coded test user, marked // TODO remove
