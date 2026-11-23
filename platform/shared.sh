#!/usr/bin/env bash
# Shared resources. Owner: Mohamed Wael · Rules: CLAUDE.md §2 "Who creates what"
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
# TODO:
#   - create HTTP API scholarship-api (if missing), stage $default with auto-deploy, route throttling
#   - create table AuditLog (PK action, SK createdAt#logId)
#   - create SSM SecureString /scholarship/jwt-secret with: openssl rand -hex 32  (only if missing; never stored in a file)
#   - write $API_URL into frontend/js/config.js (FLOCI_API), then upload the site:
#       aws s3 mb s3://scholarship-web ; aws s3 sync frontend s3://scholarship-web --exclude "*.md"
#       re-upload css with --content-type text/css and js with --content-type text/javascript
#       bucket policy: s3:GetObject only (platform/s3-public-read-policy.json)
echo "shared resources ready"
