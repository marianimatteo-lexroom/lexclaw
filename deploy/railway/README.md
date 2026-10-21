# Ada gateway on Railway

Deploy assets for the Ada gateway: the stock `docker.io/openclaw/openclaw` image plus a bundled copy of `extensions/ada` and the Kapso WhatsApp plugin.

| File           | Purpose                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`   | Image definition. Owns the `OPENCLAW_VERSION` and `KAPSO_PLUGIN_VERSION` pins.                                |
| `start.sh`     | Boot script. Installs plugins, writes config from env, then execs the gateway. Any failing step aborts boot.  |
| `railway.json` | Railway config as code: Dockerfile build, `/healthz` healthcheck, one replica.                                |
| `build.sh`     | Bundles Ada with esbuild and stages a clean build context (Dockerfile, `start.sh`, `railway.json`, `ada/`). |

No project, service, volume, or webhook IDs live in this directory. The Railway CLI picks them from the project you `railway link`.

## Deploy

Prerequisites: Node 24+, `pnpm install` run at the repo root, the Railway CLI logged in, and `railway link` pointed at the Ada project with the gateway service and a volume mounted at `/data`.

```bash
deploy/railway/build.sh --deploy
```

Without `--deploy` the script only stages the context and prints the `railway up` command. `--out DIR` chooses the staging directory (default: a new temp directory outside the repo, so the repo `.gitignore` is not applied to the upload). `RAILWAY_SERVICE` names the service (default `gateway`).

Gateway 502s during boot are normal until plugin install finishes. Railway marks the deploy healthy once `GET /healthz` returns `{"ok":true,"status":"live"}`.

Changing Ada code needs a new image. Workspace identity and OpenClaw config stay on the volume.

## Version pins

| Pin                    | Default    | Where it applies                                                                                                                |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_VERSION`     | `2026.9.9` | Base image tag.                                                                                                                 |
| `KAPSO_PLUGIN_VERSION` | `0.1.4`    | `clawhub:@kapso/openclaw-whatsapp@<version>`. Installed on first boot. A volume with another version is reinstalled at the pin. |

Both are Docker build args. Railway passes a service variable with the same name as a build arg, so set `KAPSO_PLUGIN_VERSION` on the service to move the pin without editing the Dockerfile. For a local image build use `docker build --build-arg KAPSO_PLUGIN_VERSION=<version> ...`. `start.sh` refuses to boot when the value is not an exact version.

## Service variables

Values stay in Railway. Nothing here belongs in git. `start.sh` writes config from these on every boot. A variable that is unset is skipped (logged) and never breaks the boot; whatever is already on the volume stays untouched, except where noted.

### Required (boot fails without them)

| Variable                | Notes                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KAPSO_PHONE_NUMBER_ID` | Kapso `phone_number_id` of the business sender.                                                                                                             |
| `KAPSO_DEFAULT_TO`      | Lawyer WhatsApp number in `+E.164` form: the default outbound recipient, and the only sender whose message opens the digest window. It does not limit who can chat; anyone can message the bot (`dmSecurity` is `open`).                                                                   |
| `KAPSO_PLUGIN_VERSION`  | Exact version such as `0.1.4`. The Dockerfile sets the default, so it only needs a service variable to move the pin.                                        |
| `ADA_PUBLIC_ORIGIN`    | Public origin such as `https://ada.example.com`. Not needed when Railway provides `RAILWAY_PUBLIC_DOMAIN` (a generated domain). One of the two must exist. |

Also needed for a working gateway, but not checked by `start.sh`: `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_STATE_DIR=/data/.openclaw`, `OPENCLAW_WORKSPACE_DIR=/data/workspace`, `RAILWAY_RUN_UID=0` (the volume is root-owned), and a model credential (`ANTHROPIC_API_KEY` or `ANTHROPIC_SETUP_TOKEN`). `OPENCLAW_GATEWAY_PORT` defaults to `8080` (`PORT` is the fallback).

