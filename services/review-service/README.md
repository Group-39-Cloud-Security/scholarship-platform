# review-service

Owner: **Mohamed Hazem** · Group 39 Scholarship Platform · Rules: `docs/CLAUDE.md` (repo root)

## Functions
view queue, claim, score against the rubric or flag, my reviews, release (+ hourly release of claims older than 48 h)

| Route | Who | Rule |
|---|---|---|
| `GET /api/reviews/queue` | reviewer | oldest 50 submitted applications, no student details |
| `POST /api/reviews` | reviewer | claim with one conditional update, max 5 open claims |
| `GET /api/reviews/mine` | reviewer | my open claims (time left) and my submitted reviews |
| `GET /api/reviews/{applicationId}` | reviewer who claimed it | anyone else gets 404 |
| `PUT /api/reviews/{applicationId}` | reviewer who claimed it | scores checked against the rubric, total calculated by the server, can't be changed later |
| `DELETE /api/reviews/{applicationId}` | the reviewer, or any admin | only while `under_review` |
| `GET /api/reviews/{applicationId}/pdf` | reviewer who claimed it | 5 minute presigned link, only while under review |
| `release-expired-claims` (hourly) | EventBridge Scheduler | claims older than 48 h go back to the queue |

Request and response examples: `docs/api-contract.md` (review-service). Tests: T-REV rows in `docs/api-test-plan.md`, `tests/requests.http`, and the Postman collection `tests/postman/review-service.postman_collection.json` (import it, run `tests/local-test-data.sh`, then run the collection in order).

## Run
```bash
npm install
npm run sync-shared      # copies ../../shared-lib into ./shared and ./release-expired-claims/shared (gitignored)
npm test                 # unit tests for the scoring rules
npm run dev              # local Express on PORT (copy .env.example to .env first)
npm run zip && npm run deploy   # builds lambda.zip + release-expired-claims.zip and deploys both to Floci
```
Lambda handlers: `src/lambda.handler` (review-service) and `handler.handler` (release-expired-claims).

## What deploy.sh creates
- `Reviews` table with `reviewerId-index`
- roles `review-service-role`, `release-expired-claims-role`, `scheduler-invoke-role` (policies in `infra/iam/`)
- both Lambdas, one API Gateway integration, the 7 routes above and an `OPTIONS` route for each path, `add-permission` for API Gateway
- schedule `release-expired-claims-hourly`
- CloudWatch metric filter `login-failed` on `/aws/lambda/auth-service` and alarm `login-failed-spike` (more than 20 in 5 minutes)

## Testing review-service on its own
`bash services/review-service/tests/local-test-data.sh` (from the repo root, after `deploy-all.sh`) adds 1 scholarship, 8 submitted applications and 1 claim older than 48 h, and creates the Applications and Scholarships tables only if they are missing. Local testing only; a clean Floci (`docker compose ... down -v`) removes it.

`bash services/review-service/tests/api-tests.sh` resets that test data and runs every T-REV check with curl, printing PASS or FAIL for each (save the output with `| tee evidence/review-api-tests-floci.txt`).

## Reviewer pages
`frontend/reviewer/queue.html`, `review.html`, `my-reviews.html`. Until the shared login page exists, open the browser console on the website and run `sessionStorage.setItem('token', 'test-reviewer')`, then open `reviewer/queue.html`.

## Security
- The reviewer id always comes from the token. Status, total score and dates are never taken from the body.
- Each status change is one conditional `UpdateItem`, so two reviewers can't claim the same application and a released or expired claim can't be scored.
- Reviews are write-once (`attribute_not_exists`) and the role has no Update or Delete on `Reviews`.
- Someone else's application returns 404, not 403, so ids can't be guessed.
- The queue and the review page don't include the student's id or email.
- PDFs stay in a private bucket. The reviewer gets a 5 minute presigned link, only for their own claim, and every PDF opened is written to `AuditLog`. The link is never logged.
- `claim`, `review`, `release`, `claim_expired`, `pdf_download` and `forbidden` all go to `AuditLog`.
- Responses have `Cache-Control: no-store` so essays don't stay in the browser cache.
- Pages use `textContent` only and a CSP meta tag (only our own scripts, only our API).
- The expiry job takes nothing from its event and only has the DynamoDB client in its zip.

## Known limits
- The 5 claim limit counts claims and then claims, and the count reads a GSI, which can be a moment behind. A reviewer clicking very fast could end up with 6. The claim itself is still safe (one reviewer per application). A fully atomic limit needs a counter on `Users`, which is a shared table, so it's for the team to decide.
- On Floci the presigned PDF link starts with `http://floci:4566` (Floci's name inside Docker), so the browser can't open it unless the laptop maps that name, for example a `127.0.0.1 floci` line in the hosts file. On real AWS the link points to S3 directly. application-service has the same issue (Phase B).

## Checked against the other services (28 Nov)
- `Applications.status-index` (Khalil) uses projection `ALL`, so the queue, my reviews and the expiry job get `scholarshipId`, `reviewerId` and `claimedAt` from it.
- Khalil's lock rows (`lock#...`) have no `status`, so they never show up in the queue, and the `#` in their ids is rejected by the id check (400).
- `Scholarships` (Wael) store `rubric` as `{ criterionId, name, description, weight }`, the shape `scoring.js` checks scores against.
- The end-to-end run through the gateway (`evidence/e2e-walkthrough.md` on branch `hazem-e2e`) went from apply to review to decision.
