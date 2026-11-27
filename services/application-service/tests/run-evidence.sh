#!/usr/bin/env bash
# Runs ALL application-service API tests through API Gateway on Floci and saves the output as evidence.
# Owner: Mohamed Khalil.
# Usage (Git Bash, from the repo root, after platform/shared.sh and this service's deploy):
#   bash services/application-service/tests/run-evidence.sh
# Writes evidence/application-api-tests-floci.txt (override with EVIDENCE_FILE=...). API_URL may be set to override.
set -u
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY  # use the floci profile only (no "two sets of credentials" warnings)
cd "$(dirname "$0")/.."                           # services/application-service
REPO_ROOT=$(cd ../.. && pwd)

if [ -z "${API_URL:-}" ]; then
  source ../../platform/vars.sh
  API_URL=$(echo "$API_URL" | tr -d '\r')
fi
case "$API_URL" in *None*|"") echo "No API found: run platform/shared.sh first."; exit 1 ;; esac
OUT=${EVIDENCE_FILE:-$REPO_ROOT/evidence/application-api-tests-floci.txt}

echo "Making sure the test scholarships exist..."
node scripts/test-scholarships.js >/dev/null || { echo "Could not write test scholarships (is Floci running?)"; exit 1; }

# The first call to a Lambda on Floci starts its container (slow the very first time). Wait until it answers.
echo "Waking up the Lambda behind $API_URL ..."
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 -H 'Authorization: Bearer test-student-1' "$API_URL/api/scholarships")
  [ "$code" = "200" ] && break
  sleep 3
done
[ "$code" = "200" ] || { echo "The API never answered 200 (last: $code). Check deploy.sh output and Floci logs."; exit 1; }

CODE=$(git rev-parse --short HEAD)
git diff --quiet HEAD -- . || CODE="$CODE (with uncommitted changes)"
{
  echo "application-service API tests"
  echo "Date:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  case "$API_URL" in
    *execute-api*) echo "Target:  $API_URL (API Gateway HTTP API on Floci -> Lambda application-service)" ;;
    *)             echo "Target:  $API_URL (NOT API Gateway: local server, not valid as Floci evidence)" ;;
  esac
  echo "Code:    $CODE"
  echo
  echo "== tests/api-tests.js (T-APP-01 to T-APP-43)"
  API_URL=$API_URL node tests/api-tests.js 2>&1
  echo
  echo "== tests/concurrency-tests.js (T-APP-44 to T-APP-48)"
  API_URL=$API_URL node tests/concurrency-tests.js 2>&1
} | tr -d '\r' | tee "$OUT"

PASS=$(grep -cE '^PASS ' "$OUT"); FAIL=$(grep -cE '^FAIL ' "$OUT"); SKIP=$(grep -cE '^SKIP ' "$OUT")
printf '\n%s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIP" | tee -a "$OUT"
echo "Saved: $OUT"
