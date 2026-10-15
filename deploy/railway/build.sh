#!/usr/bin/env bash
# Stage a Railway build context for the Ada gateway from this checkout.
#
#   deploy/railway/build.sh [--out DIR] [--deploy]
#
# Bundles extensions/ada with esbuild (published OpenClaw images cannot load
# TypeScript plugins), then copies the Dockerfile, start.sh, and railway.json
# next to it. The default output is a fresh temp directory outside the repo so
# `railway up` does not apply this repo's .gitignore to the staged files.
# --deploy then runs `railway up` from the staged directory against the service
# named by RAILWAY_SERVICE (default: gateway) in the project linked with
# `railway link`.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PLUGIN_DIR="${ROOT}/extensions/ada"

OUT=""
DEPLOY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || { echo "--out needs a directory" >&2; exit 2; }
      OUT="$2"
      shift 2
      ;;
    --deploy)
      DEPLOY=1
      shift
      ;;
    -h | --help)
      sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

log() {
  printf '[build] %s\n' "$*"
}

die() {
  printf '[build] ERROR: %s\n' "$*" >&2
  exit 1
}

command -v pnpm >/dev/null || die "pnpm is required (see package.json packageManager)"
[ -d "${ROOT}/node_modules" ] || die "run 'pnpm install' in ${ROOT} first"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "${NODE_MAJOR}" -ge 24 ] || die "Node 24 or newer is required to bundle Ada, found $(node -v)"

if [ -z "${OUT}" ]; then
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/ada-railway.XXXXXX")"
else
  rm -rf "${OUT}"
  mkdir -p "${OUT}"
fi
OUT="$(cd "${OUT}" && pwd)"
case "${OUT}" in
  "${ROOT}" | "${PLUGIN_DIR}" | "${SCRIPT_DIR}") die "refusing to stage into ${OUT}" ;;
esac
log "staging into ${OUT}"

BUNDLE_DIR="${OUT}/ada"
mkdir -p "${BUNDLE_DIR}/src"

# The host provides every openclaw/plugin-sdk subpath, so none are bundled.
bundle() {
  local entry=$1 outfile=$2
  log "bundle ${entry}"
  (cd "${ROOT}" && pnpm exec esbuild "${entry}" \
    --bundle --platform=node --format=esm --log-level=warning \
    --outfile="${outfile}" \
    "--external:openclaw/plugin-sdk/*")
  [ -s "${outfile}" ] || die "esbuild produced no output for ${entry}"
  node --check "${outfile}"
}

bundle extensions/ada/index.ts "${BUNDLE_DIR}/index.js"

# Worker entries come from the plugin package so a new worker cannot be missed.
WORKERS="$(node -p '
  const pkg = require(process.argv[1] + "/package.json");
  pkg.openclaw.build.workerEntries.join("\n");
' "${PLUGIN_DIR}")"
[ -n "${WORKERS}" ] || die "extensions/ada/package.json lists no openclaw.build.workerEntries"
while IFS= read -r worker; do
  name="$(basename "${worker}" .ts)"
  bundle "extensions/ada/${worker#./}" "${BUNDLE_DIR}/src/${name}.js"
done <<<"${WORKERS}"

cp "${PLUGIN_DIR}/openclaw.plugin.json" "${PLUGIN_DIR}/README.md" "${BUNDLE_DIR}/"
cp -R "${PLUGIN_DIR}/skills" "${BUNDLE_DIR}/skills"

# Point the package at the bundle and drop dependencies the bundle already
# contains, so the host never tries to install them.
node -e '
  const fs = require("node:fs");
  const [source, target] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(source, "utf8"));
  pkg.openclaw.extensions = ["./index.js"];
  pkg.dependencies = {};
  delete pkg.devDependencies;
  fs.writeFileSync(target, JSON.stringify(pkg, null, 2) + "\n");
' "${PLUGIN_DIR}/package.json" "${BUNDLE_DIR}/package.json"

cp "${SCRIPT_DIR}/Dockerfile" "${SCRIPT_DIR}/start.sh" "${SCRIPT_DIR}/railway.json" "${OUT}/"
chmod 755 "${OUT}/start.sh"

if grep -rIlE 'sk-ant-|lrsk-|BEGIN [A-Z ]*PRIVATE KEY' "${OUT}" >/dev/null; then
  die "staged files contain something that looks like a secret; refusing to continue"
fi

log "staged $(find "${OUT}" -type f | wc -l | tr -d ' ') files"

if [ "${DEPLOY}" -eq 1 ]; then
  command -v railway >/dev/null || die "the Railway CLI is required for --deploy"
  SERVICE="${RAILWAY_SERVICE:-gateway}"
  MESSAGE="Redeploy Ada gateway from $(git -C "${ROOT}" rev-parse --short HEAD)"
  log "railway up --service ${SERVICE}"
  (cd "${OUT}" && railway up --detach --service "${SERVICE}" --message "${MESSAGE}" --yes)
else
  log "next: cd ${OUT} && railway up --detach --service gateway --yes"
fi
