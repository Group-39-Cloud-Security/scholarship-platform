#!/usr/bin/env bash
# API tests for review-service with curl (the T-REV rows in docs/api-test-plan.md). Prints PASS/FAIL per check.
# Owner: Mohamed Hazem. Run from the repo root after platform/deploy-all.sh:
#   bash services/review-service/tests/api-tests.sh
# It first resets the test data (tests/local-test-data.sh) so every run starts the same.
# Save the output as evidence:  bash services/review-service/tests/api-tests.sh | tee evidence/review-api-tests.txt
# Options: --no-reset (keep the current data), API_URL=http://... to test another address.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }

RESET=yes
[ "${1:-}" = "--no-reset" ] && RESET=no

if [ -z "${API_URL:-}" ]; then
  source "$ROOT/platform/vars.sh" || { echo "Could not find the API (is Floci running?)"; exit 1; }
fi
if [ "$RESET" = yes ]; then
  echo "Resetting test data..."
  bash "$HERE/local-test-data.sh" >/dev/null || { echo "Test data reset failed"; exit 1; }
fi
echo "Testing $API_URL"
echo

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BODY="$(winpath "$TMP/body")"
HDRS="$(winpath "$TMP/headers")"
PASS=0
FAIL=0
STATUS=""

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

result() { # ID DESCRIPTION ok|no
  if [ "$3" = ok ]; then
    echo "PASS  $1  $2"; PASS=$((PASS + 1))
  else
    echo "FAIL  $1  $2   (got $STATUS: $(head -c 150 "$BODY" 2>/dev/null))"; FAIL=$((FAIL + 1))
  fi
}
expect() { [ "$STATUS" = "$3" ] && result "$1" "$2" ok || result "$1" "$2" no; }
has() { grep -q "$1" "$BODY"; }
header() { grep -qi "^$1" "$HDRS"; }
field() { grep -o "\"$1\":\"[^\"]*\"" "$BODY" | cut -d'"' -f4; }

# ---------- queue ----------
call GET /api/reviews/queue ""
expect T-REV-01 "queue without a token -> 401" 401
call GET /api/reviews/queue test-student-1
expect T-REV-02 "queue as a student -> 403" 403
call GET /api/reviews/queue test-reviewer
[ "$STATUS" = 200 ] && ! has '"essay"' && ! has '"studentEmail"' && ok=ok || ok=no
result T-REV-03 "queue as a reviewer -> 200, no essay or email" $ok

APPS=$(field applicationId)
APP1=$(echo "$APPS" | sed -n 1p)
APP2=$(echo "$APPS" | sed -n 2p)
if [ -z "$APP2" ]; then
  echo "Need at least 2 submitted applications. Run without --no-reset."; exit 1
fi

# ---------- claim ----------
call POST /api/reviews test-reviewer "applicationId=$APP1" text/plain
expect T-REV-04 "claim with text/plain -> 415" 415
call POST /api/reviews test-reviewer '{"applicationId":"../x"}'
expect T-REV-05 "claim with an invalid id -> 400" 400
call POST /api/reviews test-reviewer '{"applicationId":"00000000-0000-4000-8000-000000000000"}'
expect T-REV-06 "claim an unknown id -> 404" 404
call POST /api/reviews test-reviewer "{\"applicationId\":\"$APP1\",\"reviewerId\":\"someone-else\"}"
expect T-REV-07 "claim (reviewerId in the body is ignored) -> 201" 201
call POST /api/reviews test-reviewer "{\"applicationId\":\"$APP1\"}"
expect T-REV-08 "claim the same one again -> 409" 409

call GET /api/reviews/mine test-reviewer
[ "$STATUS" = 200 ] && has "$APP1" && ok=ok || ok=no
result MINE "my reviews lists the claim -> 200" $ok

# ---------- open ----------
call GET "/api/reviews/$APP2" test-reviewer
expect T-REV-10 "open an application I didn't claim -> 404" 404
call GET "/api/reviews/$APP1" test-reviewer
[ "$STATUS" = 200 ] && ! has '"studentEmail"' && ! has '"studentId"' && ok=ok || ok=no
result OPEN "open my claim -> 200, no student id or email" $ok

