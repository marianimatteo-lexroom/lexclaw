# Ada

Ada is the WhatsApp assistant for one Lexroom lawyer.

A plugin service diffs the connected Gmail inbox and Google Calendar every 15 minutes and at 07:40 Europe/Rome. A quiet pass updates snapshots and never calls the model. When a plan clears the cost bar, Ada starts one isolated turn (45s timeout) that phrases a single digest. Same-day deadlines and hearings that moved earlier may wake immediately; everything else waits for morning. If the WhatsApp 24-hour window is closed, the plan is held until the lawyer texts. If dispatch fails (hooks unavailable, timeout, rejection), the plan is also held and retried on later passes with a 15-minute to 2-hour backoff, up to 5 attempts; after that it waits for the next 07:40 pass or a lawyer message. The Gmail and Calendar snapshots that drive the diff only advance once a digest is delivered or held, so a failed or batched pass never drops its signals.

The 07:40 slot is scheduled one run at a time: after each run Ada computes the next 07:40 in the lawyer's timezone (profile timezone, default Europe/Rome) from the calendar, so DST days stay at 07:40. On boot, if nothing was collected since the latest 07:40 slot (the gateway was down across it), Ada runs one catch-up morning pass about 30 seconds after start; it does not repeat the Google connect ask. Collect passes never overlap: the 15-minute poll, `/ada/google/notify`, the 07:40 slot, the catch-up, and the lawyer-reply release run one at a time, and a burst of polls or notifications collapses into one waiting pass. All digest turns start through one dispatch helper (`src/dispatch-digest.ts`).

Matter memory is Instinct-shaped: markdown pages with aliases, keyword search (no vectors), a small injected brief, and a daily reconcile that writes while the answering agent only reads. Pages are matter-scoped. Research and draft still go through Lexroom, with a separate confirmation before any draft or email send.

Disable the Gateway model heartbeat for this install (`agents.defaults.heartbeat.every: "0m"`). Do not create a second model cron for the morning digest; the Ada service owns that wake.

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
      ada: {
        enabled: true,
        config: {
          // optional static fallback; prefer ada_lexroom_connect
          // accessToken: "${LEXROOM_ACCESS_TOKEN}",
          // modules ada_research searches when the call names none (default: every module your Lexroom user may search)
          // researchModules: ["Civile", "Societario"],
          googleClientId: "${ADA_GOOGLE_CLIENT_ID}",
          googleClientSecret: "${ADA_GOOGLE_CLIENT_SECRET}",
          googleRedirectUri: "https://gateway.example/ada/google/callback",
          googleStateSecret: "${ADA_GOOGLE_STATE_SECRET}",
          // optional explicit Lexroom connect URL; defaults from googleRedirectUri origin
          // lexroomConnectUri: "https://gateway.example/ada/lexroom/connect",
          // optional: projects/.../topics/... for Gmail watch
          // googlePubSubTopic: "${ADA_GOOGLE_PUBSUB_TOPIC}",
          // googleNotifyAudience: "${ADA_GOOGLE_NOTIFY_AUDIENCE}",
          // googleNotifyServiceAccount: "${ADA_GOOGLE_NOTIFY_SERVICE_ACCOUNT}",
          // static fallback only: googleNotifyToken: "${ADA_GOOGLE_NOTIFY_TOKEN}",
          // statusToken: "${ADA_STATUS_TOKEN}",
          // optional, default off: hearing and deadline intake
          // deadlineIntake: { enabled: true, reminders: ["7d", "2d", "morning-of"] },
        },
      },
    },
  },
  tools: {
    alsoAllow: [
      "ada_plan_digest",
      "ada_research",
      "ada_research_status",
      "ada_draft",
      "ada_lexroom_connect",
      "ada_google_connect",
      "ada_read_inbox",
      "ada_read_calendar",
      "ada_send_email",
      "ada_deadline_list",
      "ada_deadline_reply",
      "ada_memory_search",
      "ada_memory_list",
      "ada_memory_get",
      "ada_memory_history",
      "ada_todo_list",
      "ada_todo_get",
    ],
  },
}
```

## Lexroom account

Research (`LEXROOM_AMA`) and drafting (`LEXROOM_DRAFTING`) call `https://api.lexroom.ai` with `Authorization: Bearer` (the token the sign-in returns) and `X-Client-Type: app_lex`, plus `Content-Type: application/json` on POSTs, the same headers the lexroom-bot client sends, and with ASCII-only JSON bodies (non-ASCII characters are `\uXXXX`-escaped). Research first reads the modules the user may search from `GET /v1/user/modules` (kept for an hour, with a built-in catalog as fallback when the call fails), then posts `/v1/ask_me_anything`; drafting asks `/v2/ai/drafting/selectors` for modules and then posts `/v2/ai/drafting`. Both answer with NDJSON (one cumulative snapshot per line, lines up to several MB); Ada keeps the last snapshot and stops at `DONE`. Every Lexroom request has a hard deadline, so nothing waits on Lexroom forever. `ADA_LEXROOM_TIMEOUT_MS` (or the older `VERA_LEXROOM_TIMEOUT_MS`; default 60000, at least 1000) is the limit for one request: for the sign-in, the module lookup, the credit check and every other single call it covers connecting, headers and the whole body, and for a research or draft stream it is the longest silence tolerated, `idleTimeoutMs` in config overriding it for the Lexroom calls themselves. `timeoutMs` caps one whole research or draft call, stream included (default 180 seconds, never below three request limits), and `answerTimeoutMs` abandons a research that has produced no answer text by then even if progress lines keep arriving (default the request limit; lifted once the answer starts, because a full run takes about 80 seconds). When a limit ends a request it is aborted and its body closed, and the tool returns `{ ok: false, reason: "timeout", message: "Lexroom did not respond within Ns; the request was abandoned." }` (the same text is in `error`). Only transport failures are retried, and at most once after a 500 ms backoff: a dropped connection or a silent server for a request that is safe to repeat (the sign-in, GETs), and only a connection that was never made for a POST that starts paid work (research, drafts), so research is never run twice. A request that timed out is retried only for the sign-in. A 4xx, including a 403, and a 5xx are returned at once and never retried. The same limit protects the Google calls (20 seconds even when the caller passes its own signal), Kapso (10 seconds or less, response body included) and the Google certificate fetch (5 seconds).

