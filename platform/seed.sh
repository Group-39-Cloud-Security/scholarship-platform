#!/usr/bin/env bash
# Test data. Owner: Mohamed Wael · reads platform/.env (SEED_ADMIN_PASSWORD etc. — never committed)
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
# TODO:
#   - first admin (bcryptjs hash of SEED_ADMIN_PASSWORD), 2 reviewers, 3 students on ALLOWED_DOMAINS
#   - 2 published scholarships with rubric (academic 40, essay 40, need 20) + eligibility, 1 draft
#   - applications in each status: submitted, under_review, reviewed (one flagged)
