#!/usr/bin/env bash
# API tests for admin-service with curl (the T-ADM rows in docs/api-test-plan.md). Prints PASS/FAIL/SKIP per check.
# Owner: Mohamed Wael. Run from the repo root after platform/shared.sh and the admin-service deploy:
#   bash services/admin-service/tests/api-tests.sh                                   # through API Gateway on Floci
#   API_URL=http://localhost:3000 bash services/admin-service/tests/api-tests.sh     # local server (still uses Floci's tables)
#   For the local run start the server with  node src/server.js  (not npm run dev: node --watch can restart mid-run).
# Save the output as evidence:
#   bash services/admin-service/tests/api-tests.sh | tee evidence/admin-api-tests-floci.txt
# Needs curl and node; the table and AuditLog checks (T-ADM-09, T-ADM-18) also need the AWS CLI with the floci profile.
# Creates a few draft scholarships each run (harmless test data; platform/reset.sh clears them).
#
# LOCAL FLOCI ONLY. Never point this at a shared or real environment: to check what it asserts, it
#   - reads and DELETES every message waiting in the notifications queue (and its own messages in notifications-dlq),
#   - turns notification-sender's SQS trigger off and on, and briefly changes that Lambda's settings,
#   - writes and deletes rows straight in Applications, Reviews and Users, and sets some users' status by hand.
# Anything another person or service had queued at that moment would be lost.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

if [ -z "${API_URL:-}" ]; then
  source "$ROOT/platform/vars.sh" || { echo "Could not find the API (is Floci running?)"; exit 1; }
fi
case "$API_URL" in *execute-api*) GATEWAY=yes ;; *) GATEWAY=no ;; esac
HAVE_AWS=no
command -v aws >/dev/null && AWS_PROFILE=floci aws sts get-caller-identity >/dev/null 2>&1 && HAVE_AWS=yes

echo "admin-service API tests"
echo "Date:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Target:  $API_URL ($([ $GATEWAY = yes ] && echo 'API Gateway on Floci' || echo 'local server, node src/server.js'))"
GIT_ROOT="$(winpath "$ROOT")" # vars.sh sets MSYS_NO_PATHCONV, so git.exe needs a C:/... path
echo "Code:    $(git -C "$GIT_ROOT" rev-parse --short HEAD)$(git -C "$GIT_ROOT" diff --quiet -- services/admin-service 2>/dev/null || echo ' + uncommitted changes in services/admin-service')"
echo

TMP="$(mktemp -d)"
SENDER_ENV_SWAPPED=no # set by the notification-sender tests; the trap puts the Lambda's settings back if the run dies
restore_sender_env() { :; }
# The SQS trigger hands every queued message to notification-sender at once. The decision tests read the queue
# themselves, so the trigger is off while they run and back on for the sender tests (and on exit, whatever happens).
TRIGGER_OFF=no
set_trigger() { # enabled | disabled
  local id
  id=$(AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws lambda list-event-source-mappings --function-name notification-sender \
    --query 'EventSourceMappings[0].UUID' --output text 2>/dev/null | tr -d '\r')
  [ -n "$id" ] && [ "$id" != None ] || return 0
  if [ "$1" = disabled ]; then
    AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws lambda update-event-source-mapping --uuid "$id" --no-enabled >/dev/null && TRIGGER_OFF=yes
    node -e "setTimeout(()=>{},5000)" # let a receive that was already running finish
  else
    AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws lambda update-event-source-mapping --uuid "$id" --enabled >/dev/null && TRIGGER_OFF=no
  fi
}
trap 'restore_sender_env; [ "$TRIGGER_OFF" = yes ] && set_trigger enabled; rm -rf "$TMP"' EXIT
BODY="$(winpath "$TMP/body")"
HDRS="$(winpath "$TMP/headers")"
PASS=0; FAIL=0; SKIP=0; STATUS=""

# call METHOD PATH TOKEN [BODY] [CONTENT_TYPE] [EXTRA_HEADER...]
call() {
  local method=$1 path=$2 token=$3 data=${4:-} ctype=${5:-application/json}
  shift 5 2>/dev/null || shift $#
  local args=(-s -o "$BODY" -D "$HDRS" -w '%{http_code}' -X "$method")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  [ -n "$data" ] && args+=(-H "Content-Type: $ctype" --data "$data")
  for h in "$@"; do args+=(-H "$h"); done
  STATUS=$(curl "${args[@]}" "$API_URL$path")
}
has() { grep -qF -- "$1" "$BODY"; }
header() { tr -d '\r' < "$HDRS" | grep -qi "^$1:${2:+ *$2}"; }
result() { # ID DESCRIPTION ok|no
  if [ "$3" = ok ]; then PASS=$((PASS+1)); echo "PASS $1 $2 ($STATUS)"
  else FAIL=$((FAIL+1)); echo "FAIL $1 $2: got $STATUS $(head -c 300 "$BODY")"; fi
}
skip() { SKIP=$((SKIP+1)); echo "SKIP $1 $2 ($3)"; }
expect() { # ID DESCRIPTION STATUS [TEXT]: compares the last call
  [ "$STATUS" = "$3" ] && { [ -z "${4:-}" ] || has "$4"; } && result "$1" "$2" ok || result "$1" "$2" no
}

# Counts used by T-ADM-09 and T-ADM-18 (Floci's tables, through the AWS CLI)
count_scholarships() { AWS_PROFILE=floci aws dynamodb scan --table-name Scholarships --select COUNT --query Count --output text | tr -d '\r'; }
count_forbidden() {
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb query --table-name AuditLog \
    --key-condition-expression '#a = :a' --filter-expression 'targetId = :t' \
    --expression-attribute-names '{"#a":"action"}' \
    --expression-attribute-values '{":a":{"S":"forbidden"},":t":{"S":"/api/admin/scholarships"}}' \
    --select COUNT --query Count --output text | tr -d '\r'
}

# A valid scholarship, plus a helper that changes one thing in it (node, so the JSON stays valid)
VALID='{"title":"Cloud Excellence Award","description":"For students building on the cloud.","deadline":"2027-01-15T23:59:00Z","awards":2,
 "rubric":[{"criterionId":"academic","name":"Academic record","description":"Grades and transcript","weight":40},
           {"criterionId":"essay","name":"Essay","description":"Clarity and motivation","weight":40},
           {"criterionId":"need","name":"Financial need","description":"Evidence of need","weight":20}],
 "eligibility":{"allowedDomains":["Example-University.edu"],"minGpa":3,"years":[3,2,2]}}'
with() { node -e "const b=JSON.parse(process.argv[1]);(${1})(b);process.stdout.write(JSON.stringify(b))" "$VALID"; }
S=/api/admin/scholarships

# ---------- health, routing, CORS, headers ----------
call GET /api/health ""
expect T-ADM-01 "health, no token" 200 '"status":"ok"'
if [ $GATEWAY = yes ]; then has '"runtime":"lambda"' && ok=ok || ok=no; else has '"runtime":"local"' && ok=ok || ok=no; fi
result T-ADM-01 "health reports the right runtime" $ok

call GET /api/admin/nope ""
if [ $GATEWAY = yes ]; then expect T-ADM-02 "unknown route stopped by API Gateway" 404 '"message":"Not Found"'
else expect T-ADM-02 "unknown route (local: Express fallback)" 404 ROUTE_NOT_FOUND; fi

call POST $S test-admin '{bad'
expect T-ADM-03 "bad JSON" 400 "Request body is not valid JSON."

call GET /api/health "" "" application/json "Origin: http://localhost:4566"
header access-control-allow-origin "http://localhost:4566" && ok=ok || ok=no
result T-ADM-04 "CORS allows our site" $ok

call GET /api/health "" "" application/json "Origin: http://evil.example"
header access-control-allow-origin && ok=no || ok=ok
result T-ADM-05 "CORS gives nothing to another site" $ok

call OPTIONS $S "" "" application/json "Origin: http://localhost:4566" \
  "Access-Control-Request-Method: POST" "Access-Control-Request-Headers: authorization,content-type"
[ "$STATUS" = 204 ] && header access-control-allow-methods && ok=ok || ok=no
result T-ADM-06 "preflight on /api/admin/scholarships" $ok

call GET /api/health ""
header x-content-type-options nosniff && header x-frame-options DENY \
  && header content-security-policy "default-src 'none'" && header cache-control no-store \
  && ! header x-powered-by && ok=ok || ok=no
result T-ADM-07 "security headers (nosniff, DENY, CSP, no-store, no X-Powered-By)" $ok

# ---------- POST /api/admin/scholarships: who may call it ----------
[ $HAVE_AWS = yes ] && FORBIDDEN_BEFORE=$(count_forbidden)

call POST $S "" "$VALID"
expect T-ADM-08 "no token" 401 UNAUTHENTICATED

call POST $S test-student-1 "$VALID"
expect T-ADM-09 "student token" 403 FORBIDDEN
call POST $S test-reviewer "$VALID"
expect T-ADM-09 "reviewer token" 403 FORBIDDEN
if [ $HAVE_AWS = yes ]; then
  STATUS="AuditLog $FORBIDDEN_BEFORE -> $(count_forbidden)"
  [ "$(count_forbidden)" -eq $((FORBIDDEN_BEFORE + 2)) ] && ok=ok || ok=no
  result T-ADM-09 "both 403s written to AuditLog as forbidden with the full path" $ok
else skip T-ADM-09 "forbidden rows in AuditLog" "no AWS CLI"; fi

call POST $S test-admin "$VALID" text/plain
expect T-ADM-10 "Content-Type text/plain" 415 UNSUPPORTED_MEDIA_TYPE

# ---------- validation (each must be 400 and write nothing) ----------
[ $HAVE_AWS = yes ] && COUNT_BEFORE=$(count_scholarships)

