# End-to-end walkthrough (Floci)

Mohamed Hazem, 28 Nov 2026, 15:08 Cairo time (13:08 UTC).
Branch `hazem-e2e` at `9f2e942`, which is `main` after the auth-service, the frontend and the seed scripts were merged, plus my test changes.

## Setup

- Clean start on my laptop: `bash platform/reset.sh -y` deleted everything (API, tables, functions, queues, buckets, SSM, roles), then `bash platform/deploy-all.sh` built it all again.
- The deploy stopped at the seed the first time because my `platform/.env` was still empty. After I filled in the two passwords, the seed refused the first admin password because it is in Pwned Passwords. I made two random ones instead and `bash platform/seed.sh` worked (1 admin, 2 reviewers, 4 students, 3 scholarships, 4 applications).
- Deploy warnings: `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` are empty in `services/admin-service/.env` on my laptop, so there is no Brevo key in SSM.
- API: `http://0325675dbf.execute-api.localhost.floci.io:4566`. Every request below goes through API Gateway.
- I ran `bash tests/e2e/run-e2e.sh`, which sends each request in order and prints what came back. Full output: `evidence/e2e-run-floci.txt`.
- This time everything uses the real login. The admin is the seeded one (logged in with `platform/get-token.sh`). The reviewer and the student are new accounts made during the run with random passwords. Tokens and passwords are hidden in the output.

## Steps

### 0. Health check, and the old test tokens are gone
`GET /api/health` with no token: 200, `runtime: lambda`. Pass.
`GET /api/admin/stats` with the old `Bearer test-admin`: 401 `Login required.` So the phase-A test users don't work anymore. Pass.

### 1. Admin logs in
Logged in as `admin@example-university.edu`, then `GET /api/auth/me`: 200, role admin. Pass.

### 1b. Admin creates a reviewer
`POST /api/admin/users` with `{ "email": "e2e.reviewer.1795871294@example-university.edu", "name": "E2E Reviewer" }`.
Expected 201, role reviewer, must change password. Got 201, `mustChangePassword: true`. The temporary password came back in the response and the script hid it before printing. Pass.

### 1c. Admin creates and publishes a scholarship
`POST /api/admin/scholarships` (rubric academic 40 / essay 40 / need 20, eligibility example-university.edu, GPA 3+, years 2-3): 201 draft, id `38baec03-7583-4bee-b6cc-7e46d5a6b8a6`.
`PATCH /api/admin/scholarships/{id}/status` published: 200, `createdBy` is the seeded admin's id. Pass.

### 2. Student registers and logs in
`POST /api/auth/register` with `e2e.student.1795871294@example-university.edu`: 201, role student.
`POST /api/auth/login`: 200 with a token. Pass.

### 3. Student applies
`POST /api/applications` with a 221-word essay, GPA 3.4, year 2 and a small PDF. Got 201:
```json
{"applicationId":"266bdf18-7c82-401d-84af-8a2117427002","scholarshipId":"38baec03-7583-4bee-b6cc-7e46d5a6b8a6","status":"submitted","submittedAt":"2026-11-28T13:08:31.141Z"}
```
Pass.

### 4. Reviewer logs in with the temporary password
- `POST /api/auth/login` with the temporary password: 200, `mustChangePassword: true`.
- `GET /api/reviews/queue` with that token: 403 `Change your temporary password first.` Good, he can't do anything yet.
- `PUT /api/auth/password` with the temporary password and a new one: 200, `mustChangePassword: false`.
- Logged in again with the new password: 200 with a token.
Pass.

