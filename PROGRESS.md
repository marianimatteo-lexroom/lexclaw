# Vera progress

Handoff for a fresh session. Read this before changing Vera, Kapso, or the Railway gateway.

Last checked 2026-10-10 around 00:20 UTC. The gateway was live on OpenClaw `2026.9.9` with Instinct memory/wake Vera. No secrets belong in this file or in git. Tokens, webhook secrets, and API keys live only in Railway variables and on the volume.

## Product

Vera is a WhatsApp assistant for one Lexroom lawyer. Working name is Vera. The lawyer texts a Lexroom business number. Clients, colleagues, and secretaries do not.

Locked decisions:

- One separate agent per lawyer. Lawyers cannot see each other's matters. Each chat is one Lexroom user.
- Day-one Lexroom API is research and draft only. After a digest, offer exactly two next steps. Research runs first. Draft only after a separate confirmation. Never send email or change the calendar.
- Morning digest: one message, ranked by cost of waiting. Stay silent when nothing clears the bar. The silent reply must be exactly `NO_REPLY`.
- Collector owns Gmail/Calendar diffs and `planDigest`. The model phrases only when `deliver: true`. Quiet mornings do not open a session.
- Email and calendar are optional and chosen by the lawyer (Gmail and/or Outlook, Google Calendar and/or Outlook). Outlook has no connector yet.
- WhatsApp transport is Kapso (`@kapso/openclaw-whatsapp`), not Baileys.
- Memory is Instinct-shaped, matter-scoped SQLite (`memory.sqlite`): aliases + keyword search, injected brief, daily reconcile writes, answering agent reads only.
- Disable the Gateway model heartbeat (`every: "0m"`). The Vera service owns the 15-minute poll and 07:40 Europe/Rome pass.
- Case 1 (morning digest) plus event wakes for urgent calendar/mail are in the Instinct memory/wake build. Non-urgent mail waits for morning; drafts still need a separate yes.

Digest cost bar is 40 (`extensions/vera/src/digest.ts`):

- Same-day deadline, or calendar within 24h and not more than 12h past: 100
- Within 48h: 80
- `calendar_move` with `movedCloser`, even if farther: 70
- `overnight_email` with `needsDecision`: 60
- Confirmed deadline or hearing with a reminder due or a new date (`tracked` signal, only with `deadlineIntake.enabled`): 60
- `decision_waiting` with `needsDecision`: 50
- Otherwise 0

Deadline and hearing intake (`deadlineIntake.enabled`, default false) adds deadline lines with reply numbers to the digest plan, `vera_deadline_reply` for the lawyer's answer, and reminders for confirmed items only. See `extensions/vera/README.md`.

One line per matter. A delivered digest offers exactly two next steps. Silence is `{deliver:false, reason:"nothing_cleared_the_bar"}`.

## What is already done

- Plugin merged to `main` as `c8a0b55bebe` via PR #1 (`feat(vera): add the lawyer morning digest`). Source is `extensions/vera/`. Tools: `vera_plan_digest`, `vera_research`, `vera_draft`. Skill: `vera-morning-digest`.
- Vera is excluded from the published OpenClaw npm tarball (`!dist/extensions/vera/**`). The stock Railway OpenClaw template does not include Vera. Do not deploy that template.
- Railway gateway is running Vera plus Kapso. WhatsApp round-trip worked: the lawyer texted the business number and got a reply.
- Identity on the volume is Vera. A naming PR is not required for this server. The volume survives redeploys. A PR would matter only for a brand-new empty volume.

## What is not done

Case 1 is closer but not fully proven end-to-end. Chat works. Instinct wake service `vera-instinct-wake` starts on boot (15-minute poll + 07:40 Europe/Rome). Published OpenClaw `2026.9.9` still omits the Gateway service scheduler on the plugin service context, so Vera falls back to `setInterval` and logs a warn. Heartbeat is disabled (`every: "0m"`). `plugins.entries.vera.hooks.allowConversationAccess` is true so the brief hook is not blocked.

