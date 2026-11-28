#!/usr/bin/env bash
# End-to-end flow through API Gateway on Floci, with the real login:
# admin -> new reviewer -> scholarship -> new student -> apply -> claim and score -> decision -> email.
# Mohamed Hazem. Run from the repo root after a clean start:
#   bash platform/reset.sh -y && bash platform/deploy-all.sh
#   bash tests/e2e/run-e2e.sh | tee evidence/e2e-run-floci.txt
# Needs platform/.env (the seeded admin's password, see platform/.env.example).
# The admin logs in with platform/get-token.sh. The reviewer and the student are new accounts made in this run
# with random passwords. Passwords and tokens are never printed.
set -u
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
source platform/vars.sh >/dev/null || { echo "Floci not reachable"; exit 1; }
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
BODY="$(winpath "$TMP/body")"
REQ="$(winpath "$TMP/req")"
RUN=$(date +%s)
DOMAIN=example-university.edu
STATUS=""

# call METHOD PATH TOKEN [JSON_BODY]
# The body goes through a file, so passwords never show up on a command line.
call() {
  local args=(-s -o "$BODY" -w '%{http_code}' -X "$1")
  [ -n "$3" ] && args+=(-H "Authorization: Bearer $3")
  if [ -n "${4:-}" ]; then printf '%s' "$4" > "$REQ"; args+=(-H "Content-Type: application/json" --data-binary "@$REQ"); fi
  STATUS=$(curl "${args[@]}" "$API_URL$2")
  rm -f "$REQ"
}
field() { grep -o "\"$1\":\"[^\"]*\"" "$BODY" | head -1 | cut -d'"' -f4; }
show() { sed -e 's/"temporaryPassword":"[^"]*"/"temporaryPassword":"<hidden>"/' -e 's/"token":"[^"]*"/"token":"<hidden>"/' "$BODY"; echo; }
step() { echo; echo "=== $1"; }
line() { echo "$1 | expected $2 | got $STATUS"; }
newpass() { node -e "process.stdout.write('e2e-' + require('crypto').randomBytes(12).toString('hex'))"; }

echo "E2E run $(date -u +%Y-%m-%dT%H:%M:%SZ) against $API_URL"
echo "code at $(git rev-parse --abbrev-ref HEAD) $(git rev-parse --short HEAD)"

step "0. health, and the old test tokens are gone"
call GET /api/health ""
line "GET /api/health" "200"; show
call GET /api/admin/stats test-admin
line "GET /api/admin/stats with the old Bearer test-admin" "401"; show

step "1. admin logs in"
ADMIN=$(bash platform/get-token.sh admin) || { echo "admin login failed, check platform/.env and run platform/seed.sh"; exit 1; }
call GET /api/auth/me "$ADMIN"
line "GET /api/auth/me (seeded admin)" "200, role admin"; show

step "1b. admin creates a reviewer"
REVIEWER_EMAIL="e2e.reviewer.$RUN@$DOMAIN"
call POST /api/admin/users "$ADMIN" "{\"email\":\"$REVIEWER_EMAIL\",\"name\":\"E2E Reviewer\"}"
line "POST /api/admin/users" "201, role reviewer, mustChangePassword true"; show
TEMP_PASS=$(field temporaryPassword)

step "1c. admin creates and publishes a scholarship"
call POST /api/admin/scholarships "$ADMIN" "{\"title\":\"E2E Cloud Award $RUN\",\"description\":\"End-to-end test scholarship.\",\"deadline\":\"2027-06-30T23:59:00Z\",\"awards\":1,\"rubric\":[{\"criterionId\":\"academic\",\"name\":\"Academic record\",\"description\":\"Grades and transcript\",\"weight\":40},{\"criterionId\":\"essay\",\"name\":\"Essay\",\"description\":\"Clarity and motivation\",\"weight\":40},{\"criterionId\":\"need\",\"name\":\"Financial need\",\"description\":\"Evidence of need\",\"weight\":20}],\"eligibility\":{\"allowedDomains\":[\"$DOMAIN\"],\"minGpa\":3,\"years\":[2,3]}}"
line "POST /api/admin/scholarships" "201 draft"; SCH=$(field scholarshipId); echo "scholarshipId=$SCH"
call PATCH "/api/admin/scholarships/$SCH/status" "$ADMIN" '{"status":"published"}'
line "PATCH /api/admin/scholarships/{id}/status published" "200 published"; show

