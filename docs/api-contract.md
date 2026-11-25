# API Contract (Lab 3 format)

One section per service, written by its owner: data dictionary (Field · Type · Source · Rule), then each endpoint's request, success response and errors as valid JSON in code fences.

## auth-service

## application-service

## review-service

Owner: Mohamed Hazem. Lambda `review-service` (routes below) + `release-expired-claims` (hourly, no HTTP). Every route needs `Authorization: Bearer <token>`; role in brackets. Errors use the shared shape `{ "error": { "code", "message" } }`.

### Data dictionary — `Reviews` (one item per application, write-once)

| Field | Type | Source | Rule |
|---|---|---|---|
| applicationId | string (UUID) | Client (path) | must be an application this reviewer claimed; PK, `attribute_not_exists` → a review is never overwritten |
| reviewerId | string | Server (token) | never read from the body |
| scores | map criterionId → int | Client | every rubric criterion exactly once, whole number 0–10, no extra keys; absent when flagged |
| totalScore | number 0–100 | Server | `Σ(score × weight) / 10`; any total sent by the client is ignored |
| comment | string | Client | optional, trimmed, 1–1000 chars, shown to admins only |
| flagged | boolean | Client (`true` to flag) | flag and scores are mutually exclusive |
| flagReason | enum | Client | `incomplete_documents` · `ineligible` · `plagiarism_suspected` · `other` |
| flagNote | string | Client | optional, 1–500 chars |
| submittedAt | ISO 8601 UTC | Server | SK of `reviewerId-index` |

`Applications` fields this service changes (conditional updates only): `status` (`submitted` ↔ `under_review` → `reviewed`), `reviewerId`, `claimedAt`, `flagged`.

### GET /api/reviews/queue  [reviewer]
Submitted applications, oldest first. No essay, student id or email.
```json
[
  { "applicationId": "3f0c…", "scholarshipId": "9a1e…", "scholarshipTitle": "Cloud Excellence Award", "submittedAt": "2026-11-20T10:00:00.000Z" }
]
```
`200` (empty list → `[]`) · `401` · `403`

### POST /api/reviews  [reviewer] — claim
```json
{ "applicationId": "3f0c…" }
```
`201`
```json
{ "applicationId": "3f0c…", "status": "under_review", "claimedAt": "2026-11-26T09:00:00.000Z", "expiresAt": "2026-11-28T09:00:00.000Z" }
```
`400` invalid/missing id or bad JSON · `401` · `403` · `404 APPLICATION_NOT_FOUND` · `409` already claimed/reviewed, or the reviewer already holds 5 claims · `415`

### GET /api/reviews/mine  [reviewer]
```json
{
  "claims":  [ { "applicationId": "3f0c…", "scholarshipId": "9a1e…", "scholarshipTitle": "Cloud Excellence Award", "claimedAt": "…", "expiresAt": "…" } ],
  "reviews": [ { "applicationId": "77ab…", "scholarshipTitle": "Cloud Excellence Award", "totalScore": 70, "flagged": false, "flagReason": null, "submittedAt": "…" } ]
}
```
`200` · `401` · `403`

### GET /api/reviews/{applicationId}  [reviewer, claimer only]
Application (without student identity) + the scholarship's rubric and eligibility; `review` is filled once submitted.
```json
{
  "application": { "applicationId": "3f0c…", "scholarshipId": "9a1e…", "status": "under_review", "essay": "…", "gpa": 3.4, "yearOfStudy": 2, "hasPdf": true, "submittedAt": "…", "claimedAt": "…", "expiresAt": "…" },
  "scholarship": { "scholarshipId": "9a1e…", "title": "Cloud Excellence Award", "deadline": "…", "rubric": [ { "criterionId": "academic", "name": "Academic record", "description": "…", "weight": 40 } ], "eligibility": { "allowedDomains": ["bue.edu.eg"], "minGpa": 3, "years": [2, 3] } },
  "review": null
}
```
`200` · `400` · `401` · `403` · `404 APPLICATION_NOT_FOUND` (also for someone else's claim)

### PUT /api/reviews/{applicationId}  [reviewer, claimer only] — score or flag (final)
```json
{ "scores": { "academic": 8, "essay": 7, "need": 5 }, "comment": "Strong essay" }
```
```json
{ "flagged": true, "flagReason": "ineligible", "flagNote": "GPA in the PDF is 2.1" }
```
`200`
```json
{ "applicationId": "3f0c…", "status": "reviewed", "flagged": false, "flagReason": null, "scores": { "academic": 8, "essay": 7, "need": 5 }, "totalScore": 70, "submittedAt": "…" }
```
`400` missing/extra/out-of-range score, both or neither of scores/flag, bad reason, note/comment too long · `401` · `403` · `404` · `409` already reviewed, claim released/expired, scholarship has no rubric · `415`

### DELETE /api/reviews/{applicationId}  [reviewer (own claim), admin (any)] — release
`204` (back to `submitted`, `reviewerId`/`claimedAt` removed) · `400` · `401` · `403` · `404` · `409` not `under_review`

### GET /api/reviews/{applicationId}/pdf  [reviewer, claimer only, while under review]
```json
{ "url": "http://localhost:4566/scholarship-documents/applications/3f0c….pdf?X-Amz-…", "expiresIn": 300 }
```
`200` · `400` · `401` · `403` · `404` · `409` not under review any more

### release-expired-claims (EventBridge Scheduler `release-expired-claims-hourly`, no HTTP)
Queries `status-index` for `under_review` with `claimedAt` older than 48 h, sets each back to `submitted` with a conditional update (`claimedAt` must be unchanged), writes `claim_expired` to `AuditLog`. Returns `{ "checked": 1, "released": 1, "cutoff": "…" }`. A test event may pass `{ "now": "<ISO date>" }`.

## admin-service