1. Gmail and Google Calendar use Vera's Google OAuth API, not MCP and not `gog`. `gog` is a shell login and its callback URL must not be texted. One authorize URL covers read-only Gmail and read-only Calendar. The lawyer opens it from WhatsApp. The Gateway callback is `GET /vera/google/callback`. The refresh token stays in SQLite at `$OPENCLAW_STATE_DIR/vera/google-account.sqlite`.

   Google Cloud project `<GCP_PROJECT_ID>` has the OAuth web client, and the gateway variables are set: `VERA_GOOGLE_CLIENT_ID`, `VERA_GOOGLE_CLIENT_SECRET`, `VERA_GOOGLE_STATE_SECRET`, and `VERA_GOOGLE_REDIRECT_URI` (`https://vera.example.com/vera/google/callback`). Register that redirect URI on the OAuth web client. The installed plugin worker resolves the SDK from `/app/openclaw.mjs` because it lives outside the OpenClaw package. A bare callback request returns 400, not 503, so config loaded. WhatsApp Cloud API still rejects non-template outbound outside the 24-hour window; held digests wait for the next lawyer inbound.

2. Prove a morning or urgent wake on the live number (collector → plan → WhatsApp phrasing, or silent `NO_REPLY`). The live channel is `kapso-whatsapp`.
3. Lexroom connect is WhatsApp-linked like Google: `vera_lexroom_connect` texts `/vera/lexroom/connect`, the lawyer signs in with Lexroom email/password (MFA when required), and the bearer is stored in `$OPENCLAW_STATE_DIR/vera/lexroom-account.sqlite`. A static `LEXROOM_ACCESS_TOKEN` remains a fallback only. Machine API keys (`lrsk-...`, `X-API-Key`) are not accepted by Research or Drafting. Login is `POST https://api.lexroom.ai/v1/login` with `X-Client-Type: app_lex`. MFA accounts continue through `app.lexroom.ai` (`/api/auth/mfa/start`, `/api/auth/mfa/verify`, `mfa-session-exchange`); the MFA form returns HTTP 200 with a sealed ticket, not 401.

Later, not started: one agent per lawyer, and hard per-matter memory walls.

## Live Railway

Railway is a container service, not a VM. Account `<RAILWAY_ACCOUNT>`. Workspace `<RAILWAY_WORKSPACE_NAME>` (`<RAILWAY_WORKSPACE_ID>`).

Do not modify the other projects: `<OTHER_PROJECT_1>`, `product-roast-bot`, `lexroom-mcp`, `fluida_mono`, `lexroom-contract-review-bot`. `ANTHROPIC_API_KEY` was copied from `<OTHER_PROJECT_1>` service `api` (`<RAILWAY_SERVICE_ID_OTHER>`).

| Piece         | Value                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project       | `vera` `<RAILWAY_PROJECT_ID>`                                                                                                           |
| Service       | `gateway` `<RAILWAY_SERVICE_ID>`                                                                                                        |
| Volume        | `gateway-volume` `<RAILWAY_VOLUME_ID>` mounted at `/data`                                                                              |
| Public URL    | `https://vera.example.com` (Railway custom domain; legacy `<RAILWAY_LEGACY_DOMAIN>` may still resolve)                                    |
| Control UI    | `https://vera.example.com/openclaw`                                                                                                                     |
| Health        | `GET /healthz` returns `{"ok":true,"status":"live"}`                                                                                                    |
| Region        | `us-west2`, 1 replica                                                                                                                                   |
| Image         | `docker.io/openclaw/openclaw:2026.9.9` plus a bundled Vera copy (Instinct memory workers + wake service)                                                 |
| Latest deploy | `<RAILWAY_DEPLOY_ID>` ("Point Vera pages and links at vera.example.com"), SUCCESS, 2026-10-10T17:01Z. Wake service uses setInterval fallback until the host exposes `ctx.scheduler`. |
| Logs          | `https://railway.app/project/<RAILWAY_PROJECT_ID>/service/<RAILWAY_SERVICE_ID>?id=<RAILWAY_DEPLOY_ID>` |

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

