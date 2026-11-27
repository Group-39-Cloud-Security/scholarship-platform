#!/usr/bin/env bash
# End-to-end flow through API Gateway on Floci: admin -> student -> reviewer -> admin decision -> email.
# Mohamed Hazem. Run from the repo root after a clean deploy:
#   bash tests/e2e/run-e2e.sh | tee e2e-run.log
# Login (auth-service) is not built yet, so the login steps are tried and recorded as blocked,
# and the phase-A test tokens from shared-lib/auth.js stand in for the logged-in users.
set -u
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
source platform/vars.sh || { echo "Floci not reachable"; exit 1; }
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BODY="$(winpath "$TMP/body")"
RUN=$(date +%s)
STATUS=""

# call METHOD PATH TOKEN [JSON_BODY]
call() {
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$1")
  [ -n "$3" ] && args+=(-H "Authorization: Bearer $3")
  [ -n "${4:-}" ] && args+=(-H "Content-Type: application/json" --data "$4")
  STATUS=$(curl "${args[@]}" "$API_URL$2")
}
field() { grep -o "\"$1\":\"[^\"]*\"" "$BODY" | head -1 | cut -d'"' -f4; }
show() { sed 's/"temporaryPassword":"[^"]*"/"temporaryPassword":"<hidden>"/' "$BODY"; echo; }
step() { echo; echo "=== $1"; }
line() { echo "$1 | expected $2 | got $STATUS"; }

echo "E2E run $(date -u +%Y-%m-%dT%H:%M:%SZ) against $API_URL"
echo "main at $(git rev-parse --short HEAD)"

step "0. health"
call GET /api/health ""
line "GET /api/health" "200"; show

step "1. admin creates a reviewer (test-admin token)"
call POST /api/admin/users test-admin "{\"email\":\"e2e.reviewer.$RUN@example-university.edu\",\"name\":\"E2E Reviewer\"}"
line "POST /api/admin/users" "201, role reviewer, mustChangePassword true"; show
REVIEWER_EMAIL="e2e.reviewer.$RUN@example-university.edu"

step "1b. admin creates and publishes a scholarship"
call POST /api/admin/scholarships test-admin '{"title":"E2E Cloud Award","description":"End-to-end test scholarship.","deadline":"2027-06-30T23:59:00Z","awards":1,"rubric":[{"criterionId":"academic","name":"Academic record","description":"Grades and transcript","weight":40},{"criterionId":"essay","name":"Essay","description":"Clarity and motivation","weight":40},{"criterionId":"need","name":"Financial need","description":"Evidence of need","weight":20}],"eligibility":{"allowedDomains":["example-university.edu"],"minGpa":3,"years":[2,3]}}'
line "POST /api/admin/scholarships" "201 draft"; SCH=$(field scholarshipId); echo "scholarshipId=$SCH"
call PATCH "/api/admin/scholarships/$SCH/status" test-admin '{"status":"published"}'
line "PATCH /api/admin/scholarships/{id}/status published" "200 published"; show

step "2. student registers and logs in"
call POST /api/auth/register "" "{\"email\":\"e2e.student.$RUN@example-university.edu\",\"password\":\"long-enough-pass-$RUN\",\"name\":\"E2E Student\"}"
line "POST /api/auth/register" "201 (blocked if auth-service is not deployed)"; show
call POST /api/auth/login "" "{\"email\":\"e2e.student.$RUN@example-university.edu\",\"password\":\"long-enough-pass-$RUN\"}"
line "POST /api/auth/login" "200 with a token (blocked if auth-service is not deployed)"; show
echo "using test-student-1 (student1@example-university.edu) for the student steps"

step "3. student applies"
ESSAY=$(for i in $(seq 1 17); do printf 'I study computer science and want to build secure cloud systems for students. '; done)
PDF=$(printf '%%PDF-1.4\n%% e2e test document\n' | base64 | tr -d '\n')
call POST /api/applications test-student-1 "{\"scholarshipId\":\"$SCH\",\"essay\":\"$ESSAY\",\"gpa\":3.4,\"yearOfStudy\":2,\"pdfBase64\":\"$PDF\"}"
line "POST /api/applications" "201 submitted"; APP=$(field applicationId); show

step "4. reviewer logs in, sees the application and reviews it"
call POST /api/auth/login "" "{\"email\":\"$REVIEWER_EMAIL\",\"password\":\"temporary-password\"}"
line "POST /api/auth/login (new reviewer)" "200 (blocked if auth-service is not deployed)"; show
echo "using test-reviewer for the reviewer steps"
call GET /api/reviews/queue test-reviewer
grep -q "$APP" "$BODY" && echo "queue contains $APP" || echo "queue does NOT contain $APP"
line "GET /api/reviews/queue" "200 and the new application is in it"
call POST /api/reviews test-reviewer "{\"applicationId\":\"$APP\"}"
line "POST /api/reviews (claim)" "201 under_review"; show
call GET "/api/reviews/$APP" test-reviewer
line "GET /api/reviews/{id}" "200 with the essay and the rubric, no student email"
grep -q studentEmail "$BODY" && echo "student email IS in the response" || echo "no student email in the response"
call PUT "/api/reviews/$APP" test-reviewer '{"scores":{"academic":8,"essay":7,"need":5},"comment":"Clear essay, good grades."}'
line "PUT /api/reviews/{id}" "200 reviewed, totalScore 70"; show

step "5. student checks the status"
call GET /api/applications/mine test-student-1
line "GET /api/applications/mine" "200, this application is reviewed"
grep -o "{\"applicationId\":\"$APP\"[^]]*]" "$BODY" | head -1; echo

step "5b. admin decides"
call PATCH "/api/admin/applications/$APP/decision" test-admin '{"decision":"accepted"}'
line "PATCH /api/admin/applications/{id}/decision accepted" "200 accepted, email queued"; show
call GET /api/applications/mine test-student-1
line "GET /api/applications/mine again" "200, this application is accepted"
grep -o "{\"applicationId\":\"$APP\"[^]]*]" "$BODY" | head -1; echo

step "6. notification"
echo "waiting 20 s for notification-sender..."; sleep 20
aws logs filter-log-events --log-group-name /aws/lambda/notification-sender --filter-pattern "\"$APP\"" \
  --query 'events[].message' --output text 2>&1 | tr '\t' '\n' | tail -5
aws sqs get-queue-attributes --queue-url "$(aws sqs get-queue-url --queue-name notifications-dlq --query QueueUrl --output text 2>/dev/null)" \
  --attribute-names ApproximateNumberOfMessages --query Attributes --output text 2>&1 | sed 's/^/notifications-dlq messages: /'
call GET "/api/admin/audit-log?action=decision" test-admin
grep -q "$APP" "$BODY" && echo "audit log has the decision for $APP" || echo "audit log has NO decision for $APP"

echo; echo "E2E run finished"
