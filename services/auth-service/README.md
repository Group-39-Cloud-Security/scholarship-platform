# auth-service

Owner: **Shared (lead: Mohamed Wael, reviewed by all)** · Group 39 Scholarship Platform · Rules: `docs/CLAUDE.md` (repo root)

## Functions
register · login · change password · current user (shared component — not counted as anyone's 3 functions)

## Slices (built in Phase B, after every service passes its own tests)
| Slice | Owner |
|---|---|
| register: domain check, minimum length, Pwned Passwords (`pwnedService.js`) | Khalil |
| login backoff: `loginAttemptService.js`, 429, `login_failed` events, CloudWatch filter + alarm | Hazem |
| login (bcryptjs + JWT), `GET /me`, password change, `infra/deploy.sh` | Wael (lead, reviews every PR) |

## Run
```bash
npm install
npm run sync-shared      # copies ../../shared-lib into ./shared (gitignored, never edit ./shared)
npm run dev              # local Express on PORT (uses .env)
npm run zip && npm run deploy   # build lambda.zip and deploy this service to Floci
```
Lambda handler: `src/lambda.handler`.
