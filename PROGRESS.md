# Vera progress

Handoff for a fresh session. Read this before changing Vera, Kapso, or the Railway gateway.

Last checked 2026-10-09 around 07:53 UTC. The gateway was live. No secrets belong in this file or in git. Tokens, webhook secrets, and API keys live only in Railway variables and on the volume.

## Product

Vera is a WhatsApp assistant for one Lexroom lawyer. Working name is Vera. The lawyer texts a Lexroom business number. Clients, colleagues, and secretaries do not.

Locked decisions:

- One separate agent per lawyer. Lawyers cannot see each other's matters. Each chat is one Lexroom user.
- Day-one Lexroom API is research and draft only. After a digest, offer exactly two next steps. Research runs first. Draft only after a separate confirmation. Never send email or change the calendar.
- Morning digest: one message, ranked by cost of waiting. Stay silent when nothing clears the bar. The silent cron reply must be exactly `NO_REPLY`.
- Email and calendar are optional and chosen by the lawyer (Gmail and/or Outlook, Google Calendar and/or Outlook). Outlook has no connector yet.
- WhatsApp transport is Kapso (`@kapso/openclaw-whatsapp`), not Baileys.
- Memory stays on one client or matter. Language is the lawyer's language. Jurisdiction comes from the Lexroom account, usually Italian.
- Case 1 (morning digest) is the current build. Case 2 is not started: wake on a new email, summarize it, and draft a reply without sending it.

Digest cost bar is 40 (`extensions/vera/src/digest.ts`):

- Same-day deadline, or calendar within 24h and not more than 12h past: 100
- Within 48h: 80
- `calendar_move` with `movedCloser`, even if farther: 70
- `overnight_email` with `needsDecision`: 60
- `decision_waiting` with `needsDecision`: 50
- Otherwise 0

One line per matter. A delivered digest offers exactly two next steps. Silence is `{deliver:false, reason:"nothing_cleared_the_bar"}`.

## What is already done

- Plugin merged to `main` as `c8a0b55bebe` via PR #1 (`feat(vera): add the lawyer morning digest`). Source is `extensions/vera/`. Tools: `vera_plan_digest`, `vera_research`, `vera_draft`. Skill: `vera-morning-digest`.
- Vera is excluded from the published OpenClaw npm tarball (`!dist/extensions/vera/**`). The stock Railway OpenClaw template does not include Vera. Do not deploy that template.
- Railway gateway is running Vera plus Kapso. WhatsApp round-trip worked: Matteo texted the business number and got a reply.
- Identity on the volume is Vera. A naming PR is not required for this server. The volume survives redeploys. A PR would matter only for a brand-new empty volume.

## What is not done

Case 1 is not fully working yet. Chat works. The morning digest does not run.

1. Gmail and Google Calendar use Vera's Google OAuth API, not MCP and not `gog`. The morning cron has no WhatsApp sender, so requester-scoped MCP never attaches on that run. `gog` is a shell login and its callback URL must not be texted. One authorize URL covers read-only Gmail and read-only Calendar. The lawyer opens it from WhatsApp. The Gateway callback is `GET /vera/google/callback`. The refresh token stays in SQLite at `$OPENCLAW_STATE_DIR/vera/google-account.sqlite`.

   Google Cloud project `verus-500517` has the OAuth web client, and the gateway variables are set: `VERA_GOOGLE_CLIENT_ID`, `VERA_GOOGLE_CLIENT_SECRET`, `VERA_GOOGLE_STATE_SECRET`, and `VERA_GOOGLE_REDIRECT_URI` (`https://gateway-production-e368.up.railway.app/vera/google/callback`). The installed plugin worker resolves the SDK from `/app/openclaw.mjs` because it lives outside the OpenClaw package. A bare callback request returns 400, not 503, so config loaded. The morning cron is still not created. WhatsApp Cloud API still rejects non-template outbound outside the 24-hour window.

2. No 07:40 Europe/Rome digest job. Jobs present on 2026-10-09: heartbeat `e7c258bc-fbe6-4f59-b665-4f531667736f` (every 30 min) and skill-collection-review `57938a83-1055-4b42-bac1-d5114b45ae1d` (weekly). The README command still says `--channel whatsapp`; the live channel is `kapso-whatsapp`.
3. Lexroom bearer expires `2026-10-09T21:59:35.000Z`. Research and draft fail after that until refresh. Machine API keys (`lrsk-...`, `X-API-Key`) are not accepted by Research or Drafting. Login is `POST https://api.lexroom.ai/v1/login` with `X-Client-Type: app_lex`. `LEXROOM_EMAIL` and `LEXROOM_PASSWORD` exist on the separate Railway project `verus-legal`, not on Vera. Do not print them. MFA can return 403 `mfa_step_up_required`.

