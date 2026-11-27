# API Test Plan

| Test ID | Service | Request | Expected | Actual | Pass/Fail | Evidence |
|---|---|---|---|---|---|---|
| T-APP-01 | application-service | GET /api/scholarships, no token | 401 UNAUTHENTICATED | | | tests/api-tests.js |
| T-APP-02 | application-service | GET /api/scholarships (student) | 200, only published | | | tests/api-tests.js |
| T-APP-03 | application-service | same | no createdBy/acceptedCount in the response | | | tests/api-tests.js |
| T-APP-04 | application-service | GET /api/scholarships?search=merit | 200, only matching | | | tests/api-tests.js |
| T-APP-05 | application-service | ?search=a&search=b | 400 | | | tests/api-tests.js |
| T-APP-06 | application-service | GET /api/scholarships/test-draft | 404 SCHOLARSHIP_NOT_FOUND | | | tests/api-tests.js |
| T-APP-07 | application-service | GET /api/scholarships/test-open (reviewer) | 200 | | | tests/api-tests.js |
| T-APP-08 | application-service | POST /api/applications (admin token) | 403 FORBIDDEN + AuditLog `forbidden` | | | tests/api-tests.js |
| T-APP-09 | application-service | POST /api/applications, no token | 401 | | | tests/api-tests.js |
| T-APP-10 | application-service | POST, Content-Type text/plain | 415 | | | tests/api-tests.js |
| T-APP-11 | application-service | POST, broken JSON | 400 VALIDATION_ERROR | | | tests/api-tests.js |
| T-APP-12 | application-service | POST, essay under 200 words | 400 | | | tests/api-tests.js |
| T-APP-13 | application-service | POST, gpa as string | 400 | | | tests/api-tests.js |
| T-APP-14 | application-service | POST, yearOfStudy 9 | 400 | | | tests/api-tests.js |
| T-APP-15 | application-service | POST, non-PDF content (renamed .exe) | 400 (checked by content) | | | tests/api-tests.js |
| T-APP-16 | application-service | POST, pdfBase64 not base64 | 400 | | | tests/api-tests.js |
| T-APP-17 | application-service | POST, PDF over 2 MB | 413 PAYLOAD_TOO_LARGE | | | tests/api-tests.js |
| T-APP-18 | application-service | POST to a draft | 404 | | | tests/api-tests.js |
| T-APP-19 | application-service | POST to a closed scholarship | 409 | | | tests/api-tests.js |
| T-APP-20 | application-service | POST after the deadline | 409 | | | tests/api-tests.js |
| T-APP-21 | application-service | POST, email domain not allowed | 409 with reason | | | tests/api-tests.js |
| T-APP-22 | application-service | POST valid (body also sends studentId + status) | 201 submitted | | | tests/api-tests.js |
| T-APP-23 | application-service | POST same scholarship again | 409 already applied | | | tests/api-tests.js |
| T-APP-24 | application-service | GET /api/applications/mine | 200 with timeline | | | tests/api-tests.js |
| T-APP-25 | application-service | same | forged studentId/status ignored | | | tests/api-tests.js |
| T-APP-26 | application-service | same | no reviewerId/flag/essay | | | tests/api-tests.js |
| T-APP-27 | application-service | GET mine as student 2 | doesn't contain student 1's | | | tests/api-tests.js |
| T-APP-28 | application-service | GET mine as reviewer | 403 | | | tests/api-tests.js |
| T-APP-29 | application-service | GET /api/applications/{id}/pdf (owner) | 200 presigned URL, 300 s, no-store | | | tests/api-tests.js |
| T-APP-30 | application-service | open the presigned URL | 200, file starts with %PDF- | | | tests/api-tests.js |
| T-APP-31 | application-service | GET pdf as another student | 404 (not 403) | | | tests/api-tests.js |
| T-APP-32 | application-service | GET pdf, unknown id | 404 | | | tests/api-tests.js |
| T-APP-33 | application-service | 2nd and 3rd applications | 201, 201 | | | tests/api-tests.js |
| T-APP-34 | application-service | 4th active application | 409 max 3 | | | tests/api-tests.js |
| T-APP-35 | application-service | DELETE someone else's | 404 | | | tests/api-tests.js |
| T-APP-36 | application-service | DELETE after a reviewer claimed it | 409 | | | tests/api-tests.js |
| T-APP-37 | application-service | GET mine after claim | under_review, reviewer hidden, canWithdraw false | | | tests/api-tests.js |
| T-APP-38 | application-service | DELETE own submitted | 204, PDF removed from S3 | | | tests/api-tests.js |
| T-APP-39 | application-service | GET pdf of withdrawn | 404 | | | tests/api-tests.js |
| T-APP-40 | application-service | apply after withdrawing | 201 | | | tests/api-tests.js |
| T-APP-41 | application-service | re-apply while 3 active | 409 | | | tests/api-tests.js |
| T-APP-42 | application-service | any response | nosniff, DENY, CSP default-src 'none' | | | tests/api-tests.js |
| T-APP-43 | application-service | GET /api/applications (no such route) | 404 | | | tests/api-tests.js |
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
