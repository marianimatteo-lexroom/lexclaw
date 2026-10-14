#!/usr/bin/env bash
# Boot script for the Vera gateway container. Every step is logged and any
# failing step aborts the boot, so Railway shows a failed deploy instead of a
# gateway that is up but half configured. Secret values are never logged.
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
PORT="${OPENCLAW_GATEWAY_PORT:-${PORT:-8080}}"
APP_DIR="${OPENCLAW_APP_DIR:-/app}"
VERA_DIR="${VERA_PLUGIN_DIR:-/opt/lexroom/vera}"
KAPSO_PACKAGE="@kapso/openclaw-whatsapp"
KAPSO_EXTENSION_DIR="${STATE_DIR}/extensions/kapso-whatsapp"

log() {
  printf '[start] %s\n' "$*"
}

die() {
  printf '[start] ERROR: %s\n' "$*" >&2
  exit 1
}

oc() {
  node "${APP_DIR}/openclaw.mjs" "$@"
}

# step "description" command...  Runs the command and aborts the boot on failure.
step() {
  local description=$1
  shift
  log "${description}"
  local status=0
  "$@" || status=$?
  if [ "${status}" -ne 0 ]; then
    die "${description} failed (exit ${status})"
  fi
}

json_of_env() {
  node -p 'JSON.stringify(process.env[process.argv[1]])' "$1"
}

# config_set path json [secret]  `openclaw config set` exits 0 when the value is
# already stored, so a non-zero exit is always a real failure.
config_set() {
  local path=$1 json=$2 secret=${3:-}
  local status=0
  if [ -n "${secret}" ]; then
    log "config set ${path} (value hidden)"
    oc config set "${path}" "${json}" --strict-json >/dev/null || status=$?
  else
    log "config set ${path}"
    oc config set "${path}" "${json}" --strict-json || status=$?
  fi
  if [ "${status}" -ne 0 ]; then
    die "config set ${path} failed (exit ${status})"
  fi
}

# config_set_env path VAR [secret]  Sets the path from an env var, or logs that
# it was skipped so the value already on the volume stays untouched.
config_set_env() {
  local path=$1 var=$2 secret=${3:-}
  if [ -z "${!var:-}" ]; then
    log "skip ${path}: ${var} is unset"
    return 0
  fi
  config_set "${path}" "$(json_of_env "${var}")" "${secret}"
}

require_env() {
  local var
  for var in "$@"; do
    if [ -z "${!var:-}" ]; then
      die "${var} is required"
    fi
  done
}

kapso_installed_version() {
  node -e '
    const fs = require("node:fs");
    try {
      const pkg = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8"));
      process.stdout.write(typeof pkg.version === "string" ? pkg.version : "");
    } catch {
      process.stdout.write("");
    }
  ' "${KAPSO_EXTENSION_DIR}"
}

require_env KAPSO_PHONE_NUMBER_ID KAPSO_DEFAULT_TO KAPSO_PLUGIN_VERSION

