#!/usr/bin/env bash
# Copies the one true shared code from shared-lib/ at the repo root. Never edit ./shared by hand.
set -e
SRC="../../shared-lib"
[ -d "$SRC" ] || { echo "Missing $SRC — run this from services/review-service."; exit 1; }
rm -rf shared && mkdir -p shared && cp -r "$SRC"/. shared/
# release-expired-claims is zipped on its own, so it needs its own copy (it writes AuditLog)
rm -rf release-expired-claims/shared && mkdir -p release-expired-claims/shared && cp -r "$SRC"/. release-expired-claims/shared/
echo "shared/ synced to version $(cat shared/VERSION)"
