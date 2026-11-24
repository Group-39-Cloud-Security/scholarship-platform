# application-service

Owner: **Mohamed Khalil** · Group 39 Scholarship Platform · Rules: `docs/CLAUDE.md` (repo root)

## Functions
browse published scholarships · apply (essay + PDF) · my applications + PDF · withdraw

## Run
```bash
npm install
npm run sync-shared      # copies ../../shared-lib into ./shared (gitignored, never edit ./shared)
npm run dev              # local Express on PORT (uses .env)
npm run zip && npm run deploy   # build lambda.zip and deploy this service to Floci
```
Lambda handler: `src/lambda.handler`.
