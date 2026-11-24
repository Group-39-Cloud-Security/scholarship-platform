// decisions.js — accept/reject reviewed applications
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Deciding
// TODO:
//   - only status reviewed; flagged → reject only
//   - accept: atomic acceptedCount < awards, then conditional status update (decrement if it fails)
//   - log decision; queue email (never undo decision on email failure)
