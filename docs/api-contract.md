# API Contract (Lab 3 format)

One section per service, written by its owner: data dictionary (Field · Type · Source · Rule), then each endpoint's request, success response and errors as valid JSON in code fences.

## auth-service

Shared component, built by Mohamed Wael (team decision 28 Nov). Lambda `auth-service`. Register and login need no token; `/me` and password change need `Authorization: Bearer <token>` (any role). Every response carries `Cache-Control: no-store` and the shared security headers. Errors use the shared shape `{ "error": { "code": "...", "message": "..." } }`. Passwords and `passwordHash` are never returned, logged or audited.

### Data dictionary: `Users` (one item per account)

| Field | Type | Source | Rule |
|---|---|---|---|
| userId | string (UUID) | Server | `crypto.randomUUID()` |
| email | string | Client | trimmed, lowercased, valid address, at most 254 characters; register: domain in `ALLOWED_DOMAINS`, not already used (409) |
| name | string | Client | 2-60 characters after trimming |
| role | `student` / `reviewer` / `admin` | Server | register always makes `student`; reviewers come from admin-service, the first admin from `seed.sh` |
| status | `active` / `disabled` | Server | `active` on register; admin-service changes it |
| passwordHash | string | Server | bcryptjs, cost 10. The password itself: at least 10 characters, at most 72 bytes, not found in Pwned Passwords |
| mustChangePassword | boolean | Server | `false` on register, `true` for reviewers created by an admin |
| createdAt | string (ISO 8601 UTC) | Server | time of creation |

### Data dictionary: `LoginAttempts` (one item per email + source IP)

| Field | Type | Source | Rule |
|---|---|---|---|
| emailIp | string | Server | `<email>#<ip>`, the IP from API Gateway's `requestContext.http.sourceIp`, never `X-Forwarded-For` |
| failures | number | Server | +1 per failed login (atomic `ADD`), 0 after a success |
| blockedUntil | string (ISO 8601 UTC) | Server | after the 5th failure: now + 1 min, then 2, 4, 8, at most 15 min; removed after a success |
| expiresAt | number (epoch seconds) | Server | now + 24 h on every failure; DynamoDB TTL deletes the row after it |

### POST /api/auth/register  [anyone, no token]
```json
{ "email": "student1@example-university.edu", "name": "Student One", "password": "a long passphrase" }
```
`201`, the new account (never the password or its hash):
```json
{ "userId": "8f1c...", "email": "student1@example-university.edu", "name": "Student One", "role": "student", "status": "active", "mustChangePassword": false, "createdAt": "2026-11-28T10:00:00.000Z" }
```
`role`, `status` or `userId` in the body are ignored. Writes a `user_created` audit row (detail `student registered`).

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | bad JSON, invalid email, name not 2-60, password shorter than 10 or longer than 72 bytes, email outside `ALLOWED_DOMAINS`, password found in Pwned Passwords |
| 409 | `CONFLICT` | an account with this email already exists |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | body is not `application/json` |

Pwned Passwords: only the first 5 hex characters of the password's SHA-1 are sent (k-anonymity, `Add-Padding`), 5 s timeout. If the API can't be reached the password is allowed and a `pwned_check_unavailable` warn line is logged (fails open, docs/decisions.md).

