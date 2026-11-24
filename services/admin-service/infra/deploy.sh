#!/usr/bin/env bash
# Deploys admin-service to Floci. Run from services/admin-service, or via platform/deploy-all.sh
# Owner: Mohamed Wael · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM)
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
source ../../platform/vars.sh   # gives $API_ID, $API_URL, $CORS_ORIGINS
# TODO:
#   - create table Scholarships (PK scholarshipId; GSI status-deadline-index)
#   - create SQS notifications-dlq, then notifications with redrive (maxReceiveCount 3)
#   - put SSM SecureString /scholarship/brevo-api-key from local .env BREVO_API_KEY (never committed)
#   - create roles + Lambdas admin-service and notification-sender (zip notification-sender/ separately); event source mapping SQS → notification-sender
#   - routes from §8 (admin + GET /api/health)
#   - for EVERY route also create the OPTIONS route (preflight)
#   - aws lambda add-permission --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:000000000000:$API_ID/*"
#   - make every step safe to re-run (ignore "already exists")
echo "admin-service deployed"
