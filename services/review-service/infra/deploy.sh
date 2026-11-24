#!/usr/bin/env bash
# Deploys review-service to Floci. Run from services/review-service, or via platform/deploy-all.sh
# Owner: Mohamed Hazem · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM)
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
source ../../platform/vars.sh   # gives $API_ID, $API_URL, $CORS_ORIGINS
# TODO:
#   - create table Reviews (PK applicationId; GSI reviewerId-index)
#   - create roles + Lambdas review-service and release-expired-claims (zip release-expired-claims/ separately)
#   - create EventBridge schedule release-expired-claims-hourly (rate(1 hour)) using scheduler-invoke-role
#   - CloudWatch: metric filter on login_failed + alarm (> 20 in 5 min) — Hazem leads monitoring
#   - routes from §8 (reviews)
#   - for EVERY route also create the OPTIONS route (preflight)
#   - aws lambda add-permission --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:000000000000:$API_ID/*"
#   - make every step safe to re-run (ignore "already exists")
echo "review-service deployed"