call POST $S test-admin "$(with 'b=>b.rubric[2].weight=10')"
expect T-ADM-11 "rubric weights sum to 90" 400 "Rubric weights must sum to 100 (they sum to 90)."
call POST $S test-admin "$(with 'b=>b.rubric[0].weight=4.5')"
expect T-ADM-12 "rubric weight 4.5" 400 "whole number"
call POST $S test-admin "$(with 'b=>b.rubric[0].weight="40"')"
expect T-ADM-12 "rubric weight \"40\" as text" 400 "whole number"
call POST $S test-admin "$(with 'b=>{b.rubric=[{...b.rubric[0],weight:100}]}')"
expect T-ADM-13 "rubric with 1 criterion" 400 "between 2 and 6"
call POST $S test-admin "$(with 'b=>{b.rubric=Array.from({length:7},(_,i)=>({criterionId:"c"+i,name:"Name"+i,description:"Desc",weight:i<6?14:16}))}')"
expect T-ADM-13 "rubric with 7 criteria" 400 "between 2 and 6"
call POST $S test-admin "$(with 'b=>b.rubric[1].criterionId="academic"')"
expect T-ADM-14 "criterionId used twice" 400 "used twice"
call POST $S test-admin "$(with 'b=>b.rubric[0].criterionId="Has Space"')"
expect T-ADM-14 "criterionId with a space" 400 "criterionId must be"
call POST $S test-admin "$(with 'b=>b.eligibility.allowedDomains=["bue.edu.eg"]')"
expect T-ADM-15 "domain that is not a partner university" 400 "not a partner university"
call POST $S test-admin "$(with 'b=>b.eligibility.minGpa=5')"
expect T-ADM-16 "minGpa 5" 400 "Minimum GPA must be between 0 and 4"
call POST $S test-admin "$(with 'b=>b.eligibility.minGpa="3"')"
expect T-ADM-16 "minGpa \"3\" as text" 400 "must be a number"
call POST $S test-admin "$(with 'b=>b.eligibility.years=[7]')"
expect T-ADM-16 "year of study 7" 400 "Year of study"
call POST $S test-admin "$(with 'b=>b.deadline="next friday"')"
expect T-ADM-16 "deadline \"next friday\"" 400 "ISO 8601"
call POST $S test-admin "$(with 'b=>b.awards=0')"
expect T-ADM-16 "awards 0" 400 "Awards"
call POST $S test-admin "$(with 'b=>delete b.title')"
expect T-ADM-16 "no title" 400 "Title"
call POST $S test-admin '[]'
expect T-ADM-16 "body is an array" 400 "JSON object"
call POST $S test-admin "$(with 'b=>b.deadline="2027-01-15"')"
expect T-ADM-20 "deadline without time and zone" 400 "ISO 8601"
call POST $S test-admin "$(with 'b=>b.deadline="2027-02-30T10:00:00Z"')"
expect T-ADM-21 "deadline 30 February" 400 "ISO 8601"
call POST $S test-admin "$(with 'b=>b.deadline="2027-04-31T10:00:00Z"')"
expect T-ADM-21 "deadline 31 April" 400 "ISO 8601"
call POST $S test-admin "$(with 'b=>b.deadline="2027-01-15T23:59:00+14:30"')"
expect T-ADM-23 "zone offset +14:30 (above the 14:00 maximum)" 400 "ISO 8601"
call POST $S test-admin "$(with 'b=>b.deadline="2027-01-15T23:59:00-00:00"')"
expect T-ADM-23 "zone offset -00:00 (unknown local offset)" 400 "ISO 8601"
call POST $S test-admin "$(with 'b=>b.deadline="2027-02-29T12:00:00Z"')"
expect T-ADM-24 "29 February in 2027 (not a leap year)" 400 "ISO 8601"

if [ $HAVE_AWS = yes ]; then
  STATUS="Scholarships $COUNT_BEFORE -> $(count_scholarships)"
  [ "$(count_scholarships)" = "$COUNT_BEFORE" ] && ok=ok || ok=no
  result T-ADM-18 "no item written by any of the 400s above" $ok
else skip T-ADM-18 "no item written on 400" "no AWS CLI"; fi

# ---------- valid creates ----------
call POST $S test-admin "$(with 'b=>Object.assign(b,{status:"published",acceptedCount:99,createdBy:"hacker",scholarshipId:"chosen-by-client"})')"
expect T-ADM-17 "valid draft" 201 '"status":"draft"'
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const bad = [];
if (s.status !== "draft") bad.push("status");
if (s.acceptedCount !== 0) bad.push("acceptedCount");
if (s.createdBy !== "test-admin") bad.push("createdBy");
if (!/^[0-9a-f-]{36}$/.test(s.scholarshipId || "")) bad.push("scholarshipId");
if (s.deadline !== "2027-01-15T23:59:00.000Z") bad.push("deadline");
if (JSON.stringify(s.eligibility) !== JSON.stringify({allowedDomains:["example-university.edu"],minGpa:3,years:[2,3]})) bad.push("eligibility");
process.exit(bad.length ? 1 : 0);' "$BODY" && ok=ok || ok=no
result T-ADM-17 "body values for status, acceptedCount, createdBy, id ignored; deadline UTC; eligibility cleaned" $ok

call POST $S test-admin "$(with 'b=>b.deadline="2020-01-01T00:00:00Z"')"
expect T-ADM-22 "draft with a past deadline is allowed (future only checked at publish)" 201 '"deadline":"2020-01-01T00:00:00.000Z"'

call POST $S test-admin "$(with 'b=>b.deadline="2027-01-16T01:59:00+02:00"')"
expect T-ADM-22 "deadline with +02:00 stored in UTC" 201 '"deadline":"2027-01-15T23:59:00.000Z"'

call POST $S test-admin "$(with 'b=>b.deadline="2027-01-15T23:59:00+14:00"')"
expect T-ADM-23 "zone offset +14:00 (the maximum) accepted, stored in UTC" 201 '"deadline":"2027-01-15T09:59:00.000Z"'

call POST $S test-admin "$(with 'b=>b.deadline="2028-02-29T12:00:00Z"')"
expect T-ADM-24 "29 February 2028 (a leap year) accepted" 201 '"deadline":"2028-02-29T12:00:00.000Z"'

# ---------- routes that are not listed ----------
if [ $GATEWAY = yes ]; then
  call GET $S test-admin
  expect T-ADM-19 "GET /api/admin/scholarships is not a route yet: stopped by API Gateway" 404 '"message":"Not Found"'
else skip T-ADM-19 "route not listed in API Gateway" "only through API Gateway"; fi

# ---------- PUT /api/admin/scholarships/{id} and PATCH .../status (step 4) ----------
# new_draft [JS change]: creates a draft (optionally changed) and prints its id
new_draft() {
  call POST $S test-admin "$(with "${1:-b=>b}")"
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).scholarshipId||"")' "$BODY"
}
field() { # $1 id, $2 attribute: prints the stored value (S or N) straight from DynamoDB
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb get-item --table-name Scholarships \
    --key "{\"scholarshipId\":{\"S\":\"$1\"}}" --query "Item.$2.S || Item.$2.N" --output text | tr -d '\r'
}
count_action() { # $1 action: number of AuditLog rows for it
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb query --table-name AuditLog \
    --key-condition-expression '#a = :a' --expression-attribute-names '{"#a":"action"}' \
    --expression-attribute-values "{\":a\":{\"S\":\"$1\"}}" --select COUNT --query Count --output text | tr -d '\r'
}
PUB='{"status":"published"}'
CLOSE='{"status":"closed"}'
UNKNOWN=00000000-0000-4000-8000-000000000000

D=$(new_draft)
call PUT $S/$D "" "$VALID"
expect T-ADM-25 "PUT, no token" 401 UNAUTHENTICATED
call PUT $S/$D test-student-1 "$VALID"
expect T-ADM-25 "PUT, student token" 403 FORBIDDEN
call PATCH $S/$D/status "" "$PUB"
expect T-ADM-25 "PATCH status, no token" 401 UNAUTHENTICATED
call PATCH $S/$D/status test-reviewer "$PUB"
expect T-ADM-25 "PATCH status, reviewer token" 403 FORBIDDEN

call PUT $S/not-a-uuid test-admin "$VALID"
expect T-ADM-26 "PUT with an id that is not a UUID" 400 "Scholarship id"
call PUT $S/$UNKNOWN test-admin "$VALID"
expect T-ADM-26 "PUT unknown id" 404 SCHOLARSHIP_NOT_FOUND
call PATCH $S/$UNKNOWN/status test-admin "$PUB"
expect T-ADM-26 "PATCH status unknown id" 404 SCHOLARSHIP_NOT_FOUND

call PUT $S/$D test-admin "$VALID" text/plain
expect T-ADM-27 "PUT with Content-Type text/plain" 415 UNSUPPORTED_MEDIA_TYPE
call PATCH $S/$D/status test-admin "$PUB" text/plain
expect T-ADM-27 "PATCH status with Content-Type text/plain" 415 UNSUPPORTED_MEDIA_TYPE

call PUT $S/$D test-admin "$(with 'b=>{b.title="Changed title";b.rubric[2].weight=10}')"
expect T-ADM-28 "PUT with weights summing to 90" 400 "sum to 100"
if [ $HAVE_AWS = yes ]; then
  STATUS="stored title: $(field "$D" title)"
  [ "$(field "$D" title)" = "Cloud Excellence Award" ] && ok=ok || ok=no
  result T-ADM-28 "invalid PUT changed nothing" $ok
else skip T-ADM-28 "invalid PUT changed nothing" "no AWS CLI"; fi

[ $HAVE_AWS = yes ] && UPDATED_BEFORE=$(count_action scholarship_updated)
call PUT $S/$D test-admin "$(with 'b=>Object.assign(b,{title:"Cloud Award 2027",awards:3,status:"published",acceptedCount:5,createdBy:"hacker"})')"
expect T-ADM-29 "PUT valid on a draft" 200 '"title":"Cloud Award 2027"'
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.exit(s.status === "draft" && s.acceptedCount === 0 && s.createdBy === "test-admin" && s.awards === 3 ? 0 : 1);' "$BODY" && ok=ok || ok=no
result T-ADM-29 "PUT replaced the fields, ignored status/acceptedCount/createdBy from the body" $ok
if [ $HAVE_AWS = yes ]; then
  STATUS="AuditLog scholarship_updated $UPDATED_BEFORE -> $(count_action scholarship_updated)"
  [ "$(count_action scholarship_updated)" -eq $((UPDATED_BEFORE + 1)) ] && ok=ok || ok=no
  result T-ADM-29 "exactly one scholarship_updated row added" $ok
else skip T-ADM-29 "scholarship_updated row in AuditLog" "no AWS CLI"; fi

for bad in '{"status":"draft"}' '{"status":"open"}' '{}'; do
  call PATCH $S/$D/status test-admin "$bad"
  expect T-ADM-30 "PATCH status $bad" 400 "Status must be one of"
done

call PATCH $S/$D/status test-admin "$CLOSE"
expect T-ADM-31 "close a draft" 409 "Only a published scholarship can be closed"

P=$(new_draft 'b=>b.deadline="2020-01-01T00:00:00Z"')
call PATCH $S/$P/status test-admin "$PUB"
expect T-ADM-32 "publish a draft whose deadline has passed" 409 "deadline has passed"
if [ $HAVE_AWS = yes ]; then
  STATUS="stored status: $(field "$P" status)"
  [ "$(field "$P" status)" = draft ] && ok=ok || ok=no
  result T-ADM-32 "still a draft after the refused publish" $ok
else skip T-ADM-32 "still a draft" "no AWS CLI"; fi

[ $HAVE_AWS = yes ] && PUBLISHED_BEFORE=$(count_action scholarship_published)
call PATCH $S/$D/status test-admin "$PUB"
expect T-ADM-33 "publish a valid draft" 200 '"status":"published"'
if [ $HAVE_AWS = yes ]; then
  STATUS="AuditLog scholarship_published $PUBLISHED_BEFORE -> $(count_action scholarship_published)"
  [ "$(count_action scholarship_published)" -eq $((PUBLISHED_BEFORE + 1)) ] && ok=ok || ok=no
  result T-ADM-33 "publish written to AuditLog" $ok
else skip T-ADM-33 "publish written to AuditLog" "no AWS CLI"; fi

call PATCH $S/$D/status test-admin "$PUB"
expect T-ADM-34 "publish again" 409 "Only a draft can be published (this scholarship is published)"