Project `Lexroom` `<KAPSO_PROJECT_ID>`. Customer `<KAPSO_CUSTOMER_ID>` ("Default customer"). Plan limit is 1 number.

Production sender Lexroom `+1 202-490-8196`. `phone_number_id` `<KAPSO_PHONE_NUMBER_ID>`. Internal id `<KAPSO_NUMBER_ID>`. Status CONNECTED, name APPROVED, quality GREEN. `code_verification_status` EXPIRED does not block inbound. Sandbox number `<KAPSO_SANDBOX_NUMBER_ID>` must not be used.

Lawyer test number: Test Lawyer `+390000000000` (digits `390000000000`, WhatsApp user id `<WHATSAPP_BSUID>`). Allowlist must include both `+E.164` and digits. Conversation seen: `<KAPSO_CONVERSATION_ID>`.

Railway webhook `<WEBHOOK_ID>`, URL `https://vera.example.com/kapso/webhook`, active, payload v2, event `whatsapp.message.received`. Doctor reported registration ok. A POST with no valid signature returns 401 `invalid_signature`.

The earlier Cursor-automation webhook `<PAUSED_WEBHOOK_ID>` was paused (`active` false). Leave it paused so messages are not delivered twice. Do not record its bearer token.

WhatsApp Cloud API rejects non-template outbound outside the 24-hour customer-care window (HTTP 422). Text the business number from `+390000000000` to open the window before an outbound test.

Channel config: `channels["kapso-whatsapp"]` enabled, `dmSecurity` `allowlist`, `defaultTo` `+390000000000`. `plugins.entries.vera` and `plugins.entries.kapso-whatsapp` enabled. Do not set a restrictive `plugins.allow`. An empty allow list loads bundled plugins. A non-empty list blocks model plugins.

Kapso MCP is OAuth. There is no MCP tool to create an API key. Do not run interactive `openclaw kapso-whatsapp cli login`.

## Env var names

Set on service `gateway`. Values stay in Railway.

- `OPENCLAW_GATEWAY_PORT=8080`
- `OPENCLAW_GATEWAY_TOKEN`
- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `RAILWAY_RUN_UID=0`
- `KAPSO_PHONE_NUMBER_ID=<KAPSO_PHONE_NUMBER_ID>`
- `KAPSO_DEFAULT_TO=+390000000000`
- `KAPSO_BASE_URL=https://api.kapso.ai/meta/whatsapp`
- `KAPSO_WEBHOOK_PATH=/kapso/webhook`
- `KAPSO_WEBHOOK_SECRET`
- `KAPSO_API_KEY` (present, length 64; doctor `apiKeyStatus: available`)
- `ANTHROPIC_API_KEY` (kept in Railway; `start.sh` unsets it for the gateway process after a setup token imports)
- `ANTHROPIC_SETUP_TOKEN` (Claude Pro/Max setup token, `sk-ant-oat01-...`; imported on boot into auth profile `anthropic:manual`)
- `LEXROOM_ACCESS_TOKEN`
- `VERA_GOOGLE_CLIENT_ID`
- `VERA_GOOGLE_CLIENT_SECRET`
- `VERA_GOOGLE_STATE_SECRET`
- `VERA_PUBLIC_ORIGIN=https://vera.example.com` (Control UI origin + default connect hosts)
- `VERA_GOOGLE_REDIRECT_URI=https://vera.example.com/vera/google/callback`
- `VERA_LEXROOM_CONNECT_URI=https://vera.example.com/vera/lexroom/connect`
- `VERA_STATUS_TOKEN` (16+ characters; enables `GET /vera/status`)
- `KAPSO_PLUGIN_VERSION` (optional override of the Dockerfile pin)

