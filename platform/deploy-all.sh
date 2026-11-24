#!/usr/bin/env bash
# Builds the whole app on Floci from this one repo (services/ holds the four backends). Safe to re-run.
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
for r in auth-service admin-service application-service review-service; do
  [ -d "$ROOT/services/$r" ] || { echo "Missing $ROOT/services/$r — pull main."; exit 1; }
done
aws sts get-caller-identity --query Account --output text | grep -q 000000000000 || { echo "Not on Floci (check AWS_PROFILE)."; exit 1; }

bash "$HERE/shared.sh"
for r in auth-service admin-service application-service review-service; do
  echo "== $r =="
  (cd "$ROOT/services/$r" && npm install --silent && npm run sync-shared && npm run zip && bash infra/deploy.sh)
done
bash "$HERE/seed.sh"
source "$HERE/vars.sh"
echo "API: $API_URL"
echo "Website: http://localhost:4566/scholarship-web/index.html"
