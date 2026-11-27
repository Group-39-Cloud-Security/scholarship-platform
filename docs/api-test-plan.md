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
