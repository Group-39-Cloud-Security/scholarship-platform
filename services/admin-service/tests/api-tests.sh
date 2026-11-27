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
trap 'rm -rf "$TMP"' EXIT
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

echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ]
