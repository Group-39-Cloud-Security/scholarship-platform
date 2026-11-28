# 11. Logs and monitoring

Owner: Mohamed Hazem. Screenshots marked [Screenshot] are taken on Floci after the final deploy.

## What we log, and where

| Source | Where it goes | What is in it | What is never in it |
|---|---|---|---|
| Request log (`shared-lib/logger.js`), one line per request from every service | CloudWatch Logs, `/aws/lambda/<function>` | `level`, `fn`, `method`, `path` (no query string), `status`, `userId`, `action` | bodies, essays, passwords, tokens, headers, presigned links |
| Error and job lines (`log()`) | the same log groups | a short message and safe fields (ids, error name, counts) | stack traces in responses, AWS error text |
| Business and security events (`shared-lib/audit.js`) | DynamoDB `AuditLog` (PK `action`, SK `<createdAt>#<id>`) | `action`, `userId`, `targetId`, short `detail` | secrets, essays, request bodies |

Level follows the status: `info` below 400, `warn` for 4xx, `error` for 5xx, so failures can be filtered by level.
Audit actions include `login`, `login_failed`, `forbidden`, `claim`, `release`, `review`, `claim_expired`, `pdf_download`, `decision`, `user_created`. No role can update or delete `AuditLog` items (IAM, `docs/CLAUDE.md` section 7).

What the request line for T-REV-02 (a student calling the reviewer queue) looks like:
```json
{"level":"warn","fn":"review-service","method":"GET","path":"/api/reviews/queue","status":403,"userId":"test-student-1","action":null}
```

## Metric filter and alarm

Created by `services/review-service/infra/deploy.sh`:
- Metric filter `login-failed` on `/aws/lambda/auth-service`, pattern `"\"action\":\"login_failed\""` (changed from a JSON pattern in the auth-service PR), metric `Group39/Security / LoginFailed`.
- Alarm `login-failed-spike`: `Sum > 20` in 5 minutes.

Why a plain-text pattern: Lambda writes `<time> <requestId> <level>` before our JSON line, so a JSON pattern like `{ $.action = "login_failed" }` never matched on Floci. The quoted phrase matches the field exactly.
What it detects: password guessing across many accounts or IPs, which the per email + IP backoff in auth-service does not see as a whole.
[Screenshot: metric filter and alarm in Floci Dash] [Screenshot: alarm state after more than 20 failed logins]

## Example showing errors

From the end-to-end run (27 Nov 23:56 UTC, `evidence/e2e-run-floci.txt` on branch `hazem-e2e`), notification-sender could not read the Brevo key (the raw log has these fields on separate lines):
```
2026-11-27T23:56:00.766Z  bb6c974a-5322-4d97-9c21-94b3e02325d0  ERROR
{"level":"error","fn":"notification-sender","message":"decision email failed","applicationId":"0f81f510-5c23-4cf1-aa3d-f1762d864c91","attempt":1,"lastAttempt":false,"error":"ParameterNotFound"}
```
The line names the application and the error type only (no email address, no key), and it shows the retry design: `lastAttempt: false`, so SQS retries and then moves the message to `notifications-dlq`.

## Example showing suspicious activity

A student token calling a reviewer route (T-REV-02) gets 403. The request line is logged as `warn` with `status: 403`, and `shared-lib/auth.js` writes a `forbidden` row to `AuditLog`, so an admin sees it with `GET /api/admin/audit-log?action=forbidden`.
[Screenshot: audit-log response with forbidden rows]

## How to look at them

```bash
# request lines with errors for one function
aws logs filter-log-events --log-group-name /aws/lambda/review-service --filter-pattern '"\"status\":403"'
# a decision email and its retries
aws logs filter-log-events --log-group-name /aws/lambda/notification-sender --filter-pattern '"decision email"'
# security events through the API (admin only)
curl -H "Authorization: Bearer <admin token>" "$API_URL/api/admin/audit-log?action=forbidden"
```

## Checked: no sensitive values

The logger only writes the fields above; the reviewer's temporary password, PDF links, essays and tokens never appear in any log line or audit row (checked in the review-service tests and in the e2e output, where the temporary password was hidden before printing).
