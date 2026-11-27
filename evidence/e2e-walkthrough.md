# End-to-end walkthrough (Floci)

Mohamed Hazem, 28 Nov 2026, 01:55 Cairo time (27 Nov 23:55 UTC).
Branch `hazem-e2e` at `9c4110c`, which is `main` (`a1acc51`) plus the e2e script only.

## Setup

- Clean start on my laptop: `docker compose -f platform/docker-compose.yml down -v`, then `up -d`.
  `platform/reset.sh` is still a TODO, so removing the Floci volume was the way to start from nothing.
- `bash platform/deploy-all.sh`: shared resources, admin-service, application-service and review-service all deployed with their routes.
  auth-service only prints "deployed" (its deploy.sh is still a TODO), so there are no `/api/auth/*` routes.
- `platform/seed.sh` is still a TODO, so the scholarship and the reviewer were created through the API in steps 1 and 1b instead.
- Deploy warnings: `BREVO_API_KEY` and `BREVO_SENDER_EMAIL` are empty in `services/admin-service/.env` on my laptop, so no Brevo key is in SSM.
- API: `http://fbcea3fe0c.execute-api.localhost.floci.io:4566`. Every request below goes through API Gateway.
- I ran `bash tests/e2e/run-e2e.sh`, which sends each request in order and prints what came back.
  Full output: `evidence/e2e-run-floci.txt`.
- Login is not built yet, so the login steps were tried and are marked blocked. For the rest I used the phase-A test tokens from `shared-lib/auth.js`: `test-admin`, `test-student-1` (student1@example-university.edu) and `test-reviewer`.

A first attempt stopped right after printing the step 3 header, with no error shown. I ran it again twice and both runs went all the way through. This page is from the last run.

## Steps

### 0. Health check
Sent `GET /api/health` with no token. Expected 200. Got **200**, `runtime: lambda`. Pass.

### 1. Admin creates a reviewer
Sent `POST /api/admin/users` as `test-admin`:
```json
{ "email": "e2e.reviewer.1795823755@example-university.edu", "name": "E2E Reviewer" }
```
Expected 201, role reviewer, must change password. Got **201**:
```json
{"userId":"7ffb8bfa-2a70-43d0-bd57-bcb96e5fea47","email":"e2e.reviewer.1795823755@example-university.edu","name":"E2E Reviewer","role":"reviewer","status":"active","mustChangePassword":true,"createdAt":"2026-11-27T23:55:55.863Z","temporaryPassword":"<hidden>"}
```
The temporary password was in the response; the script replaced it with `<hidden>` before printing. Pass.

### 1b. Admin creates and publishes a scholarship
Sent `POST /api/admin/scholarships` (E2E Cloud Award, rubric academic 40 / essay 40 / need 20, eligibility example-university.edu, GPA 3+, years 2-3). Got **201** draft, id `892d3f98-721a-4b36-b6b1-f7a57d38d24f`.
Then `PATCH /api/admin/scholarships/{id}/status` with `{ "status": "published" }`. Got **200**, `status: published`. Pass.

### 2. Student registers and logs in
Sent `POST /api/auth/register` and `POST /api/auth/login`. Expected 201 and a token. Got **404** `{"message":"Not Found"}` for both: API Gateway has no auth routes because auth-service is not built yet. **Blocked.** Continued as `test-student-1`.

### 3. Student applies
Sent `POST /api/applications` as `test-student-1` with a 221-word essay, GPA 3.4, year 2 and a small PDF (base64). Expected 201 submitted. Got **201**:
```json
{"applicationId":"0f81f510-5c23-4cf1-aa3d-f1762d864c91","scholarshipId":"892d3f98-721a-4b36-b6b1-f7a57d38d24f","status":"submitted","submittedAt":"2026-11-27T23:55:57.731Z"}
```
Pass.

