# API Contract (Lab 3 format)

One section per service, written by its owner: data dictionary (Field · Type · Source · Rule), then each endpoint's request, success response and errors as valid JSON in code fences.

## auth-service

## application-service

## review-service

Owner: Mohamed Hazem. Lambda `review-service` (the routes below) and `release-expired-claims` (hourly, no HTTP route). Every route needs `Authorization: Bearer <token>`; the allowed role is in brackets.

### Data dictionary: `Reviews` (one item per application, write-once)

| Field | Type | Source | Rule |
|---|---|---|---|
| applicationId | string (UUID) | Client (path) | must be an application this reviewer claimed. PK with `attribute_not_exists`, so a review is never overwritten |
| reviewerId | string | Server (token) | never read from the body |
| scores | map criterionId to int | Client | every rubric criterion exactly once, whole number 0-10, no extra keys. Not stored when flagged |
| totalScore | number 0-100 | Server | sum of (score * weight) / 10. A total sent by the client is ignored |
| comment | string | Client | optional, trimmed, 1-1000 characters, only shown to admins |
| flagged | boolean | Client (`true` to flag) | scores and flag can't be sent together |
| flagReason | enum | Client | `incomplete_documents`, `ineligible`, `plagiarism_suspected`, `other` |
| flagNote | string | Client | optional, 1-500 characters |
| submittedAt | ISO 8601 UTC | Server | sort key of `reviewerId-index` |

Fields this service changes on `Applications` (conditional updates only): `status` (`submitted` to `under_review` to `reviewed`, or back to `submitted` on release), `reviewerId`, `claimedAt`, `flagged`.

Error responses use the shared shape, for example:
```json
{ "error": { "code": "CONFLICT", "message": "This application is no longer in the queue (already claimed or reviewed)." } }
```

### GET /api/reviews/queue  [reviewer]
The 50 oldest `submitted` applications. No essay, student id or email.
```json
[
  {
    "applicationId": "4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e73",
    "scholarshipId": "9a7e3c10-5b2f-4d6a-8e11-2c4b7f9d0a65",
    "scholarshipTitle": "Cloud Excellence Award",
    "submittedAt": "2026-11-20T10:15:00.000Z"
  }
]
```
`200` (an empty queue is `[]`), `401`, `403`

### POST /api/reviews  [reviewer]  (claim)
```json
{ "applicationId": "4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e73" }
```
`201`
```json
{
  "applicationId": "4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e73",
  "status": "under_review",
  "claimedAt": "2026-11-26T09:00:00.000Z",
  "expiresAt": "2026-11-28T09:00:00.000Z"
}
```
`400` missing or invalid id, bad JSON, `401`, `403`, `404 APPLICATION_NOT_FOUND`, `409` already claimed or reviewed, or the reviewer already has 5 claims, `415`

### GET /api/reviews/mine  [reviewer]
```json
{
  "claims": [
    {
      "applicationId": "4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e73",
      "scholarshipId": "9a7e3c10-5b2f-4d6a-8e11-2c4b7f9d0a65",
      "scholarshipTitle": "Cloud Excellence Award",
      "claimedAt": "2026-11-26T09:00:00.000Z",
      "expiresAt": "2026-11-28T09:00:00.000Z"
    }
  ],
  "reviews": [
    {
      "applicationId": "77ab90d2-3e4f-4c1a-b8d7-5f6e2a1c9b04",
      "scholarshipTitle": "Cloud Excellence Award",
      "totalScore": 70,
      "flagged": false,
      "flagReason": null,
      "submittedAt": "2026-11-25T14:30:00.000Z"
    }
  ]
}
```
`200`, `401`, `403`