### POST /api/auth/login  [anyone, no token]
```json
{ "email": "student1@example-university.edu", "password": "a long passphrase" }
```
`200`:
```json
{ "token": "eyJhbGciOiJIUzI1NiIs...", "user": { "userId": "8f1c...", "email": "student1@example-university.edu", "name": "Student One", "role": "student", "status": "active", "mustChangePassword": false } }
```
The token is a JWT, HS256, valid 1 hour, signed with `/scholarship/jwt-secret` (SSM). It holds only `sub` (userId), `role`, `iat`, `exp`; the backend never trusts the role in it and re-reads the user from `Users` on every request. Writes a `login` audit row.

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | bad JSON, invalid email, password missing |
| 401 | `UNAUTHENTICATED` | "Email or password is incorrect." for an unknown email, a wrong password and a disabled account alike (same body; unknown emails still pay for one bcrypt compare). Counts a failure, writes a `login_failed` audit row (detail: failure count and IP) and a request log line with `"action":"login_failed"` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | body is not `application/json` |
| 429 | `TOO_MANY_ATTEMPTS` | this email + IP is blocked (see `LoginAttempts`); the password is not checked, `Retry-After` gives the seconds left. Logged as `"action":"login_blocked"`, no audit row (a flood of blocked guesses can't flood `AuditLog`) |

## application-service

Owner: Mohamed Khalil. Lambda `application-service`. Every route needs `Authorization: Bearer <token>`; the allowed role is in brackets. Errors use the shared shape `{ "error": { "code": "...", "message": "..." } }`. Every response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Content-Security-Policy: default-src 'none'`.

| Route | Role | Success |
|---|---|---|
| `GET /api/scholarships?search=` | any logged-in user | 200 |
| `GET /api/scholarships/{id}` | any logged-in user | 200 |
| `POST /api/applications` | student | 201 |
| `GET /api/applications/mine` | student | 200 |
| `GET /api/applications/{id}/pdf` | student (owner) | 200 |
| `DELETE /api/applications/{id}` | student (owner) | 204 |

Errors every route can return: `401 UNAUTHENTICATED` (no, malformed or unknown token), `403 FORBIDDEN` (wrong role; also written to `AuditLog` as `forbidden`), `500 INTERNAL_ERROR` (unexpected; details only in the log). A path that is not listed above is answered by API Gateway with `404 {"message":"Not Found"}` and never reaches the Lambda (`404 ROUTE_NOT_FOUND` when run locally).

### Data dictionary: `Applications` (one item per application)

| Field | Type | Source | Rule |
|---|---|---|---|
| applicationId | string (UUID) | Server | `crypto.randomUUID()` |
| studentId | string | Server (token) | never read from the body |
| studentEmail | string | Server (token) | used by admin-service for the decision email |
| scholarshipId | string | Client | 1–64 characters `A-Z a-z 0-9 -`; must be a `published` scholarship before its deadline |
| essay | string | Client | 200–1000 words and at most 10,000 characters |
| gpa | number | Client | JSON number 0–4 (a string such as `"3.5"` is rejected); ≥ the scholarship's `minGpa` |
| yearOfStudy | integer | Client | whole number 1–6; in the scholarship's `years` |
| pdfBase64 | string (base64) | Client | request only, never stored: valid base64, ≤ 2 MB decoded, content starts with `%PDF-` |
| pdfKey | string | Server | `applications/<applicationId>.pdf` in the private bucket `scholarship-documents` (SSE-S3) |
| status | enum | Server | see Status values |
| submittedAt | string (ISO 8601 UTC) | Server | time of apply |

Any other field in the body (for example `studentId` or `status`) is ignored. Other services add `reviewerId`, `claimedAt`, `flagged`, `flagReason` (review-service) and `decidedAt` (admin-service); students never see `reviewerId`, scores or the flag.

### Lock rows in `Applications` (application-service only)

The apply limits are enforced by small lock rows written in the same DynamoDB transaction as the application. They have only these fields, so they never appear in `studentId-index`, `scholarshipId-index` or `status-index`. **A Scan of `Applications` must filter `attribute_exists(studentId)`.**

| Field | Type | Source | Rule |
|---|---|---|---|
| applicationId | string | Server | `lock#one#<studentId>#<scholarshipId>` (one per scholarship) or `lock#slot#<studentId>#<1-3>` (active slots). Contains `#`, so no route accepts it as an id |
| lockType | enum | Server | `one-per-scholarship` or `active-slot` |
| holder | string (UUID) | Server | the application holding the lock |
| createdAt | string (ISO 8601 UTC) | Server | when the lock was taken |

A slot is free again when its holder is `accepted`, `rejected` or no longer exists; the transaction checks this itself, so admin-service decisions free slots without touching lock rows. Withdraw releases both locks in the same transaction that deletes the application.

### Status values

| Status | Set by | Meaning | Counts as active (max 3) | Student may withdraw |
|---|---|---|---|---|
| `submitted` | application-service (apply); review-service (release or 48 h expiry) | waiting for a reviewer | yes | yes, before the deadline |
| `under_review` | review-service (claim) | a reviewer has it | yes | no |
| `reviewed` | review-service (score or flag) | review done, waiting for a decision | yes | no |
| `accepted` | admin-service (decision) | final | no | no |
| `rejected` | admin-service (decision) | final | no | no |

Withdrawing deletes the item and its PDF; there is no `withdrawn` status.

### Business rules for applying

- One application per scholarship per student, whatever its status (after a withdraw the student may apply again).
- At most 3 active applications per student (`submitted`, `under_review`, `reviewed`).
- Eligibility from the scholarship: the email domain **from the token** must be in `allowedDomains`, `gpa` ≥ `minGpa`, `yearOfStudy` in `years`. An empty rule means no restriction.
- The scholarship must be `published` and its `deadline` in the future.

The first two limits are atomic: one `TransactWriteItems` writes the application, the one-per-scholarship lock and an active slot, each with a condition. Of two requests sent at the same moment that clash, exactly one gets 201 and the other gets 409.

### GET /api/scholarships?search=  [any logged-in user]
Published scholarships only, earliest deadline first. `search` (optional, at most 100 characters, case-insensitive) matches the title or the description.
```json
[
  {
    "scholarshipId": "test-open",
    "title": "Open Merit Scholarship",
    "description": "Test scholarship for Phase A.",
    "deadline": "2026-12-26T19:00:00.000Z",
    "awards": 2,
    "isOpen": true,
    "eligibility": { "allowedDomains": ["example-university.edu"], "minGpa": 0, "years": [1, 2, 3, 4, 5, 6] },
    "rubric": [{ "name": "Essay", "description": "Clarity and motivation", "weight": 40 }]
  }
]
```
`isOpen` is `false` once the deadline has passed (still listed, can't apply). `createdBy` and `acceptedCount` are never returned.

| Status | Code | When |
|---|---|---|
| 200 | | list, `[]` when nothing matches |
| 400 | `VALIDATION_ERROR` | `search` given twice or longer than 100 characters |
| 401 | `UNAUTHENTICATED` | |

### GET /api/scholarships/{id}  [any logged-in user]
One scholarship, same fields as above.

| Status | Code | When |
|---|---|---|
| 200 | | published scholarship |
| 404 | `SCHOLARSHIP_NOT_FOUND` | unknown or malformed id, or the scholarship is `draft` or `closed` |
| 401 | `UNAUTHENTICATED` | |

### POST /api/applications  [student]
`Content-Type: application/json`, body up to 3 MB.
```json
{ "scholarshipId": "test-open", "essay": "…200 to 1000 words…", "gpa": 3.2, "yearOfStudy": 2, "pdfBase64": "JVBERi0xLjQK…" }
```
201:
```json
{ "applicationId": "2a4a3a7c-a7bd-45e2-9735-5227a67fd3d5", "scholarshipId": "test-open", "status": "submitted", "submittedAt": "2026-11-26T19:58:31.870Z" }
```
Checks run in this order; the first one that fails answers.

| Status | Code | When (message) |
|---|---|---|
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` is not `application/json` |
| 400 | `VALIDATION_ERROR` | body is not valid JSON or not a JSON object; `scholarshipId is required.`; essay missing, over 10,000 characters or outside 200–1000 words; `GPA must be a number.` / `between 0 and 4`; `Year of study must be a whole number.` / `Year of study must be between 1 and 6.`; `pdfBase64` missing or not valid base64; `The file must be a PDF (its content does not start with %PDF-).` |
| 413 | `PAYLOAD_TOO_LARGE` | body over 3 MB, or `The PDF must be at most 2 MB.` |
| 404 | `SCHOLARSHIP_NOT_FOUND` | unknown or `draft` scholarship |
| 409 | `CONFLICT` | scholarship `closed`; deadline passed; not eligible (the message names the failed rule: email domain, minimum GPA or year); `You have already applied for this scholarship.`; `You already have 3 active applications. Wait for a decision or withdraw one first.`; `Several applications arrived at the same moment. Please try again.` (still clashing after 3 attempts) |
| 401 / 403 | | not logged in / not a student |

### GET /api/applications/mine  [student]
The student's own applications, newest first (`[]` when none). Only the fields below are returned: never `reviewerId`, scores, the flag, the essay or the PDF key.
```json
[
  {
    "applicationId": "2a4a3a7c-a7bd-45e2-9735-5227a67fd3d5",
    "scholarshipId": "test-open",
    "scholarshipTitle": "Open Merit Scholarship",
    "deadline": "2026-12-26T19:00:00.000Z",
    "status": "under_review",
    "gpa": 3.2,
    "yearOfStudy": 2,
    "submittedAt": "2026-11-26T19:58:31.870Z",
    "timeline": [
      { "step": "submitted", "label": "Application submitted", "done": true, "at": "2026-11-26T19:58:31.870Z" },
      { "step": "under_review", "label": "Being reviewed", "done": true, "at": "2026-11-27T08:00:00.000Z" },
      { "step": "reviewed", "label": "Review finished", "done": false },
      { "step": "decision", "label": "Decision", "done": false }
    ],
    "canWithdraw": false
  }
]
```
`decidedAt` is present only for `accepted` or `rejected`, and the last timeline step then reads `Decision: accepted` or `Decision: rejected`. `scholarshipTitle` is `(scholarship no longer available)` if the scholarship can't be found.

| Status | Code | When |
|---|---|---|
| 200 | | list |
| 401 / 403 | | not logged in / not a student |

### GET /api/applications/{id}/pdf  [student, owner only]
The ownership check runs first, then a presigned GET link valid 300 seconds is returned with `Cache-Control: no-store`. The link is never logged.
```json
{ "url": "http://…/scholarship-documents/applications/2a4a3a7c-….pdf?X-Amz-Algorithm=…", "expiresIn": 300 }
```

| Status | Code | When |
|---|---|---|
| 200 | | own application |
| 404 | `APPLICATION_NOT_FOUND` | unknown or malformed id, **or another student's application** (same answer, so ids can't be probed) |
| 401 / 403 | | not logged in / not a student |

### DELETE /api/applications/{id}  [student, owner only]  (withdraw)
No body. One transaction deletes the item (conditional: still this student's and still `submitted`) and releases its two lock rows; then the PDF is deleted. The student may apply to that scholarship again.

| Status | Code | When (message) |
|---|---|---|
| 204 | | withdrawn |
| 404 | `APPLICATION_NOT_FOUND` | unknown or malformed id, or another student's application |
| 409 | `CONFLICT` | `Only applications that a reviewer has not picked up yet can be withdrawn.`; `The deadline has passed, so this application can no longer be withdrawn.`; `A reviewer has just picked up this application, so it can no longer be withdrawn.` (claimed between the read and the delete) |
| 401 / 403 | | not logged in / not a student |

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
`Users` belongs to the shared auth-service (§1, §5); admin-service only manages accounts in it. auth-service's deploy.sh creates the table. `passwordHash` is never read back or returned: every read names its fields, and responses only ever contain `userId, email, name, role, status, mustChangePassword, createdAt`.

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
2. **Claims** the email with one conditional update, `emailStatus` `pending`/`queued` → `sending`. If it is already `sent`, this copy does nothing: a duplicated SQS message can never send a second email. If it is still `sending`:
   - on a **first** delivery (`ApproximateReceiveCount` 1) another copy is sending right now: this copy does nothing;
   - on a **retry** (count > 1) the attempt that claimed it died before finishing (the Lambda times out after 15 s, a retry only comes after the 90 s visibility timeout). Whether that attempt sent is unknown, so it is not sent again: one conditional update `sending → failed`, an `email_failed` row in `AuditLog` (no email address), and the handler returns normally, so SQS deletes the message instead of retrying it into the DLQ.
3. Sends a **plain-text** email through Brevo (`POST https://api.brevo.com/v3/smtp/email`). The key comes from SSM `/scholarship/brevo-api-key` (SecureString, read once per cold start, never logged). With `BREVO_SANDBOX` not `false` the request carries `X-Sib-Sandbox: drop`: Brevo checks it but delivers nothing. A rejection includes the flag reason in plain words (§6: "the rejection email gives the flag reason"); never the essay, scores, reviewer or flag note.
4. Success → `emailStatus = sent`, `email_sent` in `AuditLog` (detail = decision, no email address).
5. Failure → if this is the queue's last attempt (`ApproximateReceiveCount` >= the queue's real `RedrivePolicy.maxReceiveCount`, read from SQS) `emailStatus = failed` and `email_failed` in `AuditLog`; otherwise back to `queued`. Then it throws, so SQS retries, and after the last attempt moves the message to `notifications-dlq` (kept 14 days).

Environment (deploy.sh): `APPLICATIONS_TABLE`, `AUDIT_TABLE`, `BREVO_KEY_PARAM`, `NOTIFICATIONS_QUEUE_URL` (to read maxReceiveCount), `BREVO_SENDER_EMAIL` (a sender verified in Brevo), `BREVO_SANDBOX` (`true` unless set to `false`), `NODE_ENV`. The last two are new and still need adding to CLAUDE.md §4 (separate small PR).