Research is a job, because a full run takes about 80 seconds and can take minutes. `ada_research` checks its arguments, starts the research in the background and returns `{ ok: true, state: "running", jobId }` at once; `ada_research_status` with that `jobId` returns `state: "running"`, `"done"` (the answer and sources) or `"failed"` (`reason: "timeout"` when Lexroom did not respond), and its `waitSeconds` (default 15, at most 30) waits that long for the result. When a WhatsApp number asked in a chat of its own (the host's trusted `requesterSenderId` on the `kapso-whatsapp` channel is a phone number, and the conversation is not a group), code tells that number at once, in the language of the question, that the research runs in the background (`ack.sent`), and sends it the result as a new WhatsApp message when the job ends (`result.pushed`): the answer, the cited sources and the `Continua su Lexroom: <link>` line last, always as one message of at most 4000 characters (`RESEARCH_TEXT_LIMIT`: WhatsApp's 4096 minus a margin, counted in UTF-16 units so an emoji counts as two and is never cut in half), or a short localized message when the research failed, timed out or Lexroom is not connected. This holds for every sender, not only the configured lawyer; each message goes to the number that asked and to no one else, and a job can be read through `ada_research_status` only by the number that started it. Nothing depends on the model, which is told to end the turn with `NO_REPLY` and not to poll. A free-text message only reaches a number inside WhatsApp's 24-hour window, which Ada tracks per number from that number's last inbound message (in memory; for the configured lawyer also from the stored last inbound; a number Ada has not heard from since a restart is tried and, if the send fails, held). When the window is closed, or a send fails twice (2 seconds apart), the result is held in this process under that number (`result.held`, at most five per number, three days), the `digestReadyTemplate` nudge goes to that number to ask it to write, and that number's next message releases it, and no one else's. When the sender is unknown, not a phone number, on another channel or in a group, nothing is sent and `ada_research_status` returns the result as before (`ack.skipped` says why). A job whose result was pushed reads as `state: "delivered"` with its `researchId` and no answer, so a model that polls anyway cannot say it twice. Jobs live in the gateway process, at most four run at once, finished ones are kept for an hour, a job that never settles is failed at its deadline (the call cap plus three request limits), and the Ada service aborts and fails every running job when it stops, so a handle that survives a restart is reported as `unknown_job` and the research is started again. Drafts stay a single call, now bounded by the same limits. Every credential write, read and clear is logged as `ada lexroom store.write|read|clear` with the storage key, backend, database path, process id, host, replica and module instance (never the token), and the sign-in page logs `connect.callback.write|confirmed|rejected` with the email as typed and as stored. The Connected page only appears after the credential has been written and read back; otherwise a failure page is shown. The gateway log shows each call as `ada lexroom <event> key=value` lines (`tool.invoked`, `config.resolved`, `login.*`, `modules.*`, `research.start`, `.response`, `.retry`, `.first_line`, `.progress`, `.done`, `.failed`, `.timeout`, `job.started|finished`, and `draft.*` and `selectors.*` equivalents) with status, content type, latencies, line counts and durations. Every line of one tool call carries the same `cid` correlation id, and each request logs its `endpoint` (method and path only), attempt, elapsed `ms` and outcome (the HTTP status, or timeout, or a failure code), never a token, a password, an address or a query. Tokens and query text are never logged, only lengths. Research searches the call's `modules`, else `researchModules` in config, limited to the modules the user may search, else all of those modules. Like lexroom-bot, Ada reads snapshots with or without a `research` envelope, keeps the last non-empty answer text (falling back to `answer.html`) when a terminal line repeats the id without a body, and returns the last snapshot with an answer if the stream ends before `DONE`. A finished research also carries `researchUrl`, `https://app.lexroom.ai/research/<id>`, the page where the lawyer can keep reading in the Lexroom app (the route is the web app's own `/research/${id}`); for a follow-up it is the page of the thread's first research. Ada appends it to the final reply herself, not the model: once a research result has reached the model (the finished job read through `ada_research_status`, or a deadline brief), the `reply_payload_sending` hook adds `<label> <url>` as the last line of the next final reply that does not already contain the URL, in the reply's language (Italian, English, Spanish, French or German, from the reply text, then the profile language, then Italian). The link waits at most 30 minutes, is added once, and `message_sending` does the same only if the host never runs `reply_payload_sending`. `research.done` logs `researchUrl=present|absent`, `ada_research_status` logs `job.read` with the job state, and the hook logs `link.appended`. The link is built for `lexroom.ai` and its subdomains and left out for any other `baseUrl`. Answers come back in WhatsApp formatting with their `[n]` markers, plus only the cited sources as `[n] title - court, date`. The bearer is never logged and is only sent to an https `baseUrl` (or http on localhost). Machine API keys are not accepted by those endpoints yet.

