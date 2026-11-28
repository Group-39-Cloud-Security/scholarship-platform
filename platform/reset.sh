#!/usr/bin/env bash
# Deletes everything our scripts create, so deploy-all.sh can start clean. Owner: Mohamed Wael
# Usage:  bash platform/reset.sh -y        then   bash platform/deploy-all.sh
# LOCAL FLOCI ONLY: refuses to run unless the account is Floci's 000000000000, and asks for -y first.
# It only removes our named resources (§4); "not found" is fine, so it also works on a half-built Floci.
# It does NOT touch Docker or the floci-data volume (never `docker compose down -v`).
# After it, the Brevo key is gone from SSM too: admin-service's deploy.sh puts it back from its .env.
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
aws sts get-caller-identity --query Account --output text | grep -q 000000000000 \
  || { echo "Not on Floci (check AWS_PROFILE=floci and that Floci is running). Nothing deleted."; exit 1; }
[ "${1:-}" = "-y" ] || { echo "This deletes every table, function, queue, bucket and secret of the app on Floci. Run with -y to go ahead."; exit 1; }

quiet() { "$@" >/dev/null 2>&1 || true; } # ignore "not found"
FUNCTIONS="auth-service admin-service notification-sender application-service review-service release-expired-claims"

# 1. Scheduler, triggers, functions (and their log groups), the CloudWatch filter and alarm
quiet aws scheduler delete-schedule --name release-expired-claims-hourly
for uuid in $(aws lambda list-event-source-mappings --function-name notification-sender \
    --query 'EventSourceMappings[].UUID' --output text 2>/dev/null | tr -d '\r'); do
  [ "$uuid" = None ] || quiet aws lambda delete-event-source-mapping --uuid "$uuid"
done
quiet aws cloudwatch delete-alarms --alarm-names login-failed-spike
quiet aws logs delete-metric-filter --log-group-name /aws/lambda/auth-service --filter-name login-failed
for f in $FUNCTIONS; do
  quiet aws lambda delete-function --function-name "$f"
  quiet aws logs delete-log-group --log-group-name "/aws/lambda/$f"
done
echo "deleted the schedule, SQS trigger, alarm, metric filter, 6 functions and their log groups"

# 2. The HTTP API (its stage, routes and integrations go with it)
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='scholarship-api'].ApiId | [0]" --output text | tr -d '\r')
[ -n "$API_ID" ] && [ "$API_ID" != None ] && quiet aws apigatewayv2 delete-api --api-id "$API_ID"
echo "deleted API scholarship-api"

# 3. Tables
for t in Users LoginAttempts Scholarships Applications Reviews AuditLog; do
  if aws dynamodb describe-table --table-name "$t" >/dev/null 2>&1; then
    aws dynamodb delete-table --table-name "$t" >/dev/null
    aws dynamodb wait table-not-exists --table-name "$t" 2>/dev/null || true
  fi
done
echo "deleted tables Users, LoginAttempts, Scholarships, Applications, Reviews, AuditLog"

# 4. Queues
for q in notifications notifications-dlq; do
  url=$(aws sqs get-queue-url --queue-name "$q" --query QueueUrl --output text 2>/dev/null | tr -d '\r' || true)
  [ -n "$url" ] && [ "$url" != None ] && quiet aws sqs delete-queue --queue-url "$url"
done
echo "deleted queues notifications, notifications-dlq"

# 5. Buckets (emptied first: a bucket with objects can't be deleted)
for b in scholarship-documents scholarship-web; do
  if aws s3api head-bucket --bucket "$b" >/dev/null 2>&1; then
    quiet aws s3 rm "s3://$b" --recursive
    quiet aws s3api delete-bucket --bucket "$b"
  fi
done
echo "deleted buckets scholarship-documents, scholarship-web"

# 6. Secrets
for p in /scholarship/jwt-secret /scholarship/brevo-api-key; do quiet aws ssm delete-parameter --name "$p"; done
echo "deleted SSM /scholarship/jwt-secret, /scholarship/brevo-api-key"

# 7. IAM roles (inline policy first: a role with policies can't be deleted)
for r in $(for f in $FUNCTIONS; do echo "$f-role"; done) scheduler-invoke-role; do
  quiet aws iam delete-role-policy --role-name "$r" --policy-name "$r-policy"
  quiet aws iam delete-role --role-name "$r"
done
echo "deleted 7 IAM roles"
echo "reset done. Rebuild with: bash platform/deploy-all.sh"
