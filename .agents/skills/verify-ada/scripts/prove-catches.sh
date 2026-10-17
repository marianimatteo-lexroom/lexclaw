#!/usr/bin/env bash
# Re-creates past Ada failure classes in a throwaway copy and shows which check goes red.
# Always exits 0. Takes a few minutes (each mutation runs the whole mock suite).
cd "$(git rev-parse --show-toplevel)" || exit 0
node --import ./scripts/tsx.mjs .agents/skills/verify-ada/scripts/prove-catches.mts "$@" || echo "ADVISORY: catch proof exited $?."
exit 0
