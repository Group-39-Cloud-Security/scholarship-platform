#!/usr/bin/env bash
# API tests for auth-service with curl (the T-AUT rows in docs/api-test-plan.md). Prints PASS/FAIL/SKIP per check.
# Owner: Shared (lead: Mohamed Wael). Run from the repo root after platform/shared.sh and the auth-service deploy:
#   bash services/auth-service/tests/api-tests.sh                                    # through API Gateway on Floci
#   API_URL=http://localhost:3000 bash services/auth-service/tests/api-tests.sh      # local server (still uses Floci's tables)
#   For the local run start the server with  node src/server.js  (not npm run dev: node --watch can restart mid-run).
# Save the output as evidence:
#   bash services/auth-service/tests/api-tests.sh | tee evidence/auth-api-tests-floci.txt
# Needs curl, node and the AWS CLI with the floci profile (to read and delete the test accounts it creates).
#
# LOCAL FLOCI ONLY: it creates accounts in Users and deletes them again, and reads AuditLog and CloudWatch Logs.
# Test passwords are random per run and never printed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

if [ -z "${API_URL:-}" ]; then
  source "$ROOT/platform/vars.sh" || { echo "Could not find the API (is Floci running?)"; exit 1; }
fi
case "$API_URL" in *execute-api*) GATEWAY=yes ;; *) GATEWAY=no ;; esac
AWS_PROFILE=floci aws sts get-caller-identity >/dev/null 2>&1 || { echo "Needs the AWS CLI with the floci profile."; exit 1; }
AWSF() { AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws "$@"; }

echo "auth-service API tests"
echo "Date:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Target:  $API_URL ($([ $GATEWAY = yes ] && echo 'API Gateway on Floci' || echo 'local server, node src/server.js'))"
GIT_ROOT="$(winpath "$ROOT")"
echo "Code:    $(git -C "$GIT_ROOT" rev-parse --short HEAD)$(git -C "$GIT_ROOT" diff --quiet -- services/auth-service shared-lib 2>/dev/null || echo ' + uncommitted changes in services/auth-service or shared-lib')"
echo

TMP="$(mktemp -d)"
CREATED=() # userIds this run created; deleted at the end (and by the trap if the run dies)
cleanup_users() { for u in "${CREATED[@]}"; do AWSF dynamodb delete-item --table-name Users --key "{\"userId\":{\"S\":\"$u\"}}" 2>/dev/null; done; }
EXTRA_PID=""
trap '[ -n "$EXTRA_PID" ] && kill "$EXTRA_PID" 2>/dev/null; cleanup_users; rm -rf "$TMP"' EXIT
BODY="$(winpath "$TMP/body")"
HDRS="$(winpath "$TMP/headers")"
PASS=0; FAIL=0; SKIP=0; STATUS=""

