#!/usr/bin/env bash
# Deletes everything our scripts create so deploy-all.sh can start clean. Owner: Mohamed Wael
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
# TODO: delete Lambdas, API, tables, queues, buckets (empty first), schedule, roles/policies, SSM parameters — ignore "not found"
