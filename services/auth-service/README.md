# auth-service

Owner: **Shared (lead: Mohamed Wael, reviewed by all)** · Group 39 Scholarship Platform · Rules: `docs/CLAUDE.md` (repo root)

## Functions
register · login · change password · current user (shared component — not counted as anyone's 3 functions)

## Who built it
Built in Phase B by Wael for the whole team (group decision 28 Nov, `docs/decisions.md`), instead of the three slices first planned in CLAUDE.md §1. Khalil and Hazem review every PR. The `login_failed` metric filter and alarm stay in review-service's `deploy.sh` (Hazem).

## Tests
`bash services/auth-service/tests/api-tests.sh` from the repo root (T-AUT rows in `docs/api-test-plan.md`, local Floci only).

## Run
```bash
npm install
npm run sync-shared      # copies ../../shared-lib into ./shared (gitignored, never edit ./shared)
npm run dev              # local Express on PORT (uses .env)
npm run zip && npm run deploy   # build lambda.zip and deploy this service to Floci
```
Lambda handler: `src/lambda.handler`.