# call METHOD PATH TOKEN [BODY] [CONTENT_TYPE]
call() {
  local method=$1 path=$2 token=$3 data=${4:-} ctype=${5:-application/json}
  local args=(-s -o "$BODY" -D "$HDRS" -w '%{http_code}' -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$data" ] && args+=(-H "Content-Type: $ctype" --data "$data")
  STATUS=$(curl "${args[@]}" "$API_URL$path")
}
has() { grep -qF -- "$1" "$BODY"; }
header() { tr -d '\r' < "$HDRS" | grep -qi "^$1:${2:+ *$2}"; }
json() { node -e "const b=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));const v=b$1;process.stdout.write(v===undefined?'':String(v))" "$BODY" 2>/dev/null; }
result() { # ID DESCRIPTION ok|no
  if [ "$3" = ok ]; then PASS=$((PASS+1)); echo "PASS $1 $2 ($STATUS)"
  else FAIL=$((FAIL+1)); echo "FAIL $1 $2: got $STATUS $(head -c 300 "$BODY")"; fi
}
skip() { SKIP=$((SKIP+1)); echo "SKIP $1 $2 ($3)"; }
expect() { # ID DESCRIPTION STATUS [TEXT]: compares the last call
  [ "$STATUS" = "$3" ] && { [ -z "${4:-}" ] || has "$4"; } && result "$1" "$2" ok || result "$1" "$2" no
}

rand() { node -e "process.stdout.write(require('crypto').randomBytes(${1:-12}).toString('base64url'))"; }
new_email() { echo "t-aut-$(node -e "process.stdout.write(require('crypto').randomBytes(5).toString('hex'))")@example-university.edu"; }
# register EMAIL PASSWORD [NAME] [EXTRA_JSON_FIELDS]; remembers the new userId for cleanup
register() {
  call POST /api/auth/register "" "{\"email\":\"$1\",\"name\":\"${3:-Test Student}\",\"password\":\"$2\"${4:+,$4}}"
  if [ "$STATUS" = 201 ]; then CREATED+=("$(json .userId)"); fi
}
user_field() { # userId field → its value (S, N or BOOL) or None
  AWSF dynamodb get-item --table-name Users --key "{\"userId\":{\"S\":\"$1\"}}" \
    --query "Item.$2.[S,N,BOOL][?@ != null] | [0]" --output text | tr -d '\r'
}
R=/api/auth/register

# ---------- routing, bad requests ----------
call POST /api/auth/nope "" '{}'
if [ $GATEWAY = yes ]; then expect T-AUT-01 "unknown route stopped by API Gateway" 404 '"message":"Not Found"'
else expect T-AUT-01 "unknown route (local: Express fallback)" 404 ROUTE_NOT_FOUND; fi

call POST $R "" '{bad'
expect T-AUT-02 "bad JSON" 400 "Request body is not valid JSON."

call POST $R "" 'email=a' text/plain
expect T-AUT-03 "register without application/json" 415 UNSUPPORTED_MEDIA_TYPE

# ---------- POST /api/auth/register (step 2) ----------
EMAIL1=$(new_email); PW1=$(rand)
register "$EMAIL1" "$PW1"
U1=$(json .userId)
expect T-AUT-04 "register a student" 201 '"role":"student"'
STATUS="keys: $(node -e "process.stdout.write(Object.keys(JSON.parse(require('fs').readFileSync(process.argv[1]))).join(','))" "$BODY")"
! has "$PW1" && ! has passwordHash && ! has '"password"' && has '"mustChangePassword":false' && ok=ok || ok=no
result T-AUT-04 "reply has the account only: no password, no hash" $ok
header Cache-Control no-store && header X-Content-Type-Options nosniff && ok=ok || ok=no
STATUS="headers"; result T-AUT-05 "no-store and nosniff on auth replies" $ok

HASH=$(user_field "$U1" passwordHash)
STATUS="role $(user_field "$U1" role), status $(user_field "$U1" status), mustChangePassword $(user_field "$U1" mustChangePassword), hash ${HASH:0:7}..."
case "$HASH" in '$2b$10$'*) h=ok ;; *) h=no ;; esac
[ "$h" = ok ] && [ "$(user_field "$U1" role)" = student ] && [ "$(user_field "$U1" status)" = active ] \
  && [ "$(user_field "$U1" mustChangePassword)" = False ] && ok=ok || ok=no
result T-AUT-06 "stored: bcrypt cost 10 hash, student, active" $ok

EMAIL2=$(new_email)
register "$EMAIL2" "$(rand)" "Role Tester" '"role":"admin","status":"disabled","userId":"chosen-id"'
expect T-AUT-07 "role, status and userId in the body are ignored" 201 '"role":"student"'
has '"status":"active"' && ! has chosen-id && ok=ok || ok=no; result T-AUT-07 "still active, server-made id" $ok

call POST $R "" "{\"email\":\"  $(echo "$EMAIL1" | tr 'a-z' 'A-Z')  \",\"name\":\"Copy Cat\",\"password\":\"$(rand)\"}"
expect T-AUT-08 "same email again (other case, spaces)" 409 CONFLICT

call POST $R "" "{\"email\":\"someone@gmail.com\",\"name\":\"Outsider\",\"password\":\"$(rand)\"}"
expect T-AUT-09 "email outside ALLOWED_DOMAINS" 400 "partner universities"

call POST $R "" "{\"email\":\"not-an-email\",\"name\":\"Bad Email\",\"password\":\"$(rand)\"}"
expect T-AUT-10 "invalid email" 400 VALIDATION_ERROR

call POST $R "" "{\"email\":\"$(new_email)\",\"name\":\"Short Pw\",\"password\":\"abcdefghi\"}"
expect T-AUT-11 "password of 9 characters" 400 "at least 10"

