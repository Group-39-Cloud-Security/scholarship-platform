#!/usr/bin/env bash
# Copies the one true shared code from shared-lib/ at the repo root. Never edit ./shared by hand.
set -e
SRC="../../shared-lib"
[ -d "$SRC" ] || { echo "Missing $SRC — run this from services/admin-service."; exit 1; }
rm -rf shared && mkdir -p shared && cp -r "$SRC"/. shared/
echo "shared/ synced to version $(cat shared/VERSION)"
