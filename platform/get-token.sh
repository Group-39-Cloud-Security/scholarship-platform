#!/usr/bin/env bash
# Prints a JWT for one of the seeded users, for Postman, REST Client or the test runners. Owner: Mohamed Wael
# Usage:  bash platform/get-token.sh admin|reviewer|reviewer2|student|student2|student3|student4
#         TOKEN=$(bash platform/get-token.sh admin)
# Logs in through the real POST /api/auth/login (same backoff and audit as a browser). Prints ONLY the token;
# passwords are read from platform/.env and never printed. Tokens last 1 hour.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/vars.sh" >/dev/null   # gives $API_URL; set TOKEN_API_URL to log in against a local server instead
API="${TOKEN_API_URL:-$API_URL}"

ENV_FILE="$HERE/.env"
[ -f "$ENV_FILE" ] || { echo "Missing platform/.env" >&2; exit 1; }
env_value() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r'; }
DOMAIN=$(env_value ALLOWED_DOMAINS | cut -d, -f1 | tr -d ' ' | tr 'A-Z' 'a-z'); DOMAIN=${DOMAIN:-example-university.edu}

case "${1:-}" in
  admin)     EMAIL=$(env_value SEED_ADMIN_EMAIL); PASSWORD_VAR=SEED_ADMIN_PASSWORD ;;
  reviewer)  EMAIL="reviewer1@$DOMAIN"; PASSWORD_VAR=SEED_TEST_PASSWORD ;;
  reviewer2) EMAIL="reviewer2@$DOMAIN"; PASSWORD_VAR=SEED_TEST_PASSWORD ;;
  student)   EMAIL="student1@$DOMAIN"; PASSWORD_VAR=SEED_TEST_PASSWORD ;;
  student[2-4]) EMAIL="student${1#student}@$DOMAIN"; PASSWORD_VAR=SEED_TEST_PASSWORD ;;
  *) echo "Usage: bash platform/get-token.sh admin|reviewer|reviewer2|student|student2|student3|student4" >&2; exit 1 ;;
esac

# The body is built by node from environment variables, so the password never appears on a command line.
BODY=$(LOGIN_EMAIL="$EMAIL" LOGIN_PASSWORD="$(env_value $PASSWORD_VAR)" \
  node -e 'process.stdout.write(JSON.stringify({ email: process.env.LOGIN_EMAIL, password: process.env.LOGIN_PASSWORD }))')
REPLY=$(printf '%s' "$BODY" | curl -s -X POST "$API/api/auth/login" -H 'Content-Type: application/json' --data-binary @-)
printf '%s' "$REPLY" | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    let r; try { r = JSON.parse(s); } catch { r = {}; }
    if (r.token) return process.stdout.write(r.token + "\n");
    console.error("login failed: " + ((r.error && r.error.code) || "no reply") + " " + ((r.error && r.error.message) || ""));
    process.exit(1);
  });'
