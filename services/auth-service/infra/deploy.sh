#!/usr/bin/env bash
# Deploys auth-service to Floci. Run from services/auth-service (npm run deploy), or via platform/deploy-all.sh.
# Run npm install, npm run sync-shared and npm run zip first (deploy-all.sh does all of that).
# Owner: Shared (lead: Mohamed Wael, reviewed by all) · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM), §8
# Safe to re-run: every step checks whether the thing already exists, and updates it if it does.
#
# Creates: Users, LoginAttempts (TTL on expiresAt), auth-service-role, the auth-service Lambda and its 4 routes
# (+ OPTIONS). The login_failed metric filter and alarm are NOT here: review-service's deploy.sh owns them (§3).
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
FN=auth-service
FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN"
ALLOWED_DOMAINS="${ALLOWED_DOMAINS:-example-university.edu}"
[ -n "$API_ID" ] && [ "$API_ID" != "None" ] || { echo "API scholarship-api not found: run platform/shared.sh first."; exit 1; }
[ -f "$SERVICE_DIR/lambda.zip" ] || { echo "Missing lambda.zip: run npm install && npm run sync-shared && npm run zip first."; exit 1; }

# ---------- 1. Users (PK userId; GSI email-index: PK email) ----------
# email-index projects everything: login looks the user up by email and needs passwordHash, role and status.
if ! aws dynamodb describe-table --table-name Users >/dev/null 2>&1; then
  aws dynamodb create-table --table-name Users \
    --attribute-definitions AttributeName=userId,AttributeType=S AttributeName=email,AttributeType=S \
    --key-schema AttributeName=userId,KeyType=HASH \
    --global-secondary-indexes '[{"IndexName":"email-index","KeySchema":[{"AttributeName":"email","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}}]' \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name Users   # don't go on until it is ACTIVE
  echo "created table Users"
else
  echo "table Users exists"
fi

# ---------- 2. LoginAttempts (PK emailIp = <email>#<ip>), DynamoDB TTL deletes rows after expiresAt ----------
if ! aws dynamodb describe-table --table-name LoginAttempts >/dev/null 2>&1; then
  aws dynamodb create-table --table-name LoginAttempts \
    --attribute-definitions AttributeName=emailIp,AttributeType=S \
    --key-schema AttributeName=emailIp,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name LoginAttempts
  echo "created table LoginAttempts"
else
  echo "table LoginAttempts exists"
fi
# Turning TTL on twice is an error, so only when it is not on yet.
TTL_STATUS=$(aws dynamodb describe-time-to-live --table-name LoginAttempts \
  --query TimeToLiveDescription.TimeToLiveStatus --output text 2>/dev/null | tr -d '\r' || true)
if [ "$TTL_STATUS" = "ENABLED" ] || [ "$TTL_STATUS" = "ENABLING" ]; then
  echo "TTL on LoginAttempts.expiresAt already on"
elif aws dynamodb update-time-to-live --table-name LoginAttempts \
     --time-to-live-specification Enabled=true,AttributeName=expiresAt >/dev/null; then
  echo "TTL on LoginAttempts.expiresAt turned on"
else
  echo "WARNING: could not turn on TTL for LoginAttempts (check Floci support); old rows will stay until deleted."
fi

# ---------- 3. IAM role (least privilege, policy in infra/iam/) ----------
if ! aws iam get-role --role-name "$FN-role" >/dev/null 2>&1; then
  aws iam create-role --role-name "$FN-role" \
    --assume-role-policy-document "file://$IAM_DIR/$FN-role-trust.json" >/dev/null
  echo "created role $FN-role"
fi
aws iam put-role-policy --role-name "$FN-role" --policy-name "$FN-role-policy" \
  --policy-document "file://$IAM_DIR/$FN-role-policy.json"   # rewritten every run, so edits apply