### Optional: Kapso and model

| Variable                | Effect                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KAPSO_API_KEY`         | Kapso API key (secret). `KAPSO_BASE_URL` and `KAPSO_WEBHOOK_PATH` are read by the plugin directly.                                                                                                                                               |
| `KAPSO_WEBHOOK_SECRET`  | Kapso webhook secret (secret).                                                                                                                                        |
| `ADA_MODEL`            | Default `anthropic/claude-opus-5`.                                                                                                                                    |
| `ANTHROPIC_API_KEY`     | API key. Required when `ANTHROPIC_SETUP_TOKEN` is unset or its import fails.                                                                                          |
| `ANTHROPIC_SETUP_TOKEN` | Imported on boot. A failed import is fatal unless `ANTHROPIC_API_KEY` is set.                                                                                         |

### Optional: Voyage embeddings

Meaning-based recall, on only while `VOYAGE_API_KEY` is set. Without it nothing changes: both memories keep their keyword search and Ada makes no Voyage request. Voyage can never fail a boot or a reply: every problem falls back to keyword search.

| Variable                     | Effect                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOYAGE_API_KEY`             | Voyage AI API key (secret). Never written to the config or logs. `start.sh` installs the Voyage provider plugin, sets `memory.search.provider=voyage` for OpenClaw's shared memory search and rebuilds its index (`openclaw memory index --agent main`, 60 s cap, non-fatal). Ada's per-number memory (`memory/<number>.sqlite`) also embeds each note through `POST https://api.voyageai.com/v1/embeddings` and ranks recall by cosine similarity blended with the keyword match. Removing the key turns both off on the next boot. Free-tier limits are low: a 429 is retried with backoff in the background, then pauses requests for a minute while recall stays keyword-only. Existing notes are embedded lazily, a few per recall or write. |
| `ADA_MEMORY_EMBEDDING_MODEL` | Embedding model for both memories. Default `voyage-law-2` (1024 dimensions; Ada ignores any answer of another size). Changing it re-embeds notes in small batches.                                                                                                                                                                                                                          |
| `VOYAGE_PLUGIN_VERSION`      | Version of `@openclaw/voyage-provider` that `start.sh` installs, default `2026.9.9` (matches `OPENCLAW_VERSION`). A failed install keeps keyword search.                                                                                                                                                                                                                                     |

### Optional: Ada

