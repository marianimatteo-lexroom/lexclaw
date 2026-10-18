#!/usr/bin/env bash
# Boot script for the Ada gateway container. Every step is logged and any
# failing step aborts the boot, so Railway shows a failed deploy instead of a
# gateway that is up but half configured. Secret values are never logged.
set -euo pipefail

STATE_DIR="${OPENCLAW_STATE_DIR:-/data/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
PORT="${OPENCLAW_GATEWAY_PORT:-${PORT:-8080}}"
APP_DIR="${OPENCLAW_APP_DIR:-/app}"
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

# Deployments from before the rename to Ada carry VERA_* variables. Each one fills the
# matching ADA_* name unless that is already set, so nothing has to be renamed in Railway.
# Only names are logged. The plugin applies the same fallback to what it reads itself.
LEGACY_ENV_USED=""
for legacy_name in $(compgen -e | grep '^VERA_' || true); do
  ada_name="ADA_${legacy_name#VERA_}"
  if [ -z "${!ada_name:-}" ]; then
    export "${ada_name}=${!legacy_name}"
    LEGACY_ENV_USED="${LEGACY_ENV_USED} ${legacy_name}"
  fi
done
if [ -n "${LEGACY_ENV_USED}" ]; then
  log "using legacy variables (rename to ADA_* when convenient):${LEGACY_ENV_USED}"
fi

require_env KAPSO_PHONE_NUMBER_ID KAPSO_DEFAULT_TO KAPSO_PLUGIN_VERSION

