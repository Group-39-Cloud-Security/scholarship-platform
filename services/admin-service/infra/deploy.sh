#!/usr/bin/env bash
# Deploys admin-service to Floci. Run from services/admin-service (npm run deploy), or via platform/deploy-all.sh.
# Run npm install, npm run sync-shared and npm run zip first (deploy-all.sh does all of that).
# Owner: Mohamed Wael · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM), §8 (routes)
# Safe to re-run: every step checks whether the thing already exists, and updates it if it does.
#
# Built step by step. Still to come:
#   - SSM /scholarship/brevo-api-key from local .env,
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
  aws dynamodb wait table-exists --table-name Scholarships   # don't go on until it is ACTIVE
  echo "created table Scholarships"
else
  echo "table Scholarships exists"
fi

# ---------- 1b. LOCAL TEST FIXTURE: Applications table ------------------------------------------------
# Applications belongs to application-service (Khalil, CLAUDE.md §5). It is created here ONLY so admin-service's
# decision step can be tested on Floci before his deploy.sh exists. Same key and indexes as §5, and it is only
# created if missing, so his script's table wins once it runs first.
# REMOVE THIS WHOLE SECTION when services/application-service/infra/deploy.sh creates the table.
if ! aws dynamodb describe-table --table-name Applications >/dev/null 2>&1; then
  aws dynamodb create-table --table-name Applications \
    --attribute-definitions AttributeName=applicationId,AttributeType=S AttributeName=studentId,AttributeType=S \
      AttributeName=scholarshipId,AttributeType=S AttributeName=status,AttributeType=S AttributeName=submittedAt,AttributeType=S \
    --key-schema AttributeName=applicationId,KeyType=HASH \
    --global-secondary-indexes '[
      {"IndexName":"studentId-index","KeySchema":[{"AttributeName":"studentId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"scholarshipId-index","KeySchema":[{"AttributeName":"scholarshipId","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"status-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws dynamodb wait table-exists --table-name Applications
  echo "created table Applications (LOCAL TEST FIXTURE, owned by application-service)"
else
  echo "table Applications exists"
fi
# ---------- end of LOCAL TEST FIXTURE ----------------------------------------------------------------

# ---------- 1c. SQS: notifications-dlq, then notifications with a redrive policy (§2, §6 Deciding) ----------
# A decision email message that fails 3 times (notification-sender throws) moves to notifications-dlq instead of
# being retried forever or lost. Visibility timeout 90 s = 6 × the sender's 15 s Lambda timeout (AWS guidance for
# SQS event sources), so a message isn't handed out again while a sender is still working on it.
# $1 queue name, $2 attributes JSON. Creates the queue, or re-applies the attributes so edits apply. Prints the URL.
ensure_queue() {
  local url
  url=$(aws sqs get-queue-url --queue-name "$1" --query QueueUrl --output text 2>/dev/null | tr -d '\r' || true)
  if [ -z "$url" ] || [ "$url" = "None" ]; then
    url=$(aws sqs create-queue --queue-name "$1" --attributes "$2" --query QueueUrl --output text | tr -d '\r')
    echo "created queue $1" >&2
  else
    aws sqs set-queue-attributes --queue-url "$url" --attributes "$2"
    echo "queue $1 exists (attributes re-applied)" >&2
  fi
  echo "$url"
}
DLQ_URL=$(ensure_queue notifications-dlq '{"MessageRetentionPeriod":"1209600"}')   # keep failed messages 14 days
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn \
  --query Attributes.QueueArn --output text | tr -d '\r')
QUEUE_ATTRS=$(printf '{"VisibilityTimeout":"90","RedrivePolicy":"{\\"deadLetterTargetArn\\":\\"%s\\",\\"maxReceiveCount\\":\\"3\\"}"}' "$DLQ_ARN")
QUEUE_URL=$(ensure_queue notifications "$QUEUE_ATTRS")

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
ADMIN_ENV=$(printf '{"Variables":{"NODE_ENV":"production","CORS_ORIGINS":"%s","ALLOWED_DOMAINS":"%s","SCHOLARSHIPS_TABLE":"Scholarships","APPLICATIONS_TABLE":"Applications","REVIEWS_TABLE":"Reviews","USERS_TABLE":"Users","AUDIT_TABLE":"AuditLog","JWT_SECRET_PARAM":"/scholarship/jwt-secret","NOTIFICATIONS_QUEUE_URL":"%s"}}' "$CORS_ORIGINS" "$ALLOWED_DOMAINS" "$QUEUE_URL")

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

# $1 = route key, e.g. "GET /api/health". Creates the route, or checks that an existing one points at
# this Lambda: a route left on a deleted integration (or another one for admin-service) is re-pointed,
# a route that belongs to another Lambda stops the script instead of being taken over.
ensure_route() {
  local id target other uri
  # tr: aws.exe on Windows ends lines with \r, which read would keep and the comparison below would fail on
  read -r id target < <(aws apigatewayv2 get-routes --api-id "$API_ID" \
    --query "Items[?RouteKey=='$1'] | [0].[RouteId, Target]" --output text | tr -d '\r')
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" \
      --target "integrations/$INTEGRATION_ID" >/dev/null
    echo "created route $1"
    return
  fi
  [ "$target" = "integrations/$INTEGRATION_ID" ] && return
  other="${target#integrations/}"
  uri=$(aws apigatewayv2 get-integration --api-id "$API_ID" --integration-id "$other" \
    --query IntegrationUri --output text 2>/dev/null || echo "")
  if [ -n "$uri" ] && [ "$uri" != "None" ] && [ "$uri" != "$ADMIN_ARN" ]; then
    echo "ERROR: route $1 already points at $uri, not admin-service. Fix it by hand." >&2
    exit 1
  fi
  aws apigatewayv2 update-route --api-id "$API_ID" --route-id "$id" \
    --target "integrations/$INTEGRATION_ID" >/dev/null
  echo "fixed route $1 (was ${target:-no target})"
}

for key in \
  "GET /api/health" \
  "POST /api/admin/scholarships" \
  "PUT /api/admin/scholarships/{id}" \
  "PATCH /api/admin/scholarships/{id}/status"; do
  ensure_route "$key"
done
# Every call with an Authorization header makes the browser send a preflight first (§2 CORS).
for path in /api/health /api/admin/scholarships /api/admin/scholarships/{id} /api/admin/scholarships/{id}/status; do
  ensure_route "OPTIONS $path"
done

# The role says what the function may do; this permission says who may call it (only our API).
# "Already exists" is fine only if the statement is for THIS API (the API id changes when it is recreated);
# any other error stops the script, so it never reports success while API Gateway can't invoke the Lambda.
ensure_invoke_permission() { # $1 = function name
  local source_arn="arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" out
  add() {
    aws lambda add-permission --function-name "$1" --statement-id apigateway-invoke \
      --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "$source_arn" 2>&1
  }
  if out=$(add "$1"); then
    echo "allowed API Gateway to invoke $1"
  elif echo "$out" | grep -q "ResourceConflictException"; then
    if aws lambda get-policy --function-name "$1" --query Policy --output text | grep -qF "$source_arn"; then
      echo "API Gateway already allowed to invoke $1"
    else
      aws lambda remove-permission --function-name "$1" --statement-id apigateway-invoke >/dev/null
      out=$(add "$1") || { echo "ERROR: add-permission failed: $out" >&2; exit 1; }
      echo "replaced old invoke permission on $1 with this API ($API_ID)"
    fi
  else
    echo "ERROR: add-permission failed: $out" >&2
    exit 1
  fi
}
ensure_invoke_permission admin-service

echo "admin-service deployed, API: $API_URL/api/health"