step "2. student registers and logs in"
STUDENT_EMAIL="e2e.student.$RUN@$DOMAIN"
STUDENT_PASS=$(newpass)
call POST /api/auth/register "" "{\"email\":\"$STUDENT_EMAIL\",\"password\":\"$STUDENT_PASS\",\"name\":\"E2E Student\"}"
line "POST /api/auth/register" "201, role student"; show
call POST /api/auth/login "" "{\"email\":\"$STUDENT_EMAIL\",\"password\":\"$STUDENT_PASS\"}"
line "POST /api/auth/login (student)" "200 with a token"; show
STUDENT=$(field token)

step "3. student applies"
ESSAY=$(for i in $(seq 1 17); do printf 'I study computer science and want to build secure cloud systems for students. '; done)
PDF=$(printf '%%PDF-1.4\n%% e2e test document\n' | base64 | tr -d '\n')
call POST /api/applications "$STUDENT" "{\"scholarshipId\":\"$SCH\",\"essay\":\"$ESSAY\",\"gpa\":3.4,\"yearOfStudy\":2,\"pdfBase64\":\"$PDF\"}"
line "POST /api/applications" "201 submitted"; APP=$(field applicationId); show

step "4. reviewer logs in with the temporary password and has to change it"
call POST /api/auth/login "" "{\"email\":\"$REVIEWER_EMAIL\",\"password\":\"$TEMP_PASS\"}"
line "POST /api/auth/login (new reviewer, temporary password)" "200, mustChangePassword true"; show
FIRST=$(field token)
call GET /api/reviews/queue "$FIRST"
line "GET /api/reviews/queue before changing the password" "403"; show
REVIEWER_PASS=$(newpass)
call PUT /api/auth/password "$FIRST" "{\"currentPassword\":\"$TEMP_PASS\",\"newPassword\":\"$REVIEWER_PASS\"}"
line "PUT /api/auth/password" "200, mustChangePassword false"; show
call POST /api/auth/login "" "{\"email\":\"$REVIEWER_EMAIL\",\"password\":\"$REVIEWER_PASS\"}"
line "POST /api/auth/login (reviewer, new password)" "200 with a token"; show
REVIEWER=$(field token)

step "4b. reviewer sees the application and reviews it"
call GET /api/reviews/queue "$REVIEWER"
line "GET /api/reviews/queue" "200 and the new application is in it"
grep -q "$APP" "$BODY" && echo "queue contains $APP" || echo "queue does NOT contain $APP"
call POST /api/reviews "$REVIEWER" "{\"applicationId\":\"$APP\"}"
line "POST /api/reviews (claim)" "201 under_review"; show
call GET "/api/reviews/$APP" "$REVIEWER"
line "GET /api/reviews/{id}" "200 with the essay and the rubric, no student email"
grep -q studentEmail "$BODY" && echo "student email IS in the response" || echo "no student email in the response"
call PUT "/api/reviews/$APP" "$REVIEWER" '{"scores":{"academic":8,"essay":7,"need":5},"comment":"Clear essay, good grades."}'
line "PUT /api/reviews/{id}" "200 reviewed, totalScore 70"; show

step "5. student checks the status"
call GET /api/applications/mine "$STUDENT"
line "GET /api/applications/mine" "200, this application is reviewed"
grep -o "{\"applicationId\":\"$APP\"[^]]*]" "$BODY" | head -1; echo

step "5b. admin decides"
call PATCH "/api/admin/applications/$APP/decision" "$ADMIN" '{"decision":"accepted"}'
line "PATCH /api/admin/applications/{id}/decision accepted" "200 accepted, email queued"; show
call GET /api/applications/mine "$STUDENT"
line "GET /api/applications/mine again" "200, this application is accepted"
grep -o "{\"applicationId\":\"$APP\"[^]]*]" "$BODY" | head -1; echo

step "6. notification and audit log"
echo "waiting 20 s for notification-sender..."; sleep 20
aws logs filter-log-events --log-group-name /aws/lambda/notification-sender --filter-pattern "\"$APP\"" \
  --query 'events[].message' --output text 2>&1 | tr '\t' '\n' | tail -5
call GET "/api/admin/audit-log?action=decision" "$ADMIN"
grep -q "$APP" "$BODY" && echo "audit log has the decision for $APP" || echo "audit log has NO decision for $APP"
call GET "/api/admin/audit-log?action=claim" "$ADMIN"
grep -q "$APP" "$BODY" && echo "audit log has the claim for $APP" || echo "audit log has NO claim for $APP"
call GET "/api/admin/audit-log?action=forbidden" "$ADMIN"
grep -q "must change password" "$BODY" && echo "audit log has the reviewer's blocked call before the password change" \
  || echo "audit log has NO forbidden row for the password change"

echo; echo "E2E run finished"