if ! [[ "${KAPSO_PLUGIN_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]; then
  die "KAPSO_PLUGIN_VERSION must be an exact version such as 0.1.4, got '${KAPSO_PLUGIN_VERSION}'"
fi

export ADA_MODEL="${ADA_MODEL:-anthropic/claude-opus-5}"
PUBLIC_ORIGIN="${ADA_PUBLIC_ORIGIN:-}"
if [ -z "${PUBLIC_ORIGIN}" ] && [ -n "${RAILWAY_PUBLIC_DOMAIN:-}" ]; then
  PUBLIC_ORIGIN="https://${RAILWAY_PUBLIC_DOMAIN}"
fi
[ -n "${PUBLIC_ORIGIN}" ] || die "set ADA_PUBLIC_ORIGIN (or generate a Railway domain) so the Control UI origin and connect links are known"

ADA_DIR="${ADA_PLUGIN_DIR:-/opt/lexroom/ada}"
if [ ! -d "${ADA_DIR}" ] && [ -d /opt/lexroom/ada ]; then
  log "plugin directory ${ADA_DIR} is missing; using the bundled /opt/lexroom/ada"
  ADA_DIR=/opt/lexroom/ada
fi

step "create state and workspace directories" mkdir -p "${STATE_DIR}" "${WORKSPACE_DIR}"
cd "${APP_DIR}"

step "install ada plugin from ${ADA_DIR}" \
  oc plugins install "${ADA_DIR}" --accept-capabilities --force

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

# Volumes from before the rename hold the plugin as "vera". Carry its non-secret settings to
# "ada", then retire the old plugin so its tools and routes cannot load beside the new ones.
# Secrets are not copied: `config get` redacts them, and every secret the plugin reads is
# written again from the environment below. Saved Lexroom and Google sign-ins live in the
# SQLite stores under ${STATE_DIR}/vera, which the plugin keeps reading, so they survive.
migrate_legacy_plugin() {
  local old=vera
  # An uninstalled plugin leaves only an `enabled: false` marker, which is not worth redoing.
  if [ "$(oc config get "plugins.entries.${old}.enabled" 2>/dev/null || true)" != "true" ] \
    && ! oc config get "plugins.entries.${old}.config" --json >/dev/null 2>&1; then
    log "no legacy ${old} plugin entry to migrate"
    return 0
  fi
  log "migrating the legacy ${old} plugin settings to ada"
  local key value
  for key in baseUrl timeoutMs idleTimeoutMs answerTimeoutMs researchModules googleClientId \
    googleRedirectUri googlePubSubTopic googleNotifyAudience googleNotifyIssuer \
    googleNotifyServiceAccount lexroomConnectUri deadlineIntake digestReadyTemplate; do
    if oc config get "plugins.entries.ada.config.${key}" --json >/dev/null 2>&1; then
      continue
    fi
    if value="$(oc config get "plugins.entries.${old}.config.${key}" --json 2>/dev/null)" && [ -n "${value}" ]; then
      log "copy plugin setting ${key}"
      oc config set "plugins.entries.ada.config.${key}" "${value}" --strict-json >/dev/null \
        || log "WARNING: could not copy plugin setting ${key}; set it again on plugins.entries.ada.config"
    fi
  done
  if oc config get "plugins.entries.${old}.config.lexroomStateSecret" --json >/dev/null 2>&1; then
    log "WARNING: the legacy plugin had lexroomStateSecret set; it is a secret and was not copied. Set plugins.entries.ada.config.lexroomStateSecret again, or Ada falls back to googleStateSecret"
  fi
  oc config set "plugins.entries.${old}.enabled" false --strict-json >/dev/null 2>&1 \
    || log "WARNING: could not disable the legacy ${old} plugin"
  if oc plugins uninstall "${old}" --force; then
    log "removed the legacy ${old} plugin"
  else
    log "WARNING: could not uninstall the legacy ${old} plugin; it stays disabled. Run: openclaw plugins uninstall ${old} --force"
  fi
}
migrate_legacy_plugin

# A volume from before the rename can still name the assistant Vera in the workspace files the
# model reads and in the agent's configured name, and describe her as working for one lawyer
# only or answering in Italian; a deploy never rewrites any of it. In IDENTITY.md and SOUL.md:
# rename the standalone word Vera, turn the known "one lawyer / one person only" phrases into
# "everyone who writes to her", and append one marked section that says she serves every sender.
# SOUL.md also gets a marked section that says she answers in the language of the latest message.
# Each section is appended once; its marker makes a second run a no-op. In AGENTS.md, TOOLS.md,
# HEARTBEAT.md and BOOTSTRAP.md only the standalone word is renamed. The first change keeps a
# .pre-ada copy of each file beside it. Every other character, USER.md, MEMORY.md and memory/ (a
# client can be called Vera), paths, domains and VERA_* names are left alone. The plugin's
# per-turn persona says the same and overrides these files either way.
migrate_identity_name() {
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const word = /(?<![\w./@:-])vera(?![\w@/-]|\.\w)/giu;
    const ada = (found) =>
      found === found.toUpperCase() ? "ADA" : found === found.toLowerCase() ? "ada" : "Ada";
    const onePerson = [
      [/\b(for|to|with) (?:one|a single|just one) (?:lawyer|person|user|client)(?: only)?\b/giu, "$1 everyone who writes to her"],
      [/\bper (?:una|un) (?:sola persona|solo avvocato|persona sola|avvocato solo)\b/giu, "per chiunque le scriva"],
    ];
    const MARK = "<!-- ada:multi-user -->";
    const block =
      MARK +
      "\n## Who Ada serves\n\nAda serves everyone who writes to her on WhatsApp, each in a private chat, with their own Lexroom, Gmail and Calendar connections. She never says she works for one person only. Any older line saying she works for one lawyer or one person is out of date.\n<!-- /ada:multi-user -->\n";
    const LANG_MARK = "<!-- ada:language -->";
    const langBlock =
      LANG_MARK +
      "\n## Language\n\nAda always replies in the language of the most recent message from the person she is talking to, and switches when they switch. That overrides any older line that names a language or says to answer in Italian, and the language of earlier messages, profiles, notes and tool output.\n<!-- /ada:language -->\n";
    const files = [
      { name: "IDENTITY.md", serves: true },
      { name: "SOUL.md", serves: true, language: true },
      { name: "AGENTS.md" },
      { name: "TOOLS.md" },
      { name: "HEARTBEAT.md" },
      { name: "BOOTSTRAP.md" },
    ];
    for (const { name, serves, language } of files) {
      const file = path.join(process.argv[1], name);
      if (!fs.existsSync(file)) continue;
      const before = fs.readFileSync(file, "utf8");
      let after = before.replace(word, ada);
      if (serves) {
        const at = after.indexOf(MARK);
        let head = at < 0 ? after : after.slice(0, at);
        const tail = at < 0 ? "" : after.slice(at);
        for (const [pattern, text] of onePerson) head = head.replace(pattern, text);
        after = at < 0 ? head.replace(/\s*$/u, "") + "\n\n" + block : head + tail;
      }
      if (language && !after.includes(LANG_MARK)) {
        after = after.replace(/\s*$/u, "") + "\n\n" + langBlock;
      }
      if (after === before) continue;
      try {
        fs.copyFileSync(file, file + ".pre-ada", fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      fs.writeFileSync(file, after);
      console.log("[start] updated the assistant identity in " + name);
    }
  ' "${WORKSPACE_DIR}" || log "WARNING: could not update the workspace identity files; the plugin still tells the model its name is Ada, that she serves everyone and that she answers in the language of the latest message"
  local current
  current="$(oc config get agents.entries.main.identity.name --json 2>/dev/null || true)"
  if printf '%s' "${current}" | grep -qiE '(^|[^[:alnum:]])vera([^[:alnum:]]|$)'; then
    config_set agents.entries.main.identity.name '"Ada"'
  fi
}
migrate_identity_name

# The tool allowlist comes from the manifest bundled with the plugin so it
# cannot drift from the tools Ada registers.
ADA_TOOLS_JSON="$(node -e '
  const fs = require("node:fs");
  const manifest = JSON.parse(fs.readFileSync(process.argv[1] + "/openclaw.plugin.json", "utf8"));
  process.stdout.write(JSON.stringify(manifest.contracts.tools));
' "${ADA_DIR}")"

config_set plugins.entries.ada.enabled true
config_set plugins.entries.ada.hooks.allowConversationAccess true
config_set plugins.entries.kapso-whatsapp.enabled true
config_set tools.alsoAllow "${ADA_TOOLS_JSON}"
config_set 'channels["kapso-whatsapp"].enabled' true
config_set 'channels["kapso-whatsapp"].phoneNumberId' "$(json_of_env KAPSO_PHONE_NUMBER_ID)"
config_set 'channels["kapso-whatsapp"].defaultTo' "$(json_of_env KAPSO_DEFAULT_TO)"
# Anyone may message the bot: dmSecurity "open" needs allowFrom to hold the wildcard. The
# lawyer's own number stays in defaultTo (outbound default, and the sender that opens the
# digest window), but it no longer gates who can chat.
config_set 'channels["kapso-whatsapp"].dmSecurity' '"open"'
config_set 'channels["kapso-whatsapp"].allowFrom' '["*"]'
# With the default "main" scope every DM shares one conversation, so anyone could read what
# another number said. One isolated session per WhatsApp number keeps chats apart; the lawyer's
# own chat moves to a session of its own too (the default scope's shared history is not copied).
config_set session.dmScope '"per-channel-peer"'
config_set agents.defaults.model.primary "$(json_of_env ADA_MODEL)"
# Ada's own service owns the 15-minute poll and the 07:40 Europe/Rome pass.
config_set agents.defaults.heartbeat.every '"0m"'
config_set gateway.controlUi.allowedOrigins "$(PUBLIC_ORIGIN="${PUBLIC_ORIGIN}" node -p 'JSON.stringify([process.env.PUBLIC_ORIGIN])')"

config_set_env 'channels["kapso-whatsapp"].webhookSecret' KAPSO_WEBHOOK_SECRET secret
config_set_env 'channels["kapso-whatsapp"].apiKey' KAPSO_API_KEY secret
config_set_env plugins.entries.ada.config.accessToken LEXROOM_ACCESS_TOKEN secret
config_set_env plugins.entries.ada.config.googleClientId ADA_GOOGLE_CLIENT_ID
config_set_env plugins.entries.ada.config.googleClientSecret ADA_GOOGLE_CLIENT_SECRET secret
config_set_env plugins.entries.ada.config.googleStateSecret ADA_GOOGLE_STATE_SECRET secret
config_set_env plugins.entries.ada.config.googlePubSubTopic ADA_GOOGLE_PUBSUB_TOPIC
config_set_env plugins.entries.ada.config.googleNotifyAudience ADA_GOOGLE_NOTIFY_AUDIENCE
config_set_env plugins.entries.ada.config.googleNotifyServiceAccount ADA_GOOGLE_NOTIFY_SERVICE_ACCOUNT
config_set_env plugins.entries.ada.config.googleNotifyToken ADA_GOOGLE_NOTIFY_TOKEN secret
config_set_env plugins.entries.ada.config.statusToken ADA_STATUS_TOKEN secret

# Utility template sent once when a digest is held because the WhatsApp window is
# closed. Both fields are required by the plugin schema, so the language defaults
# here. Unset name: not configured, and a value already on the volume stays put.
if [ -n "${ADA_DIGEST_TEMPLATE_NAME:-}" ]; then
  export ADA_DIGEST_TEMPLATE_LANG="${ADA_DIGEST_TEMPLATE_LANG:-it}"
  config_set plugins.entries.ada.config.digestReadyTemplate "$(node -p '
    JSON.stringify({
      name: process.env.ADA_DIGEST_TEMPLATE_NAME.trim(),
      language: process.env.ADA_DIGEST_TEMPLATE_LANG.trim(),
    })
  ')"
else
  if [ -n "${ADA_DIGEST_TEMPLATE_LANG:-}" ]; then
    log "WARNING: ADA_DIGEST_TEMPLATE_LANG is ignored because ADA_DIGEST_TEMPLATE_NAME is unset"
  fi
  log "skip plugins.entries.ada.config.digestReadyTemplate: ADA_DIGEST_TEMPLATE_NAME is unset"
fi

# Deadline intake is off unless ADA_DEADLINE_INTAKE_ENABLED is exactly true, and the
# value is written on every boot so removing the variable turns the feature off.
case "$(printf '%s' "${ADA_DEADLINE_INTAKE_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')" in
  true) DEADLINE_INTAKE_ENABLED=true ;;
  false | "") DEADLINE_INTAKE_ENABLED=false ;;
  *) die "ADA_DEADLINE_INTAKE_ENABLED must be true or false, got '${ADA_DEADLINE_INTAKE_ENABLED}'" ;;
esac
config_set plugins.entries.ada.config.deadlineIntake.enabled "${DEADLINE_INTAKE_ENABLED}"

# Comma-separated reminder cadence such as "7d,2d,morning-of". Validated here
# because an invalid value would make the plugin config fail schema validation.
if [ -n "${ADA_DEADLINE_REMINDERS:-}" ]; then
  REMINDERS_JSON="$(node -p '
    const steps = process.env.ADA_DEADLINE_REMINDERS.split(",").map((v) => v.trim()).filter(Boolean);
    const valid = steps.length > 0 && steps.every((v) => /^(\d{1,3}d|morning-of)$/u.test(v));
    if (!valid) {
      process.stderr.write("invalid cadence\n");
      process.exit(1);
    }
    JSON.stringify(steps);
  ')" || die "ADA_DEADLINE_REMINDERS must be comma-separated steps like 7d,2d,morning-of, got '${ADA_DEADLINE_REMINDERS}'"
  config_set plugins.entries.ada.config.deadlineIntake.reminders "${REMINDERS_JSON}"
else
  log "skip plugins.entries.ada.config.deadlineIntake.reminders: ADA_DEADLINE_REMINDERS is unset"
fi

# WhatsApp status reactions (👀 → ⏳ → ✅/❌) are sent by the Ada plugin straight through
# Kapso and read from the gateway environment, so this only validates and exports them.
# OpenClaw's messages.ackReaction/statusReactions are not used: they are a no-op on Kapso.
STATUS_REACTIONS="$(printf '%s' "${ADA_STATUS_REACTIONS:-true}" | tr '[:upper:]' '[:lower:]')"
case "${STATUS_REACTIONS}" in
  true | false) ;;
  "") STATUS_REACTIONS=true ;;
  *) die "ADA_STATUS_REACTIONS must be true or false, got '${ADA_STATUS_REACTIONS}'" ;;
