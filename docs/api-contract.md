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

## admin-service
