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
      "ada_granola_connect",
      "ada_granola_disconnect",
      "ada_granola_tools",
      "ada_granola_call",
      "ada_outlook_connect",
      "ada_outlook_read_inbox",
      "ada_outlook_read_message",
      "ada_outlook_draft_email",
      "ada_outlook_send_email",
      "ada_outlook_reply",
      "ada_outlook_read_calendar",
      "ada_outlook_create_calendar_event",
      "ada_outlook_update_calendar_event",
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

## Granola

Each person can connect their own [Granola](https://www.granola.ai) so Ada reads their meeting notes and transcripts: to answer questions about past meetings, summarize one, pull out action items, decisions and deadlines, and use the notes as context when drafting. Granola is read-only from Ada's side, and fails closed: she lists and calls only tools Granola marks `readOnlyHint: true`, or whose names start with a read verb (`get`, `list`, `search`, `query`, `find`, `read`, ...) and are not marked as writing or destructive, and refuses any other.

- **Design.** Ada talks to Granola's hosted MCP server (`https://mcp.granola.ai/mcp`, Streamable HTTP) with the person's own OAuth 2.0 token. There is no API key and no service account, and the Business-plan REST API is not used. The endpoints come from the server's own metadata (protected-resource metadata, then the authorization server's `/.well-known/oauth-authorization-server`), cached for an hour.
- **OAuth client.** Ada registers herself once by dynamic client registration (a public client, `authorization_code` plus `refresh_token`, scope `openid email profile offline_access mcp` (see below), redirect URI `<public origin>/ada/granola/callback`, derived from `googleRedirectUri`) and keeps the registration on the volume (`ada_granola_client`, the secret encrypted if Granola issues one). She registers again only when none is saved, when the redirect URI changed, when the secret expired, or when Granola answers `invalid_client`. Earlier registrations are kept, because the tokens issued to one are renewed with it, so a new origin never disconnects anyone; only a registration Granola itself forgot ends the sign-ins issued to it, and those numbers are asked to reconnect.
- **Scope.** Granola's resource metadata advertises `mcp`, but its authorization server lists only `openid`, `email`, `profile` and `offline_access`. Ada asks for `mcp` first. If the sign-in (`error=invalid_scope` on the callback) or the token step answers that the scope is invalid, that one link is replaced by a new one without `mcp`: the person is redirected straight into it and sees no failure, and nothing is remembered, so every other link still asks for `mcp` (the callback can be opened by anyone for their own link, so its answer never changes what other numbers get). A link that had already left `mcp` out gets no second try. At registration, `invalid_client_metadata` or `invalid_scope` makes Ada register again without `mcp`; only when that second registration succeeds does the process ask for the OpenID scopes alone (until restart), since the first error can have another cause such as the redirect URI. The scope a link asked for is kept with its pending row. Granola publishes no revocation endpoint, so disconnecting deletes the tokens and reports `revoked: false`. Endpoints read from metadata are used only when they are https on `granola.ai` or a subdomain.
- **Connecting.** In conversation, like Google: when someone mentions a meeting or their notes and Granola is not connected, Ada offers, and on a yes `ada_granola_connect` returns one short link `https://<origin>/gr/<code>`. It works once, expires after 30 minutes, and 302-redirects to Granola's own sign-in with PKCE (the verifier is stored encrypted with the pending row). The redirect comes back to `/ada/granola/callback` (or `/vera/granola/callback`), whose signed state names the number that asked for the link, and the tokens are saved for that number only. Ada then texts a confirmation, in the language of that number's latest message, to that number.
- **Staying connected.** The access token is renewed with the refresh token before it expires, one renewal at a time per number (Granola rotates refresh tokens, and the new one is saved), and a keep-alive in the 15-minute poll renews any token that would expire before the next poll, so an unused connection stays alive. A refresh that fails for any reason other than Granola voiding the consent (Granola down, a rate limit, a gateway page) keeps the sign-in and tries again. Only `invalid_grant` or `unauthorized_client`, or a registration Granola no longer knows, end the connection: the saved tokens are deleted and the number gets one text with a fresh link, at most one per 24 hours, in its latest language. If the WhatsApp window is closed or the send fails, the reminder stays owed in `ada_granola_reminder` (so a restart does not lose it) and goes out when that number next writes, for up to 72 hours.
- **Tools.** `ada_granola_tools` lists the tools this person's plan offers right now with their real argument schemas (nothing is hardcoded: `query_granola_meetings`, `list_meeting_folders` and the list, get and search tools are whatever Granola reports), and `ada_granola_call` calls one by name with arguments. Both act for the owner of the turn only, from the trusted sender, never from an argument. A result is text of at most 14000 characters; a longer one is cut at a line, reports `truncated`, `totalChars` and `nextOffset`, and the rest is read with `offset` from a five-minute in-process cache of that number's own result, so paging a long transcript does not fetch it again. A 401 renews the token once and repeats the call; a second 401 deletes that sign-in (unless the number reconnected meanwhile). Cached results are bound to the sign-in that fetched them.
- **Errors.** Granola's refusals are mapped to reasons the model explains naturally: `plan_limit` (the free plan reaches only the last 30 days, and some tools are paid-only), `tool_unavailable` (the plan lacks the tool, with the tools it has), `too_large` (HTTP 413 or an oversize message: ask for a narrower part or a question about the meeting), `invalid_request` (with the tool's schema), `not_connected` and `unavailable`. The classification reads Granola's error text (the plan first, then the size, then rate limits), so a message it does not recognize falls under `invalid_request`.
- **Disconnecting.** `ada_granola_disconnect`, called when the person says in any words that Ada should stop using or forget their Granola, asks Granola to revoke the token (when its metadata publishes a revocation endpoint), deletes the saved sign-in and pending links, and forgets cached results. Nothing in Granola is touched.
- **Memory.** Notes are not ingested into memory. The only write path is the existing `ada_set_preference`, for a specific fact the person asks Ada to remember. A deadline found in notes is reported; it is not added to the deadline-reminder flow, which stays fed by mail and calendar, and any email or calendar event still needs the usual confirmation.
- **Storage and deploy.** `granola-account.sqlite` is a new file beside the other account stores, with new tables only (`ada_granola_account`, `_client`, `_pending`, `_reminder`); nothing existing is altered. Access and refresh tokens, the client secret and the PKCE verifier are encrypted with the same `ADA_TOKEN_KEY`. No new environment variable or config key is needed: the redirect URI and the state secret derive from `googleRedirectUri` and `googleStateSecret` (or `lexroomConnectUri` and `lexroomStateSecret`), and the public origin must reach `/gr/*` and `/ada/granola/callback` like the other connect routes.