When the whole text does not fit, the answer is cut to make room at a paragraph, else a sentence, else a word boundary and ends in `…`; the sources stay only if they take at most half of the remaining room (the PDF lists them), and the link line is never cut, so the lawyer reads the rest on Lexroom. A short answer is sent as it is. A result held for a closed 24-hour window is held, and released, as that same single message. A finished research also carries a one-page A4 PDF (`src/research-pdf.ts`, built with `pdf-lib`, no browser), sent as a WhatsApp document right after the text messages to the same number and to no one else: the question as title, the date, a short summary, key points, the main cited sources and the Lexroom link at the bottom, in the language of the answer. The content is condensed to fit, never shrunk: the summary comes first, then the key points, then as many sources as fit, and a note says the full research is at the link. The file is `lexroom-ricerca-<short-slug>-<yyyy-mm-dd>.pdf`. The PDF is an extra and the text answer always goes first: the file is uploaded to Kapso's media endpoint and sent as a `document` message (`src/kapso-document.ts`), because `@kapso/openclaw-whatsapp` 0.1.4 cannot send documents, and a result held for a closed 24-hour window sends its PDF when it is released. If the PDF cannot be built or sent, the delivery is unaffected and the log shows `ada lexroom result.pdf_failed job=... step=build|send` (a warning with the step and an HTTP status or timeout, never the answer, the question or a key); success logs `result.pdf_sent`. A failed or timed-out research sends no PDF.