Later, not started: case 2 (email wake), one agent per lawyer, and hard per-matter memory walls.

## Live Railway

Railway is a container service, not a VM. Account `metalmetta`. Workspace `metalmetta's Projects` (`be85b6ee-8828-454d-b0be-115e63097222`).

Do not modify the other projects: `verus-legal`, `product-roast-bot`, `lexroom-mcp`, `fluida_mono`, `lexroom-contract-review-bot`. `ANTHROPIC_API_KEY` was copied from `verus-legal` service `api` (`b875372f-3dae-4ded-a74f-7aa2fcb8481b`).

| Piece         | Value                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project       | `vera` `6884818a-0e95-49d8-9052-22712801dbd0`                                                                                                           |
| Service       | `gateway` `96a03ba4-d4bf-4769-9851-e3a506f73805`                                                                                                        |
| Volume        | `gateway-volume` `12b5b404-4158-4935-afb2-6b4b8ffedd86` mounted at `/data`                                                                              |
| Public URL    | `https://gateway-production-e368.up.railway.app`                                                                                                        |
| Control UI    | `https://gateway-production-e368.up.railway.app/openclaw`                                                                                               |
| Health        | `GET /healthz` returns `{"ok":true,"status":"live"}`                                                                                                    |
| Region        | `us-west2`, 1 replica                                                                                                                                   |
| Image         | `docker.io/openclaw/openclaw:2026.9.8` plus a bundled Vera copy                                                                                         |
| Latest deploy | `a799d262-f93a-4ad0-8979-367041caa598` ("Fix Vera Google account worker imports"), SUCCESS, 2026-10-09T09:32Z. A bare `GET /vera/google/callback` returns 400 HTML once boot finishes, which means the route, Google config, and account store are live. |
| Logs          | `https://railway.com/project/6884818a-0e95-49d8-9052-22712801dbd0/service/96a03ba4-d4bf-4769-9851-e3a506f73805?id=a799d262-f93a-4ad0-8979-367041caa598` |

CLI inside the container is `node /app/openclaw.mjs`. `railway ssh` needs the key loaded in the agent. This VM registered key `vera-deploy`. A fresh machine must register its own key. Do not copy private keys into git.

`pnpm openclaw` on a Cloud Agent VM fails with `service-manager-unavailable`. Do not bypass that. Use the container CLI.

Config and workspace live on the volume:

- `/data/.openclaw/openclaw.json`
- `/data/workspace/IDENTITY.md` name Vera, emoji ⚖️, theme `Lexroom's assistant for one lawyer`
- `/data/workspace/SOUL.md` starts with "You are Vera..." and tells the model not to ask what it should be called
- `BOOTSTRAP.md` is already absent
- Identity: `agents.entries.main.identity` name `Vera`, emoji ⚖️
- SQLite: `/data/.openclaw/state/openclaw.sqlite`

`start.sh` rewrites channel, model, tools, and tokens from env on every boot. It does not clear `agents.entries.main.identity`.

## Model

Primary model is `anthropic/claude-opus-5`. No fallback is configured. Confirmed from `/data/.openclaw/openclaw.json` on 2026-10-09.

## Kapso

Project `Lexroom` `82ada295-b0cc-4886-bc3d-36d689cfe6f2`. Customer `0bb1f40f-0a71-4fcd-95fc-a97967bb5fa9` ("Default customer"). Plan limit is 1 number.

Production sender Lexroom `+1 202-490-8196`. `phone_number_id` `1197866140067824`. Internal id `59cc5195-8d66-4493-b162-5930197e8ffe`. Status CONNECTED, name APPROVED, quality GREEN. `code_verification_status` EXPIRED does not block inbound. Sandbox number `597907523413541` must not be used.

Lawyer test number: Matteo Mariani `+393403055911` (digits `393403055911`, WhatsApp user id `IT.1702791984232084`). Allowlist must include both `+E.164` and digits. Conversation seen: `4f122b80-fd4f-4e96-b56b-df17a1472f52`.

Railway webhook `9c97a689-b99f-4d48-b79e-5269c43c342e`, URL `https://gateway-production-e368.up.railway.app/kapso/webhook`, active, payload v2, event `whatsapp.message.received`. Doctor reported registration ok. A POST with no valid signature returns 401 `invalid_signature`.

The earlier Cursor-automation webhook `54268d25-ac7c-45bb-ae4b-3de20e61ea34` was paused (`active` false). Leave it paused so messages are not delivered twice. Do not record its bearer token.

WhatsApp Cloud API rejects non-template outbound outside the 24-hour customer-care window (HTTP 422). Text the business number from `+393403055911` to open the window before an outbound test.

