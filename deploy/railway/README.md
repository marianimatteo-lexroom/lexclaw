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

Values stay in Railway. Nothing here belongs in git.

Required (boot fails without them):

- `KAPSO_PHONE_NUMBER_ID`: Kapso `phone_number_id` of the business sender.
- `KAPSO_DEFAULT_TO`: lawyer WhatsApp number in `+E.164` form.
- `VERA_PUBLIC_ORIGIN`: public origin such as `https://vera.example.com`. When unset, `https://$RAILWAY_PUBLIC_DOMAIN` is used.
- `KAPSO_PLUGIN_VERSION`: set by the Dockerfile default.

Gateway runtime: `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_GATEWAY_PORT` (default `8080`; `PORT` is the fallback), `OPENCLAW_STATE_DIR=/data/.openclaw`, `OPENCLAW_WORKSPACE_DIR=/data/workspace`, `RAILWAY_RUN_UID=0` (the volume is root-owned).

Optional, written to config when set and skipped (logged) when unset:

- Kapso: `KAPSO_API_KEY`, `KAPSO_WEBHOOK_SECRET`, `KAPSO_ALLOW_FROM` (comma-separated; defaults to `KAPSO_DEFAULT_TO` with and without the `+`). `KAPSO_BASE_URL` and `KAPSO_WEBHOOK_PATH` are read by the plugin directly, not by `start.sh`.
- Model: `VERA_MODEL` (default `anthropic/claude-opus-5`), `ANTHROPIC_API_KEY`, `ANTHROPIC_SETUP_TOKEN` (imported on boot; a failed import is fatal unless `ANTHROPIC_API_KEY` is set).
- Vera: `LEXROOM_ACCESS_TOKEN`, `VERA_GOOGLE_CLIENT_ID`, `VERA_GOOGLE_CLIENT_SECRET`, `VERA_GOOGLE_STATE_SECRET`, `VERA_GOOGLE_REDIRECT_URI`, `VERA_LEXROOM_CONNECT_URI`, `VERA_GOOGLE_PUBSUB_TOPIC`, `VERA_GOOGLE_NOTIFY_TOKEN`.
- Monitoring: `VERA_STATUS_TOKEN` (16+ characters) enables `GET /vera/status`. Without it that route returns 401.

## Verify

```bash
curl -sS https://vera.example.com/healthz
curl -sS -H "Authorization: Bearer $VERA_STATUS_TOKEN" https://vera.example.com/vera/status
```

`/vera/status` and the `vera.collect` log events, plus a suggested "no collect in 45 minutes" alert, are documented in `extensions/vera/README.md#monitoring`.