### GET /api/reviews/{applicationId}  [reviewer who claimed it]
The application without the student's identity, plus the scholarship's rubric and eligibility. `review` is filled in after the review is submitted.
```json
{
  "application": {
    "applicationId": "4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e73",
    "scholarshipId": "9a7e3c10-5b2f-4d6a-8e11-2c4b7f9d0a65",
    "status": "under_review",
    "essay": "I am a second year computer science student ...",
    "gpa": 3.4,
    "yearOfStudy": 2,
    "hasPdf": true,
    "submittedAt": "2026-11-20T10:15:00.000Z",
    "claimedAt": "2026-11-26T09:00:00.000Z",
    "expiresAt": "2026-11-28T09:00:00.000Z"
  },
  "scholarship": {
    "scholarshipId": "9a7e3c10-5b2f-4d6a-8e11-2c4b7f9d0a65",
    "title": "Cloud Excellence Award",
    "deadline": "2027-01-15T23:59:00.000Z",
    "rubric": [
      { "criterionId": "academic", "name": "Academic record", "description": "Grades and transcript", "weight": 40 },
      { "criterionId": "essay", "name": "Essay", "description": "Clarity and motivation", "weight": 40 },
      { "criterionId": "need", "name": "Financial need", "description": "Evidence of need", "weight": 20 }
    ],
    "eligibility": { "allowedDomains": ["bue.edu.eg"], "minGpa": 3, "years": [2, 3] }
  },
  "review": null
}
```
`200`, `400`, `401`, `403`, `404 APPLICATION_NOT_FOUND` (also when someone else claimed it)

### PUT /api/reviews/{applicationId}  [reviewer who claimed it]  (score or flag, final)
```json
{ "scores": { "academic": 8, "essay": 7, "need": 5 }, "comment": "Strong essay" }
```
or
```json
{ "flagged": true, "flagReason": "ineligible", "flagNote": "GPA in the PDF is 2.1" }
```
`200`
```json
{
  "applicationId": "4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e73",
  "status": "reviewed",
  "flagged": false,
  "flagReason": null,
  "scores": { "academic": 8, "essay": 7, "need": 5 },
  "totalScore": 70,
  "submittedAt": "2026-11-26T11:20:00.000Z"
}
```
`400` missing, extra or out of range score, both or neither of scores and flag, bad reason, note or comment too long, `401`, `403`, `404`, `409` already reviewed, claim released or expired, scholarship has no rubric, `415`

### DELETE /api/reviews/{applicationId}  [reviewer for their own claim, admin for any]  (release)
`204` (back to `submitted`, `reviewerId` and `claimedAt` removed), `400`, `401`, `403`, `404`, `409` not `under_review`

### GET /api/reviews/{applicationId}/pdf  [reviewer who claimed it, while under review]
Writes `pdf_download` to `AuditLog`.
```json
{
  "url": "http://localhost:4566/scholarship-documents/applications/4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e73.pdf?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=300&X-Amz-Signature=...",
  "expiresIn": 300
}
```
`200`, `400`, `401`, `403`, `404`, `409` not under review any more

### release-expired-claims (schedule `release-expired-claims-hourly`, no HTTP route)
Reads `status-index` for `under_review` applications with `claimedAt` older than 48 hours, sets each one back to `submitted` with a conditional update (`claimedAt` must not have changed) and writes `claim_expired` to `AuditLog`. The event is ignored. Returns:
```json
{ "checked": 1, "released": 1 }
```

## admin-service

Owner: Mohamed Wael. Lambda `admin-service` (the routes below) and `notification-sender` (SQS consumer, no HTTP route). Every route except `GET /api/health` needs `Authorization: Bearer <token>` with role `admin`. Filled in step by step as each function is built.

Error responses use the shared shape, for example:
```json
{ "error": { "code": "ROUTE_NOT_FOUND", "message": "Route not found." } }
```

### GET /api/health  [anyone, no token]
Proves API Gateway reaches the Lambda. Says nothing about tables, versions or secrets.
```json
{ "status": "ok", "environment": "production", "runtime": "lambda" }
```
`200`. `runtime` is `local` under `npm run dev`. Every admin response also carries `Cache-Control: no-store`.

### Data dictionary: `Scholarships`