call PUT $S/$D test-admin "$(with 'b=>b.title="Edited after publish"')"
expect T-ADM-35 "PUT on a published scholarship" 409 "locked after publishing"
if [ $HAVE_AWS = yes ]; then
  STATUS="stored title: $(field "$D" title)"
  [ "$(field "$D" title)" = "Cloud Award 2027" ] && ok=ok || ok=no
  result T-ADM-35 "published scholarship unchanged" $ok
else skip T-ADM-35 "published scholarship unchanged" "no AWS CLI"; fi

[ $HAVE_AWS = yes ] && CLOSED_BEFORE=$(count_action scholarship_closed)
call PATCH $S/$D/status test-admin "$CLOSE"
expect T-ADM-36 "close a published scholarship" 200 '"status":"closed"'
if [ $HAVE_AWS = yes ]; then
  STATUS="AuditLog scholarship_closed $CLOSED_BEFORE -> $(count_action scholarship_closed)"
  [ "$(count_action scholarship_closed)" -eq $((CLOSED_BEFORE + 1)) ] && ok=ok || ok=no
  result T-ADM-36 "exactly one scholarship_closed row added" $ok
else skip T-ADM-36 "scholarship_closed row in AuditLog" "no AWS CLI"; fi
call PATCH $S/$D/status test-admin "$CLOSE"
expect T-ADM-36 "close it again" 409 "Only a published scholarship can be closed"
call PATCH $S/$D/status test-admin "$PUB"
expect T-ADM-36 "publish a closed scholarship" 409 "Only a draft can be published (this scholarship is closed)"
call PUT $S/$D test-admin "$VALID"
expect T-ADM-36 "PUT on a closed scholarship" 409 "locked after publishing"

# Five publishes of the same draft at the same time: the conditional write lets exactly one win.
# One output file per request: parallel appends to a single file can lose lines on Windows (Git Bash).
R=$(new_draft)
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H 'Authorization: Bearer test-admin' \
    -H 'Content-Type: application/json' --data "$PUB" "$API_URL$S/$R/status" > "$TMP/race-$i" &
done
wait
CODES="$(cat "$TMP"/race-* | tr -d '\r')"
WON=$(printf '%s\n' "$CODES" | grep -c '^200$'); LOST=$(printf '%s\n' "$CODES" | grep -c '^409$')
STATUS="200 x$WON, 409 x$LOST"
[ "$WON" = 1 ] && [ "$LOST" = 4 ] && ok=ok || ok=no
result T-ADM-37 "5 parallel publishes: exactly one 200, four 409" $ok

