// handler.js — scheduled job (EventBridge Scheduler, hourly)
// Owner: Mohamed Hazem   ·   Rules: CLAUDE.md §6 Reviewing
// TODO:
//   - query status-index under_review, claimedAt older than 48 h
//   - conditional update back to submitted, clear reviewerId/claimedAt, audit claim_expired