The lawyer connects Lexroom the same way as Google: WhatsApp gets one link from `ada_lexroom_connect`, opens `/ada/lexroom/connect`, and signs in with Lexroom email and password. Accounts that require a one-time code (MFA) are not supported. Ada saves the email, the password and the access token in `$OPENCLAW_STATE_DIR/vera/lexroom-account.sqlite`, with the password and tokens encrypted (see Token encryption); neither the password nor a token is ever logged or shown. With the saved password Ada signs in again by herself, with the same sign-in the connect page uses (below), when the token is missing or within 60 seconds of expiring, and once more when Lexroom answers 401 (the call is then repeated once). Only a wrong password clears the account and asks the lawyer to reconnect. An account that requires a one-time code at every sign-in cannot be renewed: Auth0 or Lexroom asks for the code (`mfa_required`), and `ada_research` / `ada_draft` return `not_connected` with a message saying so. A sign-in saved without a password behaves the same way when its token expires, and Ada asks for a new link. Renewals are logged as `ada lexroom relogin.start|ok|failed|skipped` (reason and timing only). A 403 never clears anything and never asks to reconnect: it means the signed-in user lacks a permission (for example `User not authorized to search on the specified modules`), and the tool explains it in Italian with Lexroom's detail and the modules asked for. `ada_lexroom_connect` renews if needed, then checks the token with `GET /v1/credits`; only a 401 there that a renewal cannot fix clears it, while a 403, any other status or a network failure leaves it. `force: true` discards the saved account and always issues a link. Lexroom exposes no refresh-token endpoint Ada can use (`/v1/refresh` and similar answer 404), which is why the password is kept. A static `accessToken` in config remains a fallback only and is never renewed.

### How Ada signs in to Lexroom

Lexroom now signs people in through Auth0, and the old `POST /v1/login` answers `403 {"detail":"auth0_login_required"}`. One call, `loginLexroomAccount`, serves both the connect page and the silent re-login, and tries these in order:

