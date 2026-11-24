#!/usr/bin/env bash
# Deploys application-service to Floci. Run from services/application-service, or via platform/deploy-all.sh
# Owner: Mohamed Khalil · Rules: CLAUDE.md §2 (who creates what), §4 (names), §7 (IAM)
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
source ../../platform/vars.sh   # gives $API_ID, $API_URL, $CORS_ORIGINS
# TODO:
#   - create table Applications (PK applicationId; GSIs studentId-index, scholarshipId-index, status-index)
#   - create bucket scholarship-documents: Block Public Access, SSE-S3
#   - create role + Lambda application-service; routes from §8 (scholarships + applications)
#   - for EVERY route also create the OPTIONS route (preflight)
#   - aws lambda add-permission --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:000000000000:$API_ID/*"
#   - make every step safe to re-run (ignore "already exists")
echo "application-service deployed"
