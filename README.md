# scholarship-platform — Group 39 Scholarship Platform

The team repository for Cloud Computing & Cloud Security (26CSCN29H), Group 39: all code, scripts and docs.
Rules for everyone (people and Claude): [`docs/CLAUDE.md`](docs/CLAUDE.md).

```
frontend/    pages served from S3 (scholarship-web)            — shell: Khalil · pages: each owner
platform/    Floci + deploy scripts                            — Wael
shared-lib/  the one true copy of shared backend code          — Wael (copied into each service by npm run sync-shared)
services/
  auth-service/         shared login (slices by all three, lead Wael)
  application-service/  Khalil
  review-service/       Hazem (+ release-expired-claims)
  admin-service/        Wael (+ notification-sender)
docs/        CLAUDE.md (rulebook), report material
evidence/    screenshots, Postman exports, CLI outputs
```

## Branches
Each member works on their own branch — `wael`, `khalil`, `hazem` — or a short feature branch cut from it, and opens a PR into `main` reviewed by one teammate. Nobody pushes to `main` directly. Personal proof-of-work repos: `admin-service` (Wael), `application-service` (Khalil), `review-service` (Hazem); see `docs/CLAUDE.md` section 9.

## Daily start (Git Bash, in the repo root)
```bash
git switch <your-branch> && git pull origin main         # start from the latest main
docker compose -f platform/docker-compose.yml up -d     # start Floci (never use 'down -v')
bash platform/deploy-all.sh                              # build/refresh everything
```
Website: http://localhost:4566/scholarship-web/index.html · Floci Dash: http://localhost:4566/_floci/ui