# Corrupt or legacy records written straight into DynamoDB (not through the API, which would refuse them):
# publish must still say 409 and change nothing. Both are deleted again at the end.
put_raw_draft() { # $1 id, $2 awards, $3 third weight: a draft with a future deadline, maybe broken
  local item
  item=$(node -e '
const [id, awards, w3] = process.argv.slice(1);
const c = (cid, name, w) => ({ M: { criterionId: { S: cid }, name: { S: name }, description: { S: "Legacy" }, weight: { N: w } } });
process.stdout.write(JSON.stringify({
  scholarshipId: { S: id }, title: { S: "Legacy record (test)" }, description: { S: "Written straight into DynamoDB." },
  deadline: { S: "2027-01-15T23:59:00.000Z" }, awards: { N: awards }, acceptedCount: { N: "0" }, status: { S: "draft" },
  rubric: { L: [c("academic", "Academic", "40"), c("essay", "Essay", "40"), c("need", "Need", w3)] },
  eligibility: { M: { allowedDomains: { L: [{ S: "example-university.edu" }] }, minGpa: { N: "3" }, years: { L: [{ N: "2" }] } } },
  createdBy: { S: "legacy-import" }, createdAt: { S: "2026-01-01T00:00:00.000Z" } }));' "$1" "$2" "$3")
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb put-item --table-name Scholarships --item "$item"
}
delete_raw() { AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb delete-item --table-name Scholarships --key "{\"scholarshipId\":{\"S\":\"$1\"}}"; }

if [ $HAVE_AWS = yes ]; then
  BAD_AWARDS=$(node -e 'process.stdout.write(require("crypto").randomUUID())')
  BAD_RUBRIC=$(node -e 'process.stdout.write(require("crypto").randomUUID())')
  put_raw_draft "$BAD_AWARDS" 0 20     # awards 0, rubric fine
  put_raw_draft "$BAD_RUBRIC" 2 10     # awards fine, weights 40 + 40 + 10 = 90
  PUBLISHED_BEFORE=$(count_action scholarship_published)

  call PATCH $S/$BAD_AWARDS/status test-admin "$PUB"
  expect T-ADM-38 "publish a stored draft with awards 0" 409 "Awards must be at least 1"
  call PATCH $S/$BAD_RUBRIC/status test-admin "$PUB"
  expect T-ADM-38 "publish a stored draft whose weights sum to 90" 409 "rubric is not valid"

  STATUS="status $(field "$BAD_AWARDS" status) / $(field "$BAD_RUBRIC" status), scholarship_published $PUBLISHED_BEFORE -> $(count_action scholarship_published)"
  [ "$(field "$BAD_AWARDS" status)" = draft ] && [ "$(field "$BAD_RUBRIC" status)" = draft ] \
    && [ "$(count_action scholarship_published)" = "$PUBLISHED_BEFORE" ] && ok=ok || ok=no
  result T-ADM-38 "both still drafts, no publish written to AuditLog" $ok

  delete_raw "$BAD_AWARDS"; delete_raw "$BAD_RUBRIC"
  STATUS="after cleanup: '$(field "$BAD_AWARDS" status)' '$(field "$BAD_RUBRIC" status)'"
  [ "$(field "$BAD_AWARDS" status)" = None ] && [ "$(field "$BAD_RUBRIC" status)" = None ] && ok=ok || ok=no
  result T-ADM-38 "test records deleted again" $ok
else skip T-ADM-38 "publish a corrupt stored record" "no AWS CLI"; fi

# ---------- PATCH /api/admin/applications/{id}/decision (step 5) ----------
# Applications and Reviews rows are written straight into DynamoDB (application-service and review-service make
# them in real use) and deleted again at the end. Queue messages the tests read are deleted after reading.
DEC=/api/admin/applications
uuid() { node -e 'process.stdout.write(require("crypto").randomUUID())'; }
published_scholarship() { # $1 awards: creates and publishes a scholarship, prints its id
  local id; id=$(new_draft "b=>b.awards=$1")
  call PATCH $S/$id/status test-admin "$PUB"
  echo "$id"
}
SEEDED_APPS=(); SEEDED_REVIEWS=()
seed_app() { # $1 id, $2 scholarshipId, $3 status, $4 flagged (true|false)
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb put-item --table-name Applications --item \
    "{\"applicationId\":{\"S\":\"$1\"},\"studentId\":{\"S\":\"test-student-1\"},\"studentEmail\":{\"S\":\"student1@example-university.edu\"},\"scholarshipId\":{\"S\":\"$2\"},\"status\":{\"S\":\"$3\"},\"flagged\":{\"BOOL\":$4},\"essay\":{\"S\":\"Essay text that must never reach the queue.\"},\"submittedAt\":{\"S\":\"2026-11-20T10:00:00.000Z\"}}"
  SEEDED_APPS+=("$1")
}
seed_flag_review() { # $1 applicationId, $2 flagReason
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb put-item --table-name Reviews --item \
    "{\"applicationId\":{\"S\":\"$1\"},\"reviewerId\":{\"S\":\"test-reviewer\"},\"flagged\":{\"BOOL\":true},\"flagReason\":{\"S\":\"$2\"},\"flagNote\":{\"S\":\"private note\"},\"submittedAt\":{\"S\":\"2026-11-21T10:00:00.000Z\"}}"
  SEEDED_REVIEWS+=("$1")
}
app_field() { # $1 applicationId, $2 attribute
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb get-item --table-name Applications \
    --key "{\"applicationId\":{\"S\":\"$1\"}}" --query "Item.$2.S || Item.$2.N" --output text | tr -d '\r'
}
QURL=""; [ $HAVE_AWS = yes ] && QURL=$(AWS_PROFILE=floci aws sqs get-queue-url --queue-name notifications --query QueueUrl --output text 2>/dev/null | tr -d '\r')
take_messages() { # reads every waiting message into $TMP/messages (one JSON body per line), deleting each one
  : > "$TMP/messages"
  local out
  for _ in 1 2 3 4 5; do
    out=$(AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws sqs receive-message --queue-url "$QURL" --max-number-of-messages 10 \
      --wait-time-seconds 1 --output json | tr -d '\r')
    [ -z "$out" ] && break
    node -e 'for (const m of JSON.parse(process.argv[1]).Messages || []) console.log(m.Body + "\t" + m.ReceiptHandle)' "$out" > "$TMP/batch"
    [ -s "$TMP/batch" ] || break
    while IFS=$'\t' read -r body handle; do
      printf '%s\n' "$body" >> "$TMP/messages"
      AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws sqs delete-message --queue-url "$QURL" --receipt-handle "$handle"
    done < "$TMP/batch"
  done
}
message_for() { grep -F "\"applicationId\":\"$1\"" "$TMP/messages" | head -1; }

if [ $HAVE_AWS = yes ]; then
  set_trigger disabled # these tests read the queued messages themselves (see set_trigger)
  take_messages # start with an empty queue
  SCH=$(published_scholarship 2)
  A_OK=$(uuid); A_FLAG=$(uuid); A_SUB=$(uuid); A_UNDER=$(uuid)
  seed_app "$A_OK" "$SCH" reviewed false
  seed_app "$A_FLAG" "$SCH" reviewed true; seed_flag_review "$A_FLAG" ineligible
  seed_app "$A_SUB" "$SCH" submitted false
  seed_app "$A_UNDER" "$SCH" under_review false
  ACC='{"decision":"accepted"}'; REJ='{"decision":"rejected"}'

  call PATCH $DEC/$A_OK/decision "" "$ACC"
  expect T-ADM-39 "decision, no token" 401 UNAUTHENTICATED
  call PATCH $DEC/$A_OK/decision test-student-1 "$ACC"
  expect T-ADM-39 "decision, student token" 403 FORBIDDEN
  call PATCH $DEC/$A_OK/decision test-reviewer "$ACC"
  expect T-ADM-39 "decision, reviewer token" 403 FORBIDDEN

  call PATCH $DEC/not-a-uuid/decision test-admin "$ACC"
  expect T-ADM-40 "id that is not a UUID" 400 "Application id"
  call PATCH $DEC/$UNKNOWN/decision test-admin "$ACC"
  expect T-ADM-40 "unknown application" 404 APPLICATION_NOT_FOUND
  call PATCH $DEC/$A_OK/decision test-admin "$ACC" text/plain
  expect T-ADM-40 "Content-Type text/plain" 415 UNSUPPORTED_MEDIA_TYPE
  for bad in '{"decision":"maybe"}' '{"decision":"reviewed"}' '{}'; do
    call PATCH $DEC/$A_OK/decision test-admin "$bad"
    expect T-ADM-40 "decision $bad" 400 "Decision must be one of"
  done

  call PATCH $DEC/$A_SUB/decision test-admin "$REJ"
  expect T-ADM-41 "decide a submitted application" 409 "Only a reviewed application can be decided"
  call PATCH $DEC/$A_UNDER/decision test-admin "$ACC"
  expect T-ADM-41 "decide an application under review" 409 "Only a reviewed application can be decided"

  call PATCH $DEC/$A_FLAG/decision test-admin "$ACC"
  expect T-ADM-42 "accept a flagged application" 409 "A flagged application can only be rejected"
  STATUS="acceptedCount $(field "$SCH" acceptedCount), status $(app_field "$A_FLAG" status)"
  [ "$(field "$SCH" acceptedCount)" = 0 ] && [ "$(app_field "$A_FLAG" status)" = reviewed ] && ok=ok || ok=no
  result T-ADM-42 "refused accept took no award and changed nothing" $ok

  DECISIONS_BEFORE=$(count_action decision)
  call PATCH $DEC/$A_FLAG/decision test-admin "$REJ"
  expect T-ADM-43 "reject a flagged application" 200 '"status":"rejected"'
  call PATCH $DEC/$A_OK/decision test-admin "$ACC"
  expect T-ADM-44 "accept a reviewed application" 200 '"emailStatus":"queued"'
  STATUS="status $(app_field "$A_OK" status), decidedBy $(app_field "$A_OK" decidedBy), emailStatus $(app_field "$A_OK" emailStatus), acceptedCount $(field "$SCH" acceptedCount)"
  [ "$(app_field "$A_OK" status)" = accepted ] && [ "$(app_field "$A_OK" decidedBy)" = test-admin ] \
    && [ "$(app_field "$A_OK" emailStatus)" = queued ] && [ "$(field "$SCH" acceptedCount)" = 1 ] && ok=ok || ok=no
  result T-ADM-44 "stored: accepted, decidedBy from token, emailStatus queued, acceptedCount 1" $ok
  STATUS="AuditLog decision $DECISIONS_BEFORE -> $(count_action decision)"
  [ "$(count_action decision)" -eq $((DECISIONS_BEFORE + 2)) ] && ok=ok || ok=no
  result T-ADM-44 "one decision row per decision (2) in AuditLog" $ok

  take_messages
  MSG_FLAG=$(message_for "$A_FLAG"); MSG_OK=$(message_for "$A_OK")
  STATUS="$MSG_FLAG"
  node -e '
const m = JSON.parse(process.argv[1] || "{}");
const keys = Object.keys(m).sort().join(",");
process.exit(keys === "applicationId,decision,flagReason,scholarshipTitle,studentEmail" && m.decision === "rejected"
  && m.flagReason === "ineligible" && m.studentEmail === "student1@example-university.edu" && m.scholarshipTitle ? 0 : 1);' "$MSG_FLAG" && ok=ok || ok=no
  result T-ADM-43 "queue message: exactly the 5 fields, flagReason ineligible, no essay/note/reviewer" $ok
  STATUS="$MSG_OK"
  node -e '
const m = JSON.parse(process.argv[1] || "{}");
process.exit(Object.keys(m).sort().join(",") === "applicationId,decision,scholarshipTitle,studentEmail" && m.decision === "accepted" ? 0 : 1);' "$MSG_OK" && ok=ok || ok=no
  result T-ADM-44 "queue message: 4 fields, decision accepted, no flagReason" $ok

  call PATCH $DEC/$A_OK/decision test-admin "$REJ"
  expect T-ADM-45 "decide again after accepting" 409 "already accepted"
  STATUS="acceptedCount $(field "$SCH" acceptedCount), status $(app_field "$A_OK" status)"
  [ "$(field "$SCH" acceptedCount)" = 1 ] && [ "$(app_field "$A_OK" status)" = accepted ] && ok=ok || ok=no
  result T-ADM-45 "final decision unchanged, counter unchanged" $ok

  # Awards limit: 1 award, 3 different reviewed applications accepted at the same time.
  LIM=$(published_scholarship 1)
  L1=$(uuid); L2=$(uuid); L3=$(uuid)
  for a in $L1 $L2 $L3; do seed_app "$a" "$LIM" reviewed false; done
  for a in $L1 $L2 $L3; do
    curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H 'Authorization: Bearer test-admin' \
      -H 'Content-Type: application/json' --data "$ACC" "$API_URL$DEC/$a/decision" > "$TMP/lim-$a" &
  done
  wait
  CODES="$(cat "$TMP"/lim-* | tr -d '\r')"
  WON=$(printf '%s\n' "$CODES" | grep -c '^200$'); LOST=$(printf '%s\n' "$CODES" | grep -c '^409$')
  ACCEPTED=0; for a in $L1 $L2 $L3; do [ "$(app_field "$a" status)" = accepted ] && ACCEPTED=$((ACCEPTED+1)); done
  STATUS="200 x$WON, 409 x$LOST, acceptedCount $(field "$LIM" acceptedCount), applications accepted $ACCEPTED"
  [ "$WON" = 1 ] && [ "$LOST" = 2 ] && [ "$(field "$LIM" acceptedCount)" = 1 ] && [ "$ACCEPTED" = 1 ] && ok=ok || ok=no
  result T-ADM-46 "awards 1, 3 parallel accepts: one accepted, two 409, counter 1" $ok

  # Rollback: 5 accepts of the SAME application at once, 5 awards free. Several can take an award (step 1) before
  # one wins the status update (step 2); the losers must give theirs back, so the counter ends at 1, not more.
  RB=$(published_scholarship 5)
  RA=$(uuid); seed_app "$RA" "$RB" reviewed false
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null -w '%{http_code}\n' -X PATCH -H 'Authorization: Bearer test-admin' \
      -H 'Content-Type: application/json' --data "$ACC" "$API_URL$DEC/$RA/decision" > "$TMP/rb-$i" &
  done
  wait
  CODES="$(cat "$TMP"/rb-* | tr -d '\r')"
  WON=$(printf '%s\n' "$CODES" | grep -c '^200$'); LOST=$(printf '%s\n' "$CODES" | grep -c '^409$')
  STATUS="200 x$WON, 409 x$LOST, acceptedCount $(field "$RB" acceptedCount)"
  [ "$WON" = 1 ] && [ "$LOST" = 4 ] && [ "$(field "$RB" acceptedCount)" = 1 ] && ok=ok || ok=no
  result T-ADM-47 "same application accepted 5 times at once: one 200, four 409, counter ends at 1" $ok

  # Email failure (§6: never undoes the decision). Needs a server whose queue URL is wrong, so only on the local
  # run: a second server on port 3099 with NOTIFICATIONS_QUEUE_URL pointing at a queue that doesn't exist
  # (dotenv never overrides a variable that is already set, so this beats .env).
  if [ $GATEWAY = no ]; then
    EF=$(published_scholarship 2)
    EA=$(uuid); seed_app "$EA" "$EF" reviewed false
    take_messages # nothing from earlier tests left in the queue
    ( cd "$ROOT/services/admin-service" && PORT=3099 \
        NOTIFICATIONS_QUEUE_URL=http://localhost:4566/000000000000/queue-that-does-not-exist \
        exec node src/server.js > /dev/null 2>&1 ) &
    BAD_PID=$!
    for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:3099/api/health && break; node -e "setTimeout(()=>{},300)"; done
    SAVED_URL=$API_URL; API_URL=http://localhost:3099
    call PATCH $DEC/$EA/decision test-admin "$ACC"
    API_URL=$SAVED_URL
    expect T-ADM-49 "accept while the queue can't be reached" 200 '"emailStatus":"failed"'
    take_messages
    STATUS="status $(app_field "$EA" status), emailStatus $(app_field "$EA" emailStatus), acceptedCount $(field "$EF" acceptedCount), queued messages for it: $(grep -c "$EA" "$TMP/messages")"
    [ "$(app_field "$EA" status)" = accepted ] && [ "$(app_field "$EA" emailStatus)" = failed ] \
      && [ "$(field "$EF" acceptedCount)" = 1 ] && ! grep -q "$EA" "$TMP/messages" && ok=ok || ok=no
    result T-ADM-49 "decision kept: stored accepted with emailStatus failed, award still taken, nothing queued" $ok
    kill "$BAD_PID" 2>/dev/null; wait "$BAD_PID" 2>/dev/null
    for _ in 1 2 3 4 5; do curl -s -o /dev/null --max-time 1 http://localhost:3099/api/health || break; node -e "setTimeout(()=>{},300)"; done
  else
    skip T-ADM-49 "email-failure path" "needs a second server started with a wrong NOTIFICATIONS_QUEUE_URL; run on the local run only"
  fi

  # Clean up: seeded rows and the messages the decisions above queued.
  take_messages
  for a in "${SEEDED_APPS[@]}"; do
    AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb delete-item --table-name Applications --key "{\"applicationId\":{\"S\":\"$a\"}}"
  done
  for a in "${SEEDED_REVIEWS[@]}"; do
    AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb delete-item --table-name Reviews --key "{\"applicationId\":{\"S\":\"$a\"}}"
  done
  LEFT=0; for a in "${SEEDED_APPS[@]}"; do [ "$(app_field "$a" status)" = None ] || LEFT=$((LEFT+1)); done
  STATUS="${#SEEDED_APPS[@]} applications seeded, $LEFT left"
  [ "$LEFT" = 0 ] && ok=ok || ok=no
  result T-ADM-48 "seeded applications and reviews deleted again" $ok
else
  skip T-ADM-39 "decision tests (39-48)" "need the AWS CLI to seed applications"
fi

# ---------- /api/admin/users: list, create reviewer, disable/enable (step 6) ----------
# Users rows are seeded straight into DynamoDB (auth-service and seed.sh make them in real use) and deleted at the end.
# Every seeded passwordHash contains a marker, so any response or log line that leaks a hash is easy to spot.
U=/api/admin/users
RUN_TAG=$(node -e 'process.stdout.write(require("crypto").randomBytes(4).toString("hex"))')
HASH_MARKER="HASH-MARKER-$RUN_TAG"
SEEDED_USERS=()
seed_user() { # $1 userId, $2 role, $3 status
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb put-item --table-name Users --item \
    "{\"userId\":{\"S\":\"$1\"},\"email\":{\"S\":\"$1-$RUN_TAG@example-university.edu\"},\"name\":{\"S\":\"Seeded $2\"},\"role\":{\"S\":\"$2\"},\"status\":{\"S\":\"$3\"},\"passwordHash\":{\"S\":\"$HASH_MARKER\"},\"mustChangePassword\":{\"BOOL\":false},\"createdAt\":{\"S\":\"2026-11-27T00:00:00.000Z\"}}"
  SEEDED_USERS+=("$1")
}
user_field() { # $1 userId, $2 attribute
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb get-item --table-name Users \
    --key "{\"userId\":{\"S\":\"$1\"}}" --query "Item.$2.[S,N,BOOL][?@ != null] | [0]" --output text | tr -d '\r'
}
set_user_status() { # $1 userId, $2 status (test setup only)
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb update-item --table-name Users --key "{\"userId\":{\"S\":\"$1\"}}" \
    --update-expression 'SET #s = :s' --expression-attribute-names '{"#s":"status"}' --expression-attribute-values "{\":s\":{\"S\":\"$2\"}}"
}
no_secret_keys() { # the last response has no passwordHash/temporaryPassword key and no hash marker
  ! has '"passwordHash"' && ! has '"temporaryPassword"' && ! has "$HASH_MARKER"
}
DISABLE='{"status":"disabled"}'; ENABLE='{"status":"active"}'

if [ $HAVE_AWS = yes ]; then
  STARTED_MS=$(node -e 'process.stdout.write(String(Date.now()))')
  # Phase A: the acting test admin needs its own Users row for the admin rule (Phase B: every user has one).
  seed_user test-admin admin active
  S_STU="u-stu-$RUN_TAG"; S_REV="u-rev-$RUN_TAG"; S_ADM="u-adm-$RUN_TAG"
  seed_user "$S_STU" student active
  seed_user "$S_REV" reviewer disabled
  seed_user "$S_ADM" admin active

  call GET $U ""
  expect T-ADM-50 "list users, no token" 401 UNAUTHENTICATED
  call GET $U test-student-1
  expect T-ADM-50 "list users, student token" 403 FORBIDDEN
  call POST $U test-reviewer '{"email":"x@example-university.edu","name":"X"}'
  expect T-ADM-50 "create reviewer, reviewer token" 403 FORBIDDEN
  call PATCH $U/$S_STU/status "" "$DISABLE"
  expect T-ADM-50 "change status, no token" 401 UNAUTHENTICATED

  call GET "$U?role=reviewer&status=disabled" test-admin
  expect T-ADM-51 "filter role=reviewer&status=disabled" 200 "\"userId\":\"$S_REV\""
  node -e '
const list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.exit(Array.isArray(list) && list.length > 0 && list.every((u) => u.role === "reviewer" && u.status === "disabled") ? 0 : 1);' "$BODY" && ok=ok || ok=no
  result T-ADM-51 "every user in the filtered list is a disabled reviewer" $ok
  call GET "$U?role=bogus" test-admin
  expect T-ADM-51 "unknown role filter" 400 "role must be one of"
  call GET "$U?status=maybe" test-admin
  expect T-ADM-51 "unknown status filter" 400 "status must be one of"

  call GET $U test-admin
  expect T-ADM-52 "list all users" 200 "\"userId\":\"$S_ADM\""
  no_secret_keys && ok=ok || ok=no
  result T-ADM-52 "list has no passwordHash/temporaryPassword key and no hash value" $ok
  node -e '
const list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const allowed = ["userId","email","name","role","status","mustChangePassword","createdAt"];
process.exit(list.every((u) => Object.keys(u).every((k) => allowed.includes(k))) ? 0 : 1);' "$BODY" && ok=ok || ok=no
  result T-ADM-52 "every user object has only the 7 safe fields" $ok

  NEW_EMAIL="Reviewer-$RUN_TAG@Example.org"
  call POST $U test-admin "{\"email\":\"$NEW_EMAIL\",\"name\":\"New Reviewer\",\"role\":\"admin\",\"passwordHash\":\"chosen\",\"mustChangePassword\":false}"
  expect T-ADM-53 "create reviewer" 201 '"role":"reviewer"'
  NEW_ID=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).userId||"")' "$BODY")
  TEMP_PW=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).temporaryPassword||"")' "$BODY")
  [ -n "$NEW_ID" ] && SEEDED_USERS+=("$NEW_ID")
  node -e '