1. **Auth0 password-realm grant**, only when `ADA_LEXROOM_AUTH0_CLIENT_SECRET` is set (the Lexroom web client is a confidential Auth0 application, so the grant needs its secret): `POST https://auth.lexroom.ai/oauth/token` with `grant_type=http://auth0.com/oauth/grant-type/password-realm`, `client_id` (`ADA_LEXROOM_AUTH0_CLIENT_ID`, default `Mb9ixXPSnvNlbnTlwFLTO6GpyodwM42a`), `client_secret`, `username`, `password`, `realm` (`ADA_LEXROOM_AUTH0_REALM`, default `lexroom-users`, the database connection named in Universal Login's own password-reset link), `audience=urn:lexroom:api:prod` and `scope=openid profile email`. No other path is tried when the secret is set. The Auth0 token is used as Lexroom's bearer as it is (`ADA_LEXROOM_AUTH0_TOKEN=id_token` uses the ID token instead), because no Lexroom endpoint that exchanges it is known, and it is checked once with `GET /v1/credits`: a 401 there means Lexroom's API does not take the token and is reported as `forbidden`. The Auth0 error codes map to `invalid_grant` = `wrong_password`, `mfa_required` = `mfa_required`, `unauthorized_client`, `invalid_client`, `access_denied` and `too_many_attempts` = `forbidden`, and 5xx or a rate limit = `unavailable`.
2. **The old `POST /v1/login`**, one request. It signs in where Lexroom still allows it and answers a wrong password with 401. `auth0_login_required` sends the sign-in on to the next path; any other refusal is `forbidden`.
3. **A headless replica of the web app's Auth0 flow**, for Lexroom's production hosts only: `GET app.lexroom.ai/api/auth/login`, redirected to Universal Login on `auth.lexroom.ai`; the identifier form and then the password form are posted with every field the page defines (the hidden `state`, `persist`, the selected `language`, the `js-available`, `webauthn-*` and `is-brave` flags, and the primary button's `action=default`), then the redirects are read one at a time back to `app.lexroom.ai/api/auth/callback/auth0`, and `GET /api/auth/session` gives `user.accessToken` and its expiry (the token's own, else the session's). Each host has its own cookie jar, nothing is followed outside `app.lexroom.ai` and `auth.lexroom.ai`, and the password is only ever posted to Auth0. A captcha element on a page is `captcha_required`, a one-time-code step (`/u/mfa-*`) is `mfa_required`, Auth0's wrong-credentials error on the password page is `wrong_password`, a blocked account or an Auth.js error redirect is `forbidden`, and a session without an access token is `unavailable`.

Every step is limited to `ADA_LEXROOM_TIMEOUT_MS` and the whole sign-in to twice that. Each step is logged under one correlation id as `login.*`, `auth0.*` or `web.*` with its endpoint (method and path), status and milliseconds, plus `login.path` (`auth0_password_realm`, `legacy` or `web`), `login.rejected` and `auth0.rejected` (status, code and detail) and `web.rejected` (phase, kind and code); never an email, a password, a secret, a token, a state, an authorization code or the `mfa_token`. The sign-in reasons are `wrong_password`, `mfa_required`, `captcha_required`, `forbidden`, `unavailable` and `timeout`.

## Google account

Ada uses the Gmail and Google Calendar APIs, not an MCP server and not `gog`. The collector runs without a WhatsApp sender, so requester-scoped MCP is not available. `gog` login is a shell flow and its callback URL must not be texted.

Create a Google Cloud OAuth web client, enable the Gmail API and the Google Calendar API, and register `googleRedirectUri` as an authorized redirect URI. The path is `/ada/google/callback` on the public Gateway origin; the older `/vera/google/callback` also works and stays the right choice while that is the URI registered in Google Cloud. `googleStateSecret` is any private string of at least 16 characters. The refresh token stays (encrypted, see Token encryption) in `$OPENCLAW_STATE_DIR/vera/google-account.sqlite`. Matter memory and snapshots live in `$OPENCLAW_STATE_DIR/vera/memory.sqlite`.

The connect link asks for read-only Gmail, permission to send mail, and read-only Calendar, plus the account email. Ada does not change calendar events. One link covers all of that. It expires after 30 minutes and works once. When Gmail is not connected, the morning phrasing turn still follows the ada-google-connect skill. `ada_send_email` sends one plain-text message only after `confirmed` is true. When the link succeeds, Ada texts `channels["kapso-whatsapp"].defaultTo` that Gmail and Google Calendar are connected.

Optional Pub/Sub: set `googlePubSubTopic` and point a push subscription at `/ada/google/notify`. Enable OIDC authentication on the subscription and set `googleNotifyAudience` to the audience you gave it. Ada verifies the push JWT: RS256 signature against Google's published keys (`https://www.googleapis.com/oauth2/v3/certs`, cached), issuer (`https://accounts.google.com` unless `googleNotifyIssuer` is set), audience, and expiry. Set `googleNotifyServiceAccount` to also require the subscription's service account email. `googleNotifyToken` (16+ chars, `Authorization: Bearer <token>`, compared in constant time) remains as a static fallback for a trusted proxy; prefer OIDC. Without `googleNotifyAudience` or `googleNotifyToken` the route returns 401, and the 15-minute poll owns wakes.

A push whose Gmail `historyId` is missing or not newer than the last one collected is acknowledged (204) without collecting. At most one collect pass runs per 15 seconds; extra pushes get 429 with `Retry-After` and Pub/Sub redelivers them.

## Token encryption

Google refresh and access tokens and the Lexroom password, bearer and refresh tokens are encrypted in SQLite with AES-256-GCM. Each value is bound to its table and column. Set `ADA_TOKEN_KEY` (the pre-rename name `VERA_TOKEN_KEY` is still read) to 32 random bytes as base64 or 64 hex characters:

```sh
openssl rand -base64 32
```

With `NODE_ENV=production` the account stores refuse to open without `ADA_TOKEN_KEY`, so set it before upgrading. Outside production a missing key leaves tokens in plaintext for local development. Rows saved before encryption are read as plaintext and re-written encrypted the first time the store opens with a key. Keep the key stable: losing it or changing it makes the stored tokens unreadable, and the lawyer reconnects Google and Lexroom from a fresh link. Keep it in the host's secret store, never in config files or git. When `ADA_TOKEN_KEY` is unset, Ada derives the key from the gateway's own `OPENCLAW_GATEWAY_TOKEN` (HKDF), so the credentials are still encrypted; setting `ADA_TOKEN_KEY` later, or rotating the gateway token, makes what was saved unreadable until the lawyer reconnects.

## Environment and config reference

| Name                         | Where         | Purpose                                                                               |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------- |
| `ADA_TOKEN_KEY`              | environment   | AES-256 key for tokens at rest. Required in production. `VERA_TOKEN_KEY` still works. |
| `googleNotifyAudience`       | plugin config | Audience of the Pub/Sub push OIDC token. Enables JWT verification.                    |
| `googleNotifyIssuer`         | plugin config | Expected issuer. Defaults to `https://accounts.google.com` or `accounts.google.com`.  |
| `googleNotifyServiceAccount` | plugin config | Required `email` claim (verified) of the push subscription service account.           |
| `googleNotifyToken`          | plugin config | Static Bearer fallback, 16+ chars.                                                    |
| `statusToken`                | plugin config | Bearer token (16+ chars) for `GET /ada/status`.                                       |

Plugin config values can reference environment variables, for example `googleNotifyAudience: "${ADA_GOOGLE_NOTIFY_AUDIENCE}"`.

## Lawyer sender check

Ada records a lawyer inbound message (which opens the WhatsApp 24-hour window and releases a held digest) only when the sender matches `channels["kapso-whatsapp"].defaultTo`. Comparison uses digits only, so `+390000000000`, `390000000000`, and `whatsapp:+390000000000` are the same number. A missing `defaultTo` or any other sender is not recorded (a debug log line only): it still chats normally, because DMs are open to anyone, but it cannot open the window or release a digest.

## Monitoring

`GET /ada/status` returns collector health as JSON. It needs `Authorization: Bearer <statusToken>`; `statusToken` is 16+ characters and the route returns 401 for every request while it is unset. The Railway deploy sets it from `ADA_STATUS_TOKEN`.

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
{
  "event": "ada.collect",
  "at": "2026-10-14T08:55:00.000Z",
  "trigger": "poll",
  "result": "collected",
  "decision": "hold",
  "dispatchReason": "whatsapp_window_closed",
  "delivered": false,
  "held": true,
  "urgent": true,
  "forceMorning": false,
  "windowOpen": false,
  "deliverable": true,
  "durationMs": 412
}
```

- `trigger`: `poll`, `morning`, `notify`, or `inbound`.
- `result`: `collected` (snapshots and `lastCollectAt` advanced), `skipped` (Google not connected or unreadable, or a held plan is waiting out its retry backoff or has used all retries; `dispatchReason` names the cause), or `error` (logged at error level with `error`).
- `decision`: `silent`, `batch`, `hold`, `dispatch`, `connect`, or `none`. `dispatchReason` carries `whatsapp_window_closed`, `batched_until_morning`, `dispatch_rejected`, `hooks_unavailable`, `retry_backoff`, `retries_exhausted`, and similar causes. A rejected dispatch still advances `lastCollectAt` (the collector is alive) but leaves the diff baseline in place and holds the plan for retry.

Suggested alert: page when no `result:"collected"` line appears for 45 minutes. The poll runs every 15 minutes, so three misses in a row means the collector is stopped, Google is disconnected, or the Gateway is down. In Railway, filter `"event":"ada.collect" "result":"collected"` and alert on zero matches over 45 minutes. A probe against `/ada/status` that fails on `lastCollectAgeSec > 2700` (or `null` after the first day) catches the same condition and also covers a silent log pipeline. Add lower-urgency alerts on `heldPlan.ageSec > 86400`, on `result:"error"` lines, and on `dispatchReason` values `dispatch_rejected` or `hooks_unavailable` (the collector is alive but no digest went out). The structured line is the logger message itself; if the host prefixes log lines, match on the substrings above instead of parsing the whole line as JSON.

## Reopening the WhatsApp 24-hour window

WhatsApp only lets Ada send free-form text within 24 hours of the lawyer's last message. When a digest is held because that window is closed, Ada sends one pre-approved utility template through Kapso so the lawyer can reply and release it. The reply is an ordinary inbound message: the existing flow re-collects and delivers the held plan.

Create and get approved, in the WhatsApp Business Manager that owns the Kapso number:

- Category: **Utility**
- Name: any lowercase letters, digits, and underscores, for example `ada_digest_ready`
- Language: the one you will configure below, for example `en` or `it`
- Body, with no variables, buttons, header, or footer: `Your Ada digest is ready. Reply to see it.`

Then set it in the plugin config:

```json5
{
  plugins: {
    entries: {
      ada: {
        config: {
          digestReadyTemplate: { name: "ada_digest_ready", language: "en" },
        },
      },
    },
  },
}
```

The template goes to `channels["kapso-whatsapp"].defaultTo` using the same Kapso account (`apiKey`, `phoneNumberId`, `baseUrl`, or the `KAPSO_*` environment variables) as the rest of the channel. Rules:

- If `digestReadyTemplate` is unset or missing `name` or `language`, nothing is sent and the gateway logs one warning per start. The plan is still held until the lawyer texts.
- At most one template per held plan. Ada records the send before calling Kapso and never retries it, including after a 4xx (for example, template not approved in that language), a 5xx, or a timeout. The plan stays held; check the gateway log line `ada digest-ready template not sent: ...` for the HTTP status.
- A new template can go out only after the held plan is delivered and a later plan is held again.
- The send has a 10-second timeout and never fails or delays the collect pass beyond it.

## Admin batch outreach

Off unless `ADA_ADMIN_NUMBERS` is set. For everyone else Ada behaves exactly as before and never mentions the feature. An admin can hand Ada a list of numbers, and Ada sends each one an approved WhatsApp intro template so she can start conversations with people who have never written to her. A recipient who replies starts an ordinary chat with Ada; no recipient ever sees another.

| Variable                    | Default             | Meaning                                                                                                                              |
| --------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `ADA_ADMIN_NUMBERS`         | unset (feature off) | Comma-separated E.164 numbers, such as `+390000000001,+390000000002`, allowed to run outreach from their own WhatsApp chat with Ada. |
| `ADA_INTRO_TEMPLATE_NAME`   | `ada_intro`         | Approved WhatsApp template to send.                                                                                                  |
| `ADA_INTRO_TEMPLATE_LANG`   | `it`                | Language code the template was approved in.                                                                                          |
| `ADA_INTRO_TEMPLATE_PARAMS` | `1`                 | Body variables the template declares: `1` fills `{{1}}` with the first name, `0` sends a template without variables.                 |
| `ADA_INTRO_DEFAULT_NAME`    | `gentile utente`    | What fills `{{1}}` for a row without a name (Meta rejects an empty variable).                                                        |

The template must be approved in the WhatsApp Business Manager that owns the Kapso number, with the name, language and variable count above. It is sent through the same Kapso client as the digest-ready nudge (`whatsapp-template.ts`).

How an admin uses it, in a WhatsApp chat with Ada:

1. Send the list, either as a CSV or TXT document, or as a text message that starts with `/invia-intro` and has one number per line. A row may be `number` or `number,name`; a file may instead start with a header row naming a `phone`/`telefono` column and optionally a `name`/`nome` column (comma, semicolon or tab separated). Numbers are normalized to E.164: `+39` is assumed when there is no country code, spaces, dashes and dots are removed, and a leading `00` means `+`. The first name of the row fills `{{1}}`. At most 1,000 numbers per list.
2. Ada replies with how many numbers are valid, invalid, duplicate and opted out (and how many were skipped for a recent intro), plus a few masked examples. Nothing is sent yet.
3. Reply `CONFERMA` within 30 minutes to send. `/annulla` cancels the pending list, or stops a batch that is running (messages already sent stay sent). After 30 minutes the pending list expires.
4. Ada sends about one message per second. When it finishes she tells the admin how many went out and how many failed, grouped by reason.

Rules Ada enforces:

- A number that replied `STOP`, `BASTA` or `annulla iscrizione` to Ada is saved on an opt-out list, gets a short confirmation from Ada, and is never sent outreach again. The opt-out list is permanent. The configured lawyer's `stop` is left alone, because it also aborts a running turn. OpenClaw treats `stop` as an abort command, so that reply may also carry its own "aborted" notice.
- A number is sent the intro once per batch, and not again within 30 days of its last intro.
- Progress is saved in the Gateway's plugin state (`$OPENCLAW_STATE_DIR`, the same volume as the other Ada stores) before each send. After a restart Ada resumes at the saved row. A number whose send was interrupted without a recorded outcome is reported as "non confermato" and is not sent again, so nobody gets two intros.
- Phone numbers are masked in logs (`+39********67`); nothing at info level shows a full number.
- An admin's CSV or TXT attachment is always read as an outreach list. An admin's other messages, including a `CONFERMA` with nothing pending, reach Ada as usual.

## WhatsApp read receipts

When Ada accepts an inbound Kapso WhatsApp message, she marks that WhatsApp message read. The lawyer sees the blue checks while Ada is working, instead of gray delivered checks until a later reply. Set `channels["kapso-whatsapp"].sendReadReceipts` to `false` to leave messages delivered.

## Memory

Read-only tools: `ada_memory_search`, `ada_memory_list`, `ada_memory_get`, `ada_memory_history`, `ada_todo_list`, `ada_todo_get`. Every page except lawyer-global preferences requires a `matterId`. Search is case-insensitive substring match on aliases, title, and id. The daily reconcile writes timeline notes and one-pagers; the answering turn never writes memory.

## Deadline and hearing intake

Off by default. Set `plugins.entries.ada.config.deadlineIntake.enabled: true` to turn it on; with the flag off the collector, digest, and tools behave exactly as before.

On each collect pass Ada scans new Gmail and the next `horizonDays` of Calendar for hearings and deadlines on matters it already knows:

- Mail: subject, plain-text body, PEC messages (including the `postacert.eml` envelope), and the text of PDF attachments where it can be read without OCR. Italian and English phrasing, `dd/mm/yyyy`, `12 novembre 2026`, `November 12th, 2026`, ISO dates, times in 24-hour or AM/PM form, terms counted from receipt ("entro 30 giorni dalla notifica"), and postponements ("rinviata al ...") are understood. Dates that record the past ("depositata il ...") or name another document ("sentenza del ...") are ignored, as are impossible dates.
- Calendar: events whose title says udienza, scadenza, hearing, deadline, and similar.

Each item is stored in `memory.sqlite` with the matter, type (`deadline` or `hearing`), due date and time in Europe/Rome (all-day deadlines count until 23:59, hearings without a time default to 09:00), sources, and a confidence score. The same obligation from an email, a PDF, and a calendar event is one item, and a dismissed item is not revived by a later copy. A postponement notice or a moved calendar event moves the item and carries over the lawyer's choice. An item the lawyer never answers is offered in at most three digests (always while it is due within 48 hours) and stays visible through `ada_deadline_list`. Items below `minConfidence` (default 0.6) and dates in the past are dropped. Mail about matters without an alias is ignored.

The morning digest lists upcoming items with a number: "reply 1 to run research". A reply calls `ada_deadline_reply`:

- a number runs Lexroom research for that matter, confirms tracking, and the brief is texted back in the same turn;
- `track` confirms tracking without research; `brief` resends the stored brief without calling Lexroom; `dismiss` and `done` close the item.

Reminders come only after the lawyer confirms an item. They ride in the morning digest at 07:40 Europe/Rome on the day of each step in `deadlineIntake.reminders` (default `7d`, `2d`, `morning-of`; `Nd` counts calendar days before the due date). Steps whose time had already passed when the lawyer confirmed are skipped. If the WhatsApp window is closed, the reminder waits with the held digest, and when several steps pile up only the latest is sent. Deadline lines and their reply numbers are rebuilt from matter memory on every pass, including when a held or retried digest is finally sent, and the numbers are recorded only once that digest is delivered.

Known limits: a cancelled or deleted calendar event does not end an item (reply `dismiss`), mail is scanned once per message, and PDFs without a text layer (scans) are read from the email body only.

Until the lawyer replies, intake is read-only. It sends no email and does not touch the calendar; email replies keep the existing `ada_send_email` confirmation. The flow is described in `skills/ada-deadline-intake`.

| Option                         | Default                      | Meaning                                                   |
| ------------------------------ | ---------------------------- | --------------------------------------------------------- |
| `deadlineIntake.enabled`       | `false`                      | Turn intake, digest lines, reply tools, and reminders on. |
| `deadlineIntake.reminders`     | `["7d", "2d", "morning-of"]` | Reminder cadence for confirmed items.                     |
| `deadlineIntake.horizonDays`   | `60`                         | How far ahead the calendar is scanned.                    |
| `deadlineIntake.minConfidence` | `0.6`                        | Drop extractions scored below this.                       |

## Renamed from Vera

Ada was called Vera. Existing deployments keep working: `VERA_*` variables are still read, the stores stay in `$OPENCLAW_STATE_DIR/vera/` (table names and token encryption contexts included), and the HTTP routes answer on both `/ada/...` and `/vera/...`. The plugin id is `ada` and the tools are `ada_*`. See `deploy/railway/README.md#renamed-from-vera` for the Railway steps and the variables worth renaming.