## Outlook account

Each person can connect their own Microsoft 365 or Outlook.com account (work or personal) so Ada reads their mail and calendar, saves drafts, sends mail and creates or edits calendar events only after they confirm, and includes Outlook in the morning brief and the urgent-item polls. It mirrors the Google integration: one short link per number, encrypted tokens, a permanent connection kept alive by the poll, and the same in-chat confirmation. It is off, and Ada never offers it, until the Entra app registration below is configured.

- **Design.** Microsoft identity platform v2, authority `common` (work, school and personal accounts) unless `ADA_MS_TENANT` names one, authorization code flow with PKCE (S256) from a confidential client, and Microsoft Graph (`https://graph.microsoft.com/v1.0`) for everything else. Delegated scopes: `offline_access openid email User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite`. A consent that comes back without one of `User.Read`, `Mail.ReadWrite`, `Mail.Send` or `Calendars.ReadWrite` is refused and the person is asked to approve everything.
- **Configuration.** `ADA_MS_CLIENT_ID` and `ADA_MS_CLIENT_SECRET` (a Railway secret) are read from the environment, with the pre-rename `VERA_MS_*` spelling as everywhere else; `ADA_MS_TENANT` is optional (default `common`; a tenant id, a verified domain, `organizations` or `consumers`). When either of the first two is unset or blank, or the tenant is malformed, the feature is off: no `ada_outlook_*` tool is built (so the model never sees one), the persona offers nothing, the poll reads nothing from Microsoft, and the callback answers "not configured". No plugin config key and no `start.sh` change is needed: the redirect URI and the state secret derive from `googleRedirectUri` and `googleStateSecret` (or `lexroomConnectUri` and `lexroomStateSecret`), and the public origin must reach `/o/*` and `/ada/outlook/callback`.
- **Connecting.** In conversation, like Google: when someone asks about email or calendar and mentions Outlook or Microsoft, Ada offers Outlook, and on a yes `ada_outlook_connect` returns one short link `https://<origin>/o/<code>` (10 random URL-safe characters). It works once, expires after 30 minutes, and 302-redirects to Microsoft's own sign-in with PKCE (the verifier is stored encrypted with the pending row, bound to the number). The redirect comes back to `/ada/outlook/callback` (or `/vera/outlook/callback`), whose signed state names the number that asked for the link (a key of its own, derived per purpose, so no Google, Lexroom or Granola state opens an Outlook link), and the tokens are saved for that number only. Ada then texts a confirmation, in the language of that number's latest message, to that number. A mailbox's address comes from Graph (`mail`, else the user principal name, else the id token).
- **Staying connected.** The access token (about an hour) is renewed with the refresh token before it expires, one renewal at a time per number (Microsoft rotates the refresh token on every use, and the new one is saved), and a keep-alive in the 15-minute poll renews any token that would expire within 20 minutes, so an unused connection stays alive indefinitely. A refresh that fails for any reason other than Microsoft voiding the consent (Microsoft down, a rate limit, a gateway page, or Ada's own client secret rejected, which is logged as `reason=misconfigured` and keeps every connection) keeps the sign-in and tries again. Only `invalid_grant`, `interaction_required`, `unauthorized_client` or an admin-consent failure end a connection: the saved tokens are deleted and the number gets one text with a fresh link, at most one per 24 hours, in its latest language. If the WhatsApp window is closed or the send fails, the reminder stays owed in `ada_outlook_reminder` (so a restart does not lose it) and goes out when that number next writes, for up to 72 hours. A Graph 401 renews the token once and repeats the call; a second 401 deletes that sign-in (unless the number reconnected meanwhile).
- **Admin consent.** In a tenant that only lets an administrator approve new apps, Microsoft answers `AADSTS65001`, `AADSTS90094` or `consent_required`, on the redirect or in the token exchange. The callback page then says plainly that the company's IT admin must approve the Ada app, Ada texts the same, and `ada_outlook_connect` returns `reason: "admin_consent_required"` instead of a new link that would fail the same way. The hold lasts 24 hours in this process and lifts when the person says the admin approved (`force: true`). An administrator can approve for the whole organization with `https://login.microsoftonline.com/organizations/v2.0/adminconsent?client_id=<ADA_MS_CLIENT_ID>&scope=https://graph.microsoft.com/.default&redirect_uri=https://<origin>/ada/outlook/callback`, which lands on a page telling them to return to WhatsApp.
- **Tools.** `ada_outlook_connect`, `ada_outlook_read_inbox` (the last two days, or a mailbox search with `query`), `ada_outlook_read_message` (one message in full as text), `ada_outlook_draft_email` (a draft in the Drafts folder; nothing is sent), `ada_outlook_send_email` and `ada_outlook_reply` (reply or reply-all on the thread), `ada_outlook_read_calendar`, `ada_outlook_create_calendar_event` and `ada_outlook_update_calendar_event`. All act for the owner of the turn only, from the trusted sender, never from an argument. Sending, replying, creating and editing return `confirmation_required` and touch nothing unless `confirmed` is exactly `true`, which the model sets only after the person agrees in the chat to that exact text or event. Event input is validated by the same code as Google's, new events use the person's time zone (Europe/Rome when unknown), guests can only be added, never removed, and nothing is deleted. Outlook itself emails guests an invitation or an update. Mail and calendar text is returned as data, never instructions.
- **Brief and polls.** Each pass reads the last two days of inbox (10 messages) and the next 72 hours of calendar from Outlook next to Gmail and Google Calendar, and merges them into one inbox and one calendar for the digest, the quiet morning brief and the urgent checks. Outlook ids are prefixed `outlook:` in the shared snapshots. A provider that fails for a moment keeps its earlier snapshot rows, so mail already seen is not announced again when it comes back. A number with only Outlook gets polls and the brief and is not asked to connect Google. Deadline and hearing intake still reads Gmail only.
- **Storage and deploy.** `outlook-account.sqlite` is a new file beside the other account stores, with new tables only (`ada_outlook_account`, `_pending`, `_reminder`); nothing existing is altered. Access and refresh tokens and the PKCE verifier are encrypted with the same `ADA_TOKEN_KEY`. Announcements accept `feature: "outlook"` and skip, for good, a number that already has Outlook connected.

### Entra app registration

Do this once, in the Microsoft Entra admin center (<https://entra.microsoft.com>) of the Lexroom tenant that will own the app:

1. **Register the app.** Identity, Applications, App registrations, New registration. Name it `Ada`. Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts**; this is what authority `common` needs. Redirect URI: platform **Web**, `https://vera.verus.legal/ada/outlook/callback`. Register.
2. **Second redirect URI.** Authentication, Add a platform or Add URI under Web: `https://vera.verus.legal/vera/outlook/callback`. Ada answers on both prefixes, as for the other callbacks (`/vera/google/callback`, `/vera/granola/callback`); only add it if you want the `/vera` alias to work. Leave implicit grant and hybrid flows off, and leave "Allow public client flows" at No.
3. **Permissions.** API permissions, Add a permission, Microsoft Graph, **Delegated permissions**: `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `User.Read`, plus the OpenID ones `offline_access`, `openid` and `email`. None of them is admin-only, so people can consent for themselves where their organization allows it. "Grant admin consent" for the home tenant is optional and does not cover other tenants.
4. **Client secret.** Certificates & secrets, New client secret. Copy the **Value** at once: that is `ADA_MS_CLIENT_SECRET`. The **Application (client) ID** on the Overview page is `ADA_MS_CLIENT_ID`. Secrets expire (24 months at most): put the expiry in a calendar and add a new secret before it ends. After it expires every refresh is refused, Ada logs `ada outlook refresh failed reason=misconfigured`, keeps the saved connections and recovers once the new secret is deployed.
5. **Publisher verification (needed for multi-tenant consent).** Branding & properties: set a **Publisher domain** you own, then complete publisher verification with your Microsoft Cloud Partner Program (MPN) account (Branding & properties, Add MPN ID to verify publisher). Since late 2020, most tenants block user consent to unverified multi-tenant apps, so people at other companies would see "Need admin approval" (`AADSTS65001` or `AADSTS90094`) instead of the consent screen. Personal Outlook.com and Hotmail accounts and Lexroom's own tenant are not affected. Tenants that restrict user consent to administrators still need their IT admin to approve the app, with or without verification (see Admin consent above).
6. **Railway variables.** Set `ADA_MS_CLIENT_ID`, `ADA_MS_CLIENT_SECRET` (as a secret) and, only to pin one tenant, `ADA_MS_TENANT`, then redeploy. Nothing else changes. Then ask Ada on WhatsApp about your Outlook mail to get the link.

## Token encryption

Google refresh and access tokens, Granola and Outlook tokens and the Lexroom password, bearer and refresh tokens are encrypted in SQLite with AES-256-GCM. Each value is bound to its table and column. Set `ADA_TOKEN_KEY` (the pre-rename name `VERA_TOKEN_KEY` is still read) to 32 random bytes as base64 or 64 hex characters:

```sh
openssl rand -base64 32
```

With `NODE_ENV=production` the account stores refuse to open without `ADA_TOKEN_KEY`, so set it before upgrading. Outside production a missing key leaves tokens in plaintext for local development. Rows saved before encryption are read as plaintext and re-written encrypted the first time the store opens with a key. Keep the key stable: losing it or changing it makes the stored tokens unreadable, and the lawyer reconnects Google and Lexroom from a fresh link. Keep it in the host's secret store, never in config files or git. When `ADA_TOKEN_KEY` is unset, Ada derives the key from the gateway's own `OPENCLAW_GATEWAY_TOKEN` (HKDF), so the credentials are still encrypted; setting `ADA_TOKEN_KEY` later, or rotating the gateway token, makes what was saved unreadable until the lawyer reconnects.

## Environment and config reference

| Name                         | Where         | Purpose                                                                                            |
| ---------------------------- | ------------- | -------------------------------------------------------------------------------------------------- |
| `ADA_TOKEN_KEY`              | environment   | AES-256 key for tokens at rest. Required in production. `VERA_TOKEN_KEY` still works.              |
| `ADA_MS_CLIENT_ID`           | environment   | Application (client) ID of the Entra app registration. Unset: Outlook is off.                      |
| `ADA_MS_CLIENT_SECRET`       | environment   | Client secret value of that app (secret). Unset: Outlook is off.                                   |
| `ADA_MS_TENANT`              | environment   | Optional. Tenant id, domain, `organizations` or `consumers`. Default `common`.                     |
| `ADA_WELCOME_ENABLED`        | environment   | `false` (also `0`, `off`, `no`) turns the first-message welcome off. Default on.                   |
| `ADA_ADMIN_TOKEN`            | environment   | Bearer token (16+ chars) for `/admin/feedback` and `/admin/announcements`. Unset: both return 404. |
| `googleNotifyAudience`       | plugin config | Audience of the Pub/Sub push OIDC token. Enables JWT verification.                                 |
| `googleNotifyIssuer`         | plugin config | Expected issuer. Defaults to `https://accounts.google.com` or `accounts.google.com`.               |
| `googleNotifyServiceAccount` | plugin config | Required `email` claim (verified) of the push subscription service account.                        |
| `googleNotifyToken`          | plugin config | Static Bearer fallback, 16+ chars.                                                                 |
| `statusToken`                | plugin config | Bearer token (16+ chars) for `GET /ada/status`.                                                    |

Plugin config values can reference environment variables, for example `googleNotifyAudience: "${ADA_GOOGLE_NOTIFY_AUDIENCE}"`.

## No signature

Ada never signs her messages: no "— Ada", "Ada" or "Ada · Lexroom" at the end, because the person already knows who answers. The persona and the skills that dictate a message say so. `start.sh` removes only the exact old persona sentence "Introduce yourself and sign off as Ada." from the workspace files on the volume, appends a marked "No signature" section to `SOUL.md` and `AGENTS.md`, and keeps a one-time `*.pre-nosig` backup. As a narrow safety net, `src/signature.ts` drops the last line of a model reply only when it is `— Ada`, `– Ada` or `—Ada`, optionally followed by ` · Lexroom` or `, Lexroom`, comes after a blank line and has text before it; a bare `Ada`, `*Ada*`, a hyphen signature or a name at the end of a list or draft is never touched. The legal disclaimer in the welcome and the `Continua su Lexroom` link line are not signatures and stay.

## Reply language

Ada replies in the language of the person's most recent message, in the model's turns and in every message sent by code. The persona (`src/persona.ts`) states this as a hard rule that overrides earlier messages, the profile language, memory, and the language of tool output and digest data. In code, `message_received` records the language of each WhatsApp number's latest message in memory (`recordInboundLanguage` in `src/research-link-outbound.ts`, the same stopword detection extended with hint words for short messages); a message that carries no language ("ok", a link, an emoji) keeps the previous one. The Lexroom and Gmail/Calendar connected confirmations, the research acknowledgement, result framing and failure notes, the morning digest, the Google connect ask and the held reconnect note, and the mailbox-moved note all use it, in Italian, English, Spanish, French and German. A number with no known message (for example after a restart) falls back to its profile language, then Italian. The welcome message, the digest-ready WhatsApp template (approved in one language) and the browser pages shown after connecting are not covered.

## Preferences and feedback

Ada adapts to each person without a code change. When someone says how they want her to work (style, length, tone, formality, language, emoji, signatures, how to address them, what the morning brief covers, what to alert on), in any words, the model calls `ada_set_preference` with a short topic `key` and one standing instruction as `text`, and confirms in one sentence in the person's language. `ada_forget_preference` removes one. There is no list tool: the saved preferences are already in the context of every turn, so "what do you remember about me?" is answered from them.

- **Storage.** The `vera_preferences` table (`key`, `text`, `updated_at_ms`) in the number's own `memory/<number>.sqlite`, so one number can never read or write another's. A key is lower-case words joined by underscores (at most 40 characters), a text is one flattened line of at most 300 characters, and at most 30 are kept: a new topic past the cap is refused with the list so Ada asks which to drop, while updating an existing key always works. Saving under an existing key replaces it, which is how a changed mind or a conflicting preference overwrites the old one; the tool description and the persona tell the model to reuse the key of the same topic from its context. The table is created with `CREATE TABLE IF NOT EXISTS` at startup; no existing table or row changes.
- **In the turn.** The `before_prompt_build` brief hook (`buildInjectedBrief` in `src/brief.ts`) puts a block headed "Standing preferences of this person" first in the injected context of every turn of that number. It says the preferences override Ada's default rules for style, length, tone, formality, emoji, signatures and format, and a language the person asked for replaces the follow-the-latest-message rule, but never safety, legal accuracy, or confirming with the person before sending mail, changing a calendar, drafting or starting research.
- **Code-sent messages.** The digest, the quiet-day brief, the connect asks and the research push are written by code from fixed per-language text, not by a model, so a free-text preference cannot reshape them. Two preferences map to structured settings that already exist: the time zone (`ada_set_timezone`), and the quiet-day brief, which is skipped on quiet mornings while the preference `quiet_brief_off` is saved (urgent digests are unaffected; forgetting the key turns the brief back on). The reply to a digest or a push is a normal model turn and follows every preference.
- **Product feedback.** A bug, a missing feature, a wrong answer or a complaint is recorded with `ada_report_feedback` (`category`: `bug`, `missing_feature`, `wrong_answer`, `complaint`, `other`; `text` of at most 1000 characters), and Ada tells the person in one sentence that she passed it to the team. Nothing is sent to anyone. One message can be both a preference and a report. Reports go to the `vera_feedback` table of the registry file `memory.sqlite` (`id`, `number`, `at_ms`, `category`, `text`, `language`, `status`); the registry is the one database that is not per number, and its feedback rows are left out of the copy the configured lawyer adopts from it.

### Reading the feedback log

The team reads the log over HTTP, because the Railway volume has no shell. The endpoint is disabled (404 for every request) until `ADA_ADMIN_TOKEN` is set to a token of 16 or more characters; then every request needs `Authorization: Bearer <ADA_ADMIN_TOKEN>`, compared in constant time, and a missing or wrong token gets 401. It is served at `/admin/feedback` and, like the other routes, under `/ada` and `/vera`.

```bash
curl -sS -H "Authorization: Bearer $ADA_ADMIN_TOKEN" "https://ada.example.com/admin/feedback?since=1760860000000"
curl -sS -X POST -H "Authorization: Bearer $ADA_ADMIN_TOKEN" -d '{"status":"triaged"}' https://ada.example.com/admin/feedback/12
```

`GET /admin/feedback` returns `{ "ok": true, "entries": [...] }`, oldest first, with the reports at or after `since` (milliseconds since the epoch, default 0; a bad value is a 400). Poll with the largest `atMs` you have seen and drop repeats by `id`. Each entry is `id`, `numberLast4`, `numberHash`, `at` (ISO time), `atMs`, `category`, `text`, `language` (or `null`) and `status` (`new` or `triaged`). The number is never returned in full: `numberLast4` is its last four digits and `numberHash` is the first 12 hex characters of a SHA-256 of it, the same for every report of one number, so reports can be grouped. The hash is a pseudonym, not a secret: phone numbers are a small space, so treat the token as the protection. `POST /admin/feedback/<id>` with `{"status":"new"|"triaged"}` sets the status and returns the entry (404 for an unknown id, 400 for a bad id or body). Responses are `no-store`.

### Offering to connect Lexroom

A number that has not connected Lexroom gets one gentle offer, on the turn that carries it. Code decides whether a turn may: it is the number's own turn (not a digest, cron or group run), the connect tool is available, Lexroom is not connected (a saved account, or the static token for the configured lawyer), no connect link sent earlier is still live, the number was not offered one earlier on its own local day (`lastConnectNudgeAtMs` on the wake state, compared in the time zone of the profile, Europe/Rome by default), and it did not decline in the last 7 days. When all hold, `before_prompt_build` adds a note headed "Offer to connect Lexroom" to that run (a retry of the same run gets it again, no other run does) and records the slot. The model decides whether the message is a legal question: if so it opens the reply with one or two short sentences in the language of the latest message (with Lexroom connected, answers are grounded in case law and doctrine research, with sources) and the short connect link from `ada_lexroom_connect`, or an offer to send it if that call fails, and then gives its full answer in the same reply, so the answer never waits on the offer; if not, it says nothing about Lexroom. It never tells anyone to type a phrase. The offer is also kept as a "Question you just asked" note for the number's next turn, which reads a yes (send the link, when the opening did not) or a no (`ada_set_preference` with key `lexroom_offer_declined`, whose time starts the 7-day pause; the brief does not list that key). The slot of the day is spent only when Ada really made the offer on that turn: she called `ada_lexroom_connect`, or the reply that went out (`message_sent`) carries Lexroom's short link or names Lexroom. A turn where the model said nothing about it, such as a greeting, leaves the offer for the next turn, and the next-turn yes/no note is only kept once it was made.

### Lexroom first for legal questions

Lexroom is always the preferred way for Ada to answer a legal question. While a number has Lexroom connected (a saved account, or the static token for the configured lawyer), the same `before_prompt_build` hook adds a note headed "Lexroom research first" to every one of that number's own turns (not cron, heartbeat or group runs, and only when `ada_research` is available to the turn). It tells the model to call `ada_research` before writing any answer to a legal question, with the question as `query` and the matter id (or `general`), and not to answer from its own knowledge first. `ada_research` runs in the background and Ada sends the researched answer with its sources herself, so the turn ends with `NO_REPLY` as the tool result says. Only when `ada_research` cannot start or returns an error or `timeout` does the model answer from its own knowledge, saying so in one short sentence and inventing no sources; a `not_connected` or `forbidden` result is a connection problem and follows the connect rules. A research that fails later, in the background, is reported by code with a short failure message and an offer to try again; Ada does not follow it with an answer from her own knowledge. The persona (system prompt), the `ada_research` tool description and the `SOUL.md` section `ada:lexroom-first` that `start.sh` appends to a volume's SOUL.md say the same. The note for a number without Lexroom is the offer above, never both.

### Unfinished connections

A number that was sent a connect link (Google, Lexroom or Granola) that ran out without the account being connected gets one gentle line at the end of its next reply, for that account only, once per account. Code decides: the link store of that account still holds a link for the number whose expiry has passed (`pendingExpiresAt` on the Google, Lexroom and Granola stores), the account is not connected, the connect tool is available to the turn, the preference `connect_reminded_<feature>` is not set (code writes it when the note is handed out), the person did not decline (`connect_declined_<feature>`, or `lexroom_offer_declined` for Lexroom), and, for Lexroom, this turn does not already carry the Lexroom offer. The same `before_prompt_build` hook adds a note headed "Unfinished connection": after answering fully, end with one short line in the language of the latest message saying the connection was not finished and offering a new link; no link until they say yes, no phrase to type, no signature. At most one account per turn, in the order Google, Lexroom, Granola. The next turn reads a yes (send a new link) or a no (`ada_set_preference` with the decline key). The `connect_*` preferences are state, so the brief does not list them.

### The host's no-summary text

When a tool-only turn ends with no text, the host sends its own English fallback ("The tool run finished, but no final summary was produced..."). `reply_payload_sending` and `message_sending` now catch it: nothing is sent when the run already sent text or a Lexroom research for that number is running or just ended (Ada sends that answer herself); otherwise it becomes a short line in the person's language.

### Repeated text

The same text from the same number, with a different message id, inside two minutes (compared ignoring case and spacing, using the time WhatsApp stamped on each message) is the same request sent twice, for example because the first answer was slow. The first copy is answered; the second is claimed in `before_dispatch`, before the host queues it behind the run still answering the first, so it gets no reply and no 👀 reaction, and the log says `ada inbound skipped stage=dispatch reason=duplicate_text`. Texts under 12 characters never count ("ok", "sì" answer different questions), a different text is always answered, and when the run for the first copy fails without an answer the number's repeat is answered. The same message id twice is the host's own duplicate check and is unchanged. The memory is kept in this process only.

## Fast Kapso webhook

`@kapso/openclaw-whatsapp` answers `POST /kapso/webhook` only when the whole turn is done, so a slow turn outlives Kapso's timeout and Kapso sends the webhook again (the retry then logs `cause=skipped:duplicate`). Ada cannot change that route, so it registers its own in front, `POST /ada/kapso/webhook` (and `/vera/kapso/webhook`), and the Kapso project is pointed at it:

1. It reads the raw body (at most 2 MB), checks `x-webhook-signature` (HMAC-SHA256 of the raw body, hex) against `KAPSO_WEBHOOK_SECRET` and the `webhookSecret` of the channel and its accounts, and answers 401 for a bad one, 400 for a body that is not JSON, and 503 when no secret is configured. An event other than `whatsapp.message.received` is answered 200 and dropped, as the plugin would.
2. It saves the request (raw body and the `x-webhook-*`, `content-type` and `user-agent` headers) in `$OPENCLAW_STATE_DIR/vera/kapso-inbound.sqlite`, through a SQLite worker. If that fails it answers 503 so Kapso sends it again.
3. It answers `200 {"ok":true,"queued":true}` and logs `ada kapso webhook accepted` with the masked sender and a row id, never the text.
4. A queue per sender hands the saved request to the plugin's own route in this same gateway (`http://127.0.0.1:<port>` plus `KAPSO_WEBHOOK_PATH`, default `/kapso/webhook`), with the original signature, so the plugin verifies it again and runs the turn exactly as before. Messages of one number are handed over one at a time in arrival order; different numbers run in parallel. A batch webhook belongs to the queue of its first sender.
5. The row is deleted when the plugin answers 2xx. A 4xx drops it; 408, 429, 502, 503, 504 and network errors are retried after 2, 5, 15, 45 and 120 seconds; other 5xx get one more try. After 12 failed attempts in total the row is dropped and logged as an error; after the last wait of one run it stays for the next start.
6. Ada's own reply to that number (a `message_sent` with a run id) marks the saved webhook as answered, so a restart or crash never hands an answered message over again; on shutdown a hand-off that is running is left to finish (only the waits between retries are cut), so the plugin's turn is not cut off and replayed. A restart also drops saved webhooks marked answered.
7. On start the service waits 3 seconds, then queues every saved row in id order, so a restart or crash replays what was acknowledged and not finished. A replay of a turn that had already begun is a second delivery of the same message id: the host's own duplicate checks and the repeated-text skip above keep it from being answered twice where they can.

The old `/kapso/webhook` URL keeps working unchanged, so nothing is different until Kapso is pointed at `/ada/kapso/webhook`, and pointing it back is the rollback. The gate never forwards to its own path.

## Announcements ("what's new")

Product news goes out through Ada herself, so it is part of the person's conversation. The team creates an announcement over HTTP; Ada then sends it once to every number she has a private WhatsApp conversation with (one per direct session of the channel) and writes the sent text into that number's session as an assistant message through the SDK's transcript runtime. A follow-up such as "sì" or "come funziona?" is therefore read in context. Nothing about the wording is hardcoded and no command is taught.

- **Dedupe.** The registry file `memory.sqlite` holds `vera_announcements` (`id`, `texts_json`, `feature`, `created_at_ms`) and `vera_announcement_deliveries` (primary key `announcement_id` + `number`, `status` `sent` or `skipped`, `reason`, `at_ms`). A delivery row is claimed in one transaction before the send, so two passes cannot both send, and it is released when the send fails. Both tables are left out of the copy the configured lawyer adopts from the registry.
- **24-hour window, free text only.** Text is sent only while the number's WhatsApp window is open (last inbound message under 24 hours ago, read from this process and the number's wake row; unknown counts as closed). Templates are never used. A number outside the window gets no row and stays pending.
- **Later delivery: right after the next answered message.** Ada's `message_sent` hook fires when her reply to a person has gone out; if that number is owed an announcement it is sent then, one announcement per answer (oldest first), so the news never lands before the answer and a number that was away is not handed a stack. This was chosen over appending to the morning brief because the brief only exists for numbers with Google connected and only on days it is sent; the next inbound message is the one moment every known number has an open window. A message received from the number cancels that wait, so the announcement never lands between two answers when Ada takes longer than the wait to reply; the next delivered message restarts it.
- **Language and signature.** The text is the number's latest-message language (the same `resolveLanguage` every code-sent message uses), the announcement's Italian text when it has none for that language, and a trailing "— Ada" is stripped.
- **Already connected.** An announcement with a `feature` (`granola`, `google`, `lexroom` or `outlook`) is skipped, for good, for a number that already has that account connected, so nobody is offered a link they do not need.
- **Opt-out.** The preference key `announcements_off` (set with `ada_set_preference` when the person says, in any words, that they do not want news; `ada_forget_preference` turns it back on) makes delivery skip that number for good.

The endpoint is `POST|GET /admin/announcements`, also under `/ada` and `/vera`, gated exactly like the feedback endpoint (404 until `ADA_ADMIN_TOKEN` is set, 401 without the bearer token).

```sh
# Who would get what, with nothing sent or saved
curl -sS -X POST -H "Authorization: Bearer $ADA_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"id":"granola-2026-10","feature":"granola","dryRun":true,"texts":{"it":"Novità: ora puoi collegare Granola. Vuoi il link?","en":"New: you can now connect Granola. Want the link?"}}' \
  https://ada.example.com/admin/announcements

# Save and deliver (the same body without dryRun)
curl -sS -X POST -H "Authorization: Bearer $ADA_ADMIN_TOKEN" -H "content-type: application/json" -d @announcement.json https://ada.example.com/admin/announcements

# Announcements with each number's delivery status
curl -sS -H "Authorization: Bearer $ADA_ADMIN_TOKEN" https://ada.example.com/admin/announcements
```

The body is `id` (a slug), `texts` (`it` and `en` required; `es`, `fr`, `de` optional, each at most 1500 characters), optional `feature` and optional `dryRun`. A dry run returns `recipients` with `status` `would_send`, `pending` (`window_closed`) or `skipped` (`announcements_off`, `feature_connected`) and the resolved `language` and `text` per number. Without `dryRun` the announcement is saved (201; an existing `id` is a 409 and is never overwritten) and delivered to the numbers inside their window while the response lists each number's outcome (`sent`, `skipped`, `pending` with `window_closed` or `send_failed`, and `recordedInHistory`). `GET` returns every announcement with `counts` and one row per number (`status` `sent`, `skipped` or `pending`, `reason`, `at`). Numbers appear as `numberLast4` and `numberHash`, the same pseudonym as the feedback log. The optional `exclude` list (E.164 digits, any spelling, at most 1000) marks numbers that were already told by hand as skipped with reason `excluded`: they get nothing, now or after a later message, even without a conversation yet. A dry run shows them as `skipped` / `excluded` and the response says how many were excluded (`excluded`), never the numbers.

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
| Granola sign-in (OAuth tokens), Ada's one Granola OAuth client     | `$OPENCLAW_STATE_DIR/vera/granola-account.sqlite`, encrypted                 | owner (row id); the client is shared    |
| Outlook sign-in (OAuth tokens), reconnect reminder state           | `$OPENCLAW_STATE_DIR/vera/outlook-account.sqlite`, encrypted                 | owner (row id)                          |
| Connect links in progress                                          | the four account files, one pending row per owner                            | owner and nonce                         |
| Matter memory, profile, todos, deadlines, digest state, held plans | one SQLite file per owner, `$OPENCLAW_STATE_DIR/vera/memory/<number>.sqlite` | the file name, so no query can leave it |
| Who was welcomed                                                   | the registry, `$OPENCLAW_STATE_DIR/vera/memory.sqlite`                       | number                                  |
| Research jobs, held results, research links                        | in the gateway process                                                       | owner                                   |

- **Connect links.** `ada_lexroom_connect` and `ada_google_connect` return a link whose signed state names the requesting number, expires after 30 minutes and works once. The link sent on WhatsApp is a short alias on the public origin, `/g/<code>` for Google, `/l/<code>` for Lexroom, `/gr/<code>` for Granola and `/o/<code>` for Outlook (10 random URL-safe characters), that 302-redirects to the full URL; it expires with the state, is dropped when the callback spends the state, and a new link for the same number replaces the old one. Codes live in the gateway process (at most 2000), so a restart makes links already sent answer with an Italian "link scaduto" page and the person asks Ada for a new one. Codes are never logged. The pending row names the same number, and completing the link saves the account for that number only, whoever opens it. The success page and the WhatsApp confirmation go to that number only.
- **Expired Google sign-ins.** When Google rejects a saved account (`invalid_grant`), it counts as not connected everywhere: the background pass and `ada_google_connect` drop the dead row, `ada_google_connect` issues a fresh signed link instead of answering "connected", and the background pass sends that number one plain note with the link ("Il collegamento al tuo Gmail è scaduto: ecco il link per ricollegarlo (vale 30 minuti)"). If the WhatsApp window is closed or the send fails, the note is held in memory for that number and goes out, with a link made at that moment, when the number next writes (a restart forgets it). Google's own `error_description` is logged with the failure, and a refreshed access token (and a rotated refresh token, encrypted as before) is saved back so the next pass does not refresh again.
- **Tools.** Research, drafts, `ada_read_inbox`, `ada_read_calendar`, `ada_send_email`, the deadline tools and the memory tools act for the owner of the turn. A tool the owner has not connected returns `not_connected` and Ada offers that person's connect link. The static `accessToken` in plugin config belongs to the configured lawyer (`channels["kapso-whatsapp"].defaultTo`) and to no one else.
- **Background work.** The 15-minute poll, the Gmail push route (which finds the owner by the mailbox) and the 07:40 slot (each number's own 07:40) visit every number that connected Google or Outlook, one pass each. The digest, the digest-ready template and the Google connect ask are sent by code to that number and no other; only the lawyer is asked to connect Google proactively. Research results and held results go to the number that asked. A number's WhatsApp window opens when that number writes.
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

Memory is one file per WhatsApp number, and these tools read only the memory of the person asking. Read-only tools: `ada_memory_search`, `ada_memory_list`, `ada_memory_get`, `ada_memory_history`, `ada_todo_list`, `ada_todo_get`. Every page except lawyer-global preferences requires a `matterId`. Search is case-insensitive substring match on aliases, title, and id. The daily reconcile writes timeline notes and one-pagers; the answering turn never writes matter memory. The writes a turn can make are `ada_set_timezone` (the time zone in the profile of the person asking), `ada_set_preference` and `ada_forget_preference` (their standing preferences, see [Preferences and feedback](#preferences-and-feedback)), and `ada_report_feedback` (a row in the shared feedback log).

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
