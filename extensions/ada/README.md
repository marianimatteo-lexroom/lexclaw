# Ada

Ada is Lexroom's legal assistant on WhatsApp. She serves everyone who writes to her, each in a private chat, with that person's own Lexroom account, Gmail and Calendar, and matter memory (see [Accounts and privacy](#accounts-and-privacy)).

A plugin service diffs the connected Gmail inbox and Google Calendar every 15 minutes and at 07:40 on each number's own clock (Europe/Rome until that person says where they are). A quiet pass updates snapshots and never calls the model. When a plan clears the cost bar, Ada's code writes one digest and sends it straight to that person's WhatsApp number, with no model turn. Same-day deadlines and hearings that moved earlier may wake immediately; everything else waits for morning. Polls only ever alert on urgent items. If the WhatsApp 24-hour window is closed, the plan is held until that person texts. If the send fails (WhatsApp unavailable, timeout, rejection), the plan is also held and retried on later passes with a 15-minute to 2-hour backoff, up to 5 attempts; after that it waits for the next 07:40 pass or a lawyer message. The Gmail and Calendar snapshots that drive the diff only advance once a digest is delivered or held, so a failed or batched pass never drops its signals.

The 07:40 slot is per number (scheduling lives in `src/morning-schedule.ts`). Each number gets its pass at 07:40 in the time zone saved in its own profile, and Europe/Rome when it has none (or the saved name is not a zone). One timer wakes at the earliest next slot across all numbers and runs only the numbers that are due, one after another; after each run Ada recomputes every slot from the calendar of that number's zone, so DST days stay at 07:40 and a slow run never drifts. The 15-minute poll re-reads the numbers and zones and re-arms the timer, so a number that connected, a number that was removed, or a changed zone takes effect within one poll. A person sets their zone by telling Ada where they are: the model calls `ada_set_timezone` with the IANA name (for example `Asia/Shanghai`), which writes only that number's profile (`setProfileTimezone` in `src/memory.worker.ts`; a profile it creates takes the language that number last wrote in, when known), and the next brief comes at 07:40 there. On boot, for each number whose last collect is older than the latest 07:40 slot of its own zone (the gateway was down across it), Ada runs one catch-up morning pass about 30 seconds after start; it does not repeat the Google connect ask. The once-a-day connect ask for the lawyer's not-yet-connected Google follows the same slot and is keyed by the lawyer's local day. Collect passes never overlap: the 15-minute poll, `/ada/google/notify`, the 07:40 slot, the catch-up, and the lawyer-reply release run one at a time, and a burst of polls or notifications collapses into one waiting pass. All digest turns start through one dispatch helper (`src/dispatch-digest.ts`). When the host has no service scheduler, Ada falls back to `setTimeout`/`setInterval` and says so once at info level.

### Morning brief on a quiet day

The morning pass of a connected number with an open WhatsApp 24-hour window always sends something. When a plan clears the bar it is the digest above. When nothing does, Ada sends a short brief written by code in that person's latest language (Italian by default): today's calendar events in their own time zone (or "nessun impegno"), the count of unread inbox mail with up to three subjects about their matters, the next hearings and deadlines within two weeks when deadline intake is on (listed without reply numbers or offers), and a "nothing urgent" line first ("nothing else new to report" when an alert already went out to that number earlier the same local day). It is not sent by polls or by the release of a held plan after a reply. A catch-up after a restart sends it only while that number's local time is before 11:00; later it skips the brief for the day, still records the collect, and does not mark the day as briefed (an urgent plan is still sent or held). With the window closed nothing changes: an urgent plan is held (and the digest-ready template is sent once, as before), and a quiet day stays silent; no brief is held for later and no new template is used. At most one morning brief per number per local day: the time of the last delivered morning brief (`lastMorningBriefAt`, a column on the wake state) is compared with the number's current local day, so a restart or a catch-up never sends a second one. A failed send is not counted, so the next morning pass for that number tries again.

Matter memory is Instinct-shaped: markdown pages with aliases, keyword search (plus Voyage embeddings per number when `VOYAGE_API_KEY` is set; see the Railway README), a small injected brief, and a daily reconcile that writes while the answering agent only reads. Pages are matter-scoped. Research and draft still go through Lexroom, with a separate confirmation before any draft or email send.

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
      "ada_set_timezone",
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

Each person connects their own Lexroom the same way as Google: WhatsApp gets one link from `ada_lexroom_connect`, opens `/ada/lexroom/connect`, and signs in with Lexroom email and password. Accounts that require a one-time code (MFA) are not supported. Ada saves the email, the password and the access token under that person's number in `$OPENCLAW_STATE_DIR/vera/lexroom-account.sqlite`, with the password and tokens encrypted (see Token encryption); neither the password nor a token is ever logged or shown. With the saved password Ada signs in again by herself, with the same sign-in the connect page uses (below), when the token is missing or within 60 seconds of expiring, and once more when Lexroom answers 401 (the call is then repeated once). Only a wrong password clears the account and asks that person to reconnect. An account that requires a one-time code at every sign-in cannot be renewed: Auth0 or Lexroom asks for the code (`mfa_required`), and `ada_research` / `ada_draft` return `not_connected` with a message saying so. A sign-in saved without a password behaves the same way when its token expires, and Ada asks for a new link. Renewals are logged as `ada lexroom relogin.start|ok|failed|skipped` (reason and timing only). A 403 never clears anything and never asks to reconnect: it means the signed-in user lacks a permission (for example `User not authorized to search on the specified modules`), and the tool explains it in Italian with Lexroom's detail and the modules asked for. `ada_lexroom_connect` renews if needed, then checks the token with `GET /v1/credits`; only a 401 there that a renewal cannot fix clears it, while a 403, any other status or a network failure leaves it. `force: true` discards the saved account and always issues a link. Lexroom exposes no refresh-token endpoint Ada can use (`/v1/refresh` and similar answer 404), which is why the password is kept. A static `accessToken` in config remains a fallback only for the configured lawyer, and is never renewed.

### How Ada signs in to Lexroom

Lexroom now signs people in through Auth0, and the old `POST /v1/login` answers `403 {"detail":"auth0_login_required"}`. One call, `loginLexroomAccount`, serves both the connect page and the silent re-login, and tries these in order:

1. **Auth0 password-realm grant**, only when `ADA_LEXROOM_AUTH0_CLIENT_SECRET` is set (the Lexroom web client is a confidential Auth0 application, so the grant needs its secret): `POST https://auth.lexroom.ai/oauth/token` with `grant_type=http://auth0.com/oauth/grant-type/password-realm`, `client_id` (`ADA_LEXROOM_AUTH0_CLIENT_ID`, default `Mb9ixXPSnvNlbnTlwFLTO6GpyodwM42a`), `client_secret`, `username`, `password`, `realm` (`ADA_LEXROOM_AUTH0_REALM`, default `lexroom-users`, the database connection named in Universal Login's own password-reset link), `audience=urn:lexroom:api:prod` and `scope=openid profile email`. No other path is tried when the secret is set. The Auth0 token is used as Lexroom's bearer as it is (`ADA_LEXROOM_AUTH0_TOKEN=id_token` uses the ID token instead), because no Lexroom endpoint that exchanges it is known, and it is checked once with `GET /v1/credits`: a 401 there means Lexroom's API does not take the token and is reported as `forbidden`. The Auth0 error codes map to `invalid_grant` = `wrong_password`, `mfa_required` = `mfa_required`, `unauthorized_client`, `invalid_client`, `access_denied` and `too_many_attempts` = `forbidden`, and 5xx or a rate limit = `unavailable`.
2. **The old `POST /v1/login`**, one request. It signs in where Lexroom still allows it and answers a wrong password with 401. `auth0_login_required` sends the sign-in on to the next path; any other refusal is `forbidden`.
3. **A headless replica of the web app's Auth0 flow**, for Lexroom's production hosts only: `GET app.lexroom.ai/api/auth/login`, redirected to Universal Login on `auth.lexroom.ai`; the identifier form and then the password form are posted with every field the page defines (the hidden `state`, `persist`, the selected `language`, the `js-available`, `webauthn-*` and `is-brave` flags, and the primary button's `action=default`), then the redirects are read one at a time back to `app.lexroom.ai/api/auth/callback/auth0`, and `GET /api/auth/session` gives `user.accessToken` and its expiry (the token's own, else the session's). Each host has its own cookie jar, nothing is followed outside `app.lexroom.ai` and `auth.lexroom.ai`, and the password is only ever posted to Auth0. A captcha element on a page is `captcha_required`, a one-time-code step (`/u/mfa-*`) is `mfa_required`, Auth0's wrong-credentials error on the password page is `wrong_password`, a blocked account or an Auth.js error redirect is `forbidden`, and a session without an access token is `unavailable`.

Every step is limited to `ADA_LEXROOM_TIMEOUT_MS` and the whole sign-in to twice that. Each step is logged under one correlation id as `login.*`, `auth0.*` or `web.*` with its endpoint (method and path), status and milliseconds, plus `login.path` (`auth0_password_realm`, `legacy` or `web`), `login.rejected` and `auth0.rejected` (status, code and detail) and `web.rejected` (phase, kind and code); never an email, a password, a secret, a token, a state, an authorization code or the `mfa_token`. The sign-in reasons are `wrong_password`, `mfa_required`, `captcha_required`, `forbidden`, `unavailable` and `timeout`.

## Google account

Ada uses the Gmail and Google Calendar APIs, not an MCP server and not `gog`. The collector runs without a WhatsApp sender, so requester-scoped MCP is not available. `gog` login is a shell flow and its callback URL must not be texted.

Create a Google Cloud OAuth web client, enable the Gmail API and the Google Calendar API, and register `googleRedirectUri` as an authorized redirect URI. The path is `/ada/google/callback` on the public Gateway origin; the older `/vera/google/callback` also works and stays the right choice while that is the URI registered in Google Cloud. `googleStateSecret` is any private string of at least 16 characters. Each person's refresh token stays (encrypted, see Token encryption) under their number in `$OPENCLAW_STATE_DIR/vera/google-account.sqlite`. Matter memory and snapshots live in one file per number, `$OPENCLAW_STATE_DIR/vera/memory/<number>.sqlite`.

The connect link asks for read-only Gmail, permission to send mail, read-only Calendar and permission to create and edit calendar events (`calendar.events`), plus the account email. Ada creates or edits an event only with `ada_create_calendar_event` or `ada_update_calendar_event`, after the person confirms it in the chat, and never deletes one. A connection made before that scope was added still reads; the event tools return `needs_calendar_scope` and Ada offers a fresh link. Add the `calendar.events` scope to the OAuth consent screen of the Google Cloud project. One link covers all of that. It expires after 30 minutes and works once. When a person who asks about mail has not connected Gmail, the ada-google-connect skill sends them their own link; the lawyer is also asked once each morning. `ada_send_email` sends one plain-text message only after `confirmed` is true. When the link succeeds, Ada texts the number that asked for the link, and no other, that Gmail and Google Calendar are connected.

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
| `ADA_WELCOME_ENABLED`        | environment   | `false` (also `0`, `off`, `no`) turns the first-message welcome off. Default on.      |
| `googleNotifyAudience`       | plugin config | Audience of the Pub/Sub push OIDC token. Enables JWT verification.                    |
| `googleNotifyIssuer`         | plugin config | Expected issuer. Defaults to `https://accounts.google.com` or `accounts.google.com`.  |
| `googleNotifyServiceAccount` | plugin config | Required `email` claim (verified) of the push subscription service account.           |
| `googleNotifyToken`          | plugin config | Static Bearer fallback, 16+ chars.                                                    |
| `statusToken`                | plugin config | Bearer token (16+ chars) for `GET /ada/status`.                                       |

Plugin config values can reference environment variables, for example `googleNotifyAudience: "${ADA_GOOGLE_NOTIFY_AUDIENCE}"`.

## No signature

Ada never signs her messages: no "— Ada", "Ada" or "Ada · Lexroom" at the end, because the person already knows who answers. The persona and the skills that dictate a message say so, `start.sh` removes any older instruction to sign from `SOUL.md` and `AGENTS.md` on the volume (backup in `*.pre-ada`), and as a safety net `src/signature.ts` drops a final line of a model reply that is only the signature (case-sensitive, only when other text comes before it, so a sentence that mentions Ada is never touched). The legal disclaimer in the welcome and the `Continua su Lexroom` link line are not signatures and stay.

## Reply language

Ada replies in the language of the person's most recent message, in the model's turns and in every message sent by code. The persona (`src/persona.ts`) states this as a hard rule that overrides earlier messages, the profile language, memory, and the language of tool output and digest data. In code, `message_received` records the language of each WhatsApp number's latest message in memory (`recordInboundLanguage` in `src/research-link-outbound.ts`, the same stopword detection extended with hint words for short messages); a message that carries no language ("ok", a link, an emoji) keeps the previous one. The Lexroom and Gmail/Calendar connected confirmations, the research acknowledgement, result framing and failure notes, the morning digest, the Google connect ask and the held reconnect note, and the mailbox-moved note all use it, in Italian, English, Spanish, French and German. A number with no known message (for example after a restart) falls back to its profile language, then Italian. The welcome message, the digest-ready WhatsApp template (approved in one language) and the browser pages shown after connecting are not covered.

## First-message welcome

The first time a WhatsApp number ever writes to Ada, code sends it one fixed welcome message before any model turn. It opens with the text of the approved Meta template `ada_welcome`, without the template's "reply to start" line because this message is itself a reply: Ada is Lexroom's legal assistant on WhatsApp, and the person can ask legal questions, have her run research on Lexroom, and connect Gmail and Calendar so she can manage email, meetings and deadlines. Then come three example questions (a legal one, a case-law search and a calendar question); one line that research on Lexroom needs the person's own Lexroom account and that Ada will ask whether they want to connect it when she needs it, then send the link (no command or keyword is ever taught); and the standing disclaimer that her answers do not replace a lawyer and that each user's chats and results are private. The text is deterministic (`src/welcome.ts`, Italian, English, Spanish, French and German) and costs no model call. The language is the greeting's own (`hi`, `hola`, `bonjour`, `hallo`), else the message's (the same detection that picks the language of every other message, see Reply language), else Italian.

Connecting is a conversation, not a command. When a request needs Lexroom, Gmail or Calendar and the person has not connected it (or the connection expired or was refused), Ada says so in one natural sentence and asks whether they want to connect, for example "Per farlo devo collegarmi al tuo Gmail, ti mando il link?". The model reads the answer in context (sì, ok, certo, vai, yes, 👍, ...); if it is yes she calls `ada_lexroom_connect` or `ada_google_connect` and sends that person's own signed link, if it is no she carries on without it and does not ask again. A person who says on their own that they want to connect, or that they already have Lexroom, gets the link straight away. There is no keyword matcher anywhere. The only state is for questions Ada's code asks in messages the model did not write (a research that failed because Lexroom is not connected or was refused, or the note that a mailbox moved to another number): the question is kept for that number's next turn and handed to the model as a note ("Question you just asked"), read once and forgotten after 72 hours at most, so a bare "sì" is understood. See [Accounts and privacy](#accounts-and-privacy).

- **Greeting only.** A message that is just a greeting (`ciao`, `ciao Ada`, `salve`, `buongiorno`, `hi`, `hello`, `hey Ada`, ... ignoring case, accents, punctuation and emoji) gets the welcome and nothing else: the `before_dispatch` hook handles it, so no model reply follows.
- **A question or request.** Any other first message gets the welcome first and is then answered normally.
- **Once per number.** The marker is a row in the registry file `$OPENCLAW_STATE_DIR/vera/memory.sqlite` (table `vera_welcomed`), written before the send so two messages that arrive together send one welcome. It survives restarts and redeploys. If the send fails the marker is removed, the model answers the message as usual, and the next message tries again.
- **Not for existing users.** A number whose own session already existed before the message is marked without being welcomed. This relies on one session per sender: the Railway `start.sh` sets `session.dmScope: "per-channel-peer"` on every boot, so a sender's session key is `agent:main:kapso-whatsapp:direct:<number>`. With the host default `main` every DM would share one session that names nobody, and Ada could not tell who talked to her before. Numbers that chatted under `main` before the switch have no session of their own, so each gets the welcome once on its next message.
- **Not for the lawyer.** The configured `channels["kapso-whatsapp"].defaultTo` number is never welcomed or marked. Groups and other channels are ignored.

Set `ADA_WELCOME_ENABLED=false` to turn it off (the pre-rename `VERA_WELCOME_ENABLED` also works). Nothing is marked while it is off, so turning it back on welcomes numbers that have not been welcomed yet.

### Deep link and QR code

Send new users to Ada with a WhatsApp deep link, `https://wa.me/<number>?text=<urlencoded text>`: `<number>` is Ada's WhatsApp number in international format with digits only (no `+`, spaces or leading zeros), and the text is the message WhatsApp prefills for the user, who can edit it before sending. Ada's link is:

```text
https://wa.me/12024908196?text=Ciao%20Ada
```

To encode other text, for example `Ciao Ada, ho una domanda`: `node -p 'encodeURIComponent("Ciao Ada, ho una domanda")'`. To make a QR code of the link, any QR generator works; for a PNG from the command line:

```sh
npx qrcode "https://wa.me/12024908196?text=Ciao%20Ada" -o ada-whatsapp.png
```

(or `qrencode -o ada-whatsapp.png "https://wa.me/12024908196?text=Ciao%20Ada"` where `qrencode` is installed). Scan it with the phone camera to check that it opens a chat with Ada and the prefilled `Ciao Ada` before printing it.

## Accounts and privacy

Every WhatsApp number is its own owner, written as its digits (`393331111111`). The owner of a turn is the sender of the current private chat, taken from the host's trusted sender id and session key (`agent:main:kapso-whatsapp:direct:<number>`), never from a tool argument or from the model. A group chat, another channel, a missing sender, or a sender that contradicts its own session gets `reason: "private_chat_required"` and no account is opened. There is no default and no fallback to the lawyer's or anyone else's account.

| What                                                               | Where it lives                                                               | Keyed by                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------- |
| Lexroom sign-in, saved email and password                          | `$OPENCLAW_STATE_DIR/vera/lexroom-account.sqlite`, encrypted                 | owner (row id)                          |
| Gmail and Calendar sign-in (refresh token)                         | `$OPENCLAW_STATE_DIR/vera/google-account.sqlite`, encrypted                  | owner (row id)                          |
| Connect links in progress                                          | the same two files, one pending row per owner                                | owner and nonce                         |
| Matter memory, profile, todos, deadlines, digest state, held plans | one SQLite file per owner, `$OPENCLAW_STATE_DIR/vera/memory/<number>.sqlite` | the file name, so no query can leave it |
| Who was welcomed                                                   | the registry, `$OPENCLAW_STATE_DIR/vera/memory.sqlite`                       | number                                  |
| Research jobs, held results, research links                        | in the gateway process                                                       | owner                                   |

- **Connect links.** `ada_lexroom_connect` and `ada_google_connect` return a link whose signed state names the requesting number, expires after 30 minutes and works once. The link sent on WhatsApp is a short alias on the public origin, `/g/<code>` for Google and `/l/<code>` for Lexroom (10 random URL-safe characters), that 302-redirects to the full URL; it expires with the state, is dropped when the callback spends the state, and a new link for the same number replaces the old one. Codes live in the gateway process (at most 2000), so a restart makes links already sent answer with an Italian "link scaduto" page and the person asks Ada for a new one. Codes are never logged. The pending row names the same number, and completing the link saves the account for that number only, whoever opens it. The success page and the WhatsApp confirmation go to that number only.
- **Expired Google sign-ins.** When Google rejects a saved account (`invalid_grant`), it counts as not connected everywhere: the background pass and `ada_google_connect` drop the dead row, `ada_google_connect` issues a fresh signed link instead of answering "connected", and the background pass sends that number one plain note with the link ("Il collegamento al tuo Gmail è scaduto: ecco il link per ricollegarlo (vale 30 minuti)"). If the WhatsApp window is closed or the send fails, the note is held in memory for that number and goes out, with a link made at that moment, when the number next writes (a restart forgets it). Google's own `error_description` is logged with the failure, and a refreshed access token (and a rotated refresh token, encrypted as before) is saved back so the next pass does not refresh again.
- **Tools.** Research, drafts, `ada_read_inbox`, `ada_read_calendar`, `ada_send_email`, the deadline tools and the memory tools act for the owner of the turn. A tool the owner has not connected returns `not_connected` and Ada offers that person's connect link. The static `accessToken` in plugin config belongs to the configured lawyer (`channels["kapso-whatsapp"].defaultTo`) and to no one else.
- **Background work.** The 15-minute poll, the Gmail push route (which finds the owner by the mailbox) and the 07:40 slot (each number's own 07:40) visit every number that connected Google, one pass each. The digest, the digest-ready template and the Google connect ask are sent by code to that number and no other; only the lawyer is asked to connect Google proactively. Research results and held results go to the number that asked. A number's WhatsApp window opens when that number writes.
- **The lawyer.** The configured `defaultTo` number is the owner of the accounts and memory that existed before accounts belonged to a number: the first start moves the single Lexroom and Google rows to it (saved passwords and tokens stay readable), and the first open of its memory copies the old `memory.sqlite` to `memory/<number>.sqlite` (the old file stays as a backup, and a marker keeps a changed lawyer number from taking it twice). Nothing is reconnected. The lawyer's chat is a session of its own like everyone else's.
- **What is shared.** The host's agent workspace (`IDENTITY.md`, `SOUL.md`, other workspace notes) and any agent-level memory plugin are shared by every sender. Ada does not write personal data to them, but anything saved there by an earlier version or by hand is read in every chat.

## Sender check

Ada opens a number's WhatsApp 24-hour window, and releases the digest held for it, when that number writes, but only for numbers that already have memory (a digest to release); a number is not given a database by saying hello. Comparison uses digits only, so `+390000000000`, `390000000000`, and `whatsapp:+390000000000` are the same number. Every skipped step of an inbound message is logged at info level as `ada inbound skipped stage=... reason=... sender=+39…1234` with a masked number.

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
- `decision`: `silent`, `brief` (the quiet-day brief), `batch`, `hold`, `dispatch`, `connect`, or `none`. `dispatchReason` carries `whatsapp_window_closed`, `batched_until_morning`, `dispatch_rejected`, `hooks_unavailable`, `retry_backoff`, `retries_exhausted`, and similar causes. A rejected dispatch still advances `lastCollectAt` (the collector is alive) but leaves the diff baseline in place and holds the plan for retry.

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

## WhatsApp read receipts

When Ada accepts an inbound Kapso WhatsApp message, she marks that WhatsApp message read. The lawyer sees the blue checks while Ada is working, instead of gray delivered checks until a later reply. Set `channels["kapso-whatsapp"].sendReadReceipts` to `false` to leave messages delivered.

## Memory

Memory is one file per WhatsApp number, and these tools read only the memory of the person asking. Read-only tools: `ada_memory_search`, `ada_memory_list`, `ada_memory_get`, `ada_memory_history`, `ada_todo_list`, `ada_todo_get`. Every page except lawyer-global preferences requires a `matterId`. Search is case-insensitive substring match on aliases, title, and id. The daily reconcile writes timeline notes and one-pagers; the answering turn never writes matter memory. The one write a turn can make is `ada_set_timezone`, which saves the time zone in the profile of the person asking.

## Deadline and hearing intake

Off by default. Set `plugins.entries.ada.config.deadlineIntake.enabled: true` to turn it on; with the flag off the collector, digest, and tools behave exactly as before.

On each collect pass Ada scans new Gmail and the next `horizonDays` of Calendar for hearings and deadlines on matters it already knows:

- Mail: subject, plain-text body, PEC messages (including the `postacert.eml` envelope), and the text of PDF attachments where it can be read without OCR. Italian and English phrasing, `dd/mm/yyyy`, `12 novembre 2026`, `November 12th, 2026`, ISO dates, times in 24-hour or AM/PM form, terms counted from receipt ("entro 30 giorni dalla notifica"), and postponements ("rinviata al ...") are understood. Dates that record the past ("depositata il ...") or name another document ("sentenza del ...") are ignored, as are impossible dates.
- Calendar: events whose title says udienza, scadenza, hearing, deadline, and similar.

Each item is stored in `memory.sqlite` with the matter, type (`deadline` or `hearing`), due date and time in the number's time zone (Europe/Rome by default; all-day deadlines count until 23:59, hearings without a time default to 09:00), sources, and a confidence score. The same obligation from an email, a PDF, and a calendar event is one item, and a dismissed item is not revived by a later copy. A postponement notice or a moved calendar event moves the item and carries over the lawyer's choice. An item the lawyer never answers is offered in at most three digests (always while it is due within 48 hours) and stays visible through `ada_deadline_list`. Items below `minConfidence` (default 0.6) and dates in the past are dropped. Mail about matters without an alias is ignored.

The morning digest lists upcoming items with a number and invites a reply in plain words (for example "Rispondimi con 1 se vuoi che avvii la ricerca su Lexroom, o dimmi se preferisci saltare la 1"); it teaches no command or keyword. The model reads any natural reply, looks up the current numbers with `ada_deadline_list`, and calls `ada_deadline_reply`:

- a yes or the number runs Lexroom research for that matter, confirms tracking, and the brief is texted back in the same turn;
- `track` confirms tracking without research; `brief` resends the stored brief without calling Lexroom; `dismiss` and `done` close the item.

Reminders come only after the lawyer confirms an item. They ride in the morning digest at 07:40 on the number's own clock on the day of each step in `deadlineIntake.reminders` (default `7d`, `2d`, `morning-of`; `Nd` counts calendar days before the due date). Steps whose time had already passed when the lawyer confirmed are skipped. If the WhatsApp window is closed, the reminder waits with the held digest, and when several steps pile up only the latest is sent. Deadline lines and their reply numbers are rebuilt from matter memory on every pass, including when a held or retried digest is finally sent, and the numbers are recorded only once that digest is delivered.

Known limits: a cancelled or deleted calendar event does not end an item (reply `dismiss`), mail is scanned once per message, and PDFs without a text layer (scans) are read from the email body only.

Until the lawyer replies, intake is read-only. It sends no email and does not touch the calendar; email replies keep the existing `ada_send_email` confirmation. The flow is described in `skills/ada-deadline-intake`.

| Option                         | Default                      | Meaning                                                   |
| ------------------------------ | ---------------------------- | --------------------------------------------------------- |
| `deadlineIntake.enabled`       | `false`                      | Turn intake, digest lines, reply tools, and reminders on. |
| `deadlineIntake.reminders`     | `["7d", "2d", "morning-of"]` | Reminder cadence for confirmed items.                     |
| `deadlineIntake.horizonDays`   | `60`                         | How far ahead the calendar is scanned.                    |
| `deadlineIntake.minConfidence` | `0.6`                        | Drop extractions scored below this.                       |

## Renamed from Vera

Ada was called Vera, and she always presents herself as Ada: every turn's system prompt starts with a persona line saying so (`src/persona.ts`), and `src/no-vera.test.ts` fails if the old name reaches the model or users anywhere else (tools, skills, messages, PDFs, and the workspace files the boot script rewrites). Existing deployments keep working: `VERA_*` variables are still read, the stores stay in `$OPENCLAW_STATE_DIR/vera/` (table names and token encryption contexts included), and the HTTP routes answer on both `/ada/...` and `/vera/...`. The plugin id is `ada` and the tools are `ada_*`. See `deploy/railway/README.md#renamed-from-vera` for the Railway steps and the variables worth renaming.