esac
export ADA_STATUS_REACTIONS="${STATUS_REACTIONS}"
for reaction_var in ADA_REACTION_ACK ADA_REACTION_THINKING ADA_REACTION_DONE ADA_REACTION_ERROR; do
  reaction_value="${!reaction_var:-}"
  if [ -n "${reaction_value}" ] && [ "${#reaction_value}" -gt 32 ]; then
    die "${reaction_var} must be a single emoji, got '${reaction_value}'"
  fi
done

if [ -n "${ADA_GOOGLE_CLIENT_ID:-}" ]; then
  # The default stays /vera/google/callback: that exact URI is registered in Google Cloud.
  # The plugin also answers on /ada/google/callback once that URI is registered there.
  export GOOGLE_REDIRECT_URI="${ADA_GOOGLE_REDIRECT_URI:-${PUBLIC_ORIGIN}/vera/google/callback}"
  export LEXROOM_CONNECT_URI="${ADA_LEXROOM_CONNECT_URI:-${PUBLIC_ORIGIN}/ada/lexroom/connect}"
  config_set plugins.entries.ada.config.googleRedirectUri "$(json_of_env GOOGLE_REDIRECT_URI)"
  config_set plugins.entries.ada.config.lexroomConnectUri "$(json_of_env LEXROOM_CONNECT_URI)"
