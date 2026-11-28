# 11. Logs and monitoring

Written by Mohamed Hazem. The screenshots are taken on Floci after the final deploy.

## What we log

Every service uses `shared-lib/logger.js`, which writes one JSON line per request to CloudWatch Logs (`/aws/lambda/<function name>`). The line has the level, function name, method, path, status code, userId and action. We don't log request bodies, essays, passwords, tokens, headers or PDF links, and the query string is cut from the path.

The level depends on the status code: info for normal requests, warn for 4xx and error for 5xx. This makes it easy to look only at the failures.

Errors and the hourly job also write short lines to the same log groups, with safe fields only like ids, the error name or a count. Stack traces and AWS error messages are never sent back to the user.

Security and business events are saved in the AuditLog table in DynamoDB with `shared-lib/audit.js` (action, userId, targetId and a short detail). Some of the actions are login, login_failed, forbidden, claim, release, review, claim_expired, pdf_download, decision and user_created. No IAM role is allowed to update or delete AuditLog items.

For T-REV-02 (student1 calling the reviewer queue) the request line looks like this:
```json
{"level":"warn","fn":"review-service","method":"GET","path":"/api/reviews/queue","status":403,"userId":"5eed0000-0000-4000-8000-000000000011","action":null}
```

## Metric filter and alarm

Both are created in `services/review-service/infra/deploy.sh`:
- metric filter `login-failed` on `/aws/lambda/auth-service`. It counts the lines that contain `"action":"login_failed"` (metric `Group39/Security / LoginFailed`).
- alarm `login-failed-spike`, which goes off when there are more than 20 failed logins in 5 minutes.

At first I used a JSON pattern (`{ $.action = "login_failed" }`) but it never matched on Floci, because Lambda adds the time, request id and level before our JSON. Now the filter searches for the text `"action":"login_failed"` instead, and that works.

auth-service already slows down wrong passwords for the same email and IP. The alarm is for when someone tries passwords on a lot of accounts or from a lot of IPs, which the backoff alone wouldn't notice.

[Screenshot: metric filter and alarm in Floci Dash] [Screenshot: alarm state after more than 20 failed logins]

## Example of an error

In the end-to-end run on 28 Nov (`evidence/e2e-run-floci.txt`), notification-sender couldn't read the Brevo key. In the raw log these are on separate lines:
```
2026-11-28T13:08:39.035Z  311020eb-7d24-4211-95ad-8b1cc8fd1da8  ERROR
{"level":"error","fn":"notification-sender","message":"decision email failed","applicationId":"266bdf18-7c82-401d-84af-8a2117427002","attempt":1,"lastAttempt":false,"error":"ParameterNotFound"}
```
The line only has the application id and the error type, there's no email address and no key. `lastAttempt` is false, so SQS tries again, and after the last try the message goes to `notifications-dlq`.

## Example of suspicious activity

When a student token calls a reviewer route (T-REV-02) it gets 403. The request is logged as warn with status 403, and `shared-lib/auth.js` also writes a forbidden row to AuditLog. The same happens when a new reviewer tries to work before changing his temporary password (the e2e run checks for that row). The admin can see these with `GET /api/admin/audit-log?action=forbidden`.

[Screenshot: audit-log response with forbidden rows]

## How to check the logs

```bash
# 403s in review-service
aws logs filter-log-events --log-group-name /aws/lambda/review-service --filter-pattern '"\"status\":403"'
# a decision email and its retries
aws logs filter-log-events --log-group-name /aws/lambda/notification-sender --filter-pattern '"decision email"'
# forbidden events through the API (needs an admin token)
curl -H "Authorization: Bearer <admin token>" "$API_URL/api/admin/audit-log?action=forbidden"
```

## No sensitive data in the logs

The logger only writes the fields listed above. I went through the review-service test output and the e2e output and there were no passwords, tokens, essays or PDF links in any log line or audit row. In the e2e script the reviewer's temporary password was hidden before it was printed.