| Variable                             | Plugin config                  | Effect                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LEXROOM_ACCESS_TOKEN`               | `accessToken`                  | Lexroom access token (secret).                                                                                                                                                                                                                                                             |
| `ADA_TOKEN_KEY`                     | (read from the environment)    | 32 random bytes (`openssl rand -base64 32`) that encrypt Google tokens and the Lexroom email password and tokens at rest. When it is unset, Ada derives a key from `OPENCLAW_GATEWAY_TOKEN` instead, so production can still open the stores; set it before connecting, because changing the key later makes saved credentials unreadable. The image runs with `NODE_ENV=production`, where Ada refuses to open those account stores with neither this nor `OPENCLAW_GATEWAY_TOKEN`. `start.sh` logs a warning when it is unset. |
| `ADA_LEXROOM_AUTH0_CLIENT_SECRET`   | (read from the environment)    | Secret of Lexroom's Auth0 web client. When set, Ada signs in to Lexroom with Auth0's password-realm grant instead of the headless web flow. Set it as a Railway secret variable. Optional siblings: `ADA_LEXROOM_AUTH0_CLIENT_ID` (default `Mb9ixXPSnvNlbnTlwFLTO6GpyodwM42a`), `ADA_LEXROOM_AUTH0_REALM` (default `lexroom-users`) and `ADA_LEXROOM_AUTH0_TOKEN` (`access_token`, the default, or `id_token`). |
| `ADA_GOOGLE_CLIENT_ID`              | `googleClientId`               | Google OAuth client. Setting it also sets the redirect and Lexroom connect URIs.                                                                                                                                                                                                           |
| `ADA_GOOGLE_CLIENT_SECRET`          | `googleClientSecret`           | Secret.                                                                                                                                                                                                                                                                                    |
| `ADA_GOOGLE_STATE_SECRET`           | `googleStateSecret`            | Secret that signs connect links.                                                                                                                                                                                                                                                           |
| `ADA_GOOGLE_REDIRECT_URI`           | `googleRedirectUri`            | Default `<origin>/ada/google/callback`.                                                                                                                                                                                                                                                   |
| `ADA_LEXROOM_CONNECT_URI`           | `lexroomConnectUri`            | Default `<origin>/ada/lexroom/connect`.                                                                                                                                                                                                                                                   |
| `ADA_GOOGLE_PUBSUB_TOPIC`           | `googlePubSubTopic`            | Enables the Gmail watch.                                                                                                                                                                                                                                                                   |
| `ADA_GOOGLE_NOTIFY_AUDIENCE`        | `googleNotifyAudience`         | Audience of the Pub/Sub push OIDC token. Enables JWT verification on `/ada/google/notify`.                                                                                                                                                                                                |
| `ADA_GOOGLE_NOTIFY_SERVICE_ACCOUNT` | `googleNotifyServiceAccount`   | Also require this push service account email.                                                                                                                                                                                                                                              |
| `ADA_GOOGLE_NOTIFY_TOKEN`           | `googleNotifyToken`            | Static Bearer fallback, 16+ characters (secret).                                                                                                                                                                                                                                           |
| `ADA_STATUS_TOKEN`                  | `statusToken`                  | 16+ characters. Enables `GET /ada/status`; without it the route returns 401. `start.sh` logs a warning when unset.                                                                                                                                                                        |
| `ADA_ADMIN_TOKEN`                   | (none, read at runtime)        | 16+ characters (secret). Enables the feedback log: `GET /admin/feedback` and `POST /admin/feedback/<id>`. Unset, they return 404.                                                                                                                                                         |
| `ADA_DIGEST_TEMPLATE_NAME`          | `digestReadyTemplate.name`     | Approved WhatsApp utility template sent once when a digest is held because the 24-hour window is closed. Unset: not configured, no nudge.                                                                                                                                                  |
| `ADA_DIGEST_TEMPLATE_LANG`          | `digestReadyTemplate.language` | Language code the template was approved in. Default `it`. Ignored (with a warning) when the name is unset.                                                                                                                                                                                 |
| `ADA_DEADLINE_INTAKE_ENABLED`       | `deadlineIntake.enabled`       | `true` or `false` (case-insensitive), default `false`. Written on every boot, so removing the variable turns intake off. Any other value fails the boot.                                                                                                                                   |
| `ADA_DEADLINE_REMINDERS`            | `deadlineIntake.reminders`     | Comma-separated cadence such as `7d,2d,morning-of`. Unset keeps the plugin default (`7d,2d,morning-of`). An invalid value fails the boot, because the plugin would reject it.                                                                                                              |

**Kapso health monitor.** `start.sh` sets `channels["kapso-whatsapp"].healthMonitor.enabled` to `false` on every boot. The Kapso plugin is webhook-only (it has no `gateway.startAccount`), so the channel never reports running and the Gateway's health monitor logged `restarting (reason: stopped)` every 10 minutes for a restart that does nothing. Inbound messages and sends are unaffected. If the plugin's config schema ever refuses the key, the boot logs a warning and carries on.

**Per-number sessions.** `start.sh` sets `session.dmScope` to `per-channel-peer` on every boot, so each WhatsApp number has its own conversation and chats are not visible across numbers. The lawyer's chat (`KAPSO_DEFAULT_TO`) starts a new session of its own on the first message after this deploy; the earlier shared history is not copied. Accounts, matter memory, digests and held research results are all keyed by WhatsApp number (see "Accounts and privacy" in the Ada README), not by session.

**Fast Kapso webhook.** The Kapso channel plugin answers its webhook only after the whole turn, so a slow turn outlives Kapso's timeout (Railway logged `POST /kapso/webhook` taking about 14.8 s and returning 499, followed by a retry). Ada adds a front door that answers at once: `POST /ada/kapso/webhook` checks the `x-webhook-signature` with the same secret (`KAPSO_WEBHOOK_SECRET` or the channel config), saves the request in `$OPENCLAW_STATE_DIR/vera/kapso-inbound.sqlite`, answers 200, and hands the saved request to the plugin's own route (`KAPSO_WEBHOOK_PATH`, default `/kapso/webhook`) over loopback, one sender at a time in arrival order. A restart replays what was not finished. Nothing changes until Kapso is pointed at the new address: set the webhook URL of the Kapso project to `https://vera.verus.legal/ada/kapso/webhook` (same secret, same event). The old `/kapso/webhook` URL keeps working as before, so pointing Kapso back is the rollback. Do not set `KAPSO_WEBHOOK_PATH` to an `/ada/...` or `/vera/...` path.