call POST $R "" "{\"email\":\"$(new_email)\",\"name\":\"Long Pw\",\"password\":\"$(rand 60)\"}"
expect T-AUT-12 "password over 72 bytes" 400 "too long"

call POST $R "" "{\"email\":\"$(new_email)\",\"password\":\"$(rand)\"}"
expect T-AUT-13 "name missing" 400 "Name"

# A password every breach list has. 400 here proves the Pwned Passwords call worked from where the code runs
# (from inside a Floci Lambda on the gateway run). A 201 would mean the check could not reach the API (fail open).
register "$(new_email)" "1234567890" "Breached Pw"
expect T-AUT-14 "breached password refused (Pwned Passwords reached)" 400 "data breach"

AUDIT_N=$(AWSF dynamodb query --table-name AuditLog --key-condition-expression '#a = :a' \
  --filter-expression 'targetId = :t AND detail = :d' --expression-attribute-names '{"#a":"action"}' \
  --expression-attribute-values "{\":a\":{\"S\":\"user_created\"},\":t\":{\"S\":\"$U1\"},\":d\":{\"S\":\"student registered\"}}" \
  --select COUNT --query Count --output text | tr -d '\r')
STATUS="audit rows $AUDIT_N"; [ "$AUDIT_N" = 1 ] && ok=ok || ok=no
result T-AUT-15 "user_created audit row (detail 'student registered')" $ok

# Fail open: a second local server where fetch always fails (tests/no-internet.js), so Pwned can't be reached.
if [ $GATEWAY = no ]; then
  NOINET_LOG="$TMP/no-internet.log"
  ( cd "$ROOT/services/auth-service" && PORT=3098 exec node -r ./tests/no-internet.js src/server.js > "$NOINET_LOG" 2>&1 ) &
  EXTRA_PID=$!
  for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:3098/api/auth/register && break; node -e "setTimeout(()=>{},300)"; done
  SAVED_URL=$API_URL; API_URL=http://localhost:3098
  register "$(new_email)" "$(rand)" "Offline Pwned"
  API_URL=$SAVED_URL
  expect T-AUT-16 "Pwned unreachable: registration still allowed (fail open)" 201 '"role":"student"'
  grep -q '"action":"pwned_check_unavailable"' "$NOINET_LOG" && ok=ok || ok=no
  STATUS="log line"; result T-AUT-16 "and a pwned_check_unavailable warn line is logged" $ok
  kill "$EXTRA_PID" 2>/dev/null; wait "$EXTRA_PID" 2>/dev/null; EXTRA_PID=""
else
  skip T-AUT-16 "Pwned unreachable → fail open" "needs a second local server with fetch blocked; run on the local run only"
fi

# ---------- secrets never in the logs ----------
if [ $GATEWAY = yes ]; then
  node -e "setTimeout(()=>{},3000)" # let CloudWatch Logs catch up
  SINCE=$(( ($(date +%s) - 900) * 1000 ))
  AWSF logs filter-log-events --log-group-name /aws/lambda/auth-service --start-time $SINCE \
    --query 'events[].message' --output json > "$TMP/cw.log" 2>/dev/null
  EVENTS=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')||'[]').length))" "$(winpath "$TMP/cw.log")")
  STATUS="$EVENTS log events searched"
  # Must contain this run's register lines (so the search really covers it) and none of the secrets.
  grep -q 'api/auth/register' "$TMP/cw.log" && ! grep -qF -- "$PW1" "$TMP/cw.log" \
    && ! grep -q 'passwordHash\|\$2b\$\|1234567890' "$TMP/cw.log" && ok=ok || ok=no
  result T-AUT-17 "no password or hash in auth-service's CloudWatch log" $ok
else
  skip T-AUT-17 "CloudWatch log search" "the local server logs to its own console; run through the gateway"
fi

# ---------- clean up ----------
cleanup_users
LEFT=0; for u in "${CREATED[@]}"; do [ "$(user_field "$u" email)" = None ] || LEFT=$((LEFT+1)); done
STATUS="${#CREATED[@]} accounts created, $LEFT left"; CREATED=()
[ "$LEFT" = 0 ] && ok=ok || ok=no
result T-AUT-18 "test accounts deleted again" $ok

echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ]
