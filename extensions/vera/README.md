# Vera

Vera is the WhatsApp assistant for one Lexroom lawyer.

A plugin service diffs the connected Gmail inbox and Google Calendar every 15 minutes and at 07:40 Europe/Rome. A quiet pass updates snapshots and never calls the model. When a plan clears the cost bar, Vera starts one isolated turn (45s timeout) that phrases a single digest. Same-day deadlines and hearings that moved earlier may wake immediately; everything else waits for morning. If the WhatsApp 24-hour window is closed, the plan is held until the lawyer texts. If dispatch fails (hooks unavailable, timeout, rejection), the plan is also held and retried on later passes with a 15-minute to 2-hour backoff, up to 5 attempts; after that it waits for the next 07:40 pass or a lawyer message. The Gmail and Calendar snapshots that drive the diff only advance once a digest is delivered or held, so a failed or batched pass never drops its signals.

Matter memory is Instinct-shaped: markdown pages with aliases, keyword search (no vectors), a small injected brief, and a daily reconcile that writes while the answering agent only reads. Pages are matter-scoped. Research and draft still go through Lexroom, with a separate confirmation before any draft or email send.

Disable the Gateway model heartbeat for this install (`agents.defaults.heartbeat.every: "0m"`). Do not create a second model cron for the morning digest; the Vera service owns that wake.

## Enable

```json5
{
  agents: {
    defaults: {
      heartbeat: { every: "0m" },
    },
  },
  plugins: {
    entries: {
      vera: {
        enabled: true,
        config: {
          // optional static fallback; prefer vera_lexroom_connect
          // accessToken: "${LEXROOM_ACCESS_TOKEN}",
          googleClientId: "${VERA_GOOGLE_CLIENT_ID}",
          googleClientSecret: "${VERA_GOOGLE_CLIENT_SECRET}",
          googleRedirectUri: "https://gateway.example/vera/google/callback",
          googleStateSecret: "${VERA_GOOGLE_STATE_SECRET}",
          // optional explicit Lexroom connect URL; defaults from googleRedirectUri origin
          // lexroomConnectUri: "https://gateway.example/vera/lexroom/connect",
          // optional: projects/.../topics/... for Gmail watch
          // googlePubSubTopic: "${VERA_GOOGLE_PUBSUB_TOPIC}",
          // googleNotifyAudience: "${VERA_GOOGLE_NOTIFY_AUDIENCE}",
          // googleNotifyServiceAccount: "${VERA_GOOGLE_NOTIFY_SERVICE_ACCOUNT}",
          // static fallback only: googleNotifyToken: "${VERA_GOOGLE_NOTIFY_TOKEN}",
          // statusToken: "${VERA_STATUS_TOKEN}",
        },
      },
    },
  },
  tools: {
    alsoAllow: [
      "vera_plan_digest",
      "vera_research",
      "vera_draft",
      "vera_lexroom_connect",
      "vera_google_connect",
      "vera_read_inbox",
      "vera_read_calendar",
      "vera_send_email",
      "vera_memory_search",
      "vera_memory_list",
      "vera_memory_get",
      "vera_memory_history",
      "vera_todo_list",
      "vera_todo_get",
    ],
  },
}
```

## Lexroom account

Research (`LEXROOM_AMA`) and drafting (`LEXROOM_DRAFTING`) call `https://api.lexroom.ai` with `Authorization: Bearer`, `X-Client-Type: app_lex`, and `X-Request-ID`. Research posts `/v1/ask_me_anything` and reloads `/v1/ask_me_anything/{id}`. Drafting posts `/v2/ai/drafting`. Machine API keys are not accepted by those endpoints yet.

The lawyer connects Lexroom the same way as Google: WhatsApp gets one link from `vera_lexroom_connect`, opens `/vera/lexroom/connect`, and signs in with Lexroom email/password (plus MFA when Lexroom requires it). The password is posted only to Lexroom. When Lexroom returns `mfa_step_up_required`, Vera continues through Lexroom's app MFA challenge (`/api/auth/mfa/start` + `/api/auth/mfa/verify` + session exchange) and keeps a short-lived sealed MFA ticket in the connect form—not a 401 error page. The bearer stays (encrypted, see Token encryption) in `$OPENCLAW_STATE_DIR/vera/lexroom-account.sqlite`. The connect URL defaults from the `googleRedirectUri` origin; override with `lexroomConnectUri` when needed. The state HMAC reuses `googleStateSecret` unless `lexroomStateSecret` is set. Links expire after 30 minutes. When the saved bearer expires, `vera_research` / `vera_draft` return `not_connected` and Vera asks for a new link. A static `accessToken` in config remains a fallback only.