| Field | Type | Source | Rule |
|---|---|---|---|
| scholarshipId | string (UUID) | Server | `crypto.randomUUID()`; a value in the body is ignored |
| title | string | Client | trimmed, 3-100 characters |
| description | string | Client | trimmed, 10-2000 characters |
| deadline | ISO 8601 UTC | Client | a full date-time with a zone: `2027-01-15T23:59:00Z` or `2027-01-16T01:59:00+02:00`. A bare date (`2027-01-15`), a missing zone, or a date that doesn't exist (`2027-02-30`, `2027-04-31`, `2027-02-29`) is a 400, never rolled over. Zone offsets from `-14:00` to `+14:00`; anything beyond is a 400. `-00:00` is a 400 on purpose (RFC 3339: "local offset unknown"; a deadline must be one known instant), use `Z` for UTC. Year 2000-2100. Stored as `toISOString()` (UTC) so `status-deadline-index` sorts correctly. **May be in the past on a draft**; must be in the future to publish (409, see below) |
| awards | int | Client | 1-1000; how many applications can be accepted |
| acceptedCount | int | Server | starts at 0; atomic counter, never more than `awards` |
| status | enum | Server | `draft` on create, then `published`, `closed` (PATCH status) |
| rubric | list of `{ criterionId, name, description, weight }` | Client | 2-6 criteria; `criterionId` 2-30 lowercase letters, digits, `-` or `_`, starting with a letter, unique; name 2-60, description 2-300 characters; `weight` whole number 1-100; weights sum to exactly 100. review-service scores against it |
| eligibility | `{ allowedDomains[], minGpa, years[] }` | Client | `allowedDomains`: 1-10, lowercased, each in the platform's `ALLOWED_DOMAINS`; `minGpa`: number 0-4; `years`: 1-6 whole numbers 1-6, de-duplicated and sorted |
| createdBy | string | Server (token) | the admin's userId, never read from the body |
| createdAt | ISO 8601 UTC | Server | |

### POST /api/admin/scholarships  [admin]  (create a draft)
```json
{
  "title": "Cloud Excellence Award",
  "description": "For students building on the cloud.",
  "deadline": "2027-01-15T23:59:00Z",
  "awards": 2,
  "rubric": [
    { "criterionId": "academic", "name": "Academic record", "description": "Grades and transcript", "weight": 40 },
    { "criterionId": "essay", "name": "Essay", "description": "Clarity and motivation", "weight": 40 },
    { "criterionId": "need", "name": "Financial need", "description": "Evidence of need", "weight": 20 }
  ],
  "eligibility": { "allowedDomains": ["example-university.edu"], "minGpa": 3, "years": [2, 3] }
}
```
`201`
```json
{
  "scholarshipId": "8a48f941-640d-46cc-b921-78dae29152bc",
  "title": "Cloud Excellence Award",
  "description": "For students building on the cloud.",
  "deadline": "2027-01-15T23:59:00.000Z",
  "awards": 2,
  "rubric": [
    { "criterionId": "academic", "name": "Academic record", "description": "Grades and transcript", "weight": 40 },
    { "criterionId": "essay", "name": "Essay", "description": "Clarity and motivation", "weight": 40 },
    { "criterionId": "need", "name": "Financial need", "description": "Evidence of need", "weight": 20 }
  ],
  "eligibility": { "allowedDomains": ["example-university.edu"], "minGpa": 3, "years": [2, 3] },
  "status": "draft",
  "acceptedCount": 0,
  "createdBy": "test-admin",
  "createdAt": "2026-11-27T03:10:00.000Z"
}
```
Writes `scholarship_created` to `AuditLog`. `400` invalid field (one clear message, e.g. "Rubric weights must sum to 100 (they sum to 90)."), bad JSON, `401`, `403` (also written to `AuditLog` as `forbidden`), `415`

**Deadline rules across the life of a scholarship (§6):**
- **Create and edit (draft):** the deadline only has to be a real date-time. A past deadline is accepted (`201`), so an admin can prepare a draft and fix the date later. No `409` on create.
- **Publish** (`PATCH /api/admin/scholarships/{id}/status` with `published`): `409 CONFLICT` if the deadline is not in the future at that moment, if `awards` < 1, or if the rubric is not valid. Checked by the server clock, and the deadline and awards are checked again inside the same conditional update that changes the status.
- **After publish:** rubric, eligibility and deadline are locked. Editing (`PUT`) a `published` or `closed` scholarship is `409 CONFLICT`.