const u = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
process.exit(u.role === "reviewer" && u.status === "active" && u.mustChangePassword === true && u.email === process.argv[2].toLowerCase()
  && /^[A-Za-z0-9_-]{16}$/.test(u.temporaryPassword) && !("passwordHash" in u) ? 0 : 1);' "$BODY" "$NEW_EMAIL" && ok=ok || ok=no
  result T-ADM-53 "role reviewer (body role ignored), active, mustChangePassword, email lowercased, 16-char temp password, no hash" $ok
  STORED_HASH=$(user_field "$NEW_ID" passwordHash)
  STATUS="stored hash starts '${STORED_HASH:0:7}', mustChangePassword $(user_field "$NEW_ID" mustChangePassword)"
  node -e '
const bcrypt = require(process.argv[1]);
process.exit(process.argv[2] !== process.argv[3] && process.argv[2] !== "chosen" && bcrypt.compareSync(process.argv[3], process.argv[2]) ? 0 : 1);' \
    "$(winpath "$ROOT/services/admin-service/node_modules/bcryptjs")" "$STORED_HASH" "$TEMP_PW" && ok=ok || ok=no
  result T-ADM-53 "stored passwordHash is a bcrypt hash of the temp password (not the password, not the body value)" $ok

  call POST $U test-admin "{\"email\":\"$NEW_EMAIL\",\"name\":\"Same Email\"}"
  expect T-ADM-54 "same email again (any case)" 409 "already exists"
  call POST $U test-admin '{"email":"not-an-email","name":"Bad Email"}'
  expect T-ADM-54 "invalid email" 400 "valid email"
  call POST $U test-admin '{"email":"ok@example-university.edu"}'
  expect T-ADM-54 "no name" 400 "Name"
  call POST $U test-admin '{"email":"ok@example-university.edu","name":"Ok"}' text/plain
  expect T-ADM-54 "Content-Type text/plain" 415 UNSUPPORTED_MEDIA_TYPE

  # Secrets must not be in AuditLog: the user_created row, and no AuditLog row at all.
  AUDIT_DUMP="$(winpath "$TMP/audit.json")"
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb scan --table-name AuditLog --output json > "$AUDIT_DUMP"
  CREATED_ROWS=$(grep -c "\"$NEW_ID\"" "$AUDIT_DUMP")
  STATUS="AuditLog rows naming the new user: $CREATED_ROWS; temp password found: $(grep -cF -- "$TEMP_PW" "$AUDIT_DUMP"); hash found: $(grep -cF -- "$STORED_HASH" "$AUDIT_DUMP")"
  [ "$CREATED_ROWS" -ge 1 ] && ! grep -qF -- "$TEMP_PW" "$AUDIT_DUMP" && ! grep -qF -- "$STORED_HASH" "$AUDIT_DUMP" \
    && ! grep -qF -- "$HASH_MARKER" "$AUDIT_DUMP" && ok=ok || ok=no
  result T-ADM-55 "user_created is audited; no AuditLog row contains the temp password or any password hash" $ok

  call PATCH $U/test-admin/status test-admin "$DISABLE"
  expect T-ADM-56 "disable your own account" 409 "your own account"
  STATUS="test-admin row status $(user_field test-admin status)"
  [ "$(user_field test-admin status)" = active ] && ok=ok || ok=no
  result T-ADM-56 "still active afterwards" $ok

  call PATCH "$U/bad%20id/status" test-admin "$DISABLE"
  expect T-ADM-57 "user id with a space" 400 "User id"
  call PATCH $U/no-such-user-$RUN_TAG/status test-admin "$DISABLE"
  expect T-ADM-57 "unknown user" 404 USER_NOT_FOUND
  call PATCH $U/$S_STU/status test-admin '{"status":"banned"}'
  expect T-ADM-57 "status banned" 400 "Status must be one of"
  call PATCH $U/$S_REV/status test-admin "$DISABLE"
  expect T-ADM-57 "disable an already disabled account" 409 "already disabled"

  DIS_BEFORE=$(count_action user_disabled); EN_BEFORE=$(count_action user_enabled)
  call PATCH $U/$S_STU/status test-admin "$DISABLE"
  expect T-ADM-58 "disable a student" 200 '"status":"disabled"'
  no_secret_keys && ok=ok || ok=no
  result T-ADM-58 "status reply has no password fields" $ok
  call PATCH $U/$S_STU/status test-admin "$ENABLE"
  expect T-ADM-58 "enable the student again" 200 '"status":"active"'
  STATUS="user_disabled $DIS_BEFORE -> $(count_action user_disabled), user_enabled $EN_BEFORE -> $(count_action user_enabled)"
  [ "$(count_action user_disabled)" -eq $((DIS_BEFORE + 1)) ] && [ "$(count_action user_enabled)" -eq $((EN_BEFORE + 1)) ] && ok=ok || ok=no
  result T-ADM-58 "exactly one user_disabled and one user_enabled row" $ok

  call PATCH $U/$S_ADM/status test-admin "$DISABLE"
  expect T-ADM-59 "an active admin disables another admin" 200 '"status":"disabled"'

  set_user_status test-admin disabled   # the acting admin's own row says disabled (Phase B would block the token)
  set_user_status "$S_ADM" active
  call PATCH $U/$S_ADM/status test-admin "$DISABLE"
  expect T-ADM-60 "disable an admin while your own account is not an active admin" 409 "at least one active admin"
  STATUS="target status $(user_field "$S_ADM" status)"
  [ "$(user_field "$S_ADM" status)" = active ] && ok=ok || ok=no
  result T-ADM-60 "target admin still active (the transaction wrote nothing)" $ok
  set_user_status test-admin active

  if [ $GATEWAY = no ]; then
    # A second local server that also accepts Bearer test-admin-2 (tests/second-admin.js), with its log kept.
    SECOND_LOG="$TMP/second-server.log"
    ( cd "$ROOT/services/admin-service" && PORT=3099 exec node -r ./tests/second-admin.js src/server.js > "$SECOND_LOG" 2>&1 ) &
    SECOND_PID=$!
    for _ in $(seq 1 30); do curl -s -o /dev/null http://localhost:3099/api/health && break; node -e "setTimeout(()=>{},300)"; done
    seed_user test-admin-2 admin active
    RACE_OK=0; RACE_DETAIL=""
    for trial in 1 2 3 4 5; do
      set_user_status test-admin active; set_user_status test-admin-2 active
      curl -s -o /dev/null -w '%{http_code}' -X PATCH -H 'Authorization: Bearer test-admin' -H 'Content-Type: application/json' \
        --data "$DISABLE" "http://localhost:3099$U/test-admin-2/status" > "$TMP/race-a" &
      curl -s -o /dev/null -w '%{http_code}' -X PATCH -H 'Authorization: Bearer test-admin-2' -H 'Content-Type: application/json' \
        --data "$DISABLE" "http://localhost:3099$U/test-admin/status" > "$TMP/race-b" &
      wait $(jobs -p | grep -v "^$SECOND_PID$") 2>/dev/null
      CA=$(cat "$TMP/race-a"); CB=$(cat "$TMP/race-b")
      SA=$(user_field test-admin status); SB=$(user_field test-admin-2 status)
      ACTIVE=0; [ "$SA" = active ] && ACTIVE=$((ACTIVE+1)); [ "$SB" = active ] && ACTIVE=$((ACTIVE+1))
      RACE_DETAIL="$RACE_DETAIL [$trial: $CA/$CB, active $ACTIVE]"
      { [ "$CA $CB" = "200 409" ] || [ "$CA $CB" = "409 200" ]; } && [ "$ACTIVE" = 1 ] && RACE_OK=$((RACE_OK+1))
    done
    STATUS="$RACE_DETAIL"
    [ "$RACE_OK" = 5 ] && ok=ok || ok=no
    result T-ADM-61 "two admins disable each other at once, 5 times: always one 200 + one 409 and one admin left active" $ok
    set_user_status test-admin active

    # One create through the second server, whose log we keep: the temp password and hash must not be in it.
    curl -s -o "$BODY" -X POST -H 'Authorization: Bearer test-admin' -H 'Content-Type: application/json' \
      --data "{\"email\":\"logcheck-$RUN_TAG@example.org\",\"name\":\"Log Check\"}" "http://localhost:3099$U"
    LOG_ID=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).userId||"")' "$BODY")
    LOG_PW=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).temporaryPassword||"")' "$BODY")
    [ -n "$LOG_ID" ] && SEEDED_USERS+=("$LOG_ID")
    LOG_HASH=$(user_field "$LOG_ID" passwordHash)
    kill "$SECOND_PID" 2>/dev/null; wait "$SECOND_PID" 2>/dev/null
    STATUS="server log lines $(wc -l < "$SECOND_LOG" | tr -d ' '), temp password found $(grep -cF -- "$LOG_PW" "$SECOND_LOG"), hash found $(grep -cF -- "$LOG_HASH" "$SECOND_LOG")"
    [ -n "$LOG_PW" ] && [ -n "$LOG_HASH" ] && [ "$(wc -l < "$SECOND_LOG")" -gt 0 ] && ! grep -qF -- "$LOG_PW" "$SECOND_LOG" \
      && ! grep -qF -- "$LOG_HASH" "$SECOND_LOG" && ! grep -qF -- "$HASH_MARKER" "$SECOND_LOG" && ok=ok || ok=no
    result T-ADM-55 "local server log: no temp password, no password hash" $ok
  else
    skip T-ADM-61 "two admins disabling each other at once" "needs the test-only second admin token (tests/second-admin.js), which only a local server loads; run on the local run"
    # Through the gateway the log is CloudWatch: search everything admin-service logged during this run.
    LOGS="$TMP/cloudwatch.txt"
    AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name /aws/lambda/admin-service \
      --start-time "$STARTED_MS" --query 'events[].message' --output text > "$LOGS" 2>/dev/null
    STATUS="CloudWatch lines this run $(tr '\t' '\n' < "$LOGS" | grep -c '"fn"'), temp password found $(grep -cF -- "$TEMP_PW" "$LOGS"), hash found $(grep -cF -- "$STORED_HASH" "$LOGS")"
    [ "$(tr '\t' '\n' < "$LOGS" | grep -c '"fn"')" -gt 0 ] && ! grep -qF -- "$TEMP_PW" "$LOGS" && ! grep -qF -- "$STORED_HASH" "$LOGS" \
      && ! grep -qF -- "$HASH_MARKER" "$LOGS" && ok=ok || ok=no
    result T-ADM-55 "CloudWatch log: no temp password, no password hash" $ok
  fi

  for u in "${SEEDED_USERS[@]}"; do
    AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb delete-item --table-name Users --key "{\"userId\":{\"S\":\"$u\"}}"
  done
  LEFT=0; for u in "${SEEDED_USERS[@]}"; do [ "$(user_field "$u" userId)" = None ] || LEFT=$((LEFT+1)); done
  STATUS="${#SEEDED_USERS[@]} users seeded or created, $LEFT left"
  [ "$LEFT" = 0 ] && ok=ok || ok=no
  result T-ADM-62 "test users deleted again" $ok
