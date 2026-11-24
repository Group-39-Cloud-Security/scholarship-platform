# Brevo integration — what every member must be able to explain

Brevo is our one real external service: it sends the decision email (accepted / rejected) to the student.
Wael builds it, but all three of us are asked about it in the discussion. Source of truth: CLAUDE.md sections 2, 6, 7.

## The flow in 6 steps
1. An admin decides a `reviewed` application (`PATCH /api/admin/applications/{id}/decision`, admin-service).
2. admin-service updates the application with one conditional update, then sends **one message** to the SQS queue `notifications`:
   `{ applicationId, studentEmail, scholarshipTitle, decision, flagReason? }`. No tokens, no essays.
3. The queue triggers the Lambda `notification-sender`, the **only** function that calls Brevo.
4. notification-sender reads the Brevo API key from SSM Parameter Store (`/scholarship/brevo-api-key`, SecureString), calls Brevo over HTTPS, and sets `emailStatus` on the application.
5. If sending fails, SQS retries. After 3 failed receives the message moves to the dead-letter queue `notifications-dlq` and `emailStatus = failed` is visible to the admin.
6. A failed email **never undoes the decision**. The decision is final; only the notification is retried.

## Why it is built this way (questions to expect)
- **Why a queue and not a direct call?** The admin's request should not wait for, or fail because of, an outside service. The queue gives retries and a dead-letter queue for free.
- **Why does notification-sender read nothing else?** The message already holds everything it needs, so its IAM role stays small (SQS receive/delete, one SSM parameter, update `emailStatus` only, write the audit log).
- **Where is the key stored?** SSM Parameter Store as a SecureString, never in code or in git. The value is read from the deployer's local `.env` by `admin-service/infra/deploy.sh`.
- **Why is Pwned Passwords not our integration?** It is a security control inside login. Seif's feedback: Brevo is the real external service; Turnstile and Pwned are controls.
- **What is the worst case if Brevo is down?** Decisions still work, messages wait in the queue or reach the DLQ, the admin sees `emailStatus = failed`.
- **Least privilege:** admin-service may only `SendMessage` to `notifications`; it cannot read the SSM Brevo key or call Brevo.

## Built in stages
First admin-service calls Brevo directly to prove the integration; then SQS + notification-sender are added.