**Years of study:** `years` accepts whole numbers 1-6. §6 doesn't set a numeric range; application-service must accept the same range for `yearOfStudy` (to confirm with Khalil, see `docs/decisions.md`).

### PUT /api/admin/scholarships/{id}  [admin]  (edit a draft)
Same body and the same rules as `POST`; it replaces every editable field (`title`, `description`, `deadline`, `awards`, `rubric`, `eligibility`). `status`, `acceptedCount`, `createdBy` and `createdAt` can't be changed here (body values are ignored). One conditional update: only while `status` is `draft`.

`200` with the whole scholarship, as in the `POST` response. Writes `scholarship_updated` to `AuditLog`.
`400` id is not a UUID, invalid field, bad JSON, `401`, `403`, `404 SCHOLARSHIP_NOT_FOUND`, `409` not a draft any more ("Only a draft can be edited (this scholarship is published). Rubric, eligibility and deadline are locked after publishing."), `415`

### PATCH /api/admin/scholarships/{id}/status  [admin]  (publish or close)
```json
{ "status": "published" }
```
or
```json
{ "status": "closed" }
```
`200` with the whole scholarship and its new `status`. Writes `scholarship_published` or `scholarship_closed` to `AuditLog`.

| From | To | Allowed when | Otherwise |
|---|---|---|---|
| `draft` | `published` | deadline in the future (server clock), `awards` >= 1, rubric valid | `409` with the reason ("The deadline has passed. Set a future deadline before publishing.") |
| `published` | `closed` | always (stops new applications; reviewing and deciding go on) | — |
| any other pair | | never (`published` → `draft`, `draft` → `closed`, publishing or closing twice) | `409` |

`status` other than `published` / `closed` (including `draft`) → `400`. The status change is one conditional update, so of several publishes sent at the same time exactly one succeeds and the rest get `409`.
`400`, `401`, `403`, `404 SCHOLARSHIP_NOT_FOUND`, `409`, `415`

### PATCH /api/admin/applications/{id}/decision  [admin]  (accept or reject, then queue the email)
```json
{ "decision": "accepted" }
```
or
```json
{ "decision": "rejected" }
```
`200`
```json
{
  "applicationId": "4123d54c-19de-4551-8f8b-5f88bf29438e",
  "scholarshipId": "3586ae3a-2131-44c1-aaeb-eae0bff6fa44",
  "status": "accepted",
  "decidedBy": "test-admin",
  "decidedAt": "2026-11-27T14:20:07.064Z",
  "emailStatus": "queued"
}
```
Rules (§6 Deciding):
- Only a `reviewed` application can be decided. Not reviewed yet, or already `accepted`/`rejected` (a decision is final) → `409`.
- A flagged application (`flagged = true`, set by review-service) can only be rejected → `409` on accept.
- **Accept** is two conditional writes, no transaction: (1) Scholarships `acceptedCount + 1` only while `acceptedCount < awards` (limit reached → `409`), then (2) Applications `reviewed → accepted` only if still reviewed and not flagged. If (2) fails (someone decided it first) the award is given back (`acceptedCount - 1`, never below 0) and the answer is `409`. If even the give-back fails it is written to the log as an error with both ids.
- **Reject** is one conditional write `reviewed → rejected`.
- Fields this service changes on `Applications`: `status`, `decidedBy` (from the token), `decidedAt`, `emailStatus`. On `Scholarships`: `acceptedCount`.
- Writes `decision` to `AuditLog` (detail `accepted` / `rejected`).

Email (SQS `notifications`, consumed by `notification-sender`):
- Message body, everything the sender needs so it never reads other tables. `flagReason` only for a flagged application, read from `Reviews`. Never the essay, scores, reviewer or flag note:
```json
{ "applicationId": "c110037b-0926-4254-9c47-7983b339a0f1", "studentEmail": "student1@example-university.edu", "scholarshipTitle": "Cloud Excellence Award", "decision": "rejected", "flagReason": "ineligible" }
```
- `emailStatus`: `pending` when the decision is written, then `queued` once SQS accepted the message or `failed` if it didn't (both only from `pending`, so they never overwrite what notification-sender already set). notification-sender then moves it `queued → sending → sent`, back to `queued` for a retry, or to `failed` on the last attempt. A failed email never undoes the decision; the response is still `200` with `emailStatus: "failed"`, visible to the admin. Tested with a server whose queue URL is wrong (T-ADM-49): the decision and the award stay. `notification-sender` (step 8) sets what happens after the queue.
- A message that fails 3 times in the sender moves to `notifications-dlq` (kept 14 days).