Channel config: `channels["kapso-whatsapp"]` enabled, `dmSecurity` `allowlist`, `defaultTo` `+393403055911`. `plugins.entries.vera` and `plugins.entries.kapso-whatsapp` enabled. Do not set a restrictive `plugins.allow`. An empty allow list loads bundled plugins. A non-empty list blocks model plugins.

Kapso MCP is OAuth. There is no MCP tool to create an API key. Do not run interactive `openclaw kapso-whatsapp cli login`.

## Env var names

Set on service `gateway`. Values stay in Railway.

- `OPENCLAW_GATEWAY_PORT=8080`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `RAILWAY_RUN_UID=0`
- `KAPSO_PHONE_NUMBER_ID=1197866140067824`
- `KAPSO_DEFAULT_TO=+393403055911`
- `KAPSO_BASE_URL=https://api.kapso.ai/meta/whatsapp`
- `KAPSO_WEBHOOK_PATH=/kapso/webhook`
- `KAPSO_WEBHOOK_SECRET`
- `KAPSO_API_KEY` (present, length 64; doctor `apiKeyStatus: available`)
- `ANTHROPIC_API_KEY`
- `LEXROOM_ACCESS_TOKEN`
- `VERA_GOOGLE_CLIENT_ID`
- `VERA_GOOGLE_CLIENT_SECRET`
- `VERA_GOOGLE_STATE_SECRET`
- `VERA_GOOGLE_REDIRECT_URI` (optional; defaults to the public `/vera/google/callback`)

The container runs as root because the volume is root-owned. Plugin files must be `chown root:root`. A `node`-owned copy (uid 1000) is blocked as suspicious ownership and then fails with "Plugin artifact has no valid plugin manifest".

## Redeploy

Deploy assets are not in git. The previous build directory was `/tmp/vera-deploy` on the old Cloud Agent VM and will not exist in a fresh session. Recreate it, then from that directory:

```bash
railway up --detach --service gateway --message "Redeploy Vera gateway" --yes
```

Railway CLI was 4.68.0. `railway.toml` is deprecated. This deploy did not commit IaC.

`Dockerfile`:

```dockerfile
FROM docker.io/openclaw/openclaw:2026.9.8

USER root
COPY vera /opt/lexroom/vera
COPY start.sh /opt/lexroom/start.sh
RUN chmod 755 /opt/lexroom/start.sh && chown -R root:root /opt/lexroom
USER root

ENTRYPOINT ["tini", "-s", "--"]
CMD ["/opt/lexroom/start.sh"]
```

Bundle Vera with Node 24 from a source checkout. Published images do not load TypeScript plugin entries.

```bash
pnpm exec esbuild extensions/vera/index.ts \
  --bundle --platform=node --format=esm \
  --outfile=/tmp/vera-deploy/vera/index.js \
  --external:openclaw/plugin-sdk/tool-plugin \
  --external:openclaw/plugin-sdk/plugin-entry \
  --external:openclaw/plugin-sdk/sqlite-runtime

pnpm exec esbuild extensions/vera/src/google-account.worker.ts \
  --bundle --platform=node --format=esm \
  --outfile=/tmp/vera-deploy/vera/src/google-account.worker.js \
  --external:openclaw/plugin-sdk/plugin-state-runtime \
  --external:openclaw/plugin-sdk/sqlite-worker-runtime
```

Copy `extensions/vera` into `/tmp/vera-deploy/vera`, then point `package.json` `openclaw.extensions` at `./index.js`, set `dependencies` to `{}`, and delete `devDependencies`. Keep `openclaw.plugin.json`, `skills/`, and the README. Do not upload secrets in that directory.

`start.sh`:

