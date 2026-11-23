# scholarship-frontend — Group 39 Scholarship Platform

Shared repo: **frontend pages, platform scripts, shared code, docs**. Changes go through a pull request approved by all three.

```
frontend/    pages served from S3 (scholarship-web)       — shell: Khalil · pages: each owner
platform/    Floci + deploy scripts                       — Wael
shared-lib/  the one true copy of shared backend code     — Hazem (sync into services with npm run sync-shared)
docs/        CLAUDE.md (rulebook), report material
evidence/    screenshots, Postman exports, CLI outputs
```

## Folder layout on your laptop (all 5 repos side by side)
```
group39/
  scholarship-frontend/  auth-service/  application-service/  review-service/  admin-service/
```

## Daily start (Git Bash, inside scholarship-frontend)
```bash
docker compose -f platform/docker-compose.yml up -d     # start Floci (never use 'down -v')
bash platform/deploy-all.sh                              # build/refresh everything
```
Website: http://localhost:4566/scholarship-web/index.html · Floci Dash: http://localhost:4566/_floci/ui