`400` id not a UUID, `decision` not `accepted`/`rejected`, bad JSON, `401`, `403`, `404 APPLICATION_NOT_FOUND`, `409` (not reviewed, already decided, flagged accept, awards limit reached, scholarship missing), `415`

### Users (account management)
`Users` belongs to the shared auth-service (§1, §5); admin-service only manages accounts in it. On Floci the table is a local test fixture in admin-service's deploy.sh until auth-service creates it. `passwordHash` is never read back or returned: every read names its fields, and responses only ever contain `userId, email, name, role, status, mustChangePassword, createdAt`.

### GET /api/admin/users?role=&status=  [admin]
Both filters optional: `role` one of `student`, `reviewer`, `admin`; `status` one of `active`, `disabled` (anything else → `400`). Sorted by email.
`200` (no match is `[]`)
```json
[
  { "userId": "u-rev-1", "email": "reviewer@example-university.edu", "name": "Rana Reviewer", "role": "reviewer", "status": "disabled", "mustChangePassword": false, "createdAt": "2026-11-27T00:00:00.000Z" }
]
```
`400`, `401`, `403`

### POST /api/admin/users  [admin]  (create a reviewer)
```json
{ "email": "new.reviewer@example.org", "name": "New Reviewer" }
```
`201`. The **only** response that ever contains `temporaryPassword` (16 random URL-safe characters, 96 bits). Only its bcrypt hash is stored; the password itself is not stored, logged or audited. `role` is always `reviewer` (§6: admins come from seed.sh; a role in the body is ignored), `mustChangePassword` is `true`.
```json
{
  "userId": "0b9d6c1e-3a52-4e7f-9d10-6a2f4c8b7e21",
  "email": "new.reviewer@example.org",
  "name": "New Reviewer",
  "role": "reviewer",
  "status": "active",
  "mustChangePassword": true,
  "createdAt": "2026-11-27T15:00:00.000Z",
  "temporaryPassword": "q3Xv9LmP0aZt7KcW"
}
```
Writes `user_created` to `AuditLog` (detail `reviewer created`, no email, no password). `400` invalid email (lowercased, at most 254 characters) or name (2-60 characters), bad JSON, `401`, `403`, `409` email already used, `415`.
Email uniqueness is checked on `email-index` (a GSI, eventually consistent), so two creates for the same email at the very same moment could both pass. See `docs/decisions.md`.

### PATCH /api/admin/users/{id}/status  [admin]  (disable or enable)
```json
{ "status": "disabled" }
```
`200` with the account (the 7 safe fields). Writes `user_disabled` or `user_enabled` to `AuditLog`.
Rules (§6 Accounts):
- Never your own account → `409`. Already in that status → `409`. Unknown id → `404 USER_NOT_FOUND`.
- **Disabling an admin** is one `TransactWriteItems`: update the target `active → disabled` **and** a `ConditionCheck` that the acting admin's own row is `role = admin AND status = active`. Because you can't disable yourself, an active admin (you) always remains, so the last active admin can never be disabled. If two admins disable each other at the same time, DynamoDB runs one transaction after the other and the second one's check fails: exactly one `200`, one `409`, one admin left active.
- Disabling a student or reviewer, and every enable, is one conditional update (`status` must still be what was read).
- Phase A: the acting admin needs a row in `Users` for the admin rule (the tests seed `test-admin`); in Phase B `authenticate` re-reads `Users`, so every caller has one and a disabled user is blocked on the next request (§2).

`400` id invalid or status not `active`/`disabled`, `401`, `403`, `404 USER_NOT_FOUND`, `409`, `415`

