# review-service

Owner: **Mohamed Hazem** · Group 39 Scholarship Platform · Rules: `docs/CLAUDE.md` (repo root)

## Functions
view queue · claim · score against rubric / flag · my reviews · release (+ hourly release of claims older than 48 h)

| Route | Who | Rule it enforces |
|---|---|---|
| `GET /api/reviews/queue` | reviewer | submitted only, oldest first, no student identity |
| `POST /api/reviews` | reviewer | atomic claim (conditional update), max 5 active claims |
| `GET /api/reviews/mine` | reviewer | own claims (time left) + own reviews |
| `GET /api/reviews/{applicationId}` | reviewer (claimer) | someone else's claim → 404 |
| `PUT /api/reviews/{applicationId}` | reviewer (claimer) | scores checked against the rubric, total calculated by the server, write-once |
| `DELETE /api/reviews/{applicationId}` | reviewer (own) / admin (any) | only while `under_review` |
| `GET /api/reviews/{applicationId}/pdf` | reviewer (claimer) | presigned link, 5 minutes, only while under review |
| `release-expired-claims` (hourly) | EventBridge Scheduler | claims older than 48 h go back to the queue |

Full request/response contract: `docs/api-contract.md` → review-service. Tests: `docs/api-test-plan.md` (T-REV-*), `tests/requests.http`.

## Run
```bash
npm install
npm run sync-shared      # copies ../../shared-lib into ./shared and ./release-expired-claims/shared (gitignored)
npm test                 # unit tests for the scoring rules
npm run dev              # local Express on PORT (uses .env, copy it from .env.example)
npm run zip && npm run deploy   # builds lambda.zip + release-expired-claims.zip and deploys both to Floci
```
Lambda handlers: `src/lambda.handler` (review-service) and `handler.handler` (release-expired-claims).

## What deploy.sh creates
`Reviews` table (+ `reviewerId-index`) · roles `review-service-role`, `release-expired-claims-role`, `scheduler-invoke-role` (policies in `infra/iam/`) · both Lambdas · one API Gateway integration, the 7 routes above + an `OPTIONS` route per path · `add-permission` for API Gateway · schedule `release-expired-claims-hourly` · CloudWatch metric filter `login-failed` on `/aws/lambda/auth-service` + alarm `login-failed-spike` (> 20 in 5 min).

## Reviewer pages
`frontend/reviewer/queue.html`, `review.html`, `my-reviews.html`. Until the shared login page exists (Phase B/C), open the browser console on the website and run `sessionStorage.setItem('token', 'test-reviewer')`, then open `reviewer/queue.html`.

## Security notes (for the report and the discussion)
- Reviewer id always from the token; status, scores total and timestamps never from the body.
- Every status change is one conditional `UpdateItem`: two reviewers can't claim the same application, and a released or expired claim can't be scored.
- Reviews are write-once (`attribute_not_exists`); the role has no Update/Delete on `Reviews`.
- Someone else's application returns 404, not 403, so ids can't be probed.
- The queue and review view leave out the student's id and email.
- PDFs: private bucket, 5-minute presigned link, only for the current claimer; the link is never logged.
- Pages: `textContent` only, CSP meta tag (only our scripts, only our API), links opened with no `opener`.

## Known limits
- The 5-claim limit is a count followed by the claim, so two claims sent in the same instant by the same reviewer could reach 6. The claim itself is atomic; making the count atomic would need a counter on `Users` (a shared table), so it is left for the team to decide.
- The presigned PDF link is signed with the Lambda's endpoint. If Floci gives Lambda an internal host name, the link must be rewritten to `localhost:4566` for the browser; agree on this with application-service (same issue) in Phase B.
