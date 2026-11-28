# Individual Contribution Statement: Mohamed Hazem

Component: Reviewer Scoring (review-service and the release-expired-claims job)
My files: `services/review-service`, `frontend/reviewer`, `tests/e2e/run-e2e.sh`, and my parts of `docs/api-contract.md` and `docs/api-test-plan.md`
My PRs: #8 (the service), #12 (test results), #15 (README and decisions). The end-to-end run is on the `hazem-e2e` branch.

## 1. Owned component and functions
My part is the reviewer side. A reviewer takes an application from the queue, scores it using the scholarship's rubric or flags it, and then the admin uses that to accept or reject the student.

| What | Endpoint | Who can use it |
|---|---|---|
| See the queue | GET /api/reviews/queue | reviewer |
| Claim an application | POST /api/reviews | reviewer |
| Open a claimed application | GET /api/reviews/{id} | the reviewer who claimed it |
| Submit scores or a flag | PUT /api/reviews/{id} | the reviewer who claimed it |
| My claims and reviews | GET /api/reviews/mine | reviewer |
| Release a claim | DELETE /api/reviews/{id} | the reviewer who claimed it, or an admin |
| Get the PDF link | GET /api/reviews/{id}/pdf | the reviewer who claimed it |
| Release claims older than 48 hours | release-expired-claims Lambda | runs every hour from EventBridge Scheduler |

AWS services I used: Lambda (2 functions), DynamoDB (Reviews table), EventBridge Scheduler, CloudWatch, IAM, and S3 for the PDF links.

## 2. Frontend
I made three pages in `frontend/reviewer`:
- `queue.html` shows the submitted applications with a Claim button.
- `review.html` shows the essay, the eligibility rules and a PDF button, with a form for the scores (the total updates while you type) or a flag, and a Release button.
- `my-reviews.html` shows my open claims with the time left, and the reviews I already submitted.

All text that comes from the database is added with `textContent` and not `innerHTML`, so a script inside an essay can't run. Every page also has a CSP meta tag. The token is kept in sessionStorage, and if the API returns 401 the page goes back to the login page.

[Screenshot: queue page] [Screenshot: review page] [Screenshot: my reviews page]

## 3. Backend / API
The service is an Express app that runs on Lambda using serverless-http. I followed the same structure as the rest of the team: routes, controllers and services.

The main rules:
- A claim is one conditional update in DynamoDB, so two reviewers can't get the same application.
- A reviewer can have at most 5 open claims.
- Every criterion in the rubric needs a whole number from 0 to 10. The server calculates the total (each score times its weight, added up and divided by 10). A total sent by the client is not accepted.
- After a review is submitted it can't be changed (409).
- A claim older than 48 hours goes back to the queue.

Examples of every request and response are in my part of `docs/api-contract.md`.