CRITERIA=$(field criterionId)
GOOD=""; BAD=""; first=yes
for c in $CRITERIA; do
  GOOD="$GOOD\"$c\":8,"
  if [ $first = yes ]; then BAD="$BAD\"$c\":11,"; first=no; else BAD="$BAD\"$c\":8,"; fi
done
GOOD="{\"scores\":{${GOOD%,}},\"totalScore\":100}"
BAD="{\"scores\":{${BAD%,}}}"

call GET "/api/reviews/$APP1/pdf" test-reviewer
[ "$STATUS" = 200 ] && has '"expiresIn":300' && ok=ok || ok=no
result T-REV-19 "PDF link -> 200, valid 5 minutes" $ok

# ---------- score ----------
call PUT "/api/reviews/$APP1" test-reviewer "$BAD"
expect T-REV-11 "score out of range -> 400" 400
call PUT "/api/reviews/$APP1" test-reviewer "$GOOD"
[ "$STATUS" = 200 ] && has '"totalScore":80' && ok=ok || ok=no
result T-REV-12 "score -> 200, server total 80 (the 100 we sent is ignored)" $ok
call PUT "/api/reviews/$APP1" test-reviewer "$GOOD"
expect T-REV-13 "score again -> 409 (final)" 409

# ---------- release ----------
call POST /api/reviews test-reviewer "{\"applicationId\":\"$APP2\"}"
expect CLAIM2 "claim a second application -> 201" 201
call PUT "/api/reviews/$APP2" test-reviewer '{"flagged":true,"flagReason":"lazy"}'
expect T-REV-14 "flag with a bad reason -> 400" 400
call DELETE "/api/reviews/$APP2" test-student-1
expect T-REV-18 "student tries to release -> 403" 403
call DELETE "/api/reviews/$APP2" test-reviewer
expect T-REV-16 "release my claim -> 204" 204
call POST /api/reviews test-reviewer "{\"applicationId\":\"$APP2\"}"
call DELETE "/api/reviews/$APP2" test-admin
expect T-REV-17 "admin releases a claim -> 204" 204
call DELETE "/api/reviews/$APP2" test-admin
expect T-REV-17b "admin releases it again -> 409" 409

# ---------- flag ----------
call POST /api/reviews test-reviewer "{\"applicationId\":\"$APP2\"}"
call PUT "/api/reviews/$APP2" test-reviewer '{"flagged":true,"flagReason":"ineligible","flagNote":"GPA in the PDF is lower"}'
[ "$STATUS" = 200 ] && has '"flagged":true' && has '"totalScore":null' && ok=ok || ok=no
result T-REV-15 "flag -> 200, flagged with no score" $ok

# ---------- browser and headers ----------
call OPTIONS /api/reviews/queue "" "" "" "Origin: http://localhost:4566" \
  "Access-Control-Request-Method: GET" "Access-Control-Request-Headers: authorization"
[ "$STATUS" = 204 ] && header "access-control-allow-origin: http://localhost:4566" && ok=ok || ok=no
result T-REV-21 "preflight from our website -> 204, origin allowed" $ok
call GET /api/reviews/queue test-reviewer "" "" "Origin: http://evil.example"
[ "$STATUS" = 200 ] && ! header "access-control-allow-origin" && ok=ok || ok=no
result T-REV-22 "other website -> no CORS header" $ok
call GET /api/reviews/queue test-reviewer
header "x-content-type-options: nosniff" && header "x-frame-options: DENY" \
  && header "content-security-policy: default-src 'none'" && header "cache-control: no-store" \
  && ! header "x-powered-by" && ok=ok || ok=no
result T-REV-23 "security headers (nosniff, DENY, CSP, no-store, no X-Powered-By)" $ok

# ---------- hourly job ----------
if [ "$RESET" = yes ] && command -v aws >/dev/null; then
  (cd "$TMP" && aws lambda invoke --function-name release-expired-claims --profile floci job.json >/dev/null 2>&1)
  cp "$TMP/job.json" "$BODY" 2>/dev/null || echo "" > "$BODY"
  STATUS="job"
  has '"released":1' && ok=ok || ok=no
  result T-REV-20 "expiry job releases the 49 h old claim" $ok
fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
