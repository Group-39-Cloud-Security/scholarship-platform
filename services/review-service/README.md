# review-service

Owner: **Mohamed Hazem** · Group 39 Scholarship Platform · Rules: `docs/CLAUDE.md` (repo root)

## Functions
view queue · claim · score against rubric / flag · my reviews · release (+ hourly release of claims older than 48 h)

## Run
```bash
npm install
npm run sync-shared      # copies ../../shared-lib into ./shared (gitignored, never edit ./shared)
npm run dev              # local Express on PORT (uses .env)
npm run zip && npm run deploy   # build lambda.zip and deploy this service to Floci
```
Lambda handler: `src/lambda.handler`.