if ! [[ "${KAPSO_PLUGIN_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  die "KAPSO_PLUGIN_VERSION must be an exact version such as 0.1.4, got '${KAPSO_PLUGIN_VERSION}'"
fi

export VERA_MODEL="${VERA_MODEL:-anthropic/claude-opus-5}"
PUBLIC_ORIGIN="${VERA_PUBLIC_ORIGIN:-}"
if [ -z "${PUBLIC_ORIGIN}" ] && [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  PUBLIC_ORIGIN="https://${RAILWAY_PUBLIC_DOMAIN}"
fi
[ -n "${PUBLIC_ORIGIN}" ] || die "set VERA_PUBLIC_ORIGIN (or generate a Railway domain) so the Control UI origin and connect links are known"

step "create state and workspace directories" mkdir -p "${STATE_DIR}" "${WORKSPACE_DIR}"
cd "${APP_DIR}"

step "install vera plugin from ${VERA_DIR}" \
  oc plugins install "${VERA_DIR}" --accept-capabilities --force

KAPSO_SPEC="clawhub:${KAPSO_PACKAGE}@${KAPSO_PLUGIN_VERSION}"
if [ ! -d "${KAPSO_EXTENSION_DIR}" ]; then
  step "install kapso plugin ${KAPSO_SPEC}" \
    oc plugins install "${KAPSO_SPEC}" --accept-capabilities
else
  installed="$(kapso_installed_version)"
  if [ "${installed}" = "${KAPSO_PLUGIN_VERSION}" ]; then
    log "kapso plugin ${KAPSO_PLUGIN_VERSION} already installed"
  else
    step "replace kapso plugin '${installed:-unknown}' with ${KAPSO_PLUGIN_VERSION}" \
      oc plugins install "${KAPSO_SPEC}" --accept-capabilities --force
  fi
fi

# The tool allowlist comes from the manifest bundled with the plugin so it
# cannot drift from the tools Vera registers.
VERA_TOOLS_JSON="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1] + "/openclaw.plugin.json", "utf8"));
  process.stdout.write(JSON.stringify(manifest.contracts.tools));
' "${VERA_DIR}")"

# Allowlist needs both +E.164 and bare digits (see PROGRESS.md). Override with a
# comma-separated KAPSO_ALLOW_FROM.
KAPSO_ALLOW_FROM_JSON="$(node -p '
  const configured = (process.env.KAPSO_ALLOW_FROM ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const to = process.env.KAPSO_DEFAULT_TO;
  JSON.stringify(configured.length > 0 ? configured : [to, to.replace(/^\+/, "")]);
')"

config_set plugins.entries.vera.enabled true
config_set plugins.entries.vera.hooks.allowConversationAccess true
config_set plugins.entries.kapso-whatsapp.enabled true
config_set tools.alsoAllow "${VERA_TOOLS_JSON}"
config_set 'channels["kapso-whatsapp"].enabled' true
config_set 'channels["kapso-whatsapp"].phoneNumberId' "$(json_of_env KAPSO_PHONE_NUMBER_ID)"
config_set 'channels["kapso-whatsapp"].defaultTo' "$(json_of_env KAPSO_DEFAULT_TO)"
config_set 'channels["kapso-whatsapp"].dmSecurity' '"allowlist"'
config_set 'channels["kapso-whatsapp"].allowFrom' "${KAPSO_ALLOW_FROM_JSON}"
config_set agents.defaults.model.primary "$(json_of_env VERA_MODEL)"
# Vera's own service owns the 15-minute poll and the 07:40 Europe/Rome pass.
config_set agents.defaults.heartbeat.every '"0m"'
config_set gateway.controlUi.allowedOrigins "$(PUBLIC_ORIGIN="${PUBLIC_ORIGIN}" node -p 'JSON.stringify([process.env.PUBLIC_ORIGIN])')"

config_set_env 'channels["kapso-whatsapp"].webhookSecret' KAPSO_WEBHOOK_SECRET secret
config_set_env 'channels["kapso-whatsapp"].apiKey' KAPSO_API_KEY secret
config_set_env plugins.entries.vera.config.accessToken LEXROOM_ACCESS_TOKEN secret
config_set_env plugins.entries.vera.config.googleClientId VERA_GOOGLE_CLIENT_ID
config_set_env plugins.entries.vera.config.googleClientSecret VERA_GOOGLE_CLIENT_SECRET secret
config_set_env plugins.entries.vera.config.googleStateSecret VERA_GOOGLE_STATE_SECRET secret
config_set_env plugins.entries.vera.config.googlePubSubTopic VERA_GOOGLE_PUBSUB_TOPIC
config_set_env plugins.entries.vera.config.googleNotifyAudience VERA_GOOGLE_NOTIFY_AUDIENCE
config_set_env plugins.entries.vera.config.googleNotifyServiceAccount VERA_GOOGLE_NOTIFY_SERVICE_ACCOUNT
config_set_env plugins.entries.vera.config.googleNotifyToken VERA_GOOGLE_NOTIFY_TOKEN secret
config_set_env plugins.entries.vera.config.statusToken VERA_STATUS_TOKEN secret

# Utility template sent once when a digest is held because the WhatsApp window is
# closed. Both fields are required by the plugin schema, so the language defaults
# here. Unset name: not configured, and a value already on the volume stays put.
if [ -n "${VERA_DIGEST_TEMPLATE_NAME:-}" ]; then
  export VERA_DIGEST_TEMPLATE_LANG="${VERA_DIGEST_TEMPLATE_LANG:-it}"
  config_set plugins.entries.vera.config.digestReadyTemplate "$(node -p '
    JSON.stringify({
      name: process.env.VERA_DIGEST_TEMPLATE_NAME.trim(),
      language: process.env.VERA_DIGEST_TEMPLATE_LANG.trim(),
    })
  ')"
else
  if [ -n "${VERA_DIGEST_TEMPLATE_LANG:-}" ]; then
    log "WARNING: VERA_DIGEST_TEMPLATE_LANG is ignored because VERA_DIGEST_TEMPLATE_NAME is unset"
  fi
  log "skip plugins.entries.vera.config.digestReadyTemplate: VERA_DIGEST_TEMPLATE_NAME is unset"
fi

# Deadline intake is off unless VERA_DEADLINE_INTAKE_ENABLED is exactly true, and the
# value is written on every boot so removing the variable turns the feature off.
case "$(printf '%s' "${VERA_DEADLINE_INTAKE_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')" in
  true) DEADLINE_INTAKE_ENABLED=true ;;
  false | "") DEADLINE_INTAKE_ENABLED=false ;;
  *) die "VERA_DEADLINE_INTAKE_ENABLED must be true or false, got '${VERA_DEADLINE_INTAKE_ENABLED}'" ;;
esac
config_set plugins.entries.vera.config.deadlineIntake.enabled "${DEADLINE_INTAKE_ENABLED}"

# Comma-separated reminder cadence such as "7d,2d,morning-of". Validated here
# because an invalid value would make the plugin config fail schema validation.
if [ -n "${VERA_DEADLINE_REMINDERS:-}" ]; then
  REMINDERS_JSON="$(node -p '
    const steps = process.env.VERA_DEADLINE_REMINDERS.split(",").map((v) => v.trim()).filter(Boolean);
    const valid = steps.length > 0 && steps.every((v) => /^(\d{1,3}d|morning-of)$/u.test(v));
    if (!valid) {
      process.stderr.write("invalid cadence\n");
      process.exit(1);
    }
    JSON.stringify(steps);
  ')" || die "VERA_DEADLINE_REMINDERS must be comma-separated steps like 7d,2d,morning-of, got '${VERA_DEADLINE_REMINDERS}'"
  config_set plugins.entries.vera.config.deadlineIntake.reminders "${REMINDERS_JSON}"
else
  log "skip plugins.entries.vera.config.deadlineIntake.reminders: VERA_DEADLINE_REMINDERS is unset"
fi

# WhatsApp status reactions (👀 → ⏳ → ✅/❌) are sent by the Vera plugin straight through
# Kapso and read from the gateway environment, so this only validates and exports them.
# OpenClaw's messages.ackReaction/statusReactions are not used: they are a no-op on Kapso.
STATUS_REACTIONS="$(printf '%s' "${VERA_STATUS_REACTIONS:-true}" | tr '[:upper:]' '[:lower:]')"
case "${STATUS_REACTIONS}" in
  true | false) ;;
  "") STATUS_REACTIONS=true ;;
  *) die "VERA_STATUS_REACTIONS must be true or false, got '${VERA_STATUS_REACTIONS}'" ;;
