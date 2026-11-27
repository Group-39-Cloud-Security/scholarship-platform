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
test_attempt_keys() { # every LoginAttempts key for a t-aut- email (this run's, or left by a run that died)
  AWSF dynamodb scan --table-name LoginAttempts --filter-expression 'begins_with(emailIp, :p)' \
    --expression-attribute-values '{":p":{"S":"t-aut-"}}' --query 'Items[].emailIp.S' --output text 2>/dev/null \
    | tr -d '\r' | tr '\t' '\n' | grep -v '^None$' | grep .
}
cleanup_attempts() {
  test_attempt_keys | while read -r k; do
    AWSF dynamodb delete-item --table-name LoginAttempts --key "{\"emailIp\":{\"S\":\"$k\"}}"
  done
}
EXTRA_PID=""
trap '[ -n "$EXTRA_PID" ] && kill "$EXTRA_PID" 2>/dev/null; cleanup_users; cleanup_attempts; rm -rf "$TMP"' EXIT
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
  else FAIL=$((FAIL+1)); echo "FAIL $1 $2: got $STATUS $(sed -E 's/eyJ[A-Za-z0-9_-]*(\.[A-Za-z0-9_-]*)*/<token hidden>/g' "$BODY" | head -c 300)"; fi # never print a JWT
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

# ---------- POST /api/auth/login (step 3) ----------
L=/api/auth/login
attempt_field() { # emailIp field → value or None
  AWSF dynamodb get-item --table-name LoginAttempts --key "{\"emailIp\":{\"S\":\"$1\"}}" \
    --query "Item.$2.[S,N][?@ != null] | [0]" --output text | tr -d '\r'
}
attempt_key() { # email → the LoginAttempts key the server made for it (whatever IP it saw)
  AWSF dynamodb scan --table-name LoginAttempts --filter-expression 'begins_with(emailIp, :e)' \
    --expression-attribute-values "{\":e\":{\"S\":\"$1#\"}}" --query 'Items[0].emailIp.S' --output text | tr -d '\r'
}
set_blocked_until() { # emailIp ISO-time
  AWSF dynamodb update-item --table-name LoginAttempts --key "{\"emailIp\":{\"S\":\"$1\"}}" \
    --update-expression 'SET blockedUntil = :b' --expression-attribute-values "{\":b\":{\"S\":\"$2\"}}"
}
login() { call POST $L "" "{\"email\":\"$1\",\"password\":\"$2\"}"; }
iso_in() { node -e "process.stdout.write(new Date(Date.now()+($1)*1000).toISOString())"; } # seconds from now

login "$EMAIL1" "$PW1"
expect T-AUT-17 "login with the right password" 200 '"token":"'
TOKEN1=$(json .token)
! has passwordHash && ! has "$PW1" && [ "$(json .user.userId)" = "$U1" ] && ok=ok || ok=no
result T-AUT-17 "reply has the token and the account, no password or hash" $ok

