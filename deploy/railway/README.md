# Vera gateway on Railway

Deploy assets for the Vera gateway: the stock `docker.io/openclaw/openclaw` image plus a bundled copy of `extensions/vera` and the Kapso WhatsApp plugin.

| File           | Purpose                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`   | Image definition. Owns the `OPENCLAW_VERSION` and `KAPSO_PLUGIN_VERSION` pins.                                |
| `start.sh`     | Boot script. Installs plugins, writes config from env, then execs the gateway. Any failing step aborts boot.  |
| `railway.json` | Railway config as code: Dockerfile build, `/healthz` healthcheck, one replica.                                |
| `build.sh`     | Bundles Vera with esbuild and stages a clean build context (Dockerfile, `start.sh`, `railway.json`, `vera/`). |

No project, service, volume, or webhook IDs live in this directory. The Railway CLI picks them from the project you `railway link`.

## Deploy

Prerequisites: Node 24+, `pnpm install` run at the repo root, the Railway CLI logged in, and `railway link` pointed at the Vera project with the gateway service and a volume mounted at `/data`.

```bash
deploy/railway/build.sh --deploy
```

Without `--deploy` the script only stages the context and prints the `railway up` command. `--out DIR` chooses the staging directory (default: a new temp directory outside the repo, so the repo `.gitignore` is not applied to the upload). `RAILWAY_SERVICE` names the service (default `gateway`).

Gateway 502s during boot are normal until plugin install finishes. Railway marks the deploy healthy once `GET /healthz` returns `{"ok":true,"status":"live"}`.

Changing Vera code needs a new image. Workspace identity and OpenClaw config stay on the volume.

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
| `KAPSO_DEFAULT_TO`      | Lawyer WhatsApp number in `+E.164` form. Also the only sender Vera accepts as the lawyer.                                                                   |
| `KAPSO_PLUGIN_VERSION`  | Exact version such as `0.1.4`. The Dockerfile sets the default, so it only needs a service variable to move the pin.                                        |
| `VERA_PUBLIC_ORIGIN`    | Public origin such as `https://vera.example.com`. Not needed when Railway provides `RAILWAY_PUBLIC_DOMAIN` (a generated domain). One of the two must exist. |

Also needed for a working gateway, but not checked by `start.sh`: `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_STATE_DIR=/data/.openclaw`, `OPENCLAW_WORKSPACE_DIR=/data/workspace`, `RAILWAY_RUN_UID=0` (the volume is root-owned), and a model credential (`ANTHROPIC_API_KEY` or `ANTHROPIC_SETUP_TOKEN`). `OPENCLAW_GATEWAY_PORT` defaults to `8080` (`PORT` is the fallback).

### Optional: Kapso and model

