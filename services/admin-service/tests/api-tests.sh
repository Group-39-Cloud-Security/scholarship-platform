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

echo
echo "$PASS passed, $FAIL failed, $SKIP skipped"
[ "$FAIL" = 0 ]
