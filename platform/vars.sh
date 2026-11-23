#!/usr/bin/env bash
# Sourced by every deploy script: finds the shared HTTP API by name.
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='scholarship-api'].ApiId | [0]" --output text)
export API_ID
export API_URL="http://$API_ID.execute-api.localhost.floci.io:4566"
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:4566}"
