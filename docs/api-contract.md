# API Contract (Lab 3 format)

One section per service, written by its owner: data dictionary (Field · Type · Source · Rule), then each endpoint's request, success response and errors as valid JSON in code fences.

## auth-service

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
| 409 | `CONFLICT` | scholarship `closed`; deadline passed; not eligible (the message names the failed rule: email domain, minimum GPA or year); `You have already applied for this scholarship.`; `You already have 3 active applications. Wait for a decision or withdraw one first.` |
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
No body. Deletes the item (conditional: still this student's and still `submitted`) and then its PDF. The student may apply to that scholarship again.

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
