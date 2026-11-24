#!/usr/bin/env bash
# Copies the one true shared code from shared-lib/ at the repo root. Never edit ./shared by hand.
set -e
SRC="../../shared-lib"
[ -d "$SRC" ] || { echo "Missing $SRC — run this from services/admin-service."; exit 1; }
rm -rf shared && mkdir -p shared && cp -r "$SRC"/. shared/
# notification-sender is zipped on its own, so it needs its own copy (it writes AuditLog)
rm -rf notification-sender/shared && mkdir -p notification-sender/shared && cp -r "$SRC"/. notification-sender/shared/
echo "shared/ synced to version $(cat shared/VERSION)"
