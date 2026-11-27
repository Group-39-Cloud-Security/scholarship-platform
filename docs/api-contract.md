# API Contract (Lab 3 format)

One section per service, written by its owner: data dictionary (Field · Type · Source · Rule), then each endpoint's request, success response and errors as valid JSON in code fences.

## auth-service

## application-service

Owner: Mohamed Khalil. All routes need `Authorization: Bearer <token>`. Errors use the shared shape `{ "error": { "code", "message" } }`.

### Data dictionary — Application (table `Applications`)
| Field | Type | Source | Rule |
|---|---|---|---|
| applicationId | string (UUID) | Server | `crypto.randomUUID()` |
| studentId | string | Server | from the token, never the body |
| studentEmail | string | Server | from the token (used for the decision email) |
| scholarshipId | string | Client | must be a `published` scholarship before its deadline |
| essay | string | Client | 200–1000 words, at most 10,000 characters |
| gpa | number | Client | JSON number 0–4, ≥ the scholarship's `minGpa` |
| yearOfStudy | integer | Client | 1–7, in the scholarship's `years` |
| pdfBase64 | string (base64) | Client | request only, never stored: ≤ 2 MB decoded, content starts with `%PDF-` |
| pdfKey | string | Server | `applications/<applicationId>.pdf` in S3 `scholarship-documents` |
| status | string | Server | `submitted` on create; later `under_review` / `reviewed` / `accepted` / `rejected` (other services) |
| submittedAt | string (ISO 8601 UTC) | Server | time of apply |

### GET /api/scholarships?search=
Any logged-in user. `published` only, earliest deadline first. `search` (≤ 100 chars) matches title or description.
```json
[
  {
    "scholarshipId": "test-open",
    "title": "Open Merit Scholarship",
    "description": "Test scholarship for Phase A.",
    "deadline": "2026-12-26T19:00:00.000Z",
    "awards": 2,
    "isOpen": true,
    "eligibility": { "allowedDomains": ["example-university.edu"], "minGpa": 0, "years": [1, 2, 3, 4] },
    "rubric": [{ "name": "Essay", "description": "Clarity and motivation", "weight": 40 }]
  }
]
```
Errors: 400 (search given twice / too long), 401.

### GET /api/scholarships/{id}
200 = one object as above. 404 `SCHOLARSHIP_NOT_FOUND` for unknown, `draft` and `closed`. 401.

### POST /api/applications
Student only. Body:
```json
{ "scholarshipId": "test-open", "essay": "…200 to 1000 words…", "gpa": 3.2, "yearOfStudy": 2, "pdfBase64": "JVBERi0xLjQK…" }
```
201:
```json
{ "applicationId": "2a4a3a7c-a7bd-45e2-9735-5227a67fd3d5", "scholarshipId": "test-open", "status": "submitted", "submittedAt": "2026-11-26T19:58:31.870Z" }
```
Errors: 400 `VALIDATION_ERROR` (bad JSON, missing/invalid field, not a PDF by content) · 401 · 403 (not a student) · 404 `SCHOLARSHIP_NOT_FOUND` (unknown or draft) · 409 `CONFLICT` (closed, deadline passed, not eligible with the reason, already applied, 3 active) · 413 `PAYLOAD_TOO_LARGE` (PDF > 2 MB) · 415.

### GET /api/applications/mine
Student only. 200, newest first (`[]` when none). Never contains reviewer, scores, flag or essay.
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
Errors: 401, 403.

### GET /api/applications/{id}/pdf
Owner only. 200 (header `Cache-Control: no-store`):
```json
{ "url": "http://…/scholarship-documents/applications/<id>.pdf?X-Amz-…", "expiresIn": 300 }
```
Errors: 401, 403, 404 `APPLICATION_NOT_FOUND` (unknown id **or someone else's**).

### DELETE /api/applications/{id}
Owner only, withdraw. 204, no body. Deletes the item and its PDF.
Errors: 401, 403, 404 `APPLICATION_NOT_FOUND`, 409 (not `submitted` any more, or deadline passed).

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