## Google account

Vera uses the Gmail and Google Calendar APIs, not an MCP server and not `gog`. The collector runs without a WhatsApp sender, so requester-scoped MCP is not available. `gog` login is a shell flow and its callback URL must not be texted.

Create a Google Cloud OAuth web client, enable the Gmail API and the Google Calendar API, and register `googleRedirectUri` as an authorized redirect URI. The path is `/vera/google/callback` on the public Gateway origin. `googleStateSecret` is any private string of at least 16 characters. The refresh token stays (encrypted, see Token encryption) in `$OPENCLAW_STATE_DIR/vera/google-account.sqlite`. Matter memory and snapshots live in `$OPENCLAW_STATE_DIR/vera/memory.sqlite`.

The connect link asks for read-only Gmail, permission to send mail, and read-only Calendar, plus the account email. Vera does not change calendar events. One link covers all of that. It expires after 30 minutes and works once. When Gmail is not connected, the morning phrasing turn still follows the vera-google-connect skill. `vera_send_email` sends one plain-text message only after `confirmed` is true. When the link succeeds, Vera texts `channels["kapso-whatsapp"].defaultTo` that Gmail and Google Calendar are connected.

Optional Pub/Sub: set `googlePubSubTopic` and point a push subscription at `/vera/google/notify`. Enable OIDC authentication on the subscription and set `googleNotifyAudience` to the audience you gave it. Vera verifies the push JWT: RS256 signature against Google's published keys (`https://www.googleapis.com/oauth2/v3/certs`, cached), issuer (`https://accounts.google.com` unless `googleNotifyIssuer` is set), audience, and expiry. Set `googleNotifyServiceAccount` to also require the subscription's service account email. `googleNotifyToken` (16+ chars, `Authorization: Bearer <token>`, compared in constant time) remains as a static fallback for a trusted proxy; prefer OIDC. Without `googleNotifyAudience` or `googleNotifyToken` the route returns 401, and the 15-minute poll owns wakes.

A push whose Gmail `historyId` is missing or not newer than the last one collected is acknowledged (204) without collecting. At most one collect pass runs per 15 seconds; extra pushes get 429 with `Retry-After` and Pub/Sub redelivers them.

## Token encryption

Google refresh and access tokens and Lexroom bearer and refresh tokens are encrypted in SQLite with AES-256-GCM. Each value is bound to its table and column. Set `VERA_TOKEN_KEY` to 32 random bytes as base64 or 64 hex characters:

```sh
openssl rand -base64 32
```

With `NODE_ENV=production` the account stores refuse to open without `VERA_TOKEN_KEY`, so set it before upgrading. Outside production a missing key leaves tokens in plaintext for local development. Rows saved before encryption are read as plaintext and re-written encrypted the first time the store opens with a key. Keep the key stable: losing it or changing it makes the stored tokens unreadable, and the lawyer reconnects Google and Lexroom from a fresh link. Keep it in the host's secret store, never in config files or git.

## Environment and config reference

| Name                         | Where         | Purpose                                                                              |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------ |
| `VERA_TOKEN_KEY`             | environment   | AES-256 key for tokens at rest. Required in production.                              |
| `googleNotifyAudience`       | plugin config | Audience of the Pub/Sub push OIDC token. Enables JWT verification.                   |
| `googleNotifyIssuer`         | plugin config | Expected issuer. Defaults to `https://accounts.google.com` or `accounts.google.com`. |
| `googleNotifyServiceAccount` | plugin config | Required `email` claim (verified) of the push subscription service account.          |
| `googleNotifyToken`          | plugin config | Static Bearer fallback, 16+ chars.                                                   |
| `statusToken`                | plugin config | Bearer token (16+ chars) for `GET /vera/status`.                                     |

Plugin config values can reference environment variables, for example `googleNotifyAudience: "${VERA_GOOGLE_NOTIFY_AUDIENCE}"`.