First-message welcome (read by the plugin from the gateway environment; not validated by `start.sh`):

| Variable              | Effect                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ADA_WELCOME_ENABLED` | `false` (also `0`, `off`, `no`) stops Ada from sending the welcome to a number's first message. Default on. See the Ada README. |

WhatsApp status reactions (read from the gateway environment; validated by `start.sh`). Reactions are sent by Ada herself straight through Kapso (the channel plugin cannot send them), so these variables are the only place they are configured. By default the inbound message shows `👀` while Ada works and the reaction is removed (an empty emoji) when the run ends, however it ends: no `⏳`, no `✅` and no `❌`.

| Variable                | Effect                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ADA_STATUS_REACTIONS`  | `true` or `false` (case-insensitive), default `true`. Any other value fails the boot. `false` sends no reactions at all. |
| `ADA_REACTION_ACK`      | Emoji on receipt of a message. Default `👀`.                                                                            |
| `ADA_REACTION_THINKING` | Optional emoji while Ada runs tools. Unset: none.                                                                       |
| `ADA_REACTION_DONE`     | Optional emoji when a run succeeds. Unset: the `👀` is removed.                                                         |
| `ADA_REACTION_ERROR`    | Optional emoji when a run fails or declines. Unset: the `👀` is removed.                                                |

The Ada plugin sends these reactions directly through the Kapso API on the inbound message, replacing the previous emoji, because `@kapso/openclaw-whatsapp` 0.1.4 cannot send reactions. Failures are logged as warnings and never affect the reply. OpenClaw's `messages.ackReaction` and `messages.statusReactions` do nothing on Kapso and are not used. The final emoji follows the agent run, not WhatsApp delivery, so a failed outbound send does not turn it into `❌`.

## Verify

```bash
curl -sS https://ada.example.com/healthz
curl -sS -H "Authorization: Bearer $ADA_STATUS_TOKEN" https://ada.example.com/ada/status
curl -sS -H "Authorization: Bearer $ADA_ADMIN_TOKEN" https://ada.example.com/admin/feedback
```

`/ada/status` and the `ada.collect` log events, plus a suggested "no collect in 45 minutes" alert, are documented in `extensions/ada/README.md#monitoring`.

## Renamed from Vera

The bot was renamed from Vera to Ada. Nothing has to change in Railway for the deploy to keep working:

