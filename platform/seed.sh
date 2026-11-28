#!/usr/bin/env bash
# Test and demo data. Owner: Mohamed Wael · reads platform/.env (SEED_ADMIN_PASSWORD, SEED_TEST_PASSWORD — never committed)
# Run after every deploy.sh (deploy-all.sh does it last). Safe to re-run: puts the demo data back to its start state.
# What it creates and why: see the header of platform/seed.js. Passwords are never printed.
set -e
export AWS_PROFILE=floci MSYS_NO_PATHCONV=1 AWS_PAGER=""
HERE="$(cd "$(dirname "$0")" && pwd)"
winpath() { if command -v cygpath >/dev/null; then cygpath -m "$1"; else echo "$1"; fi; }
aws sts get-caller-identity --query Account --output text | grep -q 000000000000 || { echo "Not on Floci (check AWS_PROFILE)."; exit 1; }

ENV_FILE="$HERE/.env"
[ -f "$ENV_FILE" ] || { echo "Missing platform/.env: copy platform/.env.example and fill in the two passwords."; exit 1; }
env_value() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r'; }
[ -d "$HERE/../services/auth-service/node_modules/bcryptjs" ] \
  || { echo "Run npm install in services/auth-service first (deploy-all.sh does)."; exit 1; }

OUT=$(SEED_ADMIN_EMAIL="$(env_value SEED_ADMIN_EMAIL)" SEED_ADMIN_PASSWORD="$(env_value SEED_ADMIN_PASSWORD)" \
  SEED_TEST_PASSWORD="$(env_value SEED_TEST_PASSWORD)" ALLOWED_DOMAINS="$(env_value ALLOWED_DOMAINS)" \
  node "$(winpath "$HERE/seed.js")")
echo "$OUT" | grep -v '^PDF_KEYS='

# One small valid PDF per seeded application, so reviewers can open them (private bucket, SSE-S3 by default).
PDF="$(mktemp)"; trap 'rm -f "$PDF"' EXIT
printf '%%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%%%EOF\n' > "$PDF"
for key in $(echo "$OUT" | grep '^PDF_KEYS=' | cut -d= -f2-); do
  aws s3api put-object --bucket scholarship-documents --key "$key" --body "$(winpath "$PDF")" \
    --content-type application/pdf --server-side-encryption AES256 >/dev/null
done
echo "seed: PDFs uploaded to scholarship-documents"
echo "seed done. Get a token with: bash platform/get-token.sh admin|reviewer|reviewer2|student|student2|student3|student4"