## Lawyer sender check

Vera records a lawyer inbound message (which opens the WhatsApp 24-hour window and releases a held digest) only when the sender matches `channels["kapso-whatsapp"].defaultTo`. Comparison uses digits only, so `+390000000000`, `390000000000`, and `whatsapp:+390000000000` are the same number. A missing `defaultTo` or any other sender is ignored and logged, even if the channel allowlist accepted it.

## Monitoring

`GET /vera/status` returns collector health as JSON. It needs `Authorization: Bearer <statusToken>`; `statusToken` is 16+ characters and the route returns 401 for every request while it is unset. The Railway deploy sets it from `VERA_STATUS_TOKEN`.

```json
{
  "ok": true,
  "now": "2026-10-14T09:00:00.000Z",
  "lastCollectAt": "2026-10-14T08:55:00.000Z",
  "lastCollectAgeSec": 300,
  "lastDigestAt": "2026-10-14T05:40:00.000Z",
  "heldPlan": { "held": false, "heldSince": null, "ageSec": null },
  "window": {
    "state": "open",
    "lastLawyerInboundAt": "2026-10-14T05:41:00.000Z",
    "expiresAt": "2026-10-15T05:41:00.000Z"
  }
}
```

`window.state` is `open`, `closed` (24 hours since the lawyer last texted, so held digests wait), or `never_opened`. `heldPlan.heldSince` is when the current held plan was first held. Nulls mean the event has not happened yet; `heldPlan.ageSec` is also null for a plan held before the status columns existed.

Every collect pass (15-minute poll, 07:40 pass, Pub/Sub notify, and the re-collect after a lawyer text) logs one JSON line:

```json
{"event":"vera.collect","at":"2026-10-14T08:55:00.000Z","trigger":"poll","result":"collected","decision":"hold","dispatchReason":"whatsapp_window_closed","delivered":false,"held":true,"urgent":true,"forceMorning":false,"windowOpen":false,"deliverable":true,"durationMs":412}
```

- `trigger`: `poll`, `morning`, `notify`, or `inbound`.
- `result`: `collected` (snapshots and `lastCollectAt` advanced), `skipped` (Google not connected or unreadable, or a held plan is waiting out its retry backoff or has used all retries; `dispatchReason` names the cause), or `error` (logged at error level with `error`).
- `decision`: `silent`, `batch`, `hold`, `dispatch`, `connect`, or `none`. `dispatchReason` carries `whatsapp_window_closed`, `batched_until_morning`, `dispatch_rejected`, `hooks_unavailable`, `retry_backoff`, `retries_exhausted`, and similar causes. A rejected dispatch still advances `lastCollectAt` (the collector is alive) but leaves the diff baseline in place and holds the plan for retry.

Suggested alert: page when no `result:"collected"` line appears for 45 minutes. The poll runs every 15 minutes, so three misses in a row means the collector is stopped, Google is disconnected, or the Gateway is down. In Railway, filter `"event":"vera.collect" "result":"collected"` and alert on zero matches over 45 minutes. A probe against `/vera/status` that fails on `lastCollectAgeSec > 2700` (or `null` after the first day) catches the same condition and also covers a silent log pipeline. Add lower-urgency alerts on `heldPlan.ageSec > 86400`, on `result:"error"` lines, and on `dispatchReason` values `dispatch_rejected` or `hooks_unavailable` (the collector is alive but no digest went out). The structured line is the logger message itself; if the host prefixes log lines, match on the substrings above instead of parsing the whole line as JSON.

## WhatsApp read receipts

When Vera accepts an inbound Kapso WhatsApp message, she marks that WhatsApp message read. The lawyer sees the blue checks while Vera is working, instead of gray delivered checks until a later reply. Set `channels["kapso-whatsapp"].sendReadReceipts` to `false` to leave messages delivered.

## Memory

Read-only tools: `vera_memory_search`, `vera_memory_list`, `vera_memory_get`, `vera_memory_history`, `vera_todo_list`, `vera_todo_get`. Every page except lawyer-global preferences requires a `matterId`. Search is case-insensitive substring match on aliases, title, and id. The daily reconcile writes timeline notes and one-pagers; the answering turn never writes memory.
