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
          // optional, default off: hearing and deadline intake
          // deadlineIntake: { enabled: true, reminders: ["7d", "2d", "morning-of"] },
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
      "vera_deadline_list",
      "vera_deadline_reply",
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

The lawyer connects Lexroom the same way as Google: WhatsApp gets one link from `vera_lexroom_connect`, opens `/vera/lexroom/connect`, and signs in with Lexroom email/password (plus MFA when Lexroom requires it). The password is posted only to Lexroom. When Lexroom returns `mfa_step_up_required`, Vera continues through Lexroom's app MFA challenge (`/api/auth/mfa/start` + `/api/auth/mfa/verify` + session exchange) and keeps a short-lived sealed MFA ticket in the connect form—not a 401 error page. The bearer stays in `$OPENCLAW_STATE_DIR/vera/lexroom-account.sqlite`. The connect URL defaults from the `googleRedirectUri` origin; override with `lexroomConnectUri` when needed. The state HMAC reuses `googleStateSecret` unless `lexroomStateSecret` is set. Links expire after 30 minutes. When the saved bearer expires, `vera_research` / `vera_draft` return `not_connected` and Vera asks for a new link. A static `accessToken` in config remains a fallback only.

## Google account

Vera uses the Gmail and Google Calendar APIs, not an MCP server and not `gog`. The collector runs without a WhatsApp sender, so requester-scoped MCP is not available. `gog` login is a shell flow and its callback URL must not be texted.

Create a Google Cloud OAuth web client, enable the Gmail API and the Google Calendar API, and register `googleRedirectUri` as an authorized redirect URI. The path is `/vera/google/callback` on the public Gateway origin. `googleStateSecret` is any private string of at least 16 characters. The refresh token stays in `$OPENCLAW_STATE_DIR/vera/google-account.sqlite`. Matter memory and snapshots live in `$OPENCLAW_STATE_DIR/vera/memory.sqlite`.

The connect link asks for read-only Gmail, permission to send mail, and read-only Calendar, plus the account email. Vera does not change calendar events. One link covers all of that. It expires after 30 minutes and works once. When Gmail is not connected, the morning phrasing turn still follows the vera-google-connect skill. `vera_send_email` sends one plain-text message only after `confirmed` is true. When the link succeeds, Vera texts `channels["kapso-whatsapp"].defaultTo` that Gmail and Google Calendar are connected.

Optional Pub/Sub: set `googlePubSubTopic`, set `googleNotifyToken` (16+ chars), and point the push subscription at `/vera/google/notify` with `Authorization: Bearer <token>`. Without both, the 15-minute poll owns wakes; notify without the token returns 401.

## WhatsApp read receipts

When Vera accepts an inbound Kapso WhatsApp message, she marks that WhatsApp message read. The lawyer sees the blue checks while Vera is working, instead of gray delivered checks until a later reply. Set `channels["kapso-whatsapp"].sendReadReceipts` to `false` to leave messages delivered.

## Memory

Read-only tools: `vera_memory_search`, `vera_memory_list`, `vera_memory_get`, `vera_memory_history`, `vera_todo_list`, `vera_todo_get`. Every page except lawyer-global preferences requires a `matterId`. Search is case-insensitive substring match on aliases, title, and id. The daily reconcile writes timeline notes and one-pagers; the answering turn never writes memory.

## Deadline and hearing intake

Off by default. Set `plugins.entries.vera.config.deadlineIntake.enabled: true` to turn it on; with the flag off the collector, digest, and tools behave exactly as before.

On each collect pass Vera scans new Gmail and the next `horizonDays` of Calendar for hearings and deadlines on matters it already knows:

- Mail: subject, plain-text body, PEC messages (including the `postacert.eml` envelope), and the text of PDF attachments where it can be read without OCR. Italian and English phrasing, `dd/mm/yyyy`, `12 novembre 2026`, `November 12th, 2026`, ISO dates, times in 24-hour or AM/PM form, terms counted from receipt ("entro 30 giorni dalla notifica"), and postponements ("rinviata al ...") are understood. Dates that record the past ("depositata il ...") or name another document ("sentenza del ...") are ignored, as are impossible dates.
- Calendar: events whose title says udienza, scadenza, hearing, deadline, and similar.

Each item is stored in `memory.sqlite` with the matter, type (`deadline` or `hearing`), due date and time in Europe/Rome (all-day deadlines count until 23:59, hearings without a time default to 09:00), sources, and a confidence score. The same obligation from an email, a PDF, and a calendar event is one item, and a dismissed item is not revived by a later copy. A postponement notice or a moved calendar event moves the item and carries over the lawyer's choice. An item the lawyer never answers is offered in at most three digests (always while it is due within 48 hours) and stays visible through `vera_deadline_list`. Items below `minConfidence` (default 0.6) and dates in the past are dropped. Mail about matters without an alias is ignored.

The morning digest lists upcoming items with a number: "reply 1 to run research". A reply calls `vera_deadline_reply`:

- a number runs Lexroom research for that matter, confirms tracking, and the brief is texted back in the same turn;
- `track` confirms tracking without research; `dismiss` and `done` close the item.

Reminders come only after the lawyer confirms an item. They ride in the morning digest at 07:40 Europe/Rome on the day of each step in `deadlineIntake.reminders` (default `7d`, `2d`, `morning-of`; `Nd` counts calendar days before the due date). Steps whose time had already passed when the lawyer confirmed are skipped. If the WhatsApp window is closed, the reminder waits with the held digest, and when several steps pile up only the latest is sent.

Until the lawyer replies, intake is read-only. It sends no email and does not touch the calendar; email replies keep the existing `vera_send_email` confirmation. The flow is described in `skills/vera-deadline-intake`.

| Option | Default | Meaning |
| --- | --- | --- |
| `deadlineIntake.enabled` | `false` | Turn intake, digest lines, reply tools, and reminders on. |
| `deadlineIntake.reminders` | `["7d", "2d", "morning-of"]` | Reminder cadence for confirmed items. |
| `deadlineIntake.horizonDays` | `60` | How far ahead the calendar is scanned. |
| `deadlineIntake.minConfidence` | `0.6` | Drop extractions scored below this. |