### GET /api/admin/audit-log?action=&since=&limit=&next=  [admin]
- `action` (required): one of `login`, `login_failed`, `forbidden`, `claim`, `claim_expired`, `release`, `review`, `pdf_download`, `scholarship_created`, `scholarship_updated`, `scholarship_published`, `scholarship_closed`, `decision`, `user_created`, `user_disabled`, `user_enabled`. It is the table's partition key, so every call is one Query, never a Scan. **A service that writes a new action must add it to this list** (`src/controllers/audit.js`).
- `since` (optional): a full ISO 8601 date-time with a zone, same rules as a deadline. Rows with `createdAt` >= since.
- `limit` (optional): 1-100, default 50. 100 is a hard cap per call.
- `next` (optional): the `next` value from the previous page. Only accepted for the same `action`.

`200`, newest first. Each row has exactly these 5 fields, returned as plain data:
```json
{
  "items": [
    { "action": "decision", "createdAt": "2026-11-27T14:20:07.064Z", "userId": "test-admin", "targetId": "4123d54c-19de-4551-8f8b-5f88bf29438e", "detail": "accepted" }
  ],
  "next": "eyJhY3Rpb24iOiJkZWNpc2lvbiIsInNvcnRLZXkiOiIyMDI2LTExLTI3VDE0OjIwOjA3LjA2NFojLi4uIn0"
}
```
`next` is `null` on the last page. Audit rows never hold passwords, hashes or tokens (writers only put short descriptions in `detail`).
`400` no or unknown `action`, bad `since`, `limit` outside 1-100, a `next` that is not a token for this action, `401`, `403`

### GET /api/admin/stats  [admin]
Counted live by DynamoDB on the status indexes (`status-deadline-index` on Scholarships, `status-index` on Applications, `Select: COUNT`, every page). Nothing stored or hard-coded.
`200`
```json
{
  "scholarships": { "draft": 3, "published": 2, "closed": 1 },
  "applications": { "submitted": 5, "under_review": 2, "reviewed": 1, "accepted": 1, "rejected": 0 }
}
```
`401`, `403`

### notification-sender  (Lambda, triggered by SQS `notifications`, no HTTP route)
One message per invocation (batch size 1), the message format from the decision endpoint above.
1. Checks the message: `applicationId` a UUID, `studentEmail` a valid address, `scholarshipTitle` 1-100 characters, `decision` `accepted`/`rejected`, `flagReason` one of the 4 reasons if present. An invalid message throws (retried, then kept in `notifications-dlq`) and writes nothing.
2. **Claims** the email with one conditional update, `emailStatus` `pending`/`queued` → `sending`. If it is already `sending` or `sent`, this copy does nothing: a duplicated SQS message can never send a second email.
3. Sends a **plain-text** email through Brevo (`POST https://api.brevo.com/v3/smtp/email`). The key comes from SSM `/scholarship/brevo-api-key` (SecureString, read once per cold start, never logged). With `BREVO_SANDBOX` not `false` the request carries `X-Sib-Sandbox: drop`: Brevo checks it but delivers nothing. A rejection includes the flag reason in plain words (§6: "the rejection email gives the flag reason"); never the essay, scores, reviewer or flag note.
4. Success → `emailStatus = sent`, `email_sent` in `AuditLog` (detail = decision, no email address).
5. Failure → if this is the queue's last attempt (`ApproximateReceiveCount` >= the queue's real `RedrivePolicy.maxReceiveCount`, read from SQS) `emailStatus = failed` and `email_failed` in `AuditLog`; otherwise back to `queued`. Then it throws, so SQS retries, and after the last attempt moves the message to `notifications-dlq` (kept 14 days).

Environment (deploy.sh): `APPLICATIONS_TABLE`, `AUDIT_TABLE`, `BREVO_KEY_PARAM`, `NOTIFICATIONS_QUEUE_URL` (to read maxReceiveCount), `BREVO_SENDER_EMAIL` (a sender verified in Brevo), `BREVO_SANDBOX` (`true` unless set to `false`), `NODE_ENV`. The last two are new and still need adding to CLAUDE.md §4 (separate small PR).
