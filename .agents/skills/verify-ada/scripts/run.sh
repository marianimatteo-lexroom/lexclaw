#!/usr/bin/env bash
# Advisory verification of Ada's Lexroom integration. Always exits 0.
#   .agents/skills/verify-ada/scripts/run.sh [--only <id-prefix>] [--no-live] [--live-only] [--json]
cd "$(git rev-parse --show-toplevel)" || exit 0

major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$major" -lt 24 ]; then
  echo "ADVISORY: verify-ada needs Node 24 or newer (found $(node -v 2>/dev/null || echo none)); nothing was verified."
  exit 0
fi
if [ ! -d node_modules ]; then
  echo "ADVISORY: node_modules is missing; run 'pnpm install' first. Nothing was verified."
  exit 0
fi

node --import ./scripts/tsx.mjs .agents/skills/verify-ada/scripts/verify.mts "$@" || echo "ADVISORY: runner exited $? before finishing."
exit 0
