# admin-service

Owner: **Mohamed Wael** · Group 39 Scholarship Platform · Rules: `docs/CLAUDE.md` (repo root)

## Functions
create/edit/publish/close scholarships with rubric + eligibility · accept/reject + email · account management · audit log + stats

## Run
```bash
npm install
npm run sync-shared      # copies ../../shared-lib into ./shared (gitignored, never edit ./shared)
npm run dev              # local Express on PORT (uses .env)
npm run zip && npm run deploy   # build lambda.zip and deploy this service to Floci
```
Lambda handler: `src/lambda.handler`.