else
  skip T-ADM-50 "user tests (50-62)" "need the AWS CLI to seed users"
fi

# ---------- GET /api/admin/audit-log and GET /api/admin/stats (step 7) ----------
AL=/api/admin/audit-log
ST=/api/admin/stats
b64url() { node -e 'process.stdout.write(Buffer.from(process.argv[1]).toString("base64url"))' "$1"; }
json() { node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));process.stdout.write(String((${1})(d)))" "$BODY"; }

call GET "$AL?action=decision" ""
expect T-ADM-63 "audit log, no token" 401 UNAUTHENTICATED
call GET "$AL?action=decision" test-student-1
expect T-ADM-63 "audit log, student token" 403 FORBIDDEN
call GET $ST ""
expect T-ADM-63 "stats, no token" 401 UNAUTHENTICATED
call GET $ST test-reviewer
expect T-ADM-63 "stats, reviewer token" 403 FORBIDDEN

call GET $AL test-admin
expect T-ADM-64 "no action" 400 "action is required"
call GET "$AL?action=bogus" test-admin
expect T-ADM-64 "unknown action" 400 "action must be one of"
call GET "$AL?action=decision&since=yesterday" test-admin
expect T-ADM-64 "since=yesterday" 400 "since must be a real ISO 8601"
call GET "$AL?action=decision&since=2027-02-30T10:00:00Z" test-admin
expect T-ADM-64 "since on 30 February" 400 "since must be a real ISO 8601"
for bad in 0 101 abc -1; do
  call GET "$AL?action=decision&limit=$bad" test-admin
  expect T-ADM-64 "limit=$bad" 400 "limit must be a whole number from 1 to 100"
done
call GET "$AL?action=decision&next=not-a-token" test-admin
expect T-ADM-64 "next that is not a token" 400 "not a valid paging token"
call GET "$AL?action=scholarship_created&next=$(b64url '{"action":"decision","sortKey":"2026"}')" test-admin
expect T-ADM-64 "next made for another action" 400 "not a valid paging token"
call GET "$AL?action=decision&next=$(b64url '{"action":"decision","sortKey":"2026","extra":"x"}')" test-admin
expect T-ADM-64 "next with an extra key" 400 "not a valid paging token"

STEP7_START=$(node -e 'process.stdout.write(new Date(Date.now() - 1000).toISOString())')
A1=$(new_draft); A2=$(new_draft); A3=$(new_draft)
call GET "$AL?action=scholarship_created&since=$STEP7_START" test-admin
expect T-ADM-65 "created scholarships since this run's start" 200 '"items"'
node -e '
const { items, next } = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const ids = process.argv.slice(2);
const keysOk = items.every((r) => Object.keys(r).sort().join(",") === "action,createdAt,detail,targetId,userId");
const newestFirst = items.every((r, i) => i === 0 || items[i - 1].createdAt >= r.createdAt);
const want = [ids[2], ids[1], ids[0]].join(",");
process.exit(items.length === 3 && next === null && keysOk && newestFirst && items.map((r) => r.targetId).join(",") === want
  && items.every((r) => r.action === "scholarship_created" && r.userId === "test-admin") ? 0 : 1);' "$BODY" "$A1" "$A2" "$A3" && ok=ok || ok=no
STATUS="items $(json 'd=>d.items.length'), next $(json 'd=>d.next')"
result T-ADM-65 "exactly the 3 new rows, newest first, only the 5 fields, next null" $ok
call GET "$AL?action=scholarship_created&since=2099-01-01T00:00:00Z" test-admin
expect T-ADM-65 "since in the future" 200 '{"items":[],"next":null}'

call GET "$AL?action=scholarship_created&since=$STEP7_START&limit=2" test-admin
expect T-ADM-66 "first page, limit 2" 200 '"items"'
P1_IDS=$(json 'd=>d.items.map(r=>r.targetId).join(",")'); P1_COUNT=$(json 'd=>d.items.length'); NEXT=$(json 'd=>d.next||""')
call GET "$AL?action=scholarship_created&since=$STEP7_START&limit=2&next=$NEXT" test-admin
expect T-ADM-66 "second page with next" 200 '"items"'
P2_IDS=$(json 'd=>d.items.map(r=>r.targetId).join(",")'); P2_NEXT=$(json 'd=>d.next')
STATUS="page 1: $P1_COUNT items, page 2: [$P2_IDS], page 2 next $P2_NEXT"
[ "$P1_COUNT" = 2 ] && [ -n "$NEXT" ] && [ "$P2_IDS" = "$A1" ] && [ "$P2_NEXT" = null ] \
  && [ "$P1_IDS" = "$A3,$A2" ] && ok=ok || ok=no
result T-ADM-66 "2 + 1 rows over two pages, no overlap, no next after the last page" $ok

call GET "$AL?action=scholarship_created&limit=100" test-admin
expect T-ADM-67 "limit 100 (the cap)" 200 '"items"'
STATUS="items $(json 'd=>d.items.length')"
[ "$(json 'd=>d.items.length')" -le 100 ] && ok=ok || ok=no
result T-ADM-67 "never more than 100 rows in one call" $ok

if [ $HAVE_AWS = yes ]; then
  # Secrets: create a reviewer (temp password + hash), then read the audit output for this run.
  call POST $U test-admin "{\"email\":\"audit-$RUN_TAG@example.org\",\"name\":\"Audit Check\"}"
  AU_ID=$(json 'd=>d.userId||""'); AU_PW=$(json 'd=>d.temporaryPassword||""'); AU_HASH=$(user_field "$AU_ID" passwordHash)
  OUT="$TMP/audit-out.txt"; : > "$OUT"
  for act in user_created forbidden scholarship_created; do
    call GET "$AL?action=$act&since=$STEP7_START" test-admin
    cat "$BODY" >> "$OUT"
  done
  STATUS="user_created rows for the new user $(grep -o "\"targetId\":\"$AU_ID\"" "$OUT" | wc -l | tr -d ' '); temp password $(grep -cF -- "$AU_PW" "$OUT"); hash $(grep -cF -- "$AU_HASH" "$OUT"); passwordHash/Bearer/authorization $(grep -ciE 'passwordHash|bearer|authorization' "$OUT")"
  [ -n "$AU_PW" ] && [ -n "$AU_HASH" ] && grep -q "\"targetId\":\"$AU_ID\"" "$OUT" && ! grep -qF -- "$AU_PW" "$OUT" \
    && ! grep -qF -- "$AU_HASH" "$OUT" && ! grep -qiE 'passwordHash|bearer|authorization' "$OUT" && ok=ok || ok=no
  result T-ADM-68 "audit output has the new user's row but no temp password, hash or token" $ok
  AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb delete-item --table-name Users --key "{\"userId\":{\"S\":\"$AU_ID\"}}"
else skip T-ADM-68 "no secrets in the audit output" "need the AWS CLI to read the stored hash"; fi

call GET $ST test-admin
expect T-ADM-69 "stats" 200 '"scholarships"'
node -e '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const ok = (o, keys) => o && Object.keys(o).sort().join(",") === keys && Object.values(o).every((n) => Number.isInteger(n) && n >= 0);
process.exit(Object.keys(s).sort().join(",") === "applications,scholarships"
  && ok(s.scholarships, "closed,draft,published") && ok(s.applications, "accepted,rejected,reviewed,submitted,under_review") ? 0 : 1);' "$BODY" && ok=ok || ok=no
result T-ADM-69 "exactly scholarships{draft,published,closed} and applications{5 statuses}, whole numbers" $ok

if [ $HAVE_AWS = yes ]; then
  # Known data in, exact change out: 2 drafts (1 then published) and 3 applications.
  STATS_BEFORE="$(winpath "$TMP/stats-before")"; cp "$BODY" "$STATS_BEFORE"
  SD=$(new_draft); SP=$(published_scholarship 2)
  ST_APPS=(); for st in submitted reviewed accepted; do a=$(uuid); seed_app "$a" "$SP" "$st" false; ST_APPS+=("$a"); done
  call GET $ST test-admin
  STATUS="$(node -e '