CLAIMS=$(node -e "const [h,p]=process.argv[1].split('.').slice(0,2).map(x=>JSON.parse(Buffer.from(x,'base64url')));
  process.stdout.write([h.alg,p.sub,p.role,p.exp-p.iat,Object.keys(p).sort().join('+')].join(' '))" "$TOKEN1")
STATUS="alg sub role lifetime claims = $CLAIMS"
[ "$CLAIMS" = "HS256 $U1 student 3600 exp+iat+role+sub" ] && ok=ok || ok=no
result T-AUT-18 "JWT: HS256, sub = userId, 1 hour, nothing else inside" $ok

login "$EMAIL1" "wrong-password-$(rand 4)"
expect T-AUT-19 "wrong password" 401 "Email or password is incorrect."
cp "$BODY" "$TMP/wrong-pw.json"
login "t-aut-nobody-$(rand 4 | tr -dc a-z0-9)@example-university.edu" "$(rand)"
expect T-AUT-20 "unknown email" 401
cmp -s "$BODY" "$TMP/wrong-pw.json" && ok=ok || ok=no
STATUS="same body as T-AUT-19: $ok"; result T-AUT-20 "exactly the same reply as a wrong password" $ok

EMAIL3=$(new_email); PW3=$(rand); register "$EMAIL3" "$PW3" "Disabled Student"; U3=$(json .userId)
AWSF dynamodb update-item --table-name Users --key "{\"userId\":{\"S\":\"$U3\"}}" \
  --update-expression 'SET #s = :d' --expression-attribute-names '{"#s":"status"}' --expression-attribute-values '{":d":{"S":"disabled"}}'
login "$EMAIL3" "$PW3"
expect T-AUT-21 "disabled user with the right password" 401
cmp -s "$BODY" "$TMP/wrong-pw.json" && ok=ok || ok=no
STATUS="same body as T-AUT-19: $ok"; result T-AUT-21 "same reply, so it doesn't say the account exists" $ok

AUDIT_D=$(AWSF dynamodb query --table-name AuditLog --key-condition-expression '#a = :a' --filter-expression 'targetId = :t' \
  --expression-attribute-names '{"#a":"action"}' --expression-attribute-values "{\":a\":{\"S\":\"login_failed\"},\":t\":{\"S\":\"$EMAIL1\"}}" \
  --query 'Items[].detail.S' --output text | tr -d '\r')
STATUS="details: $AUDIT_D"
echo "$AUDIT_D" | grep -q 'failure 1 from ' && ! echo "$AUDIT_D" | grep -q 'wrong-password' && ok=ok || ok=no
result T-AUT-22 "login_failed audit row (failure count and IP, no password)" $ok
LOGIN_N=$(AWSF dynamodb query --table-name AuditLog --key-condition-expression '#a = :a' --filter-expression 'userId = :u' \
  --expression-attribute-names '{"#a":"action"}' --expression-attribute-values "{\":a\":{\"S\":\"login\"},\":u\":{\"S\":\"$U1\"}}" \
  --select COUNT --query Count --output text | tr -d '\r')
STATUS="login rows $LOGIN_N"; [ "$LOGIN_N" = 1 ] && ok=ok || ok=no
result T-AUT-22 "login audit row for the successful login" $ok

call POST $L "" "{\"email\":\"$EMAIL1\"}"
expect T-AUT-23 "login without a password" 400 VALIDATION_ERROR
call POST $L "" 'email=a' text/plain
expect T-AUT-23 "login without application/json" 415 UNSUPPORTED_MEDIA_TYPE

# Backoff (§6): 5 failures per email + IP, then blocked 1 min, doubling to 15 min. No lockout of the account.
EMAIL4=$(new_email); PW4=$(rand); register "$EMAIL4" "$PW4" "Backoff Student"; U4=$(json .userId)
CODES=""; for i in 1 2 3 4 5; do login "$EMAIL4" "wrong-$i-$(rand 4)"; CODES="$CODES$STATUS "; done
STATUS="$CODES"; [ "$CODES" = "401 401 401 401 401 " ] && ok=ok || ok=no
result T-AUT-24 "5 wrong passwords: 401 each" $ok
K4=$(attempt_key "$EMAIL4")
login "$EMAIL4" "$PW4"
expect T-AUT-24 "then even the right password is refused while blocked" 429 TOO_MANY_ATTEMPTS
RA=$(tr -d '\r' < "$HDRS" | grep -i '^retry-after:' | awk '{print $2}')
STATUS="key $K4, failures $(attempt_field "$K4" failures), Retry-After $RA"
[ "$(attempt_field "$K4" failures)" = 5 ] && [ "${RA:-0}" -gt 0 ] && [ "${RA:-0}" -le 60 ] && ok=ok || ok=no
result T-AUT-24 "LoginAttempts row: 5 failures, blocked for at most 1 minute" $ok

EXP=$(attempt_field "$K4" expiresAt); NOW=$(date +%s)
STATUS="expiresAt - now = $((EXP - NOW)) s"
[ $((EXP - NOW)) -gt 86000 ] && [ $((EXP - NOW)) -le 86400 ] && ok=ok || ok=no
result T-AUT-25 "expiresAt (the TTL attribute) is epoch seconds, about 24 h ahead" $ok

login_xff() { local args=(-s -o "$BODY" -D "$HDRS" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -H "X-Forwarded-For: $1"); STATUS=$(curl "${args[@]}" --data "{\"email\":\"$EMAIL4\",\"password\":\"$PW4\"}" "$API_URL$L"); }
login_xff 203.0.113.77
expect T-AUT-26 "a made-up X-Forwarded-For doesn't escape the block" 429 TOO_MANY_ATTEMPTS

# Same email from another IP: seed a block for <email>#198.51.100.9 and log in from here.
EMAIL5=$(new_email); PW5=$(rand); register "$EMAIL5" "$PW5" "Other IP Student"; U5=$(json .userId)
AWSF dynamodb put-item --table-name LoginAttempts --item "{\"emailIp\":{\"S\":\"$EMAIL5#198.51.100.9\"},\"failures\":{\"N\":\"9\"},\"blockedUntil\":{\"S\":\"$(iso_in 900)\"},\"expiresAt\":{\"N\":\"$(( $(date +%s) + 86400 ))\"}}"
login "$EMAIL5" "$PW5"
expect T-AUT-27 "blocked on another IP only: this IP still logs in (no account lockout)" 200 '"token":"'

# Block over (moved into the past by hand): one more failure blocks for 2 minutes (doubling).
set_blocked_until "$K4" "$(iso_in -1)"
login "$EMAIL4" "still-wrong-$(rand 4)"
expect T-AUT-28 "after the block, a 6th failure" 401
BU=$(attempt_field "$K4" blockedUntil)
SECS=$(node -e "process.stdout.write(String(Math.round((Date.parse(process.argv[1])-Date.now())/1000)))" "$BU")
STATUS="failures $(attempt_field "$K4" failures), blocked for ${SECS}s"
[ "$(attempt_field "$K4" failures)" = 6 ] && [ "$SECS" -gt 90 ] && [ "$SECS" -le 120 ] && ok=ok || ok=no
result T-AUT-28 "blocks for 2 minutes now (doubled)" $ok
set_blocked_until "$K4" "$(iso_in -1)"
login "$EMAIL4" "$PW4"
expect T-AUT-29 "after the block, the right password" 200 '"token":"'
STATUS="failures $(attempt_field "$K4" failures), blockedUntil $(attempt_field "$K4" blockedUntil)"
[ "$(attempt_field "$K4" failures)" = 0 ] && [ "$(attempt_field "$K4" blockedUntil)" = None ] && ok=ok || ok=no
result T-AUT-29 "a success resets the count and removes the block" $ok

# review-service's deploy.sh creates the metric filter login-failed on this log group: run its real pattern.
if [ $GATEWAY = yes ]; then
  node -e "setTimeout(()=>{},3000)"
  PATTERN=$(AWSF logs describe-metric-filters --log-group-name /aws/lambda/auth-service --filter-name-prefix login-failed \
    --query 'metricFilters[0].filterPattern' --output text | tr -d '\r')
  MF=$(AWSF logs filter-log-events --log-group-name /aws/lambda/auth-service --start-time $(( ($(date +%s) - 600) * 1000 )) \
    --filter-pattern "$PATTERN" --query 'length(events)' --output text | tr -d '\r')
  : > "$BODY"
  STATUS="pattern $PATTERN: $MF matching lines (this run made at least 8)"
  [ "${MF:-0}" -ge 8 ] && ok=ok || ok=no
  result T-AUT-30 "login_failed log lines match the metric filter's pattern" $ok
else
  skip T-AUT-30 "metric filter pattern on CloudWatch" "the local server logs to its own console; run through the gateway"
fi

# ---------- shared auth.js with real JWTs (step 4), on an admin-service route ----------
# Needs admin-service deployed with shared-lib 0.4.0 or later. A Users row's role and status are changed by hand
# to prove authenticate re-reads Users on every request and never trusts the role inside the token.
set_user() { # userId field value
  AWSF dynamodb update-item --table-name Users --key "{\"userId\":{\"S\":\"$1\"}}" --update-expression 'SET #f = :v' \
    --expression-attribute-names "{\"#f\":\"$2\"}" --expression-attribute-values "{\":v\":{\"S\":\"$3\"}}"
}
if [ $GATEWAY = yes ]; then
  STATS=/api/admin/stats
  for t in test-admin test-student-1 test-reviewer; do
    call GET $STATS "$t"
    expect T-AUT-31 "old Phase A token 'Bearer $t' is refused" 401 UNAUTHENTICATED
  done

  EMAIL6=$(new_email); PW6=$(rand); register "$EMAIL6" "$PW6" "Promoted Admin"; U6=$(json .userId)
  login "$EMAIL6" "$PW6"; TOKEN6=$(json .token)
  call GET $STATS "$TOKEN6"
  expect T-AUT-32 "real student token on an admin route" 403 FORBIDDEN
  set_user "$U6" role admin
  call GET $STATS "$TOKEN6"
  expect T-AUT-32 "same token after the role is changed to admin in Users (token still says student)" 200 '"scholarships"'

  set_user "$U6" status disabled
  call GET $STATS "$TOKEN6"
  expect T-AUT-33 "same token after the account is disabled" 401 UNAUTHENTICATED
  set_user "$U6" status active

  TAMPERED="${TOKEN6%?}$( [ "${TOKEN6: -1}" = A ] && echo B || echo A )"
  call GET $STATS "$TAMPERED"
  expect T-AUT-34 "token with its signature changed" 401 UNAUTHENTICATED
  FORGED=$(node -e "const h=Buffer.from('{\"alg\":\"none\",\"typ\":\"JWT\"}').toString('base64url');
    const p=Buffer.from(JSON.stringify({sub:process.argv[1],role:'admin'})).toString('base64url');process.stdout.write(h+'.'+p+'.')" "$U6")
  call GET $STATS "${FORGED}x"
  expect T-AUT-34 "unsigned token (alg none) for a real admin id" 401 UNAUTHENTICATED

  # A reviewer with a temporary password (mustChangePassword) may only use GET /me and PUT /password.
  AWSF dynamodb update-item --table-name Users --key "{\"userId\":{\"S\":\"$U6\"}}" --update-expression 'SET mustChangePassword = :t' \
    --expression-attribute-values '{":t":{"BOOL":true}}'
  call GET $STATS "$TOKEN6"
  expect T-AUT-35 "mustChangePassword: an admin route is refused until the password is changed" 403 "Change your temporary password first."
  AWSF dynamodb update-item --table-name Users --key "{\"userId\":{\"S\":\"$U6\"}}" --update-expression 'SET mustChangePassword = :f' \
    --expression-attribute-values '{":f":{"BOOL":false}}'
else
  skip T-AUT-31 "shared auth.js on admin routes (31-35)" "admin routes only exist through the gateway"
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
  result T-AUT-36 "no password or hash in auth-service's CloudWatch log" $ok
else
  skip T-AUT-36 "CloudWatch log search" "the local server logs to its own console; run through the gateway"
fi

# ---------- clean up ----------
cleanup_users; cleanup_attempts
LEFT=0; for u in "${CREATED[@]}"; do [ "$(user_field "$u" email)" = None ] || LEFT=$((LEFT+1)); done
ATT_LEFT=$(test_attempt_keys | grep -c .)
STATUS="${#CREATED[@]} accounts created, $LEFT left; test LoginAttempts rows left $ATT_LEFT"; CREATED=()
[ "$LEFT" = 0 ] && [ "$ATT_LEFT" = 0 ] && ok=ok || ok=no
result T-AUT-37 "test accounts and their LoginAttempts rows deleted again" $ok

echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ]
