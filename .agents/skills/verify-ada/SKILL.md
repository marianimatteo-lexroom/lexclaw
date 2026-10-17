---
name: verify-ada
description: Advisory verification of Ada's Lexroom integration (login, silent re-login, timeouts, structured failures, research-as-a-job, research link). Runs checks against a checked-in mock Lexroom, plus one real research query when live credentials are set. Use after changing extensions/ada Lexroom code or before trusting a Lexroom-related PR. Never blocks a merge.
---

# Verify Ada's Lexroom integration

Warn-only, by Matteo's standing decision (2026-10-17): nothing in lexclaw blocks a merge.
Every script here exits 0 and reports findings. Do not wire it into a required check or any
workflow, and do not let a red result stop work. Read it, then decide.

**Surface:** the Lexroom calls Ada makes (`extensions/ada/src`): the sign-in (`POST /v1/login`, which now answers 403 `auth0_login_required`, then the headless web flow through app.lexroom.ai and Auth0 Universal Login, or the optional password-realm `/oauth/token`),
`GET /v1/user/modules`, `GET /v1/credits`, `POST /v1/ask_me_anything`, on top of the typed client
from #43. **Not covered:** the gateway, Kapso, WhatsApp delivery, Google, drafting
(`/v2/ai/drafting`). Those need their own skill.

## Launch

Needs Node 24+ (`nvm install 24` if the shell has 22; the repo engine is `>=24.16`) and
`pnpm install` once. Nothing else: the mock starts inside the run, on a random loopback port, and
each check gets its own temp state dir with a real Ada SQLite account store.

```bash
.agents/skills/verify-ada/scripts/run.sh            # all mock checks, then the live step if creds are set
.agents/skills/verify-ada/scripts/run.sh --no-live  # mock checks only (about 20 s)
.agents/skills/verify-ada/scripts/run.sh --only relogin   # checks whose id starts with this
.agents/skills/verify-ada/scripts/run.sh --live-only
.agents/skills/verify-ada/scripts/run.sh --json     # machine-readable report on one line
```

Ready means the run printed `ADVISORY: ...` and an `evidence:` path.

## Doctor

```bash
.agents/skills/verify-ada/scripts/run.sh --doctor
```

Read-only: Node version, `node_modules`, the Ada files the checks import, and whether the live
credentials are set (yes/no only, never the values). Run it first if a run printed
`could not run` or `nothing was verified`.

## Drive

`scripts/verify.mts` loads Ada's real modules (`lexroom-login`, `lexroom-client`, `lexroom-tools`,
`lexroom-jobs`, `research-push`, `research-link-outbound`, `lexroom-account`) and calls them the way
the tools do. Ada keeps its production base URL; a `fetch` wrapper in `scripts/lib.mts` rewrites
`https://api.lexroom.ai` to the mock's loopback port, so every request crosses a real socket and the
web-app link (which Ada builds only for `lexroom.ai` hosts) is the production one. No Ada runtime
code is changed for testability.

| Check id            | What it proves                                                                                                                                                                                                                                            | Past failure it guards          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `login.ok`          | legacy `POST /v1/login` gets 403 `auth0_login_required`, then the exact web-flow sequence (login, identifier, password, resume, callback, session) ends with the mock's bearer; with a client secret set, only `POST /oauth/token` plus `GET /v1/credits` | #43 contract                    |
| `login.failures`    | wrong password, MFA, captcha, blocked account, missing token, 500 and unusable pages on every path (legacy, web, `/oauth/token`) are `ok:false` with a reason, never an exception                                                                         | the 401, 502, 403 connect chain |
| `login.timeouts`    | stalled and silent steps of every login path end as `reason: timeout` at the limit                                                                                                                                                                        | unbounded calls                 |
| `research.ok`       | answer, sources, research id and `https://app.lexroom.ai/research/<id>` from the recorded stream                                                                                                                                                          | #43 contract                    |
| `research.timeouts` | ask stalled after one line, ask silent, modules silent: all `reason: timeout`                                                                                                                                                                             | unbounded stream                |
| `research.failures` | 401 is `not_connected`; 403 is not (names the 403); 500, malformed, empty are `ok:false`; bad modules list degrades to the catalog                                                                                                                        | 403 read as a lost sign-in      |
| `relogin.auto`      | a rejected bearer is renewed once from the saved password and the ask retried; an expired bearer is renewed before the first call; the new bearer and the password are saved                                                                              | auto re-login                   |
| `relogin.edges`     | 403 keeps the sign-in and never re-logs in; wrong password and MFA clear the account and say `not_connected`, captcha keeps it; no saved password does not call login; a stalled re-login is `timeout` and keeps the account                              | account loss, hangs             |
| `job.polling`       | `ada_research` returns an `rj_` handle in under 1.5 s while the research takes about 2 s; status reads running, then done with the link; unknown handle is `unknown_job`                                                                                  | #38 research as a job           |
| `job.stall`         | a stalled Lexroom ends the job as `failed`/`timeout`                                                                                                                                                                                                      | unbounded job                   |
| `link.appended`     | a final reply without the link gets it appended once; the next reply does not; a reply with the link is untouched; blocks and `NO_REPLY` are untouched; `message_sending` is the fallback                                                                 | #36 to #37                      |
| `push.per-sender`   | two numbers ask at once: each gets its own ack while it runs, then its own result with the link last; the other cannot read the job; group chats push nothing                                                                                             | #38 to #39                      |
| `secrets.no-leak`   | the saved password and every issued bearer are absent from Ada's logs and the mock request log                                                                                                                                                            | secrets in logs                 |