else
  log "skip Google redirect and Lexroom connect URIs: ADA_GOOGLE_CLIENT_ID is unset"
fi

if [ -z "${ADA_TOKEN_KEY:-}" ]; then
  if [ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]; then
    log "WARNING: ADA_TOKEN_KEY is unset; Ada derives the key for saved Lexroom and Google credentials from OPENCLAW_GATEWAY_TOKEN, and rotating that token makes them unreadable (set ADA_TOKEN_KEY before connecting: openssl rand -base64 32)"
  else
    log "WARNING: ADA_TOKEN_KEY is unset; NODE_ENV=production makes Ada refuse to open its Google and Lexroom account stores (generate one with: openssl rand -base64 32)"
  fi
fi

if [ -z "${ADA_STATUS_TOKEN:-}" ]; then
  log "WARNING: ADA_STATUS_TOKEN is unset, so GET /ada/status returns 401"
fi

# Meaning-based memory search through Voyage AI embeddings, on only while VOYAGE_API_KEY is
# set. The Voyage provider is not bundled in the OpenClaw image, so it is installed here.
# OpenClaw reads VOYAGE_API_KEY from the environment itself, so the key is never written to the
# config. A provider or model change pauses memory search until the index is rebuilt, so the
# index is refreshed before the gateway starts (incremental once it matches). Nothing in this
# block may fail the boot: every step is bounded by a timeout and any problem leaves memory
# search on its keyword-only default.
VOYAGE_PLUGIN_SPEC="npm:@openclaw/voyage-provider@${VOYAGE_PLUGIN_VERSION:-2026.9.9}"
voyage_memory_index() {
  timeout 60 node "${APP_DIR}/openclaw.mjs" memory index --agent main \
    || log "WARNING: memory index rebuild failed; run: openclaw memory index --agent main"
}
voyage_memory_off() {
  oc config unset memory.search.provider >/dev/null || log "WARNING: could not unset memory.search.provider"
  oc config unset memory.search.model >/dev/null || log "WARNING: could not unset memory.search.model"
  voyage_memory_index
}
current_memory_provider="$(oc config get memory.search.provider 2>/dev/null || true)"
if [ -n "${VOYAGE_API_KEY:-}" ]; then
  export ADA_MEMORY_EMBEDDING_MODEL="${ADA_MEMORY_EMBEDDING_MODEL:-voyage-law-2}"
  log "install voyage embeddings plugin ${VOYAGE_PLUGIN_SPEC}"
  if timeout 60 node "${APP_DIR}/openclaw.mjs" plugins install "${VOYAGE_PLUGIN_SPEC}" --accept-capabilities --force \
    && oc config set memory.search.provider '"voyage"' --strict-json \
    && oc config set memory.search.model "$(json_of_env ADA_MEMORY_EMBEDDING_MODEL)" --strict-json; then
    log "rebuild memory index with voyage/${ADA_MEMORY_EMBEDDING_MODEL}"
    voyage_memory_index
  else
    log "WARNING: could not set up voyage memory search (${VOYAGE_PLUGIN_SPEC}); using keyword-only search"
    if printf '%s' "${current_memory_provider}" | grep -q voyage; then
      voyage_memory_off
    fi
  fi
elif printf '%s' "${current_memory_provider}" | grep -q voyage; then
  log "VOYAGE_API_KEY is unset; turning voyage memory search off"
  voyage_memory_off
else
  log "skip voyage memory search: VOYAGE_API_KEY is unset"
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