- **Variables.** Every `VERA_*` variable still works. `start.sh` copies each one to its `ADA_*` name unless that is already set (the boot log lists the legacy names it used, never values), and the plugin applies the same fallback to `ADA_TOKEN_KEY`, `ADA_STATUS_REACTIONS` and `ADA_REACTION_*`. Rename them when convenient: `VERA_TOKEN_KEY`, `VERA_STATUS_TOKEN`, `VERA_MODEL`, `VERA_PUBLIC_ORIGIN`, `VERA_PLUGIN_DIR`, `VERA_GOOGLE_CLIENT_ID`, `VERA_GOOGLE_CLIENT_SECRET`, `VERA_GOOGLE_STATE_SECRET`, `VERA_GOOGLE_REDIRECT_URI`, `VERA_LEXROOM_CONNECT_URI`, `VERA_GOOGLE_PUBSUB_TOPIC`, `VERA_GOOGLE_NOTIFY_AUDIENCE`, `VERA_GOOGLE_NOTIFY_SERVICE_ACCOUNT`, `VERA_GOOGLE_NOTIFY_TOKEN`, `VERA_DIGEST_TEMPLATE_NAME`, `VERA_DIGEST_TEMPLATE_LANG`, `VERA_DEADLINE_INTAKE_ENABLED`, `VERA_DEADLINE_REMINDERS`, `VERA_STATUS_REACTIONS`, `VERA_REACTION_ACK`, `VERA_REACTION_THINKING`, `VERA_REACTION_DONE` and `VERA_REACTION_ERROR` become the same name with `ADA_`.
- **Plugin id.** The plugin id changed from `vera` to `ada`, so config moves from `plugins.entries.vera` to `plugins.entries.ada`. On the first boot `start.sh` copies the non-secret settings across, disables and uninstalls the old plugin, and writes the secrets again from the environment. A `lexroomStateSecret` set by hand is the one secret that cannot be copied (the CLI redacts it); the boot log warns when it existed. Tool names are `ada_*` now, and `tools.alsoAllow` is rewritten from the manifest on every boot.
- **State.** The SQLite stores stay in `<state dir>/vera/` (`lexroom-account.sqlite`, `google-account.sqlite`, `memory.sqlite`), with their table names and token encryption contexts unchanged, so saved Lexroom and Google sign-ins and the matter memory carry over untouched.
- **URLs.** The domain and service are unchanged. The plugin answers on `/ada/...` and still on `/vera/...` (`/vera/google/callback`, `/vera/google/notify`, `/vera/status`, `/vera/lexroom/connect`), because Google Cloud holds the callback URI and Pub/Sub the push endpoint. `start.sh` keeps `/vera/google/callback` as the default Google redirect URI and uses `/ada/lexroom/connect` for new Lexroom links. To move Google to `/ada/google/callback`, register that URI in Google Cloud first, then set `ADA_GOOGLE_REDIRECT_URI`.
- **Logs.** Prefixes changed from `vera ...` to `ada ...` (for example `ada lexroom store.read`), and the `vera.collect` event is now `ada.collect`. Update any log alert that matches the old text.
- **Name.** The workspace and agent config on the volume survive a deploy, so a volume from before the rename can still say Vera. The plugin prepends "your name is Ada, never call yourself Vera" to the system prompt of every turn (`extensions/ada/src/persona.ts`), and on every boot `start.sh` renames the standalone word in `IDENTITY.md`, `SOUL.md`, `AGENTS.md`, `TOOLS.md`, `HEARTBEAT.md` and `BOOTSTRAP.md` in the workspace (keeping a one-time `*.pre-ada` copy of each) and in `agents.entries.main.identity.name` when it is Vera. `IDENTITY.md` and `SOUL.md` also get a marked "Who Ada serves" section, and `SOUL.md` a marked "Language" section saying Ada answers in the language of the latest message, each added once. `SOUL.md` and `AGENTS.md` also get a marked "No signature" section, and in all six files the one sentence the old persona carried, "Introduce yourself and sign off as Ada.", is removed (exact, case-sensitive match; no other line is touched, so legal instructions about signatures stay). A change of that kind keeps its own `*.pre-nosig` copy, made once, besides the `*.pre-ada` one. The persona and the new section override anything else. `USER.md`, `MEMORY.md`, `memory/`, per-number memory pages and past conversations are not rewritten, because a client can be called Vera; the persona overrides them.

