# application-service

Owner: **Mohamed Khalil** · Group 39 Scholarship Platform · Rules: `docs/CLAUDE.md` (repo root)

## Functions (CLAUDE.md §1, §8)
| Endpoint | Who | Business rules |
|---|---|---|
| `GET /api/scholarships?search=` · `GET /api/scholarships/{id}` | any logged-in user | only `published` shown; drafts/closed → 404 |
| `POST /api/applications` | student | published + before deadline · eligibility (email domain from the token, min GPA, year) · one per scholarship · max 3 active · essay 200–1000 words (≤ 10,000 chars) · PDF ≤ 2 MB starting with `%PDF-` |
| `GET /api/applications/mine` | student | own only; status timeline; never reviewer, scores or flag |
| `GET /api/applications/{id}/pdf` | student (owner) | ownership first, then a 5-minute presigned link |
| `DELETE /api/applications/{id}` | student (owner) | only while `submitted` and before the deadline (conditional delete); removes the PDF too |

AWS: Lambda `application-service`, DynamoDB `Applications` (+ `studentId-index`, `scholarshipId-index`, `status-index`), S3 `scholarship-documents` (private, SSE-S3).

## Files
```
src/routes/        method + path + role only
src/controllers/   415 → 400 → business rules (409) → status code
src/services/      AWS calls (applicationService, scholarshipReadService, documentService) + pure rules (eligibility, pdfCheck)
infra/deploy.sh    table, bucket, IAM role, Lambda, integration, routes + OPTIONS, add-permission (safe to re-run)
scripts/test-scholarships.js   Phase A test data only (8 scholarships with ids test-*)
tests/unit.test.js             pure rules (no AWS)
tests/api-tests.js             43 end-to-end tests, PASS/FAIL per test ID
```

## Run (Git Bash, from this folder, Floci running, `platform/shared.sh` done once)
```bash
npm install
npm run sync-shared      # copies ../../shared-lib into ./shared (gitignored, never edit ./shared)
npm run zip              # lambda.zip
npm run deploy           # infra/deploy.sh → prints the API URL
npm run test-data        # Phase A test scholarships
npm test                 # unit tests
API_URL=<printed API URL> npm run test:api
```
Lambda handler: `src/lambda.handler`.