### 4b. Reviewer reviews the application
- `GET /api/reviews/queue`: 200, the new application is in the queue.
- `POST /api/reviews` (claim): 201, `under_review`, `expiresAt` 48 h later.
- `GET /api/reviews/{id}`: 200, essay and rubric, no student email in the response.
- `PUT /api/reviews/{id}` with academic 8, essay 7, need 5. Expected total 70. Got 200:
```json
{"applicationId":"266bdf18-7c82-401d-84af-8a2117427002","status":"reviewed","flagged":false,"flagReason":null,"scores":{"academic":8,"essay":7,"need":5},"totalScore":70,"submittedAt":"2026-11-28T13:08:34.840Z"}
```
Pass.

### 5. Student checks the status
`GET /api/applications/mine`: 200, `status: reviewed`, timeline shows submitted, being reviewed and review finished as done. Pass.

### 5b. Admin decides, student checks again
`PATCH /api/admin/applications/{id}/decision` accepted: 200, `decidedBy` is the seeded admin, `emailStatus: queued`.
`GET /api/applications/mine` again: 200, `status: accepted`, timeline "Decision: accepted". Pass.

### 6. Notification and audit log
Waited 20 s and read the notification-sender log for this application:
```
{"level":"error","fn":"notification-sender","message":"decision email failed","applicationId":"266bdf18-7c82-401d-84af-8a2117427002","attempt":1,"lastAttempt":false,"error":"ParameterNotFound"}
```
notification-sender picked the message up about 3.5 seconds after the decision (35.561 to 39.035), so the notification was triggered. The email wasn't sent because there is no Brevo key in SSM on my Floci. With `lastAttempt: false`, SQS tries again and then moves it to `notifications-dlq`.
`GET /api/admin/audit-log` as the admin: the `decision` and the `claim` for this application are there, and so is the `forbidden` row for the reviewer's call before he changed his password.

## Summary

| # | Step | Expected | Got | Result |
|---|---|---|---|---|
| 0 | Health check | 200 | 200, runtime lambda | Pass |
| 0b | Old `test-admin` token | 401 | 401 | Pass |
| 1 | Admin logs in | 200, role admin | 200, admin | Pass |
| 1b | Admin creates a reviewer | 201, must change password | 201, password hidden | Pass |
| 1c | Admin creates and publishes a scholarship | 201, 200 | 201, 200 | Pass |
| 2 | Student registers and logs in | 201, 200 with token | 201, 200 | Pass |
| 3 | Student applies | 201 submitted | 201 submitted | Pass |
| 4 | Reviewer logs in with the temporary password | 200, then 403 until he changes it | 200, 403, 200, 200 | Pass |
| 4b | Reviewer claims, opens and scores | 201, 200 no email, 200 total 70 | same | Pass |
| 5 | Student checks the status | reviewed | reviewed | Pass |
| 5b | Admin accepts, student checks again | accepted, email queued | accepted, queued | Pass |
| 6a | Notification triggered | notification-sender runs | ran, attempt 1 | Pass |
| 6b | Email sent through Brevo | sent | ParameterNotFound (no key) | Not tested |
| 6c | Audit log | decision, claim, forbidden | all three | Pass |

13 pass, 1 not tested (email delivery).

## Other runs on the same deploy

- `bash services/review-service/tests/api-tests.sh` (real tokens: admin, student1, reviewer2): the first run gave 27 passed, 1 failed. T-REV-20 (the expiry job) returned `checked 0`. I checked the table and the old claim was there, then ran the job by hand and it released it (`checked 1, released 1`). I ran the whole file again and got 28 passed, 0 failed (`evidence/review-api-tests-floci.txt`). It only happened on the first run after the fresh deploy and I couldn't make it happen again.
- Postman collection with newman (reviewer2 and student1 tokens): 20 requests, 25 assertions, 0 failed (`evidence/review-postman-floci.txt`).

## Notes

- Compared to the first walkthrough on 27 Nov, the two blocked login steps now pass, and no test tokens are used anywhere.
- Not tested: the Brevo email needs `BREVO_API_KEY` and a verified `BREVO_SENDER_EMAIL` in `services/admin-service/.env` on the machine that deploys.
- No service code was changed for this run.