The container runs as root because the volume is root-owned. Plugin files must be `chown root:root`. A `node`-owned copy (uid 1000) is blocked as suspicious ownership and then fails with "Plugin artifact has no valid plugin manifest".

## Redeploy

Deploy assets live in git under `deploy/railway/` (`Dockerfile`, `start.sh`, `railway.json`, `build.sh`, and a README with the variable list). From a checkout with `pnpm install` run, `railway link` pointed at the Vera project, and Node 24:

```bash
deploy/railway/build.sh --deploy
```

`build.sh` bundles Vera with esbuild, stages a clean build context, and runs `railway up` for the `gateway` service. Run it without `--deploy` to stage only. Published OpenClaw images do not load TypeScript plugins, which is why Vera is bundled.

`start.sh` runs under `set -euo pipefail`, logs every config step (secret values hidden), and aborts the boot on any failing step, so Railway shows a failed deploy instead of a half-configured gateway. It rewrites channel, model, tools, and tokens from env on every boot.

The Kapso plugin is pinned: `KAPSO_PLUGIN_VERSION` is a Dockerfile build arg (default `0.1.4`, installed as `clawhub:@kapso/openclaw-whatsapp@<version>`). Set a service variable with that name to move the pin. A volume that holds another version is reinstalled at the pin on boot. Railway CLI was 4.68.0, and `railway.toml` is deprecated, so config as code is `railway.json` with healthcheck path `/healthz`.

Monitoring: `GET /vera/status` (Bearer `VERA_STATUS_TOKEN`) and one `vera.collect` JSON log line per collect pass. The suggested "no collect in 45 min" alert is in `extensions/vera/README.md#monitoring`.

Gateway 502s during boot are normal until plugin install finishes. Health should return 200 about 10 seconds after the deploy is SUCCESS.

Changing Vera code requires a new image. Workspace identity and OpenClaw config stay on the volume.

## Lexroom API

Base `https://api.lexroom.ai`. Auth is `Authorization: Bearer` plus `X-Client-Type: app_lex`.

- Research (`LEXROOM_AMA`): `POST /v1/ask_me_anything` with `{query, search_on_modules, documents: [], is_temporary: false, search_on_user_data}`. `search_on_modules` needs at least one module; Vera sends the call's modules, else `researchModules` from config, else `["Civile"]`. The body is NDJSON despite the `text/event-stream` header: every line is a full cumulative `{research}` snapshot, with no deltas. Read line by line (lines reach several MB), keep the last, and stop at `status: "DONE"`. Answer text is `research.answer.text` (markdown with `[n]` markers); sources are `research.documents[].files[]` keyed by `citation_id`. Vera converts the answer to WhatsApp formatting and lists only the cited sources as `[n] title - court, date`. There is no reload GET. About 80 seconds. Never set `search_on_user_data` true unless the call names that matter's `libraryDocumentIds`.
- Draft (`LEXROOM_DRAFTING`): `POST /v2/ai/drafting/selectors` with `{prompt, template: null}` when modules are not already chosen (modules with `is_active: false` are skipped), then `POST /v2/ai/drafting` with `{prompt, documents: [], template: null, modules}`. Same NDJSON stream; the final snapshot has `draft{title, content}`, `analysis`, and `sources[]`. Display text is `draft.edited_content`, otherwise `draft.content`. Draft does not call the network unless `confirmed` is true.
- `GET /v2/craft/drafting/{id}` returns the final research object unwrapped. Vera only calls it, with a 30 second budget, when the stream ends DONE without a draft; an earlier integration saw it hang.
- Do not use `/healthcheck` (404).

The internal API doc must not be committed.

## Verify

```bash
curl -sS https://vera.example.com/healthz
```

Over SSH, the identity check should show name Vera, channel true, apiKey set, and phone set. Logs should include `kapso-whatsapp` and `vera` in the listening plugin list. Google and Lexroom connect links must use `https://vera.example.com/...`.

Text `+1 202-490-8196` from `+39 000 000 0000`.
