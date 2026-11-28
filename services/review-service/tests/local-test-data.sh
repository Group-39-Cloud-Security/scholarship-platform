#!/usr/bin/env bash
# Extra test data for review-service on your own Floci. I wrote it before the other services existed, and
# api-tests.sh still uses it so every run starts from the same queue. The demo data is platform/seed.sh.
# Run from the repo root AFTER deploy-all.sh:
#   bash services/review-service/tests/local-test-data.sh
# Creates (only if missing) the Applications and Scholarships tables exactly as CLAUDE.md section 5 describes,
# the private scholarship-documents bucket, 1 scholarship with a rubric, 8 submitted applications with a small PDF,
# and 1 claim that is 49 hours old (to test the release-expired-claims job).
# bash platform/reset.sh -y removes all of it.
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
aws sts get-caller-identity --query Account --output text | grep -q 000000000000 \
  || { echo "Not on Floci (is Docker running? is the floci profile set?)"; exit 1; }
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
TMP="$(winpath "$(mktemp -d)")"
trap 'rm -rf "$TMP"' EXIT

# ---------- tables ----------
if ! aws dynamodb describe-table --table-name Scholarships >/dev/null 2>&1; then
  aws dynamodb create-table --table-name Scholarships \
    --attribute-definitions AttributeName=scholarshipId,AttributeType=S AttributeName=status,AttributeType=S AttributeName=deadline,AttributeType=S \
    --key-schema AttributeName=scholarshipId,KeyType=HASH \
    --global-secondary-indexes '[{"IndexName":"status-deadline-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"deadline","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "created table Scholarships"
fi
if ! aws dynamodb describe-table --table-name Applications >/dev/null 2>&1; then
  aws dynamodb create-table --table-name Applications \
    --attribute-definitions AttributeName=applicationId,AttributeType=S AttributeName=studentId,AttributeType=S \
      AttributeName=scholarshipId,AttributeType=S AttributeName=status,AttributeType=S AttributeName=submittedAt,AttributeType=S \
    --key-schema AttributeName=applicationId,KeyType=HASH \
    --global-secondary-indexes '[
      {"IndexName":"studentId-index","KeySchema":[{"AttributeName":"studentId","KeyType":"HASH"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"scholarshipId-index","KeySchema":[{"AttributeName":"scholarshipId","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}},
      {"IndexName":"status-index","KeySchema":[{"AttributeName":"status","KeyType":"HASH"},{"AttributeName":"submittedAt","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "created table Applications"
fi

# ---------- private bucket for PDFs ----------
if ! aws s3api head-bucket --bucket scholarship-documents >/dev/null 2>&1; then
  aws s3 mb s3://scholarship-documents >/dev/null
  aws s3api put-public-access-block --bucket scholarship-documents --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true \
    || echo "note: this Floci doesn't support Block Public Access, bucket is still private by default"
  echo "created private bucket scholarship-documents"
fi

# ---------- 1 scholarship with a rubric ----------
SCH=9a7e3c10-5b2f-4d6a-8e11-2c4b7f9d0a65
cat > "$TMP/sch.json" <<EOF
{
  "scholarshipId": {"S": "$SCH"},
  "title": {"S": "Cloud Excellence Award"},
  "description": {"S": "Test scholarship for review-service"},
  "deadline": {"S": "2027-01-15T23:59:00.000Z"},
  "awards": {"N": "2"}, "acceptedCount": {"N": "0"},
  "status": {"S": "published"},
  "rubric": {"L": [
    {"M": {"criterionId": {"S": "academic"}, "name": {"S": "Academic record"}, "description": {"S": "Grades and transcript"}, "weight": {"N": "40"}}},
    {"M": {"criterionId": {"S": "essay"}, "name": {"S": "Essay"}, "description": {"S": "Clarity and motivation"}, "weight": {"N": "40"}}},
    {"M": {"criterionId": {"S": "need"}, "name": {"S": "Financial need"}, "description": {"S": "Evidence of need"}, "weight": {"N": "20"}}}
  ]},
  "eligibility": {"M": {"allowedDomains": {"L": [{"S": "example-university.edu"}]}, "minGpa": {"N": "3"}, "years": {"L": [{"N": "2"}, {"N": "3"}]}}},
  "createdBy": {"S": "review-test-data"}, "createdAt": {"S": "2026-11-01T10:00:00.000Z"}
}
EOF
aws dynamodb put-item --table-name Scholarships --item "file://$TMP/sch.json"
echo "added scholarship 'Cloud Excellence Award'"

# ---------- applications ----------
printf '%%PDF-1.4\n%% test application document\n' > "$TMP/test.pdf"
add_app() { # $1 id, $2 status, $3 submittedAt, $4 extra attributes (JSON fragment, may be empty)
  cat > "$TMP/app.json" <<EOF
{
  "applicationId": {"S": "$1"}, "studentId": {"S": "review-test-student"}, "studentEmail": {"S": "review.test@example-university.edu"},
  "scholarshipId": {"S": "$SCH"},
  "essay": {"S": "I am a second year computer science student. This is a test essay for application $1.\n\nI want this scholarship because..."},
  "gpa": {"N": "3.4"}, "yearOfStudy": {"N": "2"}, "pdfKey": {"S": "applications/$1.pdf"},
  "status": {"S": "$2"}, "flagged": {"BOOL": false}, "submittedAt": {"S": "$3"}$4
}
EOF
  aws dynamodb put-item --table-name Applications --item "file://$TMP/app.json"
  aws s3 cp "$TMP/test.pdf" "s3://scholarship-documents/applications/$1.pdf" --content-type application/pdf >/dev/null
}
# remove old reviews of these test applications so every run starts clean
for n in 1 2 3 4 5 6 7 8 9; do
  aws dynamodb delete-item --table-name Reviews --key "{\"applicationId\":{\"S\":\"4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e7$n\"}}" >/dev/null 2>&1 || true
done
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e71 submitted 2026-11-20T10:00:00.000Z ""
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e72 submitted 2026-11-21T10:00:00.000Z ""
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e73 submitted 2026-11-22T10:00:00.000Z ""
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e74 submitted 2026-11-23T10:00:00.000Z ""
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e76 submitted 2026-11-24T10:00:00.000Z ""
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e77 submitted 2026-11-24T11:00:00.000Z ""
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e78 submitted 2026-11-24T12:00:00.000Z ""
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e79 submitted 2026-11-24T13:00:00.000Z ""
# claimed 49 hours ago by another reviewer: the hourly job should put it back in the queue
OLD=$(node -e "process.stdout.write(new Date(Date.now() - 49 * 3600 * 1000).toISOString())")
add_app 4f1c2b9e-7a3d-4e21-9c55-1b2a6f0d8e75 under_review 2026-11-19T10:00:00.000Z \
  ", \"reviewerId\": {\"S\": \"old-reviewer\"}, \"claimedAt\": {\"S\": \"$OLD\"}"
echo "added 8 submitted applications + 1 expired claim (with PDFs)"
echo
echo "Done. Test the expiry job:  aws lambda invoke --function-name release-expired-claims out.json && cat out.json"
echo "Website: http://localhost:4566/scholarship-web/reviewer/queue.html"
