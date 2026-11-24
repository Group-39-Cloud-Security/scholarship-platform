# Decisions log

| Date | Decision | Why | Who |
|---|---|---|---|
| 2026-11-24 | Everyone must understand the Brevo integration (Seif: all members involved in the APIs); we do not change the design, each member can explain it (docs/brevo-integration-explained.md). Ask Seif if he meant each service should use it. | Costs nothing, safe either way; sending from every service would change IAM roles and the queue message (Phase B at the earliest). | Wael |
| 2026-11-24 | Moved from five repos to one team repo `scholarship-platform` (backends in `services/`), with a long-lived branch per member (`wael`, `khalil`, `hazem`) and PRs into `main`. The old per-member repos become personal proof-of-work repos (`git subtree push`); `auth-service` repo to be archived. | TA email of 24 Nov: one team repo with each member's branch + one personal repo per member. Moved before any service code existed, so nothing was lost. | Wael |
| 2026-11-24 | `shared/auth.js` uses four test users picked by the token until Phase B; `req.user` shape fixed as `{ userId, email, role, status }`. Essay capped at 10,000 characters. | Lets every owner test 401/403/ownership in Phase A; Phase B only swaps the body of `authenticate`. The cap stops oversized essays failing at DynamoDB's 400 KB item limit. | Wael |