esac
export VERA_STATUS_REACTIONS="${STATUS_REACTIONS}"
for reaction_var in VERA_REACTION_ACK VERA_REACTION_THINKING VERA_REACTION_DONE VERA_REACTION_ERROR; do
  reaction_value="${!reaction_var:-}"
  if [ -n "${reaction_value}" ] && [ "${#reaction_value}" -gt 32 ]; then
    die "${reaction_var} must be a single emoji, got '${reaction_value}'"
  fi
done

if [ -n "${VERA_GOOGLE_CLIENT_ID:-}" ]; then
  export GOOGLE_REDIRECT_URI="${VERA_GOOGLE_REDIRECT_URI:-${PUBLIC_ORIGIN}/vera/google/callback}"
  export LEXROOM_CONNECT_URI="${VERA_LEXROOM_CONNECT_URI:-${PUBLIC_ORIGIN}/vera/lexroom/connect}"
  config_set plugins.entries.vera.config.googleRedirectUri "$(json_of_env GOOGLE_REDIRECT_URI)"
  config_set plugins.entries.vera.config.lexroomConnectUri "$(json_of_env LEXROOM_CONNECT_URI)"
else
  log "skip Google redirect and Lexroom connect URIs: VERA_GOOGLE_CLIENT_ID is unset"
fi

if [ -z "${VERA_TOKEN_KEY:-}" ]; then
  log "WARNING: VERA_TOKEN_KEY is unset; NODE_ENV=production makes Vera refuse to open its Google and Lexroom account stores (generate one with: openssl rand -base64 32)"
fi

if [ -z "${VERA_STATUS_TOKEN:-}" ]; then
  log "WARNING: VERA_STATUS_TOKEN is unset, so GET /vera/status returns 401"
fi

if [ -n "${ANTHROPIC_SETUP_TOKEN:-}" ]; then
  log "import anthropic setup token (value hidden)"
  token_file="$(mktemp)"
  chmod 600 "${token_file}"
  printf '%s' "${ANTHROPIC_SETUP_TOKEN}" >"${token_file}"
  import_status=0
  oc models auth paste-token --provider anthropic <"${token_file}" || import_status=$?
  rm -f "${token_file}"
  if [ "${import_status}" -eq 0 ]; then
    # The imported subscription token must win over a leftover API key.
    unset ANTHROPIC_API_KEY
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    log "WARNING: anthropic setup token import failed (exit ${import_status}); continuing with ANTHROPIC_API_KEY"
  else
    die "anthropic setup token import failed (exit ${import_status}) and ANTHROPIC_API_KEY is unset"
  fi
else
  log "skip anthropic setup token import: ANTHROPIC_SETUP_TOKEN is unset"
fi

log "starting gateway on port ${PORT}"
exec node "${APP_DIR}/openclaw.mjs" gateway --allow-unconfigured --bind lan --port "${PORT}"
