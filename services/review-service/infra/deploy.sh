#!/usr/bin/env bash
# Deploys review-service to Floci. Run from services/review-service (npm run deploy), or via platform/deploy-all.sh.
# Run npm install, npm run sync-shared and npm run zip first (deploy-all.sh does all of that).
# Owner: Mohamed Hazem · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM), §8 (routes)
# Safe to re-run: every step checks whether the thing already exists, and updates it if it does.
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
[ -n "$API_ID" ] && [ "$API_ID" != "None" ] || { echo "API scholarship-api not found: run platform/shared.sh first."; exit 1; }
for z in lambda.zip release-expired-claims.zip; do
  [ -f "$SERVICE_DIR/$z" ] || { echo "Missing $z: run npm install && npm run sync-shared && npm run zip first."; exit 1; }
done

# ---------- 1. Reviews table (PK applicationId; GSI reviewerId-index: PK reviewerId, SK submittedAt) ----------
if ! aws dynamodb describe-table --table-name Reviews >/dev/null 2>&1; then
  aws dynamodb create-table --table-name Reviews \
    --attribute-definitions AttributeName=applicationId,AttributeType=S \
      AttributeName=reviewerId,AttributeType=S AttributeName=submittedAt,AttributeType=S \
    --key-schema AttributeName=applicationId,KeyType=HASH \
    --global-secondary-indexes '[{"IndexName":"reviewerId-index","KeySchema":[{"AttributeName":"reviewerId","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "created table Reviews"
else
  echo "table Reviews exists"
fi

# ---------- 2. IAM roles: one per function + the scheduler's (least privilege, policies in infra/iam/) ----------
ensure_role() { # $1 = role name. Creates it if missing, then (re)writes its inline policy so edits apply.
  if ! aws iam get-role --role-name "$1" >/dev/null 2>&1; then
    aws iam create-role --role-name "$1" \
      --assume-role-policy-document "file://$IAM_DIR/$1-trust.json" >/dev/null
    echo "created role $1"
  fi
  aws iam put-role-policy --role-name "$1" --policy-name "$1-policy" \
    --policy-document "file://$IAM_DIR/$1-policy.json"
}
ensure_role review-service-role
ensure_role release-expired-claims-role
ensure_role scheduler-invoke-role

# ---------- 3. Lambda functions ----------
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

# Each function gets only the variables it needs (§4). No endpoints or keys: Floci injects AWS_ENDPOINT_URL.
REVIEW_ENV=$(printf '{"Variables":{"NODE_ENV":"production","CORS_ORIGINS":"%s","REVIEWS_TABLE":"Reviews","APPLICATIONS_TABLE":"Applications","SCHOLARSHIPS_TABLE":"Scholarships","USERS_TABLE":"Users","AUDIT_TABLE":"AuditLog","DOCUMENTS_BUCKET":"scholarship-documents","JWT_SECRET_PARAM":"/scholarship/jwt-secret"}}' "$CORS_ORIGINS")
JOB_ENV='{"Variables":{"NODE_ENV":"production","APPLICATIONS_TABLE":"Applications","AUDIT_TABLE":"AuditLog"}}'

ensure_function review-service src/lambda.handler lambda.zip "$REVIEW_ENV"
ensure_function release-expired-claims handler.handler release-expired-claims.zip "$JOB_ENV"

REVIEW_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:review-service"
JOB_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:release-expired-claims"

# ---------- 4. API Gateway: one integration, exactly the §8 routes + an OPTIONS route per path ----------
INTEGRATION_ID=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$REVIEW_ARN'].IntegrationId | [0]" --output text)
if [ -z "$INTEGRATION_ID" ] || [ "$INTEGRATION_ID" = "None" ]; then
  INTEGRATION_ID=$(aws apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --integration-uri "$REVIEW_ARN" --payload-format-version 2.0 --query IntegrationId --output text)
  echo "created integration $INTEGRATION_ID"
fi

ensure_route() { # $1 = route key, e.g. "GET /api/reviews/queue"
  local id
  id=$(aws apigatewayv2 get-routes --api-id "$API_ID" --query "Items[?RouteKey=='$1'].RouteId | [0]" --output text)
  if [ -z "$id" ] || [ "$id" = "None" ]; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$1" \
      --target "integrations/$INTEGRATION_ID" >/dev/null
    echo "created route $1"
  fi
}

for key in \
  "GET /api/reviews/queue" \
  "POST /api/reviews" \
  "GET /api/reviews/mine" \
  "GET /api/reviews/{applicationId}" \
  "PUT /api/reviews/{applicationId}" \
  "DELETE /api/reviews/{applicationId}" \
  "GET /api/reviews/{applicationId}/pdf"; do
  ensure_route "$key"
done
# Every call carries an Authorization header, so the browser sends a preflight first (§2 CORS).
for path in /api/reviews /api/reviews/queue /api/reviews/mine /api/reviews/{applicationId} /api/reviews/{applicationId}/pdf; do
  ensure_route "OPTIONS $path"
done

# The role says what the function may do; this permission says who may call it (only our API).
aws lambda add-permission --function-name review-service --statement-id apigateway-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" >/dev/null 2>&1 \
  && echo "allowed API Gateway to invoke review-service" || true

# ---------- 5. EventBridge Scheduler: release-expired-claims every hour ----------
SCHEDULE_TARGET=$(printf '{"Arn":"%s","RoleArn":"arn:aws:iam::%s:role/scheduler-invoke-role","Input":"{}"}' "$JOB_ARN" "$ACCOUNT")
if aws scheduler get-schedule --name release-expired-claims-hourly >/dev/null 2>&1; then
  aws scheduler update-schedule --name release-expired-claims-hourly --schedule-expression "rate(1 hour)" \
    --flexible-time-window Mode=OFF --target "$SCHEDULE_TARGET" >/dev/null && echo "updated schedule release-expired-claims-hourly"
elif aws scheduler create-schedule --name release-expired-claims-hourly --schedule-expression "rate(1 hour)" \
    --flexible-time-window Mode=OFF --target "$SCHEDULE_TARGET" >/dev/null 2>&1; then
  echo "created schedule release-expired-claims-hourly"
else
  echo "WARNING: could not create the EventBridge schedule (is Scheduler supported on this Floci?)."
  echo "         Test the job by hand: aws lambda invoke --function-name release-expired-claims out.json"
fi

# ---------- 6. CloudWatch: count login_failed lines from auth-service, alarm on > 20 in 5 minutes ----------
# The log group may not exist until auth-service has logged once, so create it (ignore "already exists").
aws logs create-log-group --log-group-name /aws/lambda/auth-service >/dev/null 2>&1 || true
if aws logs put-metric-filter --log-group-name /aws/lambda/auth-service --filter-name login-failed \
     --filter-pattern '{ $.action = "login_failed" }' \
     --metric-transformations metricName=LoginFailed,metricNamespace=Group39/Security,metricValue=1,defaultValue=0 \
   && aws cloudwatch put-metric-alarm --alarm-name login-failed-spike \
     --alarm-description "More than 20 failed logins in 5 minutes" \
     --namespace Group39/Security --metric-name LoginFailed --statistic Sum \
     --period 300 --evaluation-periods 1 --threshold 20 --comparison-operator GreaterThanThreshold \
     --treat-missing-data notBreaching; then
  echo "metric filter login-failed + alarm login-failed-spike ready"
else
  echo "WARNING: could not create the CloudWatch metric filter/alarm (check Floci support)."
fi

echo "review-service deployed, API: $API_URL/api/reviews"
