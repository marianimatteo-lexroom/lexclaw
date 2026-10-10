# Vera

Vera is the WhatsApp assistant for one Lexroom lawyer.

A plugin service diffs the connected Gmail inbox and Google Calendar every 15 minutes and at 07:40 Europe/Rome. A quiet pass updates snapshots and never calls the model. When a plan clears the cost bar, Vera starts one isolated turn (45s timeout) that phrases a single digest. Same-day deadlines and hearings that moved earlier may wake immediately; everything else waits for morning. If the WhatsApp 24-hour window is closed, the plan is held until the lawyer texts.

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
          // googleNotifyToken: "${VERA_GOOGLE_NOTIFY_TOKEN}",
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

Research and drafting call `https://api.lexroom.ai` with `Authorization: Bearer` and `X-Client-Type: app_lex`. Machine API keys are not accepted by those endpoints yet.

The lawyer connects Lexroom the same way as Google: WhatsApp gets one link from `vera_lexroom_connect`, opens `/vera/lexroom/connect`, and signs in with Lexroom email/password (plus MFA when Lexroom requires it). The password is posted only to Lexroom. When Lexroom returns `mfa_step_up_required`, Vera continues through Lexroom's app MFA challenge (`/api/auth/mfa/start` + `/api/auth/mfa/verify` + session exchange) and keeps a short-lived sealed MFA ticket in the connect form—not a 401 error page. The bearer stays in `$OPENCLAW_STATE_DIR/vera/lexroom-account.sqlite`. The connect URL defaults from the `googleRedirectUri` origin; override with `lexroomConnectUri` when needed. The state HMAC reuses `googleStateSecret` unless `lexroomStateSecret` is set. Links expire after 30 minutes. When the saved bearer expires, `vera_research` / `vera_draft` return `not_connected` and Vera asks for a new link. A static `accessToken` in config remains a fallback only.

## Google account

Vera uses the Gmail and Google Calendar APIs, not an MCP server and not `gog`. The collector runs without a WhatsApp sender, so requester-scoped MCP is not available. `gog` login is a shell flow and its callback URL must not be texted.

Create a Google Cloud OAuth web client, enable the Gmail API and the Google Calendar API, and register `googleRedirectUri` as an authorized redirect URI. The path is `/vera/google/callback` on the public Gateway origin. `googleStateSecret` is any private string of at least 16 characters. The refresh token stays in `$OPENCLAW_STATE_DIR/vera/google-account.sqlite`. Matter memory and snapshots live in `$OPENCLAW_STATE_DIR/vera/memory.sqlite`.

The connect link asks for read-only Gmail, permission to send mail, and read-only Calendar, plus the account email. Vera does not change calendar events. One link covers all of that. It expires after 30 minutes and works once. When Gmail is not connected, the morning phrasing turn still follows the vera-google-connect skill. `vera_send_email` sends one plain-text message only after `confirmed` is true. When the link succeeds, Vera texts `channels["kapso-whatsapp"].defaultTo` that Gmail and Google Calendar are connected.

Optional Pub/Sub: set `googlePubSubTopic`, set `googleNotifyToken` (16+ chars), and point the push subscription at `/vera/google/notify` with `Authorization: Bearer <token>`. Without both, the 15-minute poll owns wakes; notify without the token returns 401.

## Memory

Read-only tools: `vera_memory_search`, `vera_memory_list`, `vera_memory_get`, `vera_memory_history`, `vera_todo_list`, `vera_todo_get`. Every page except lawyer-global preferences requires a `matterId`. Search is case-insensitive substring match on aliases, title, and id. The daily reconcile writes timeline notes and one-pagers; the answering turn never writes memory.
