// handler.js — SQS → Brevo email
// Owner: Mohamed Wael   ·   Rules: CLAUDE.md §6 Deciding
// TODO:
//   - read Brevo key from SSM once per cold start
//   - send email via Brevo API; update emailStatus sent/failed; throw to retry (3 tries → DLQ)