# ---------- 4. Lambda function ----------
# Only the variables auth-service needs (§4). No endpoints or keys: Floci injects AWS_ENDPOINT_URL.
AUTH_ENV=$(printf '{"Variables":{"NODE_ENV":"production","CORS_ORIGINS":"%s","ALLOWED_DOMAINS":"%s","USERS_TABLE":"Users","LOGIN_ATTEMPTS_TABLE":"LoginAttempts","AUDIT_TABLE":"AuditLog","JWT_SECRET_PARAM":"/scholarship/jwt-secret"}}' "$CORS_ORIGINS" "$ALLOWED_DOMAINS")
ZIP="$(winpath "$SERVICE_DIR/lambda.zip")"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$ZIP" >/dev/null
  aws lambda wait function-updated --function-name "$FN" 2>/dev/null || sleep 2
  aws lambda update-function-configuration --function-name "$FN" --runtime nodejs24.x --handler src/lambda.handler \
    --environment "$AUTH_ENV" --timeout 15 --memory-size 256 >/dev/null
  echo "updated function $FN"
else
  aws lambda create-function --function-name "$FN" --runtime nodejs24.x --handler src/lambda.handler \
    --role "arn:aws:iam::$ACCOUNT:role/$FN-role" --zip-file "fileb://$ZIP" \
    --environment "$AUTH_ENV" --timeout 15 --memory-size 256 >/dev/null
  echo "created function $FN"
fi

# ---------- 5. API Gateway: one integration, exactly the §8 routes + an OPTIONS route per path ----------
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$FN_ARN'].IntegrationId | [0]" --output text | tr -d '\r')
if [ -z "$INTEGRATION_ID" ] || [ "$INTEGRATION_ID" = "None" ]; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --integration-uri "$FN_ARN" --payload-format-version 2.0 --query IntegrationId --output text | tr -d '\r')
  echo "created integration $INTEGRATION_ID"
fi

# $1 = route key. Creates the route, or checks an existing one points at this Lambda: a route left on a deleted
# integration is re-pointed, a route that belongs to another Lambda stops the script instead of being taken over.
ensure_route() {
  local id target other uri
  read -r id target < <(aws apigatewayv2 get-routes --api-id "$API_ID" \
    --query "Items[?RouteKey=='$1'] | [0].[RouteId, Target]" --output text | tr -d '\r')
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" --target "integrations/$INTEGRATION_ID" >/dev/null
    echo "created route $1"
    return
  fi
  [ "$target" = "integrations/$INTEGRATION_ID" ] && return
  other="${target#integrations/}"
  uri=$(aws apigatewayv2 get-integration --api-id "$API_ID" --integration-id "$other" \
    --query IntegrationUri --output text 2>/dev/null | tr -d '\r' || echo "")
  if [ -n "$uri" ] && [ "$uri" != "None" ] && [ "$uri" != "$FN_ARN" ]; then
    echo "ERROR: route $1 already points at $uri, not $FN. Fix it by hand." >&2
    exit 1
  fi
  aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$id" --target "integrations/$INTEGRATION_ID" >/dev/null
  echo "fixed route $1 (was ${target:-no target})"
}
for key in "POST /api/auth/register" "POST /api/auth/login" "PUT /api/auth/password" "GET /api/auth/me"; do
  ensure_route "$key"
done
# Every call with an Authorization header (or a JSON body) makes the browser send a preflight first (§2 CORS).
for path in /api/auth/register /api/auth/login /api/auth/password /api/auth/me; do
  ensure_route "OPTIONS $path"
done

# ---------- 6. Only our API may invoke the function ----------
# "Already exists" is fine only if the statement is for THIS API (the id changes when the API is recreated).
SOURCE_ARN="arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*"
add_permission() {
  aws lambda add-permission --function-name "$FN" --statement-id apigateway-invoke \
    --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "$SOURCE_ARN" 2>&1
}
if out=$(add_permission); then
  echo "allowed API Gateway to invoke $FN"
elif echo "$out" | grep -q "ResourceConflictException"; then
  if aws lambda get-policy --function-name "$FN" --query Policy --output text | grep -qF "$SOURCE_ARN"; then
    echo "API Gateway already allowed to invoke $FN"
  else
    aws lambda remove-permission --function-name "$FN" --statement-id apigateway-invoke >/dev/null
    out=$(add_permission) || { echo "ERROR: add-permission failed: $out" >&2; exit 1; }
    echo "replaced old invoke permission on $FN with this API ($API_ID)"
  fi
else
  echo "ERROR: add-permission failed: $out" >&2
  exit 1
fi

echo "auth-service deployed, API: $API_URL/api/auth"
