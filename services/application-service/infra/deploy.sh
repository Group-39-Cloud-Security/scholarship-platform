#!/usr/bin/env bash
# Deploys application-service to Floci. Run from anywhere (it moves into the service folder), or via platform/deploy-all.sh.
# Needs: Floci running, platform/shared.sh already run (it creates the API and the AuditLog table), and
#        "npm install && npm run sync-shared && npm run zip" done in this folder.
# Owner: Mohamed Khalil · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM), §8 (routes)
# Safe to re-run: every step checks first or updates in place.
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
cd "$(dirname "$0")/.."            # services/application-service
source ../../platform/vars.sh      # gives $API_ID, $API_URL, $CORS_ORIGINS

# aws.exe on Windows ends text output with \r\n; strip the \r so it doesn't end up inside ids.
awst() { aws "$@" --output text | tr -d '\r'; }

FN=application-service
ROLE=$FN-role
TABLE=Applications
BUCKET=scholarship-documents
REGION=us-east-1
ACCOUNT=000000000000
FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE"

API_ID=$(echo "$API_ID" | tr -d '\r')
[ -n "$API_ID" ] && [ "$API_ID" != "None" ] || { echo "scholarship-api not found: run platform/shared.sh first."; exit 1; }
[ -f lambda.zip ] || { echo "lambda.zip missing: run npm install && npm run sync-shared && npm run zip first."; exit 1; }

# ---------- 1. Applications table + its 3 indexes (CLAUDE.md §5) ----------
if ! aws dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE" \
    --attribute-definitions \
      AttributeName=applicationId,AttributeType=S AttributeName=studentId,AttributeType=S \
      AttributeName=scholarshipId,AttributeType=S AttributeName=status,AttributeType=S \
      AttributeName=submittedAt,AttributeType=S \
    --key-schema AttributeName=applicationId,KeyType=HASH \
    --global-secondary-indexes '[
      {"IndexName":"studentId-index","KeySchema":[{"AttributeName":"studentId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"scholarshipId-index","KeySchema":[{"AttributeName":"scholarshipId","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"status-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}
    ]' \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "created table $TABLE"
else
  echo "table $TABLE exists"
fi

# ---------- 2. Private PDF bucket: Block Public Access ON + SSE-S3 by default ----------
if ! aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  aws s3api create-bucket --bucket "$BUCKET" >/dev/null
  echo "created bucket $BUCKET"
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption --bucket "$BUCKET" --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
echo "bucket $BUCKET: public access blocked, SSE-S3 on"

# ---------- 3. IAM role: who may use it (trust) + what it may do (policy, CLAUDE.md §7) ----------
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" \
    --assume-role-policy-document file://infra/iam/$ROLE-trust.json >/dev/null
  echo "created role $ROLE"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name "$ROLE-policy" \
  --policy-document file://infra/iam/$ROLE-policy.json
echo "role $ROLE policy updated"

# ---------- 4. Lambda function (create, or update code + settings) ----------
# Only the variables this function needs (CLAUDE.md §4). JSON form because CORS_ORIGINS may contain commas.
ENV_JSON=$(cat <<EOF
{"Variables":{
  "NODE_ENV":"production",
  "CORS_ORIGINS":"$CORS_ORIGINS",
  "APPLICATIONS_TABLE":"Applications",
  "SCHOLARSHIPS_TABLE":"Scholarships",
  "USERS_TABLE":"Users",
  "AUDIT_TABLE":"AuditLog",
  "DOCUMENTS_BUCKET":"$BUCKET",
  "JWT_SECRET_PARAM":"/scholarship/jwt-secret"
}}
EOF
)
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file fileb://lambda.zip >/dev/null
  aws lambda wait function-updated --function-name "$FN" 2>/dev/null || sleep 3
  aws lambda update-function-configuration --function-name "$FN" --role "$ROLE_ARN" \
    --runtime nodejs22.x --handler src/lambda.handler --timeout 15 --memory-size 512 \
    --environment "$ENV_JSON" >/dev/null
  echo "updated Lambda $FN"
else
  aws lambda create-function --function-name "$FN" --role "$ROLE_ARN" \
    --runtime nodejs22.x --handler src/lambda.handler --timeout 15 --memory-size 512 \
    --zip-file fileb://lambda.zip --environment "$ENV_JSON" >/dev/null
  echo "created Lambda $FN"
fi
aws lambda wait function-active-v2 --function-name "$FN" 2>/dev/null || sleep 3

# ---------- 5. One API Gateway integration for this Lambda (AWS_PROXY, payload 2.0) ----------
INT_ID=$(awst apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$FN_ARN'].IntegrationId | [0]")
if [ -z "$INT_ID" ] || [ "$INT_ID" = "None" ]; then
  INT_ID=$(awst apigatewayv2 create-integration --api-id "$API_ID" --integration-type AWS_PROXY \
    --integration-uri "$FN_ARN" --payload-format-version 2.0 --query IntegrationId)
  echo "created integration $INT_ID"
fi

# ---------- 6. Exactly the routes in CLAUDE.md §8, plus an OPTIONS (CORS preflight) route per path ----------
ROUTES=(
  "GET /api/scholarships"
  "GET /api/scholarships/{id}"
  "POST /api/applications"
  "GET /api/applications/mine"
  "GET /api/applications/{id}/pdf"
  "DELETE /api/applications/{id}"
  "OPTIONS /api/scholarships"
  "OPTIONS /api/scholarships/{id}"
  "OPTIONS /api/applications"
  "OPTIONS /api/applications/mine"
  "OPTIONS /api/applications/{id}/pdf"
  "OPTIONS /api/applications/{id}"
)
EXISTING=$(awst apigatewayv2 get-routes --api-id "$API_ID" --query "Items[].RouteKey" | tr '\t' '\n')
for KEY in "${ROUTES[@]}"; do
  if ! grep -qxF "$KEY" <<< "$EXISTING"; then
    aws apigatewayv2 create-route --api-id "$API_ID" --route-key "$KEY" \
      --target "integrations/$INT_ID" >/dev/null
    echo "created route $KEY"
  fi
done

# ---------- 7. Allow API Gateway (only this API) to invoke the function ----------
aws lambda remove-permission --function-name "$FN" --statement-id apigateway-invoke >/dev/null 2>&1 || true
aws lambda add-permission --function-name "$FN" --statement-id apigateway-invoke \
  --action lambda:InvokeFunction --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*" >/dev/null

echo "application-service deployed"
echo "Try: curl -H 'Authorization: Bearer test-student-1' $API_URL/api/scholarships"
