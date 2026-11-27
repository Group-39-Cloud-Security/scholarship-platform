# API Test Plan

| Test ID | Service | Request | Expected | Actual | Pass/Fail | Evidence |
|---|---|---|---|---|---|---|
| T-REV-01 | review-service | GET /api/reviews/queue, no token | 401 UNAUTHENTICATED |  |  |  |
| T-REV-02 | review-service | GET /api/reviews/queue as test-student-1 | 403 FORBIDDEN + `forbidden` in AuditLog |  |  |  |
| T-REV-03 | review-service | GET /api/reviews/queue as test-reviewer | 200, submitted only, oldest first, at most 50, no essay/email |  |  |  |
| T-REV-04 | review-service | POST /api/reviews with Content-Type text/plain | 415 UNSUPPORTED_MEDIA_TYPE |  |  |  |
| T-REV-05 | review-service | POST /api/reviews `{ "applicationId": "../x" }` | 400 VALIDATION_ERROR |  |  |  |
| T-REV-06 | review-service | POST /api/reviews unknown applicationId | 404 APPLICATION_NOT_FOUND |  |  |  |
| T-REV-07 | review-service | POST /api/reviews valid id (body also has reviewerId) | 201 under_review; stored reviewerId = token user, body value ignored |  |  |  |
| T-REV-08 | review-service | Same claim sent 5 times in parallel | exactly one 201, four 409 (atomic claim) |  |  |  |
| T-REV-09 | review-service | 6th claim while holding 5 | 409 CONFLICT |  |  |  |
| T-REV-10 | review-service | GET /api/reviews/{id} claimed by another reviewer | 404 APPLICATION_NOT_FOUND |  |  |  |
| T-REV-11 | review-service | PUT scores missing / extra / 11 / 7.5 / "8" | 400 VALIDATION_ERROR each |  |  |  |
| T-REV-12 | review-service | PUT `{ scores: {academic:8, essay:7, need:5}, totalScore: 100 }` (weights 40/40/20) | 200, totalScore 70 (client total ignored), application `reviewed` |  |  |  |
| T-REV-13 | review-service | PUT again on the same application | 409 CONFLICT (review is final) |  |  |  |
| T-REV-14 | review-service | PUT `{ flagged: true, flagReason: "lazy" }` | 400 VALIDATION_ERROR |  |  |  |
| T-REV-15 | review-service | PUT `{ flagged: true, flagReason: "ineligible" }` | 200, flagged, no scores |  |  |  |
| T-REV-16 | review-service | DELETE own claim | 204, application back to `submitted`, reviewerId/claimedAt removed |  |  |  |
| T-REV-17 | review-service | DELETE as test-admin on any claim | 204; second time 409 |  |  |  |
| T-REV-18 | review-service | DELETE as test-student-1 | 403 FORBIDDEN |  |  |  |
| T-REV-19 | review-service | GET /api/reviews/{id}/pdf while under review | 200, presigned URL, expiresIn 300, `pdf_download` in AuditLog, URL not in logs |  |  |  |
| T-REV-20 | review-service | Invoke release-expired-claims with claims 49 h and 47 h old | the 49 h one goes back to submitted with `claim_expired` in AuditLog, the 47 h one is unchanged |  |  |  |
| T-REV-21 | review-service | OPTIONS /api/reviews/queue from http://localhost:4566 | 204 with Access-Control-Allow-Origin |  |  |  |
| T-REV-22 | review-service | GET with Origin http://evil.example | no Access-Control-Allow-Origin header |  |  |  |
| T-REV-23 | review-service | Any review response | X-Content-Type-Options nosniff, X-Frame-Options DENY, CSP default-src 'none', no X-Powered-By |  |  |  |
| T-REV-24 | review-service | Essay containing `<script>` opened on reviewer/review.html | shown as text, never run (textContent) |  |  |  |
| T-ADM-01 | admin-service | GET /api/health through API Gateway, no token | 200 `{ status: ok, environment: production, runtime: lambda }` | 200, runtime lambda (27 Nov, Floci) | Pass | requests.http |
| T-ADM-02 | admin-service | GET /api/admin/nope through API Gateway | 404 `{"message":"Not Found"}` from API Gateway, no log line | 404 `{"message":"Not Found"}` | Pass | requests.http |
| T-ADM-03 | admin-service | POST with body `{bad` and Content-Type application/json (local) | 400 VALIDATION_ERROR "Request body is not valid JSON." | 400 VALIDATION_ERROR | Pass | requests.http |
| T-ADM-04 | admin-service | GET /api/health with Origin http://localhost:4566 | Access-Control-Allow-Origin: http://localhost:4566 | header present | Pass | requests.http |
| T-ADM-05 | admin-service | GET /api/health with Origin http://evil.example | no Access-Control-Allow-Origin header | no header | Pass | requests.http |
| T-ADM-06 | admin-service | OPTIONS /api/health preflight from http://localhost:4566 | 204 with Access-Control-Allow-Methods/Headers | 204 | Pass | requests.http |
| T-ADM-07 | admin-service | Any admin response | X-Content-Type-Options nosniff, X-Frame-Options DENY, CSP default-src 'none', Cache-Control no-store, no X-Powered-By | all present, no X-Powered-By | Pass | requests.http |