```sh
#!/bin/sh
set -u
PORT="${OPENCLAW_GATEWAY_PORT:-8080}"
mkdir -p "${OPENCLAW_STATE_DIR:-/data/.openclaw}" "${OPENCLAW_WORKSPACE_DIR:-/data/workspace}"
cd /app

node openclaw.mjs plugins install /opt/lexroom/vera --accept-capabilities --force || echo "vera plugin install failed"
if [ ! -d /data/.openclaw/extensions/kapso-whatsapp ]; then
  node openclaw.mjs plugins install clawhub:@kapso/openclaw-whatsapp --accept-capabilities || echo "kapso plugin install failed"
fi

node openclaw.mjs config set plugins.entries.vera.enabled true --strict-json || true
node openclaw.mjs config set plugins.entries.kapso-whatsapp.enabled true --strict-json || true
node openclaw.mjs config set 'tools.alsoAllow' '["vera_plan_digest","vera_research","vera_draft","vera_google_connect","vera_read_inbox","vera_read_calendar"]' --strict-json || true
node openclaw.mjs config set 'channels["kapso-whatsapp"].enabled' true --strict-json || true
node openclaw.mjs config set 'channels["kapso-whatsapp"].phoneNumberId' '"1197866140067824"' --strict-json || true
node openclaw.mjs config set 'channels["kapso-whatsapp"].defaultTo' '"+393403055911"' --strict-json || true
node openclaw.mjs config set 'channels["kapso-whatsapp"].dmSecurity' '"allowlist"' --strict-json || true
node openclaw.mjs config set 'channels["kapso-whatsapp"].allowFrom' '["+393403055911","393403055911"]' --strict-json || true
node openclaw.mjs config set agents.defaults.model.primary '"anthropic/claude-opus-5"' --strict-json || true
node openclaw.mjs config set gateway.controlUi.allowedOrigins '["https://gateway-production-e368.up.railway.app"]' --strict-json || true

if [ -n "${KAPSO_WEBHOOK_SECRET:-}" ]; then
  secret_json="$(node -e 'process.stdout.write(JSON.stringify(process.env.KAPSO_WEBHOOK_SECRET))')"
  node openclaw.mjs config set 'channels["kapso-whatsapp"].webhookSecret' "$secret_json" --strict-json || true
fi
if [ -n "${KAPSO_API_KEY:-}" ]; then
  key_json="$(node -e 'process.stdout.write(JSON.stringify(process.env.KAPSO_API_KEY))')"
  node openclaw.mjs config set 'channels["kapso-whatsapp"].apiKey' "$key_json" --strict-json || true
fi
if [ -n "${LEXROOM_ACCESS_TOKEN:-}" ]; then
  token_json="$(node -e 'process.stdout.write(JSON.stringify(process.env.LEXROOM_ACCESS_TOKEN))')"
  node openclaw.mjs config set plugins.entries.vera.config.accessToken "$token_json" --strict-json || true
fi
if [ -n "${VERA_GOOGLE_CLIENT_ID:-}" ]; then
  node openclaw.mjs config set plugins.entries.vera.config.googleClientId "$(node -e 'process.stdout.write(JSON.stringify(process.env.VERA_GOOGLE_CLIENT_ID))')" --strict-json || true
fi
if [ -n "${VERA_GOOGLE_CLIENT_SECRET:-}" ]; then
  node openclaw.mjs config set plugins.entries.vera.config.googleClientSecret "$(node -e 'process.stdout.write(JSON.stringify(process.env.VERA_GOOGLE_CLIENT_SECRET))')" --strict-json || true
fi
if [ -n "${VERA_GOOGLE_STATE_SECRET:-}" ]; then
  node openclaw.mjs config set plugins.entries.vera.config.googleStateSecret "$(node -e 'process.stdout.write(JSON.stringify(process.env.VERA_GOOGLE_STATE_SECRET))')" --strict-json || true
fi
if [ -n "${VERA_GOOGLE_CLIENT_ID:-}" ]; then
  redirect_uri="${VERA_GOOGLE_REDIRECT_URI:-https://gateway-production-e368.up.railway.app/vera/google/callback}"
  redirect_json="$(REDIRECT_URI="$redirect_uri" node -e 'process.stdout.write(JSON.stringify(process.env.REDIRECT_URI))')"
  node openclaw.mjs config set plugins.entries.vera.config.googleRedirectUri "$redirect_json" --strict-json || true
fi

exec node openclaw.mjs gateway --allow-unconfigured --bind lan --port "$PORT"
```

Gateway 502s during boot are normal until plugin install finishes. Health should return 200 about 10 seconds after the deploy is SUCCESS.

Changing Vera code requires a new image. Workspace identity and OpenClaw config stay on the volume.

## Lexroom API

Base `https://api.lexroom.ai`. Auth is `Authorization: Bearer` plus `X-Client-Type: app_lex`.

- Research: `POST /v1/ask_me_anything`. NDJSON snapshots, not SSE. Terminal `research.status` is DONE or FAILED. About one minute. Never set `search_on_user_data` true unless the call names that matter's `libraryDocumentIds`.
- Cited sources: `GET /v1/cited_public_sources/{id}`.
- Draft: `POST /v2/ai/drafting/selectors`, then `POST /v2/ai/drafting`. Draft does not call the network unless `confirmed` is true.
- `GET /v2/craft/drafting/{id}` hangs. Do not use it.
- Do not use `/healthcheck` (404).

The internal API doc must not be committed.

## Verify

```bash
curl -sS https://gateway-production-e368.up.railway.app/healthz
```

Over SSH, the identity check should show name Vera, channel true, apiKey set, and phone set. Logs should include `kapso-whatsapp` and `vera` in the listening plugin list.

Text `+1 202-490-8196` from `+39 340 305 5911`.
