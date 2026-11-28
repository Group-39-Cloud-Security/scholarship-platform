# Individual Contribution Statement: Mohamed Hazem

Component: **Reviewer Scoring** (`review-service` + `release-expired-claims`).
Repository: `services/review-service`, `frontend/reviewer`, my sections of `docs/api-contract.md` and `docs/api-test-plan.md`.
Pull requests: #8 (the service), #12 (test results), #15 (README and decisions). Branch for the end-to-end run: `hazem-e2e`.

## 1. Owned component and functions
Reviewers take applications from a shared queue, score them against the scholarship's rubric (or flag them) and the result goes to the admin's decision.

| Function | Endpoint | Role |
|---|---|---|
| View the queue | `GET /api/reviews/queue` | reviewer |
| Claim an application | `POST /api/reviews` | reviewer |
| Open a claimed application with its rubric | `GET /api/reviews/{applicationId}` | reviewer (the claimer) |
| Score or flag (final) | `PUT /api/reviews/{applicationId}` | reviewer (the claimer) |
| My claims and reviews | `GET /api/reviews/mine` | reviewer |
| Release a claim | `DELETE /api/reviews/{applicationId}` | the claimer, or any admin |
| 5 minute PDF link | `GET /api/reviews/{applicationId}/pdf` | reviewer (the claimer) |
| Release claims older than 48 h | `release-expired-claims` Lambda, hourly | EventBridge Scheduler |

AWS services in my component: Lambda (2 functions), DynamoDB (`Reviews`), EventBridge Scheduler, CloudWatch (metric filter and alarm), IAM (one role per function plus the scheduler role).

## 2. Frontend
Three pages in `frontend/reviewer`: `queue.html` (claim), `review.html` (essay, eligibility rules, PDF button, scoring form with a live total preview, flag form, release) and `my-reviews.html` (open claims with time left, submitted reviews).
Text from the database is only ever put on the page with `textContent`, never `innerHTML`, and every page has a Content-Security-Policy meta tag (only our own scripts and styles, only our API). The token is kept in `sessionStorage` and a 401 sends the user back to the login page.
[Screenshot: queue page] [Screenshot: review page with scores] [Screenshot: my reviews]

## 3. Backend / API
Express app on Lambda (`serverless-http`), following the team pattern: routes (method, path, role), controller (415, validation 400, business rules 409, status code), services (AWS calls only).
Business rules:
- a claim is one conditional `UpdateItem` (`status = submitted`), so two reviewers can never get the same application
- at most 5 open claims per reviewer
- scores: every rubric criterion exactly once, whole number 0-10, no extra criteria; the total is `sum(score * weight) / 10`, calculated by the server
- a submitted review is final (409 on a second submit)
- claims older than 48 h go back to the queue (hourly job)
Request and response examples for every endpoint are in my section of `docs/api-contract.md`.

## 4. Data operations
- `Reviews` (mine): one item per application, written once with `attribute_not_exists`; `reviewerId-index` for "my reviews".
- `Applications` (Khalil's table): read, and status changed only through conditional updates (`submitted -> under_review -> reviewed`, or back to `submitted`); the queue reads `status-index`.
- `Scholarships` (Wael's table): read the rubric (`GetItem` only).
- `AuditLog`: `claim`, `review`, `release`, `claim_expired`, `pdf_download`.
- S3 `scholarship-documents`: no reads by the service itself, it only signs a 5 minute GET link for the claimer.

## 5. Security controls
- Authentication on every route, role checked on the server (401/403).
- The reviewer id comes from the token, never the body; status, total and dates are set by the server.
- Ownership: someone else's claim returns 404, not 403, so ids can't be probed. Ids are checked against a pattern before reaching DynamoDB.
- Concurrency: atomic claim with a condition; reviews are write-once; the expiry job only releases a claim if `claimedAt` is unchanged.
- Least privilege: each Lambda has its own role (`infra/iam/*.json`) with a `Sid` per statement and only its own log group; the review role has no Update or Delete on `Reviews`.
- Privacy: the queue and review page leave out the student's id and email; PDFs stay private, links last 5 minutes, every link is audited, the link itself is never logged; responses have `Cache-Control: no-store`.
- Security headers on every response (`nosniff`, `X-Frame-Options: DENY`, CSP), no `X-Powered-By`, CORS only for our website.
- Monitoring: CloudWatch metric filter and alarm for failed logins (more than 20 in 5 minutes).
- No secrets in the code or the history (checked with detect-secrets), `npm audit` with 0 vulnerabilities, Node.js 24 runtime.

## 6. Tests
- Unit tests for the scoring rules (`npm test`, 6 tests).
- `tests/api-tests.sh`: 28 checks with curl through API Gateway on Floci, including 5 parallel claims (exactly one 201) and the 6th claim (409). On 27 Nov they all passed; a 29th check that opened the PDF link failed because of the `floci` host name (section 9) and was taken out. Local run: `evidence/review-api-tests-local.txt`.
- Postman collection `tests/postman/review-service.postman_collection.json`: 20 requests, 25 checks.
- All 24 T-REV rows in `docs/api-test-plan.md` are filled with the actual results.
[Screenshot: api-tests.sh output] [Screenshot: Postman run]

## 7. Integration work
- Checked my service against Khalil's and Wael's code: `status-index` projection, Khalil's lock rows never reaching the queue, the rubric format, Wael reading `flagged` and `Reviews` for the decision email.
- End-to-end run through the gateway on a clean Floci (`evidence/e2e-walkthrough.md`, branch `hazem-e2e`): admin creates a reviewer and a scholarship, student applies, reviewer claims and scores (total 70), student sees "reviewed", admin accepts, student sees "accepted", notification-sender is triggered. Login was blocked because auth-service was not built yet, and the email was not sent because my laptop has no Brevo key.

## 8. Technical decisions
Logged in `docs/decisions.md`: the queue returns the 50 oldest applications; the 5 claim limit is a count followed by an atomic claim (known gap, accepted); PDFs through 5 minute presigned links with a `pdf_download` audit row.

## 9. Difficulties and solutions
- **Two reviewers claiming at once:** solved with a conditional update instead of read-then-write; tested with 5 parallel requests.
- **Node.js 20 out of support:** moved the Lambdas to `nodejs24.x`.
- **npm 11 blocked install scripts (`EALLOWSCRIPTS`):** the expiry job's packages are now picked from the service's own `node_modules` when zipping, with no second `npm install`.
- **PDF link not opening on Floci:** the presigned link uses `floci:4566`, Floci's name inside Docker; it works with a `127.0.0.1 floci` hosts entry, and on AWS it points to S3.
- **Failed-login alarm never matching:** Lambda writes a timestamp and request id before our JSON, so my JSON filter pattern matched nothing. Wael found it and changed it to a plain-text pattern in his auth-service PR.
- **Testing before the other services existed:** wrote `tests/local-test-data.sh` to create test applications and a scholarship.
