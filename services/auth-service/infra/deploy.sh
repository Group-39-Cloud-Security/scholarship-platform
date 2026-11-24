#!/usr/bin/env bash
# Deploys auth-service to Floci. Run from services/auth-service, or via platform/deploy-all.sh
# Owner: Shared (lead: Mohamed Wael, reviewed by all) · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM)
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
source ../../platform/vars.sh   # gives $API_ID, $API_URL, $CORS_ORIGINS
# TODO:
#   - create tables Users (PK userId, GSI email-index) and LoginAttempts (PK emailIp, TTL on expiresAt)
#   - create role auth-service-role from infra/iam/*.json, create Lambda auth-service (nodejs24.x, handler src/lambda.handler, env vars)
#   - routes: POST /api/auth/register, POST /api/auth/login, PUT /api/auth/password, GET /api/auth/me
#   - for EVERY route also create the OPTIONS route (preflight)
#   - aws lambda add-permission --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:000000000000:$API_ID/*"
#   - make every step safe to re-run (ignore "already exists")
echo "auth-service deployed"