| Variable                | Effect                                                                                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KAPSO_API_KEY`         | Kapso API key (secret).                                                                                                                                               |
| `KAPSO_WEBHOOK_SECRET`  | Kapso webhook secret (secret).                                                                                                                                        |
| `KAPSO_ALLOW_FROM`      | Comma-separated sender allowlist. Defaults to `KAPSO_DEFAULT_TO` with and without the `+`. `KAPSO_BASE_URL` and `KAPSO_WEBHOOK_PATH` are read by the plugin directly. |
| `VERA_MODEL`            | Default `anthropic/claude-opus-5`.                                                                                                                                    |
| `ANTHROPIC_API_KEY`     | API key. Required when `ANTHROPIC_SETUP_TOKEN` is unset or its import fails.                                                                                          |
| `ANTHROPIC_SETUP_TOKEN` | Imported on boot. A failed import is fatal unless `ANTHROPIC_API_KEY` is set.                                                                                         |

### Optional: Vera

| Variable                             | Plugin config                  | Effect                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LEXROOM_ACCESS_TOKEN`               | `accessToken`                  | Lexroom access token (secret).                                                                                                                                                                                                                                                             |
| `VERA_TOKEN_KEY`                     | (read from the environment)    | 32 random bytes (`openssl rand -base64 32`) that encrypt Google and Lexroom tokens at rest. The image runs with `NODE_ENV=production`, where Vera refuses to open those account stores without it, so set it before connecting either account. `start.sh` logs a warning when it is unset. |
| `VERA_GOOGLE_CLIENT_ID`              | `googleClientId`               | Google OAuth client. Setting it also sets the redirect and Lexroom connect URIs.                                                                                                                                                                                                           |
| `VERA_GOOGLE_CLIENT_SECRET`          | `googleClientSecret`           | Secret.                                                                                                                                                                                                                                                                                    |
| `VERA_GOOGLE_STATE_SECRET`           | `googleStateSecret`            | Secret that signs connect links.                                                                                                                                                                                                                                                           |
| `VERA_GOOGLE_REDIRECT_URI`           | `googleRedirectUri`            | Default `<origin>/vera/google/callback`.                                                                                                                                                                                                                                                   |
| `VERA_LEXROOM_CONNECT_URI`           | `lexroomConnectUri`            | Default `<origin>/vera/lexroom/connect`.                                                                                                                                                                                                                                                   |
| `VERA_GOOGLE_PUBSUB_TOPIC`           | `googlePubSubTopic`            | Enables the Gmail watch.                                                                                                                                                                                                                                                                   |
| `VERA_GOOGLE_NOTIFY_AUDIENCE`        | `googleNotifyAudience`         | Audience of the Pub/Sub push OIDC token. Enables JWT verification on `/vera/google/notify`.                                                                                                                                                                                                |
| `VERA_GOOGLE_NOTIFY_SERVICE_ACCOUNT` | `googleNotifyServiceAccount`   | Also require this push service account email.                                                                                                                                                                                                                                              |
| `VERA_GOOGLE_NOTIFY_TOKEN`           | `googleNotifyToken`            | Static Bearer fallback, 16+ characters (secret).                                                                                                                                                                                                                                           |
| `VERA_STATUS_TOKEN`                  | `statusToken`                  | 16+ characters. Enables `GET /vera/status`; without it the route returns 401. `start.sh` logs a warning when unset.                                                                                                                                                                        |
| `VERA_DIGEST_TEMPLATE_NAME`          | `digestReadyTemplate.name`     | Approved WhatsApp utility template sent once when a digest is held because the 24-hour window is closed. Unset: not configured, no nudge.                                                                                                                                                  |
| `VERA_DIGEST_TEMPLATE_LANG`          | `digestReadyTemplate.language` | Language code the template was approved in. Default `it`. Ignored (with a warning) when the name is unset.                                                                                                                                                                                 |
| `VERA_DEADLINE_INTAKE_ENABLED`       | `deadlineIntake.enabled`       | `true` or `false` (case-insensitive), default `false`. Written on every boot, so removing the variable turns intake off. Any other value fails the boot.                                                                                                                                   |
| `VERA_DEADLINE_REMINDERS`            | `deadlineIntake.reminders`     | Comma-separated cadence such as `7d,2d,morning-of`. Unset keeps the plugin default (`7d,2d,morning-of`). An invalid value fails the boot, because the plugin would reject it.                                                                                                              |

WhatsApp status reactions (read from the gateway environment; validated by `start.sh`):

| Variable                 | Effect                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `VERA_STATUS_REACTIONS`  | `true` or `false` (case-insensitive), default `true`. Any other value fails the boot.                          |
| `VERA_REACTION_ACK`      | Emoji on receipt of the lawyer's message. Default `👀`.                                                        |
| `VERA_REACTION_THINKING` | Emoji while Vera thinks or runs tools. Default `⏳`. Skipped when the reply completes within about one second. |
| `VERA_REACTION_DONE`     | Emoji when the run completes. Default `✅`.                                                                    |
| `VERA_REACTION_ERROR`    | Emoji when the run fails. Default `❌`.                                                                        |

The Vera plugin sends these reactions directly through the Kapso API on the inbound message, replacing the previous emoji, because `@kapso/openclaw-whatsapp` 0.1.4 cannot send reactions. Failures are logged as warnings and never affect the reply. OpenClaw's `messages.ackReaction` and `messages.statusReactions` do nothing on Kapso and are not used. The final emoji follows the agent run, not WhatsApp delivery, so a failed outbound send does not turn it into `❌`.

## Verify

```bash
curl -sS https://vera.example.com/healthz
curl -sS -H "Authorization: Bearer $VERA_STATUS_TOKEN" https://vera.example.com/vera/status
```

`/vera/status` and the `vera.collect` log events, plus a suggested "no collect in 45 minutes" alert, are documented in `extensions/vera/README.md#monitoring`.