const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")), a = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const d = (g) => Object.fromEntries(Object.keys(a[g]).map((k) => [k, a[g][k] - b[g][k]]));
process.stdout.write(JSON.stringify({ scholarships: d("scholarships"), applications: d("applications") }));' "$STATS_BEFORE" "$BODY")"
  [ "$STATUS" = '{"scholarships":{"draft":1,"published":1,"closed":0},"applications":{"submitted":1,"under_review":0,"reviewed":1,"accepted":1,"rejected":0}}' ] && ok=ok || ok=no
  result T-ADM-70 "after 1 draft, 1 published, 3 applications: counts change by exactly that" $ok
  for a in "${ST_APPS[@]}"; do
    AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws dynamodb delete-item --table-name Applications --key "{\"applicationId\":{\"S\":\"$a\"}}"
  done
  LEFT=0; for a in "${ST_APPS[@]}"; do [ "$(app_field "$a" status)" = None ] || LEFT=$((LEFT+1)); done
  STATUS="${#ST_APPS[@]} applications seeded, $LEFT left"
  [ "$LEFT" = 0 ] && ok=ok || ok=no
  result T-ADM-71 "stats test applications deleted again" $ok
else
  skip T-ADM-70 "stats change by exactly the seeded data" "need the AWS CLI to seed applications"
fi

