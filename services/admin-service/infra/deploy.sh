#!/usr/bin/env bash
# Deploys admin-service to Floci. Run from services/admin-service (npm run deploy), or via platform/deploy-all.sh.
# Run npm install, npm run sync-shared and npm run zip first (deploy-all.sh does all of that).
# Owner: Mohamed Wael · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM), §8 (routes)
# Safe to re-run: every step checks whether the thing already exists, and updates it if it does.
#
# Built step by step. Still to come:
#   - SQS notifications-dlq + notifications (redrive, maxReceiveCount 3), SSM /scholarship/brevo-api-key from local .env,
#     notification-sender role + Lambda + SQS event source mapping (step 8)
#   - the admin routes from §8, added in the step that builds each one
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
SERVICE_DIR="$(cd "$HERE/.." && pwd)"
source "$HERE/../../../platform/vars.sh"   # gives $API_ID, $API_URL, $CORS_ORIGINS

# MSYS_NO_PATHCONV stops Git Bash translating paths for the Windows aws.exe, so pass C:/... paths
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
IAM_DIR="$(winpath "$HERE/iam")"

REGION=us-east-1
ACCOUNT=000000000000
ALLOWED_DOMAINS="${ALLOWED_DOMAINS:-example-university.edu}"
[ -n "$API_ID" ] && [ "$API_ID" != "None" ] || { echo "API scholarship-api not found: run platform/shared.sh first."; exit 1; }
[ -f "$SERVICE_DIR/lambda.zip" ] || { echo "Missing lambda.zip: run npm install && npm run sync-shared && npm run zip first."; exit 1; }

# ---------- 1. Scholarships table (PK scholarshipId; GSI status-deadline-index: PK status, SK deadline) ----------
# The index lets students list published scholarships by deadline without a Scan (§5).
if ! aws dynamodb describe-table --table-name Scholarships >/dev/null 2>&1; then
  aws dynamodb create-table --table-name Scholarships \
    --attribute-definitions AttributeName=scholarshipId,AttributeType=S \
      AttributeName=status,AttributeType=S AttributeName=deadline,AttributeType=S \
    --key-schema AttributeName=scholarshipId,KeyType=HASH \
    --global-secondary-indexes '[{"IndexName":"status-deadline-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"deadline","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "created table Scholarships"
else
  echo "table Scholarships exists"
fi

# ---------- 2. IAM role (least privilege, policy in infra/iam/) ----------
ensure_role() { # $1 = role name. Creates it if missing, then (re)writes its inline policy so edits apply.
  if ! aws iam get-role --role-name "$1" >/dev/null 2>&1; then
    aws iam create-role --role-name "$1" \
      --assume-role-policy-document "file://$IAM_DIR/$1-trust.json" >/dev/null
    echo "created role $1"
  fi
  aws iam put-role-policy --role-name "$1" --policy-name "$1-policy" \
    --policy-document "file://$IAM_DIR/$1-policy.json"
}
ensure_role admin-service-role

# ---------- 3. Lambda function ----------
# $1 name, $2 handler, $3 zip file, $4 environment JSON
ensure_function() {
  local zip; zip="$(winpath "$SERVICE_DIR/$3")"
  if aws lambda get-function --function-name "$1" >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$1" --zip-file "fileb://$zip" >/dev/null
    aws lambda wait function-updated --function-name "$1" 2>/dev/null || sleep 2
    aws lambda update-function-configuration --function-name "$1" --runtime nodejs24.x --handler "$2" \
      --environment "$4" --timeout 15 --memory-size 256 >/dev/null
    echo "updated function $1"
  else
    aws lambda create-function --function-name "$1" --runtime nodejs24.x --handler "$2" \
      --role "arn:aws:iam::$ACCOUNT:role/$1-role" --zip-file "fileb://$zip" \
      --environment "$4" --timeout 15 --memory-size 256 >/dev/null
    echo "created function $1"
  fi
}

# Only the variables admin-service needs (§4). No endpoints or keys: Floci injects AWS_ENDPOINT_URL.
# NOTIFICATIONS_QUEUE_URL is added in step 8, when the queue exists.
ADMIN_ENV=$(printf '{"Variables":{"NODE_ENV":"production","CORS_ORIGINS":"%s","ALLOWED_DOMAINS":"%s","SCHOLARSHIPS_TABLE":"Scholarships","APPLICATIONS_TABLE":"Applications","REVIEWS_TABLE":"Reviews","USERS_TABLE":"Users","AUDIT_TABLE":"AuditLog","JWT_SECRET_PARAM":"/scholarship/jwt-secret"}}' "$CORS_ORIGINS" "$ALLOWED_DOMAINS")

ensure_function admin-service src/lambda.handler lambda.zip "$ADMIN_ENV"
ADMIN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:admin-service"

# ---------- 4. API Gateway: one integration, exactly the §8 routes + an OPTIONS route per path ----------
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$ADMIN_ARN'].IntegrationId | [0]" --output text)
if [ -z "$INTEGRATION_ID" ] || [ "$INTEGRATION_ID" = "None" ]; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --integration-uri "$ADMIN_ARN" --payload-format-version 2.0 --query IntegrationId --output text)
  echo "created integration $INTEGRATION_ID"
fi

ensure_route() { # $1 = route key, e.g. "GET /api/health"
  local id
  id=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='$1'].RouteId | [0]" --output text)
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" \
      --target "integrations/$INTEGRATION_ID" >/dev/null
    echo "created route $1"
  fi
}

for key in \
  "GET /api/health"; do
  ensure_route "$key"
done
# Every call with an Authorization header makes the browser send a preflight first (§2 CORS).
for path in /api/health; do
  ensure_route "OPTIONS $path"
done

# The role says what the function may do; this permission says who may call it (only our API).
aws lambda add-permission --function-name admin-service --statement-id apigateway-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" >/dev/null 2>&1 \
  && echo "allowed API Gateway to invoke admin-service" || true

echo "admin-service deployed, API: $API_URL/api/health"