### The mock

`scripts/mock-lexroom.mts` serves the checked-in fixtures in `extensions/ada/src/test-fixtures`
(`lexroom-login*.json`, `lexroom-user-modules.json`, `lexroom-credits.json`,
`lexroom-ask.ndjson`) and, for the sign-in, the Auth0 pages in `auth0-*.html`. Like the real API it needs a bearer it issued (the web flow and `/oauth/token` issue a fresh one every time), so a stale token really gets a 401. The test harness maps `https://app.lexroom.ai` and `https://auth.lexroom.ai` onto `/__host/<host>/...` of the mock so Ada keeps its production URLs; the mock's Auth0 pages are fixtures plus modeled error markup, not a live Auth0. Run it by hand to point a gateway at it:

```bash
node --import ./scripts/tsx.mjs .agents/skills/verify-ada/scripts/mock-lexroom.mts --port 18765 [--mode normal] [--route /v1/login=401]
```

Modes, global (`*`) or per path: `normal`, `slow` (stream over ~2 s), `stall` (headers and first
line, then nothing), `silent` (never answers), `401`, `403`, `500`, `mfa`, `wrong_password`, `captcha`, `blocked`, `no_token` (sign-in only),
`malformed` (200, unusable body), `empty`. Control endpoints: `POST /__mock/config`
(`{"mode":"*","routes":{"/v1/login":"401"},"revokeTokens":true}`), `GET /__mock/requests`,
`POST /__mock/reset`. The request log records method, path, mode, bearer valid/unknown/none, client
type and body keys, never values.

## Live step

One real login (whatever path Ada takes) and **one** real research query per run (`runResearch`, no retries, fixed query
about the term for opposing an injunction). Matteo approved a real query for the `+verus` account.
It costs research credits, so run it deliberately.

Credentials come from the environment only. The repo had no existing env names for a Lexroom
sign-in (production signs in through the connect page; `ADA_LEXROOM_TIMEOUT_MS` is the only Lexroom
variable), so this skill defines:

| Variable                      | Meaning                                    |
| ----------------------------- | ------------------------------------------ |
| `ADA_VERIFY_LEXROOM_EMAIL`    | sign-in email of the `+verus` account      |
| `ADA_VERIFY_LEXROOM_PASSWORD` | its password                               |
| `ADA_VERIFY_LEXROOM_BASE_URL` | optional; default `https://api.lexroom.ai` |

If either of the first two is unset the step prints an `ADVISORY: live step skipped` message and
nothing real is sent. The output is masked: email as `s***@e***`, no bearer, no password, no phone
number, no answer text, research id cut to four characters; only counts, timings and status. Never
paste a credential into a command line, a file, a PR or a chat; export it in the shell session.

## Evidence

Each run writes `.artifacts/verify-ada/<timestamp>/report.txt` and `report.json` (gitignored, kept
after the run): per check the assertions, which passed, and for failures the reason. Proof standards:
checks call Ada's real code paths over real HTTP and a real SQLite store; the only stand-in is the
Lexroom server, which is the production boundary. They assert what the lawyer would see (a message
in the right number's inbox, a link in the reply, a handle, a structured failure) and side effects
(saved token, cleared account, request counts on the mock), not internals.

### Proving the checks can fail

```bash
.agents/skills/verify-ada/scripts/prove-catches.sh [--only <mutation-id>]   # about 3 minutes
```

Copies the Ada plugin to `extensions/.verify-ada-mutant-*`, reintroduces one past failure at a
time (link left to the model, link never marked ready, result to a fixed number, 403 as lost
sign-in, legacy login treated as a refusal, captcha page unrecognized, unbounded research calls, no auto re-login), runs the mock suite against each copy
and prints which check went red. The copy is deleted afterwards; your tree is untouched. If a
mutation prints `SKIPPED`, the code it edits moved: update `MUTATIONS` in `prove-catches.mts`.

## Cleanup

Nothing is left running: the mock lives inside the runner process and the runner calls
`process.exit` when done. Temp state dirs are removed per check. A mutant copy is removed in a
`finally`. If a run was killed, remove strays by name:
`rm -rf extensions/.verify-ada-mutant-* /tmp/verify-ada-*`. Evidence under `.artifacts/verify-ada/`
is kept on purpose.

## Helpers

| File                       | Use                                                     |
| -------------------------- | ------------------------------------------------------- |
| `scripts/run.sh`           | entry point, always exit 0 (shown above)                |
| `scripts/verify.mts`       | the runner: loads checks, writes evidence               |
| `scripts/checks.mts`       | the 13 checks; add one by appending a `CheckDefinition` |
| `scripts/mock-lexroom.mts` | the mock server, also runnable standalone               |
| `scripts/live.mts`         | the single live query                                   |
| `scripts/lib.mts`          | Ada loader, fetch redirect, sandbox, masking            |
| `scripts/prove-catches.sh` | failure-class replay                                    |

Feature map: [features/README.md](features/README.md). Keep it honest as Ada changes.

## Limits

- Fixtures replay shapes captured once; a Lexroom API change shows up only in the live step.
- The mock cannot reproduce Lexroom's real latency, 502s from a proxy, or MFA enrollment.
- The `#37`/`#39` checks drive the hook handler and `startAdaResearch` directly with a fake
  WhatsApp sender, not a running gateway: they prove the code path, not the host's wiring
  (`requesterSenderId`, hook registration). Gateway-level driving is a separate skill.
- The live step covers login plus one research; drafting and the connect page are not exercised.