# ---------- notification-sender (step 8): SQS → Brevo, emailStatus, DLQ ----------
[ $HAVE_AWS = yes ] && { take_messages; set_trigger enabled; } # drain what earlier tests left, then the sender takes over
# The sender is a Lambda on Floci in both runs (no HTTP route). Most tests invoke it directly with a crafted SQS
# event. To make a send fail without touching the real Brevo key, the Lambda's BREVO_KEY_PARAM is pointed at a
# parameter that doesn't exist for a moment, then the saved settings are put back.
if [ $HAVE_AWS = yes ]; then
  AWSF() { AWS_PROFILE=floci MSYS_NO_PATHCONV=1 aws "$@"; }
  MAXRC=$(AWSF sqs get-queue-attributes --queue-url "$QURL" --attribute-names RedrivePolicy --query Attributes.RedrivePolicy --output text \
    | tr -d '\r' | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(String(JSON.parse(d).maxReceiveCount)))')
  DLQURL=$(AWSF sqs get-queue-url --queue-name notifications-dlq --query QueueUrl --output text | tr -d '\r')
  dlq_count() { AWSF sqs get-queue-attributes --queue-url "$DLQURL" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text | tr -d '\r'; }
  SENDER_ENV_FILE="$(winpath "$TMP/sender-env.json")"
  AWSF lambda get-function-configuration --function-name notification-sender --query Environment --output json > "$SENDER_ENV_FILE"
  restore_sender_env() {
    if [ "$SENDER_ENV_SWAPPED" = yes ]; then
      AWSF lambda update-function-configuration --function-name notification-sender --environment "file://$SENDER_ENV_FILE" >/dev/null
      AWSF lambda wait function-updated --function-name notification-sender 2>/dev/null
      SENDER_ENV_SWAPPED=no
    fi
  }
  break_key_param() {
    node -e 'const f=require("fs");const e=JSON.parse(f.readFileSync(process.argv[1],"utf8"));e.Variables.BREVO_KEY_PARAM="/scholarship/test-key-that-does-not-exist";f.writeFileSync(process.argv[2],JSON.stringify(e))' \
      "$SENDER_ENV_FILE" "$(winpath "$TMP/sender-env-broken.json")"
    AWSF lambda update-function-configuration --function-name notification-sender --environment "file://$(winpath "$TMP/sender-env-broken.json")" >/dev/null
    AWSF lambda wait function-updated --function-name notification-sender 2>/dev/null
    SENDER_ENV_SWAPPED=yes
  }
  sqs_event() { # $1 file, $2 message body JSON, $3 receive count
    node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ Records: [{ messageId: "test-" + Date.now(), body: process.argv[2], attributes: { ApproximateReceiveCount: process.argv[3] } }] }))' "$(winpath "$1")" "$2" "$3"
  }
  invoke_sender() { # $1 event file, $2 output file: STATUS = "error <type>" or "ok"
    local fe
    fe=$(AWSF lambda invoke --function-name notification-sender --payload "fileb://$(winpath "$1")" "$(winpath "$2")" --query FunctionError --output text 2>&1 | tr -d '\r' | tail -1)
    if [ "$fe" = None ] || [ -z "$fe" ]; then STATUS=ok; else STATUS="error $(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).errorType||"?")}catch{process.stdout.write("?")}' "$(winpath "$2")")"; fi
  }
  seed_email_app() { # $1 id, $2 emailStatus
    AWSF dynamodb put-item --table-name Applications --item \
      "{\"applicationId\":{\"S\":\"$1\"},\"studentId\":{\"S\":\"test-student-1\"},\"studentEmail\":{\"S\":\"student1@example-university.edu\"},\"scholarshipId\":{\"S\":\"email-test\"},\"status\":{\"S\":\"accepted\"},\"emailStatus\":{\"S\":\"$2\"},\"submittedAt\":{\"S\":\"2026-11-20T10:00:00.000Z\"}}"
    SEEDED_APPS+=("$1")
  }
  email_msg() { printf '{"applicationId":"%s","studentEmail":"student1@example-university.edu","scholarshipTitle":"Cloud Excellence Award","decision":"%s"}' "$1" "${2:-accepted}"; }
  emails_logged() { echo $(( $(count_action email_sent) + $(count_action email_failed) )); }

  # T-ADM-72: what deploy.sh built
  CONF=$(AWSF lambda get-function-configuration --function-name notification-sender --query '[Handler,Timeout,Role]' --output text | tr -d '\r')
  MAP=$(AWSF lambda list-event-source-mappings --function-name notification-sender --query 'EventSourceMappings[0].[State,BatchSize,EventSourceArn]' --output text | tr -d '\r')
  SIDS=$(AWSF iam get-role-policy --role-name notification-sender-role --policy-name notification-sender-role-policy --query 'PolicyDocument.Statement[].Sid' --output text | tr -d '\r')
  STATUS="function [$CONF], trigger [$MAP], queue maxReceiveCount $MAXRC, policy Sids [$SIDS]"
  echo "$CONF" | grep -q "^handler.handler	15	arn:aws:iam::000000000000:role/notification-sender-role$" \
    && echo "$MAP" | grep -q "^Enabled	1	arn:aws:sqs:us-east-1:000000000000:notifications$" \
    && [ "$MAXRC" = 3 ] && [ "$(echo $SIDS | wc -w)" = 5 ] && echo "$SIDS" | grep -q OwnLogGroupOnly && ok=ok || ok=no
  result T-ADM-72 "sender Lambda (15 s), SQS trigger enabled with batch size 1, queue maxReceiveCount 3, role with 5 Sids" $ok

  # T-ADM-73: messages that aren't valid are refused without writing anything
  BEFORE=$(emails_logged)
  BAD_OK=yes
  for body in '{"applicationId":"not-a-uuid","studentEmail":"a@b.org","scholarshipTitle":"T","decision":"accepted"}' \
              "{\"applicationId\":\"$(uuid)\",\"scholarshipTitle\":\"T\",\"decision\":\"accepted\"}" \
              "{\"applicationId\":\"$(uuid)\",\"studentEmail\":\"a@b.org\",\"scholarshipTitle\":\"T\",\"decision\":\"maybe\"}" \
              'not json at all'; do
    sqs_event "$TMP/bad.json" "$body" 1; invoke_sender "$TMP/bad.json" "$TMP/bad-out.json"
    [ "$STATUS" = "error Error" ] || BAD_OK=no
  done
  STATUS="last: $STATUS, email audit rows $BEFORE -> $(emails_logged)"
  [ "$BAD_OK" = yes ] && [ "$(emails_logged)" = "$BEFORE" ] && ok=ok || ok=no
  result T-ADM-73 "4 invalid messages: each throws (so SQS retries, then DLQ), nothing written" $ok

  # T-ADM-74: an email already sent, or being sent by another copy, is never sent again
  for st in sent sending; do
    E=$(uuid); seed_email_app "$E" "$st"; BEFORE=$(emails_logged)
    sqs_event "$TMP/dup.json" "$(email_msg "$E")" 1; invoke_sender "$TMP/dup.json" "$TMP/dup-out.json"
    STATUS="$STATUS, emailStatus $(app_field "$E" emailStatus), email audit rows $BEFORE -> $(emails_logged)"
    [ "${STATUS%%,*}" = ok ] && [ "$(app_field "$E" emailStatus)" = "$st" ] && [ "$(emails_logged)" = "$BEFORE" ] && ok=ok || ok=no
    result T-ADM-74 "message for an email already '$st': skipped, no send, nothing written" $ok
  done

  # T-ADM-75/76: a failing send (no key) before and on the queue's last attempt (its real maxReceiveCount)
  break_key_param
  E=$(uuid); seed_email_app "$E" queued; BEFORE_F=$(count_action email_failed)
  sqs_event "$TMP/f1.json" "$(email_msg "$E")" $((MAXRC - 1)); invoke_sender "$TMP/f1.json" "$TMP/f1-out.json"
  STATUS="$STATUS, emailStatus $(app_field "$E" emailStatus), email_failed $BEFORE_F -> $(count_action email_failed)"
  [ "${STATUS%%,*}" != ok ] && [ "$(app_field "$E" emailStatus)" = queued ] && [ "$(count_action email_failed)" = "$BEFORE_F" ] && ok=ok || ok=no
  result T-ADM-75 "send fails on attempt $((MAXRC - 1)) of $MAXRC: throws, emailStatus back to queued, no email_failed" $ok
  sqs_event "$TMP/f2.json" "$(email_msg "$E")" "$MAXRC"; invoke_sender "$TMP/f2.json" "$TMP/f2-out.json"
  STATUS="$STATUS, emailStatus $(app_field "$E" emailStatus), email_failed $BEFORE_F -> $(count_action email_failed)"
  [ "${STATUS%%,*}" != ok ] && [ "$(app_field "$E" emailStatus)" = failed ] && [ "$(count_action email_failed)" -eq $((BEFORE_F + 1)) ] && ok=ok || ok=no
  result T-ADM-76 "send fails on attempt $MAXRC of $MAXRC (last): throws, emailStatus failed, exactly one email_failed" $ok

  # T-ADM-80: the real path, through SQS: decision → queue → sender fails each time → after maxReceiveCount the
  # message is in the DLQ and emailStatus is failed. Takes about maxReceiveCount × 90 s, so only on the API Gateway run.
  if [ $GATEWAY = yes ]; then
    DLQ_BEFORE=$(dlq_count)
    DS=$(published_scholarship 2); DA=$(uuid); seed_app "$DA" "$DS" reviewed false
    call PATCH $DEC/$DA/decision test-admin "$ACC"
    for _ in $(seq 1 30); do
      [ "$(app_field "$DA" emailStatus)" = failed ] && [ "$(dlq_count)" -gt "$DLQ_BEFORE" ] && break
      node -e "setTimeout(()=>{},15000)"
    done
    ATTEMPTS=$(AWSF logs filter-log-events --log-group-name /aws/lambda/notification-sender --query 'events[].message' --output text \
      | tr '\t' '\n' | grep "$DA" | grep -o '"attempt":[0-9]*,"lastAttempt":[a-z]*' | tr '\n' ' ')
    STATUS="emailStatus $(app_field "$DA" emailStatus), DLQ $DLQ_BEFORE -> $(dlq_count), sender log: $ATTEMPTS"
    [ "$(app_field "$DA" emailStatus)" = failed ] && [ "$(dlq_count)" -eq $((DLQ_BEFORE + 1)) ] \
      && echo "$ATTEMPTS" | grep -q "\"attempt\":$MAXRC,\"lastAttempt\":true" && ok=ok || ok=no
    result T-ADM-80 "through SQS: $MAXRC failed attempts, then the message is in the DLQ and emailStatus is failed" $ok
    # take that one message out of the DLQ again
    for _ in 1 2 3; do
      AWSF sqs receive-message --queue-url "$DLQURL" --max-number-of-messages 10 --output json | tr -d '\r' > "$TMP/dlq.json"
      node -e 'for (const m of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8") || "{}").Messages || []) if (m.Body.includes(process.argv[2])) console.log(m.ReceiptHandle)' "$(winpath "$TMP/dlq.json")" "$DA" > "$TMP/handles"
      while read -r h; do AWSF sqs delete-message --queue-url "$DLQURL" --receipt-handle "$h"; done < "$TMP/handles"
      [ -s "$TMP/handles" ] && break
    done
  else
    skip T-ADM-80 "through SQS into the DLQ" "takes about 4.5 minutes and runs the same Floci Lambda; it runs on the API Gateway run"
  fi
  restore_sender_env

  # T-ADM-77/78: real sends through Brevo's sandbox (Brevo checks each email, delivers nothing). Need your key in SSM
  # (from .env through deploy.sh) and a verified sender address.
  SENDER_ADDR=$(AWSF lambda get-function-configuration --function-name notification-sender --query Environment.Variables.BREVO_SENDER_EMAIL --output text | tr -d '\r')
  SANDBOX=$(AWSF lambda get-function-configuration --function-name notification-sender --query Environment.Variables.BREVO_SANDBOX --output text | tr -d '\r')
  if AWSF ssm get-parameter --name /scholarship/brevo-api-key >/dev/null 2>&1 && [ -n "$SENDER_ADDR" ] && [ "$SENDER_ADDR" != None ] && [ "$SANDBOX" = true ]; then
    SENT_BEFORE=$(count_action email_sent)
    RS=$(published_scholarship 2); RA=$(uuid); seed_app "$RA" "$RS" reviewed false
    call PATCH $DEC/$RA/decision test-admin "$ACC"
    for _ in $(seq 1 20); do [ "$(app_field "$RA" emailStatus)" = sent ] && break; node -e "setTimeout(()=>{},3000)"; done
    STATUS="emailStatus $(app_field "$RA" emailStatus), email_sent $SENT_BEFORE -> $(count_action email_sent)"
    [ "$(app_field "$RA" emailStatus)" = sent ] && [ "$(count_action email_sent)" -eq $((SENT_BEFORE + 1)) ] && ok=ok || ok=no
    result T-ADM-77 "decision → SQS → sender → Brevo sandbox: emailStatus sent, one email_sent row" $ok
    # Two copies of the same message at the same time: the conditional claim lets only one of them send.
    E=$(uuid); seed_email_app "$E" queued; SENT_BEFORE=$(count_action email_sent)
    sqs_event "$TMP/p.json" "$(email_msg "$E")" 1
    invoke_sender "$TMP/p.json" "$TMP/p1.json" & invoke_sender "$TMP/p.json" "$TMP/p2.json" & wait
    STATUS="emailStatus $(app_field "$E" emailStatus), email_sent $SENT_BEFORE -> $(count_action email_sent)"
    [ "$(app_field "$E" emailStatus)" = sent ] && [ "$(count_action email_sent)" -eq $((SENT_BEFORE + 1)) ] && ok=ok || ok=no
    result T-ADM-78 "2 copies of one message at the same time: exactly one email sent" $ok
  else
    skip T-ADM-77 "real send through the Brevo sandbox" "no Brevo key in SSM or no BREVO_SENDER_EMAIL (or sandbox off): set them in services/admin-service/.env and run deploy.sh"
    skip T-ADM-78 "two copies of one message, one email" "same as T-ADM-77"
  fi

  # T-ADM-82: "sending" found again. On a first delivery it's a duplicate copy while another is sending: skip.
  # On a retry the attempt that claimed it died (15 s Lambda timeout, retry after 90 s): mark failed, return normally.
  E=$(uuid); seed_email_app "$E" sending; BEFORE_F=$(count_action email_failed)
  sqs_event "$TMP/s1.json" "$(email_msg "$E")" 1; invoke_sender "$TMP/s1.json" "$TMP/s1-out.json"
  STATUS="$STATUS, emailStatus $(app_field "$E" emailStatus), email_failed $BEFORE_F -> $(count_action email_failed)"
  [ "${STATUS%%,*}" = ok ] && [ "$(app_field "$E" emailStatus)" = sending ] && [ "$(count_action email_failed)" = "$BEFORE_F" ] && ok=ok || ok=no
  result T-ADM-82 "attempt 1 finds 'sending' (a copy still in progress): skipped, nothing changed" $ok
  sqs_event "$TMP/s2.json" "$(email_msg "$E")" 2; invoke_sender "$TMP/s2.json" "$TMP/s2-out.json"
  STATUS="$STATUS, emailStatus $(app_field "$E" emailStatus), email_failed $BEFORE_F -> $(count_action email_failed)"
  [ "${STATUS%%,*}" = ok ] && [ "$(app_field "$E" emailStatus)" = failed ] && [ "$(count_action email_failed)" -eq $((BEFORE_F + 1)) ] && ok=ok || ok=no
  result T-ADM-82 "attempt 2 finds 'sending' (the earlier attempt died): returns normally, emailStatus failed, one email_failed" $ok

  # T-ADM-83: the same through real SQS. The test plays the attempt that died: it receives the message once (attempt 1)
  # and claims the email (queued → sending) the way the sender does, then lets the message come back at once instead of
  # after 90 s. SQS then delivers it to the sender as attempt 2.
  E=$(uuid); seed_email_app "$E" queued
  set_trigger disabled; take_messages
  AWSF sqs send-message --queue-url "$QURL" --message-body "$(email_msg "$E")" >/dev/null
  AWSF sqs receive-message --queue-url "$QURL" --max-number-of-messages 1 --wait-time-seconds 2 --output json | tr -d '\r' > "$TMP/died.json"
  DIED_HANDLE=$(node -e 'const m=(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")||"{}").Messages||[])[0];process.stdout.write(m?m.ReceiptHandle:"")' "$(winpath "$TMP/died.json")")
  AWSF dynamodb update-item --table-name Applications --key "{\"applicationId\":{\"S\":\"$E\"}}" --update-expression 'SET emailStatus = :s' \
    --condition-expression 'emailStatus = :q' --expression-attribute-values '{":s":{"S":"sending"},":q":{"S":"queued"}}'
  [ -n "$DIED_HANDLE" ] && AWSF sqs change-message-visibility --queue-url "$QURL" --receipt-handle "$DIED_HANDLE" --visibility-timeout 0
  DLQ_BEFORE=$(dlq_count); BEFORE_F=$(count_action email_failed)
  set_trigger enabled
  for _ in $(seq 1 20); do [ "$(app_field "$E" emailStatus)" = failed ] && break; node -e "setTimeout(()=>{},3000)"; done
  node -e "setTimeout(()=>{},3000)" # let SQS finish deleting the message
  INQ=$(AWSF sqs get-queue-attributes --queue-url "$QURL" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible \
    --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible]' --output text | tr -d '\r' | tr '\t' '/')
  DIED_LOG=$(AWSF logs filter-log-events --log-group-name /aws/lambda/notification-sender --start-time "$STARTED_MS" --query 'events[].message' --output text \
    | tr '\t' '\n' | grep "$E" | grep -o '"message":"previous attempt did not finish[^"]*","applicationId":"[^"]*","attempt":[0-9]*' | sed 's/"applicationId":"[^"]*",//')
  STATUS="emailStatus $(app_field "$E" emailStatus), email_failed $BEFORE_F -> $(count_action email_failed), queue visible/in flight $INQ, DLQ $DLQ_BEFORE -> $(dlq_count), log: $DIED_LOG"
  [ -n "$DIED_HANDLE" ] && [ "$(app_field "$E" emailStatus)" = failed ] && [ "$(count_action email_failed)" -eq $((BEFORE_F + 1)) ] \
    && [ "$INQ" = 0/0 ] && [ "$(dlq_count)" = "$DLQ_BEFORE" ] && echo "$DIED_LOG" | grep -q '"attempt":2' && ok=ok || ok=no
  result T-ADM-83 "through SQS: a retry after a dead attempt marks failed, the message is deleted, nothing in the DLQ, no second send" $ok

  # T-ADM-79: no Brevo key or key header in the sender's log, no email address in the email audit rows
  AWSF logs filter-log-events --log-group-name /aws/lambda/notification-sender --start-time "$STARTED_MS" \
    --query 'events[].message' --output text > "$TMP/sender-log.txt" 2>/dev/null
  AWSF dynamodb query --table-name AuditLog --key-condition-expression '#a = :a' --expression-attribute-names '{"#a":"action"}' \
    --expression-attribute-values '{":a":{"S":"email_failed"}}' --output json > "$TMP/email-audit.json"
  AWSF dynamodb query --table-name AuditLog --key-condition-expression '#a = :a' --expression-attribute-names '{"#a":"action"}' \
    --expression-attribute-values '{":a":{"S":"email_sent"}}' --output json >> "$TMP/email-audit.json"
  STATUS="sender log lines $(tr '\t' '\n' < "$TMP/sender-log.txt" | grep -c '"fn"'), key-like text $(grep -ciE 'xkeysib-|api-key' "$TMP/sender-log.txt"), '@' in email audit rows $(grep -c '@' "$TMP/email-audit.json")"
  [ "$(tr '\t' '\n' < "$TMP/sender-log.txt" | grep -c '"fn"')" -gt 0 ] && ! grep -qiE 'xkeysib-|api-key' "$TMP/sender-log.txt" \
    && ! grep -q '@' "$TMP/email-audit.json" && ok=ok || ok=no
  result T-ADM-79 "sender log has no Brevo key or api-key header; email audit rows have no email address" $ok

  for a in "${SEEDED_APPS[@]}"; do AWSF dynamodb delete-item --table-name Applications --key "{\"applicationId\":{\"S\":\"$a\"}}"; done
  take_messages
  LEFT=0; for a in "${SEEDED_APPS[@]}"; do [ "$(app_field "$a" status)" = None ] || LEFT=$((LEFT+1)); done
  KEYP=$(AWSF lambda get-function-configuration --function-name notification-sender --query Environment.Variables.BREVO_KEY_PARAM --output text | tr -d '\r')
  STATUS="BREVO_KEY_PARAM $KEYP, test applications left $LEFT"
  [ "$KEYP" = /scholarship/brevo-api-key ] && [ "$LEFT" = 0 ] && ok=ok || ok=no
  result T-ADM-81 "sender settings restored after the failure tests, email test applications deleted" $ok
else
  skip T-ADM-72 "notification-sender tests (72-81)" "need the AWS CLI"
fi

echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ]