### 4. Reviewer logs in, sees the application and reviews it
- `POST /api/auth/login` with the new reviewer's email: **404** Not Found. **Blocked.** Continued as `test-reviewer`.
- `GET /api/reviews/queue`: **200**, the new application is in the queue. Pass.
- `POST /api/reviews` `{ "applicationId": "0f81f510-..." }` (claim): **201**, `under_review`, expires in 48 h. Pass.
- `GET /api/reviews/{id}`: **200**, essay and rubric returned, no student email in the response. Pass.
- `PUT /api/reviews/{id}` with scores academic 8, essay 7, need 5. Expected 200 and total 70. Got **200**:
```json
{"applicationId":"0f81f510-5c23-4cf1-aa3d-f1762d864c91","status":"reviewed","flagged":false,"flagReason":null,"scores":{"academic":8,"essay":7,"need":5},"totalScore":70,"submittedAt":"2026-11-27T23:55:59.416Z"}
```
Pass.

### 5. Student checks the status
`GET /api/applications/mine` as `test-student-1`. Expected the application as reviewed. Got **200**, `status: reviewed`, timeline: submitted, being reviewed, review finished all done, decision not yet. Pass.

### 5b. Admin decides, student checks again
`PATCH /api/admin/applications/{id}/decision` `{ "decision": "accepted" }` as `test-admin`. Got **200**:
```json
{"applicationId":"0f81f510-5c23-4cf1-aa3d-f1762d864c91","scholarshipId":"892d3f98-721a-4b36-b6b1-f7a57d38d24f","status":"accepted","decidedBy":"test-admin","decidedAt":"2026-11-27T23:56:00.087Z","emailStatus":"queued"}
```
Then `GET /api/applications/mine` again: **200**, `status: accepted`, timeline "Decision: accepted". Pass.

### 6. Notification
Waited 20 s, then read the notification-sender log group for this application id:
```
{"level":"error","fn":"notification-sender","message":"decision email failed","applicationId":"0f81f510-5c23-4cf1-aa3d-f1762d864c91","attempt":1,"lastAttempt":false,"error":"ParameterNotFound"}
```
The decision went into the SQS queue and notification-sender picked it up less than a second after the decision (00.087 to 00.766), so the notification was triggered. The email itself was not sent: `ParameterNotFound` means `/scholarship/brevo-api-key` is not in SSM on my Floci (no key in my `.env`). With `lastAttempt: false`, SQS retries it and then moves it to `notifications-dlq`.
`GET /api/admin/audit-log?action=decision` as `test-admin`: **200**, the decision for this application is there.
Triggered: pass. Email delivered: not tested here (needs the Brevo key).

## Summary

| # | Step | Expected | Got | Result |
|---|---|---|---|---|
| 0 | Health check | 200 | 200, runtime lambda | Pass |
| 1 | Admin creates a reviewer | 201, reviewer, must change password | 201, password hidden in output | Pass |
| 1b | Admin creates and publishes a scholarship | 201 draft, 200 published | 201, 200 | Pass |
| 2 | Student registers and logs in | 201, 200 with token | 404 Not Found (no auth routes) | Blocked |
| 3 | Student applies | 201 submitted | 201 submitted | Pass |
| 4a | Reviewer logs in | 200 with token | 404 Not Found (no auth routes) | Blocked |
| 4b | Reviewer sees it in the queue | 200, application listed | 200, listed | Pass |
| 4c | Reviewer claims it | 201 under_review | 201 under_review | Pass |
| 4d | Reviewer opens it | 200, no student email | 200, no student email | Pass |
| 4e | Reviewer scores it | 200, total 70 | 200, total 70 | Pass |
| 5 | Student checks the status | reviewed | reviewed | Pass |
| 5b | Admin accepts, student checks again | 200 accepted, then accepted | 200 accepted (email queued), accepted | Pass |
| 6a | Notification triggered | notification-sender runs | ran, attempt 1 | Pass |
| 6b | Email sent through Brevo | sent | ParameterNotFound (no Brevo key in SSM) | Not tested |
| 6c | Decision in the audit log | present | present | Pass |

12 pass, 2 blocked (login), 1 not tested (email delivery).

## Notes

- Blocked: register and login need auth-service (Phase B). The rest of the flow runs on the phase-A test tokens; once login exists the same script should use real tokens.
- Not tested: the Brevo email needs `BREVO_API_KEY` and a verified `BREVO_SENDER_EMAIL` in `services/admin-service/.env` on the machine that deploys.
- No service code was changed for this run. The only workarounds were `down -v` instead of the empty `reset.sh` and creating data through the API instead of the empty `seed.sh`.
