// loginAttemptService.js — LoginAttempts table (TTL)
// Owner: Shared (lead: Mohamed Wael, reviewed by all)   ·   Rules: CLAUDE.md §6
// TODO:
//   - record failure, compute blockedUntil (1 min doubling, max 15 min), reset on success, set expiresAt
