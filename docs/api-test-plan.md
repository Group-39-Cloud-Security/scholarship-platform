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
| T-ADM-01 | admin-service | GET /api/health, no token | 200 `{ status: ok }`, runtime `lambda` through API Gateway (`local` locally) | 200, runtime lambda / local (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-02 | admin-service | GET /api/admin/nope | through API Gateway: 404 `{"message":"Not Found"}` (Lambda never runs); locally: 404 ROUTE_NOT_FOUND | 404 both (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-03 | admin-service | POST /api/admin/scholarships as admin, body `{bad` | 400 VALIDATION_ERROR "Request body is not valid JSON." | 400 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-04 | admin-service | GET /api/health with Origin http://localhost:4566 | Access-Control-Allow-Origin: http://localhost:4566 | header present (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-05 | admin-service | GET /api/health with Origin http://evil.example | no Access-Control-Allow-Origin header | no header (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-06 | admin-service | OPTIONS /api/admin/scholarships preflight from http://localhost:4566 | 204 with Access-Control-Allow-Methods | 204 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-07 | admin-service | GET /api/health, check response headers | nosniff, X-Frame-Options DENY, CSP default-src 'none', Cache-Control no-store, no X-Powered-By | all present, no X-Powered-By (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-08 | admin-service | POST /api/admin/scholarships, no token | 401 UNAUTHENTICATED | 401 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-09 | admin-service | POST /api/admin/scholarships as test-student-1 and as test-reviewer | both 403 FORBIDDEN; 2 new `forbidden` rows in AuditLog with targetId /api/admin/scholarships | 403, 403; AuditLog count +2 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-10 | admin-service | POST /api/admin/scholarships with Content-Type text/plain | 415 UNSUPPORTED_MEDIA_TYPE | 415 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-11 | admin-service | POST rubric weights 40/40/10 | 400 "Rubric weights must sum to 100 (they sum to 90)." | 400 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-12 | admin-service | POST rubric weight 4.5, and weight "40" as text | 400 must be a whole number (both) | 400, 400 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-13 | admin-service | POST rubric with 1 criterion, and with 7 | 400 between 2 and 6 criteria (both) | 400, 400 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-14 | admin-service | POST criterionId used twice, and "Has Space" | 400 used twice / criterionId format | 400, 400 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-15 | admin-service | POST allowedDomains ["bue.edu.eg"] (not in ALLOWED_DOMAINS) | 400 not a partner university | 400 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-16 | admin-service | POST minGpa 5, minGpa "3", year 7, deadline "next friday", awards 0, no title, body `[]` | 400 with one clear message each | 400 x7 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-17 | admin-service | POST valid body that also sends status published, acceptedCount 99, createdBy hacker, scholarshipId | 201; status draft, acceptedCount 0, createdBy test-admin, server UUID, deadline UTC, eligibility lowercased/sorted | 201, all server values (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-18 | admin-service | Count Scholarships items before and after the 400s in T-ADM-11..16, 20, 21, 23, 24 | count unchanged: nothing written on a 400 | count unchanged (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-19 | admin-service | GET /api/admin/scholarships through API Gateway (route not listed yet) | 404 `{"message":"Not Found"}` from API Gateway | 404 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt` |
| T-ADM-20 | admin-service | POST deadline "2027-01-15" (no time or zone) | 400 ISO 8601 date and time with a zone | 400 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-21 | admin-service | POST deadline "2027-02-30T10:00:00Z" and "2027-04-31T10:00:00Z" | 400 (non-existent dates are rejected, not rolled over) | 400, 400 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-22 | admin-service | POST draft with deadline 2020-01-01T00:00:00Z, and one with +02:00 | 201 (a past deadline is allowed on a draft; publish checks it); +02:00 stored as UTC | 201, 201 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-23 | admin-service | POST deadline offsets +14:30 and -00:00, then +14:00 | +14:30 and -00:00 → 400 (above the 14:00 maximum / unknown local offset); +14:00 → 201 stored as 09:59Z | 400, 400, 201 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
| T-ADM-24 | admin-service | POST deadline 2027-02-29, then 2028-02-29 | 2027 (not a leap year) → 400; 2028 → 201 | 400, 201 (27 Nov) | Pass | `services/admin-service/tests/api-tests.sh` → `evidence/admin-api-tests-floci.txt`, `evidence/admin-api-tests-local.txt` |
