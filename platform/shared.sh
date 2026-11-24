#!/usr/bin/env bash
# Shared resources. Owner: Mohamed Wael · Rules: CLAUDE.md §2 "Who creates what"
# Safe to re-run: every step checks whether the thing already exists.
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
SITE_DIR="$HERE/../frontend"
BUCKET=scholarship-web

aws sts get-caller-identity --query Account --output text | grep -q 000000000000 \
  || { echo "Not on Floci (check AWS_PROFILE=floci and that Floci is running)."; exit 1; }

# ---------- 1. HTTP API scholarship-api, stage $default, throttling ----------
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='scholarship-api'].ApiId | [0]" --output text)
if [ -z "$API_ID" ] || [ "$API_ID" = "None" ]; then
  API_ID=$(aws apigatewayv2 create-api --name scholarship-api --protocol-type HTTP \
    --query ApiId --output text)
  echo "created API $API_ID"
else
  echo "API exists: $API_ID"
fi
if ! aws apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' >/dev/null 2>&1; then
  aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy \
    --default-route-settings ThrottlingBurstLimit=50,ThrottlingRateLimit=25 >/dev/null
  echo "created stage \$default (auto-deploy, throttling 25 req/s, burst 50)"
fi
API_URL="http://$API_ID.execute-api.localhost.floci.io:4566"

# ---------- 2. AuditLog table (PK action, SK sortKey = "<createdAt>#<logId>") ----------
if ! aws dynamodb describe-table --table-name AuditLog >/dev/null 2>&1; then
  aws dynamodb create-table --table-name AuditLog \
    --attribute-definitions AttributeName=action,AttributeType=S AttributeName=sortKey,AttributeType=S \
    --key-schema AttributeName=action,KeyType=HASH AttributeName=sortKey,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "created table AuditLog"
fi

# ---------- 3. JWT secret in SSM (random, never written to a file) ----------
if ! aws ssm get-parameter --name /scholarship/jwt-secret >/dev/null 2>&1; then
  JWT_SECRET=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
  aws ssm put-parameter --name /scholarship/jwt-secret --type SecureString --value "$JWT_SECRET" >/dev/null
  unset JWT_SECRET
  echo "created SSM /scholarship/jwt-secret"
fi

# ---------- 4. Website bucket + upload ----------
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3 mb "s3://$BUCKET" >/dev/null
  echo "created bucket $BUCKET"
fi

# Upload a staged copy so we never edit the tracked config.js
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -r "$SITE_DIR"/. "$STAGE"/
CONFIG="$STAGE/js/config.js"
if grep -q "__FLOCI_API__" "$CONFIG" 2>/dev/null; then
  sed -i "s|__FLOCI_API__|$API_URL|g" "$CONFIG"
elif ! grep -v '^[[:space:]]*//' "$CONFIG" 2>/dev/null | grep -q "FLOCI_API"; then
  printf "\nconst FLOCI_API = '%s';\n" "$API_URL" >> "$CONFIG"
fi

aws s3 sync "$STAGE" "s3://$BUCKET" --delete \
  --exclude "*.md" --exclude ".env*" --exclude "node_modules/*" --exclude "*.zip" >/dev/null
# Floci/S3 guesses content types badly: set the ones the browser needs
aws s3 cp "$STAGE" "s3://$BUCKET" --recursive --exclude "*" --include "*.css" \
  --content-type text/css --metadata-directive REPLACE >/dev/null
aws s3 cp "$STAGE" "s3://$BUCKET" --recursive --exclude "*" --include "*.js" \
  --content-type text/javascript --metadata-directive REPLACE >/dev/null
aws s3 cp "$STAGE" "s3://$BUCKET" --recursive --exclude "*" --include "*.html" \
  --content-type text/html --metadata-directive REPLACE >/dev/null

# Public can only read objects (s3:GetObject), nothing else
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "file://$HERE/s3-public-read-policy.json"

echo "shared resources ready"
echo "API:     $API_URL"
echo "Website: http://localhost:4566/$BUCKET/index.html"