## 4. Data operations
- Reviews (my table): one review per application, written only once using `attribute_not_exists`. It has a `reviewerId-index` for the my reviews page.
- Applications (Khalil's table): I read it and only change the status with conditional updates (submitted to under_review to reviewed, or back to submitted). The queue reads `status-index`.
- Scholarships (Wael's table): I only read the rubric.
- AuditLog: I write claim, review, release, claim_expired and pdf_download.
- S3: my service doesn't read the PDFs itself. It only makes a 5 minute link for the reviewer who claimed the application.

## 5. Security controls
- Every route needs a valid login, and the role is checked on the server (401 or 403).
- The reviewer id is taken from the token, not from the request body. Status, total and dates are also set by the server.
- If a reviewer asks for an application someone else claimed they get 404 instead of 403, so they can't tell which ids exist. Ids are checked with a regex before they reach DynamoDB.
- Claims are atomic, reviews can only be written once, and the expiry job only releases a claim if `claimedAt` didn't change since it read it.
- Each Lambda has its own IAM role with only the permissions it needs, and it can only write to its own log group. The review-service role can't update or delete reviews.
- The reviewer doesn't see the student's id or email. PDF links last 5 minutes, every link is saved in AuditLog, and the link itself is not logged. Responses have `Cache-Control: no-store` so essays don't stay in the browser cache.
- Security headers on every response (nosniff, X-Frame-Options DENY, CSP), X-Powered-By is turned off, and CORS only allows our website.
- CloudWatch metric filter and alarm for failed logins (more than 20 in 5 minutes).
- I checked for secrets with detect-secrets and ran npm audit (0 vulnerabilities). Both Lambdas run on Node.js 24.

## 6. Tests
- 6 unit tests for the scoring rules (`npm test`).
- `tests/api-tests.sh` runs 28 checks with curl through API Gateway on Floci. This includes 5 claims sent at the same time (only one gets 201) and a 6th claim (409). I had one more check that opened the PDF link, but it failed because of the floci hostname (see section 9) so I removed it.
- After the real login was merged I changed the tests to log in with real accounts (the seeded admin, student1 and reviewer2) and ran everything again on a clean Floci on 28 Nov: 28 of 28 passed (`evidence/review-api-tests-floci.txt`).
- Postman collection with 20 requests and 25 checks, all passed in the same run (`evidence/review-postman-floci.txt`).
- All 24 T-REV rows in `docs/api-test-plan.md` have the actual results.

[Screenshot: api-tests.sh output] [Screenshot: Postman run]

## 7. Integration work
- Before merging I checked my service against Khalil's and Wael's code. For example, that `status-index` has the fields I need, that Khalil's lock rows never show up in my queue, that the rubric format matches, and that Wael reads `flagged` and the review for the decision email.
- I did a full end-to-end run through API Gateway on a clean Floci (`tests/e2e/run-e2e.sh`, write-up in `evidence/e2e-walkthrough.md`). The first run on 27 Nov had to use test tokens because login wasn't built yet. I ran it again on 28 Nov with the real login: the admin logged in and created a reviewer and a scholarship, a new student registered and applied, the reviewer had to change his temporary password before he could do anything (403 before), then claimed and scored it (total 70), the student saw "reviewed", the admin accepted it, the student saw "accepted" and notification-sender was triggered. The email wasn't sent because I don't have a Brevo key on my laptop.

## 8. Technical decisions
These are written in `docs/decisions.md`:
- The queue returns the 50 oldest submitted applications, not all of them.
- The 5 claim limit counts the claims first and then claims. A reviewer clicking very fast could get a 6th one. We accepted this for now because fixing it fully needs a counter in the Users table, which is shared.
- PDFs are opened with a 5 minute presigned link, and each one is logged as pdf_download.

## 9. Difficulties and solutions
- Two reviewers claiming at the same time: I used a conditional update instead of reading and then writing, and tested it with 5 requests at once.
- Node.js 20 support ended, so I moved both Lambdas to nodejs24.x.
- npm 11 blocked install scripts (EALLOWSCRIPTS) when I built the zip for the expiry job. I changed the zip script so it takes the packages from the service's own node_modules.
- The PDF link didn't open on Floci because it uses `floci:4566`, which is Floci's name inside Docker. Adding `127.0.0.1 floci` to the hosts file fixes it, and on real AWS the link goes straight to S3.
- My first metric filter never matched anything, because Lambda adds the time and request id before our JSON log line. Wael noticed it and changed it to a plain text pattern in the auth-service PR.
- The other services weren't ready when I started testing, so I wrote `tests/local-test-data.sh` to create test applications and a scholarship.
- When I seeded the real accounts, the seed refused my first admin password because it was in Pwned Passwords, so I used random passwords instead (they stay in `platform/.env`, which git ignores).
- The first test run after a fresh deploy failed the expiry job check once (it found 0 old claims). I checked the table, ran the job by hand and it released the claim, and the whole run passed when I ran it again.
