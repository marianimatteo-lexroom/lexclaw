---
title: "Agent trust plan for Ada"
sidebarTitle: "Agent trust plan"
summary: "Plan to make agent-written changes to the Ada plugin trustworthy by fixing the codebase first, then CI, then minimal prose, with human review last."
read_when:
  - You are about to change `extensions/ada` or its deploy path with an agent
  - You want to know which agent mistakes repeat and what enforces against each
  - You are deciding what to build next for agent trust in this fork
---

# Agent trust plan for Ada

Status: draft for review. Nothing in this plan has been adopted. Three prototype draft PRs exist ([#41](https://github.com/marianimatteo-lexroom/lexclaw/pull/41), [#42](https://github.com/marianimatteo-lexroom/lexclaw/pull/42), [#43](https://github.com/marianimatteo-lexroom/lexclaw/pull/43)); their results and limits are in [Prototypes](#prototypes). None is merged.

Goal: a change that looks right from one file is right for the whole repo, so a human spot-check at the end is enough. The method is the inverse pyramid from poteto's recipe. Work from the bottom up and spend the cheapest, most reliable lever first:

1. Codebase: one owner per responsibility, bad states unrepresentable.
2. Static analysis and CI: a check whose error names the fix, run locally and in CI as the same command.
3. Minimal prose: `AGENTS.md`, rules, skills, only for judgment calls nothing can enforce.
4. Human review: last, and aimed at what only a human can judge.

The unit of analysis is the agent that sees only the files it opened, copies the nearest example, and takes the shortest path that compiles.

## Sources and limits

- Repo: [marianimatteo-lexroom/lexclaw](https://github.com/marianimatteo-lexroom/lexclaw), a public fork of `openclaw/openclaw`. Ada (formerly Vera, renamed in [#31](https://github.com/marianimatteo-lexroom/lexclaw/pull/31)) is `extensions/ada`, plus `deploy/railway` and `PROGRESS.md`.
- **Zero GitHub review feedback exists.** All 39 PRs have 0 inline comments, 0 review threads, 0 formal reviews, 0 PR comments, 0 commit comments. Issues are disabled. A category count of "reviewer corrected X" is 0 in every class and is not used.
- Steering evidence therefore comes from Cursor agent transcripts: 19 runs mapped to PRs, 125 user turns. Only 87 of those turns (4 desktop runs) are typed by Matteo. The other 38 are orchestrator prompts that quote his decisions, so "he said X N times" applies to the 87 only.
- `marianimatteo-lexroom/lexclaw-private` does not resolve with the available token. It is not visible, so nothing from it is used.
- CI history starts 2026-10-14 13:01 UTC. Earlier PRs have no CI data.
- Branch protection could not be read (HTTP 403). `rulesets` is `[]`, so nothing indicates a required check.
- Counts of failing job classes are lower bounds: GitHub returned HTTP 502 for part of the jobs list on 5 of 24 failed PR runs.

## Headline findings

Numbers were re-checked against the GitHub API on 2026-10-17 unless marked otherwise.

| Finding | Evidence |
| --- | --- |
| 39 PRs in 9 days (2026-10-07 to 2026-10-16): 38 merged, 1 closed and replaced ([#8](https://github.com/marianimatteo-lexroom/lexclaw/pull/8) by [#9](https://github.com/marianimatteo-lexroom/lexclaw/pull/9)). All authored by Cursor agents. | `gh pr list` |
| Merge outruns every gate. For PRs #16 to #39 the median open-to-merge time is 1.2 min and 13 of 24 merged in under 5 min. `Ada CI` takes about 7.5 min ([run 38836224751](https://github.com/marianimatteo-lexroom/lexclaw/actions/runs/38836224751)). | PR `createdAt`/`mergedAt`, run timestamps |
| The broad `CI` workflow is red every time: 24 of 24 completed PR runs and 24 of 24 completed `main` push runs failed, 0 green (plus 13 skipped, 3 cancelled on PRs). | Actions API, workflow `CI` |
| The only gate that passes is `Ada CI`, and it only runs `pnpm test extensions/ada`: 10 of 10 completed runs passed (1 more cancelled). So "green" means tests, and format, lint, types and architecture guards are ignored. | Actions API, workflow `Ada CI` |
| Debt only grows. The last PR run, on [#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39)'s head, has 103 oxlint errors in `extensions/ada` (91 in tests), 44 test type errors, 16 unformatted files, 3 coercion-helper violations, an import cycle and an unlisted hook ([run 38836224811](https://github.com/marianimatteo-lexroom/lexclaw/actions/runs/38836224811)). Lint errors were 18 on the first PR in the data ([#16](https://github.com/marianimatteo-lexroom/lexclaw/pull/16)). | CI job logs (see [pitfalls report](#evidence-index)) |
| Agents rationalize the red. At least 14 PR bodies say remaining errors are "already on main" or "pre-existing" ([#16](https://github.com/marianimatteo-lexroom/lexclaw/pull/16), [#17](https://github.com/marianimatteo-lexroom/lexclaw/pull/17), [#34](https://github.com/marianimatteo-lexroom/lexclaw/pull/34) to [#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39) among them). The check they ran was "no new errors in touched files", which a new file always passes. | PR body search (regex, so a floor) |
| The Lexroom integration was guessed, then fixed repeatedly. 8 fix PRs in 5 days ([#13](https://github.com/marianimatteo-lexroom/lexclaw/pull/13), [#14](https://github.com/marianimatteo-lexroom/lexclaw/pull/14), [#27](https://github.com/marianimatteo-lexroom/lexclaw/pull/27) to [#30](https://github.com/marianimatteo-lexroom/lexclaw/pull/30), [#34](https://github.com/marianimatteo-lexroom/lexclaw/pull/34), [#35](https://github.com/marianimatteo-lexroom/lexclaw/pull/35)). Six of them landed within 18 hours on 2026-10-15. 10 PRs touch Lexroom auth or research reliability in total (those plus [#11](https://github.com/marianimatteo-lexroom/lexclaw/pull/11) and [#32](https://github.com/marianimatteo-lexroom/lexclaw/pull/32)). | PR titles, merge times, bodies |
| One fix broke the previous one. [#30](https://github.com/marianimatteo-lexroom/lexclaw/pull/30) states that [#29](https://github.com/marianimatteo-lexroom/lexclaw/pull/29)'s status probe wiped fresh sign-ins on a 403. #29 had listed that probe as an unverified assumption. | PR #29, #30 bodies |
| What fixed it was a known-good reference client, not more guessing. [#34](https://github.com/marianimatteo-lexroom/lexclaw/pull/34) (commit [`6a6b797`](https://github.com/marianimatteo-lexroom/lexclaw/commit/6a6b797746db)) mirrors the sibling `lexroom-bot` client and deleted more (-1,528) than it added (+890). | PR #34 |
| Prompt-only behavior failed in production, then moved into code. [#36](https://github.com/marianimatteo-lexroom/lexclaw/pull/36) told the model to end with a link. [#37](https://github.com/marianimatteo-lexroom/lexclaw/pull/37) records a finished research whose reply had no link, and appends it in a hook. [#38](https://github.com/marianimatteo-lexroom/lexclaw/pull/38) scoped the push to one number, and [#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39) widened it to the asking sender 12 minutes later. | PR bodies, merge times |
| Egress has no owner. [#28](https://github.com/marianimatteo-lexroom/lexclaw/pull/28) bounded research streams, and [#35](https://github.com/marianimatteo-lexroom/lexclaw/pull/35) then found the same unbounded-call hole in login, Google, Kapso and template modules. | PR #35 body |
| Private data re-leaks. [#15](https://github.com/marianimatteo-lexroom/lexclaw/pull/15) scrubbed personal data and infra IDs by hand over 3 files. A hand count found five references back on `main`. The shape-based check in [#41](https://github.com/marianimatteo-lexroom/lexclaw/pull/41) later found 28 findings in 9 files, a superset that may include acceptable fixtures (values deliberately not reproduced here). Every task prompt repeats "never add personal numbers or IDs", which means nothing enforces it. | pitfalls report, transcripts |
| The real verification loop is Matteo testing live and pasting the failure back. 30 of 39 PR bodies have an `Evidence` section, and 20 of 39 say something was "not run" or could not run live. | PR body counts, transcripts |
| Agents edit shared guards to fit their change. [#26](https://github.com/marianimatteo-lexroom/lexclaw/pull/26) adds Ada to a hook allowlist in a core test, and [#31](https://github.com/marianimatteo-lexroom/lexclaw/pull/31) edits a ratchet script so a rename stops looking like new assertions. | PR diffs |
| Guards agents can run locally do get honored. The line-cap and assertion ratchets are respected (agents moved code out of `index.ts` to stay under the cap). The failing guards are the ones no single command runs. | pitfalls report |

What is not a problem here, so it gets no work: Ada imports only `openclaw/plugin-sdk/*`, `node:*`, `typebox` and `vitest`; production code has 0 `as any`, 0 `@ts-*` and 0 lint suppressions; no flaky tests and no reverts were observed.

## Ranked pitfalls

Score is frequency (1 to 5) times cost (1 to 5). Cost is rework plus risk to the live WhatsApp and Gmail bot. Ranks use the commit and CI analysis, with the steering classes folded in.

| Rank | Pitfall | Measured frequency | Cost | Score | Primary fix level |
| --- | --- | --- | --- | --- | --- |
| 1 (tie) | Red CI ignored; merge waits for no gate | 24/24 PR runs and 24/24 `main` runs red; median merge 1.2 min | 5 | 25 | CI: one `check:ada` gate, required status |
| 1 (tie) | External API guessed, then a fix-after-fix chain (Lexroom) | 8 fix PRs in 5 days; 10 PRs on one area | 5 | 25 | Types and tests: one contract owner, recorded fixtures |
| 3 | No egress owner; timeouts are per module | 15 files touch fetch or timeouts; #35 found 3 unbounded modules; 6 hung research runs in production | 4 | 16 | Types: a required `timeoutMs`, plus a lint |
| 4 (tie) | Hand-synced duplicates: config keys, docs, hook allowlist, old names | `answerTimeoutMs` in 8 files; 222 `vera` references in 34 files after the rename | 3 | 12 | Architecture: one source of truth, generated projections |
| 4 (tie) | Behavior left to the model, then moved to code | 4 PRs ([#9](https://github.com/marianimatteo-lexroom/lexclaw/pull/9), #36 to #39) | 3 | 12 | Architecture and tests: a hook plus a scenario test |
| 4 (tie) | Stacked and parallel agent branches collide | 13 "Merge origin/main" commits; 14 commit SHAs reused across PRs; `index.ts` in 25 commits | 3 | 12 | Architecture: split the registration file |
| 4 (tie) | Fork lives in the monorepo and drifts from the deployed image | 3,698 commits behind upstream; one 10,655-file sync merged in 0.3 min ([#2](https://github.com/marianimatteo-lexroom/lexclaw/pull/2)) | 4 | 12 | Strategic: extract `@lexroom/ada` |
| 8 | Deploy path not checked in or not run, local state mistaken for deployed state | About 11 deploy or redeploy requests in the 4 desktop runs; the bot name lived only on the live volume | 3 | 9 (est.) | Architecture: one checked-in deploy command, plus a status check |
| 9 (tie) | Private data and infra IDs committed, scrubbed, re-leaked | #15 scrub; 5 references back by hand count, 28 findings in 9 files by the #41 check | 4 | 8 | CI: a denylist whose error names the placeholder |
| 9 (tie) | Test patterns copied from the nearest example | 91 of 103 lint errors and 44 of 46 type errors are in tests | 2 | 8 | Types: a typed fetch-mock helper |

Notes:

- Ranks 1 (Lexroom) and 3 share a root, no owner of external calls. They are one prototype track.
- Rank 8 comes from the transcript classes. Its frequency is an estimate from 87 typed turns, so treat the score as soft. Deploy assets were committed in [#20](https://github.com/marianimatteo-lexroom/lexclaw/pull/20), which already removed most of the cause.
- Verbosity ("don't be verbose, just tell me how to") and WhatsApp style preferences are real but low cost. They go in prose, not in this ranking.

## Target architecture by layer

"Cheap now" means a small, independent change that can be proven against a real past mistake. "Strategic" means a larger move that removes a root cause but needs a decision.

### Layer 1: codebase

| Change | Kills | Cheap now | Strategic |
| --- | --- | --- | --- |
| **One Lexroom contract owner**: a single module holds paths, headers, and Typebox request and response schemas. Every Lexroom call goes through it. Responses stop being `unknown` plus hand parsing. | Lexroom chain | Prototype in [#43](https://github.com/marianimatteo-lexroom/lexclaw/pull/43) covers login, modules and credits only. Research and draft calls (the NDJSON streams) still need migrating, and their existing fixtures need schemas. | Generate the schemas from a shared package that `lexroom-bot` and Ada both consume. |
| **One egress owner**: `AdaHttp.request({ service, url, timeoutMs, ... })` is the only way to call out, and `timeoutMs` is a required field. A caller signal can shorten the timeout but never replace it. | Unbounded calls | [#43](https://github.com/marianimatteo-lexroom/lexclaw/pull/43) makes `timeoutMs` required for the Lexroom login, modules and credits calls only. A generic owner for Google, Kapso and the rest, plus a `fetch(` lint, is still open. | None needed. |
| **Typed sender identity** carried end to end (the Kapso sender ID is a typed field), so per-sender scoping is a type error to forget. | #38 to #39 scoping miss | Add the type at the inbound boundary. | None needed. |
| **Mandatory outbound content in code**: one outbound hook owns "this reply must contain X". Skills stop describing it. | #36 to #37 | Already exists for the link. Make it the pattern. | A scenario harness (a scripted model driven through real tools and hooks) as a shared fixture. |
| **Config single source**: one Typebox schema in `config.ts`. The plugin manifest `configSchema`, the README config table and the deploy env list are generated from it. Nothing reads `process.env` outside it. | Hand-synced duplicates | Generate and diff-check the manifest and README table. | Remove the `VERA_*` env fallbacks once the deployed environment no longer sets them. This needs Matteo to confirm what the live service sets, so it is not assumed. |
| **One hook registration owner** (`registerAdaHooks(api)`) and `index.ts` reduced to composition. | Branch collisions, hook allowlist red | Extract the file. Add a single allowlist entry. | Key the core allowlist off manifest hook declarations so a plugin never edits a core test. |
| **Delete what agents copy**: `PROGRESS.md` duplicates PR bodies and git history (181 lines, edited in 16 commits). Old names and dead flows go. | Stale-example copying | Delete `PROGRESS.md` after moving its product rules (see Layer 3) to `extensions/ada/AGENTS.md`. | None needed. |
| **Typed test helpers**: `createFetchMock()` returns a typed mock with a `callsOf()` accessor, replacing copied untyped `vi.fn()`. | 91 test lint errors, 44 test type errors | Add the helper and migrate the worst files. | None needed. |
| **Extract Ada into `@lexroom/ada`**, built against a pinned published `openclaw` SDK equal to the deployed image. The plan is already written in `extensions/ada/UPSTREAM.md` (option 1). | Monorepo guard noise, upstream drift, core-test edits | Not cheap. Do not start before the contract and egress owners exist, because they define the package surface. | Yes: this is the strategic item. It trades the monorepo's inherited guards for a small lint and type config Ada owns, so Layer 2 must land first and move with it. |

The extraction decision belongs to Matteo. If it happens, the order above still holds: owners first, then the gate, then the move. Doing it first would carry the problems into a new repo.

### Layer 2: static analysis and CI

Principle: fail only when a change adds more, and make the error name the fix. One command, the same locally and in CI.

| Check | Fails on | Error names |
| --- | --- | --- |
| `pnpm check:ada`, first version in [#42](https://github.com/marianimatteo-lexroom/lexclaw/pull/42): six steps (oxfmt check, oxlint, production types, test types, core hook allowlist, tests). It runs every step and prints a per-step summary. Later steps to add: coercion-helper and mock-export ratchets, madge import cycles (cheap after #43 removes the `lexroom-client` cycle), package-boundary compile, `check:private-ids`. | The state of [#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39)'s head: shown on `main` at its merge commit (format, lint, types, test types, hook allowlist all red). Not shown on #16's head. | Each guard's existing message (they already name the fix). |
| Debt handling per step (not yet built): warn-only with an expiry, then a baseline ratchet, then zero. See [the debt decision](#debt-decision-warn-only-ratchet-or-pay-down). | Any PR that adds an error in a new or touched file, or raises a total, once a step leaves warn-only. | The rule and the count delta. |
| `Ada CI` runs `check:ada` on every PR and on pushes to `main`, with no path filter (so a required check never waits on a skipped workflow), and a repository ruleset requires the job `check-ada`. #42 does the workflow change. The ruleset is Matteo's. | A merge before it finishes. | The failing check. |
| `check:private-ids`, prototype in [#41](https://github.com/marianimatteo-lexroom/lexclaw/pull/41): shape-based rules (phone, WhatsApp ID, email, URL host, token, UUID, infra host), no real value embedded or printed. A standalone script, not a lint rule, because the leaks were in Markdown, tests, TOML and shell that oxlint does not see. | The tree before the #15 scrub (63 findings in 8 files) and `main` today (28 findings in 9 files). | A masked shape and the placeholder to use (for example `+390000000001`, `someone@example.com`). |
| `check:ada-egress`: global `fetch(` is allowed only inside the egress module and its adapters. | The unbounded call sites #35 found. | `use AdaHttp.request with timeoutMs`. |
| Generated-file drift: regenerate the manifest schema and README config table, then `git diff --exit-code`. | An edit to one of the 8 `answerTimeoutMs` locations. | `edit config.ts, then run the generator`. |
| Ratchet extension: new `vi.mock` of a module without `importOriginal`, and new `as unknown as` in tests. | Both are in the debt list. | The typed helper to use. |
| Post-deploy status check: the authenticated status endpoint added in [#20](https://github.com/marianimatteo-lexroom/lexclaw/pull/20) (`GET /ada/status`) is extended, if it does not already, to report the running commit, which CI compares with `main`. | A merge not yet deployed, or deployed from the wrong commit. | The deploy command. |
| Live Lexroom smoke: an opt-in command run by a human or a credentialed job after deploy. It is not part of the merge gate because it needs credentials. | The class of failure in #27, #28, #34. | Which call failed and with which status. |

Repo settings that need Matteo (agents cannot or should not change them): the ruleset that requires the `check-ada` job, and whether to stop treating the upstream `CI` workflow as a signal. The workflow fails on fork-environment jobs too (7 runs on `checks-node-core-tooling-*`, 6 on `checks-node-release-packed-*`, not root-caused), and red noise trains people to ignore red.

Exceptions go on the offending line with a reason, an expiry date, and a human's approval, per the `/correct` recipe. No blanket baselines.

#### Debt decision: warn-only, ratchet or pay down

Today `check:ada` is red on `main` in four of six steps ([#42](https://github.com/marianimatteo-lexroom/lexclaw/pull/42) measured format 16 files, lint 106 errors, 2 production type errors, 46 test type errors, plus the hook allowlist), and `check:private-ids` ([#41](https://github.com/marianimatteo-lexroom/lexclaw/pull/41)) is red with 28 findings. A required check that is red on `main` blocks every fix PR, including the ones that pay the debt down. The three options:

| Option | Good | Bad |
| --- | --- | --- |
| Pay down first, then require | Ends at zero with no tooling. Format, production types and the allowlist entry are small (format is an autofix, production types are 2 errors, the allowlist entry is in #42's second commit). | Lint (91 of 103 errors in tests) and test types need the typed fetch-mock helper and file-by-file work. Nothing is enforced while that happens. |
| Baseline ratchet (fail only on more than recorded) | Enforced from day one. Matches the repo's existing ratchets. Debt cannot grow. | Needs a small per-file counting script for lint and test types, because oxlint has no baseline mode. A baseline that is never lowered becomes the new normal. |
| Warn-only start | Lands immediately and shows the summary on every PR. Right for a brand-new step such as `check:private-ids`. | This is the failure mode the history shows: at least 14 PR bodies called red "pre-existing" and shipped. Warn-only without an end date recreates it. |

Recommendation, as a per-step mode rather than one global choice:

1. Land #42 with the steps that are already green or one fix from green as blocking: `tests`, `hook-allowlist` (after the allowlist entry), and, after one autofix commit, `format` and production `types`.
2. Start `lint`, `test-types` and `check:private-ids` as warn-only, each with an expiry date and Matteo's approval in the PR, per the exception rule above.
3. Replace warn-only with a baseline ratchet for `lint` and `test-types` as soon as the counting script exists, and burn the baseline down with the typed fetch-mock helper.
4. Clean up the 28 private-ID findings (Matteo decides which are real and which are acceptable fixtures), then make `check:private-ids` blocking and wire it into `check:ada`.
5. Require the `check-ada` job in the ruleset only when every step is blocking or on a ratchet. Requiring it earlier makes `main` unmergeable.

Pay-down and ratchet are not alternatives: the ratchet is the safety net while pay-down runs.

### Layer 3: minimal prose

Prose is for judgment calls that nothing fails when skipped. Everything else belongs in layers 1 and 2. Keep it short and put a rule table first: each rule beside what enforces it. A rule with no enforcer is a repeat to fix at a higher level in the same change.

**`extensions/ada/AGENTS.md`** (new, about 40 lines). Contents:

- The rule table. Draft rows: "No private numbers or IDs in the repo" enforced by `check:private-ids`; "Every outbound call has a timeout" by the egress type and lint; "Lexroom wire shapes live in the contract module" by the module boundary and contract test; "Mandatory reply content lives in a hook" by the scenario test; "Config has one source" by generated-file drift.
- Judgment rules with no enforcer, kept short: WhatsApp replies are plain chat (no asterisks, emoji, em dashes or status cards) in the lawyer's language, usually Italian ([#9](https://github.com/marianimatteo-lexroom/lexclaw/pull/9)); never send mail or change the calendar without an exact-text confirmation; one sender never reads another's data ([#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39)); say plainly what was not verified live.
- Product rules moved out of `PROGRESS.md` (one agent per lawyer, silent reply exactly `NO_REPLY`, the model phrases only when `deliver: true`).
- Merge and deploy authority, stated once (see [Conflict note](#conflict-note-merge-and-deploy-authority)).

**Rules.** None beyond `extensions/ada/AGENTS.md`. The root `AGENTS.md` is upstream's and stays untouched, so a sync does not conflict.

**Skills.** Ada's existing `extensions/ada/skills/` are runtime skills for the product (digest, connect flows, deadline intake). Agent-development skills are different and go in `.agents/skills/` (the repo convention; `.claude/skills` points there). Two are worth adding, and only one is urgent:

1. `/create-verification-skill` for Ada, producing `.agents/skills/verify-ada/` (proposal below). This replaces the part of verification that Matteo does by hand today.
2. A small `/correct` loop note in the same `AGENTS.md`: when Matteo corrects a mistake, add the rule and its enforcer in the same change. No separate skill needed until the table has more than a screen of rules.

#### Proposal: `/create-verification-skill` for Ada

The recipe's skill interviews the repo, then generates a project-local skill that drives the real app and captures evidence. This is still a proposal, but it can now be generated as a follow-up. See [Can it be generated now](#can-it-be-generated-now) for the how and the limits. Findings from reading the repo (to be confirmed by the generator):

| Section | What it should contain for Ada |
| --- | --- |
| Surface | A WhatsApp assistant behind Kapso. Users touch WhatsApp messages. The testable surface is the gateway: inbound webhook in, outbound Kapso and Lexroom and Google calls out, plus a status endpoint and `/healthz`. |
| Launch | The gateway started the way `deploy/railway/start.sh` starts it, but with an empty temp state directory, mock outbound hosts, and no real credentials. Ready means the health endpoint answers and the plugin reports registered tools and hooks, not only that a process is up. |
| Doctor | Read-only: process up, version matches the checkout, port owned by this run, config loads, no real credentials present. |
| Drive | Post a recorded inbound webhook payload and read the outbound payloads. Run a mock Lexroom server that can answer normally, send headers then nothing, and send nothing at all (the stalls behind #28 and #35). Replay the captured `ask.ndjson` and `draft.ndjson` fixtures. Feature files: morning digest, confirmed Gmail send, Lexroom research with link and per-sender ack and result, Lexroom connect, deadline intake, status reactions. |
| Evidence | The inbound payload, every outbound request (secret-redacted), the final WhatsApp text, and the log lines named in the task. Side effects checked too: rows written, nothing sent to a real host. A proof for "research reply has the link" must show the link in the final outbound text, not in a test double. |
| Isolation | Temp state dir and random port per run, so two runs do not share a volume. It must refuse to run against the live Railway instance. |
| Live tier | A separate, human-run section for the opt-in Lexroom smoke. It lists the credentials the human supplies and never reads them from the repo. |
| Cleanup | Kill only processes the run started. Keep evidence under a named directory. |

<a id="can-it-be-generated-now" />

**Can it be generated now?** Yes, as a scoped follow-up, not as a full-app skill. What [#43](https://github.com/marianimatteo-lexroom/lexclaw/pull/43) provides and what it does not:

| Input | State |
| --- | --- |
| Lexroom replies | Five synthetic fixtures (login, 401, MFA-required, modules, credits) plus the existing research and draft NDJSON fixtures (`lexroom-ask.ndjson`, `lexroom-draft.ndjson`, `lexroom-draft-get.json`). No real data. |
| Stall behavior | Unit tests already model "headers then nothing" and "nothing at all" with injected `fetch` (`lexroom-stall.test.ts`), and the new contract test checks a hung call ends at `timeoutMs`. |
| What is missing | The fixtures are canned replies fed to an injected `fetchImpl` in unit tests. There is no running mock server. A verification skill must drive the gateway the way a user does, so it needs a small local HTTP server that serves these fixtures (normal, stall, silent). The research and draft fixtures are not yet schema-checked, so they prove replay, not shape. |
| Can the gateway be pointed at mocks? | Lexroom: yes, `baseUrl` is a plugin config key. Kapso: yes, `KAPSO_BASE_URL` is read by the plugin. Google: no. The Gmail, Calendar and OAuth URLs are hard-coded constants in `google-api.ts` and `google-push-auth.ts`, so the digest and Gmail-send flows cannot be driven against a mock until an egress owner makes them overridable. |
| Does the gateway start locally from an empty state? | Not verified by this plan. `deploy/railway/start.sh` is the documented start path. The generator must prove it starts with a temp state directory and no credentials before it writes any step down. |

How to generate it:

1. Land #43 first (or stack the follow-up branch on it), so the fixtures and the typed client are on the branch the skill is generated against.
2. Write the mock Lexroom and Kapso server as a checked-in helper (a short script that serves the fixtures by path, with `normal`, `stall` and `silent` modes). The skill's Helpers section shows its exact invocation.
3. Run `/create-verification-skill` on that branch. Its interview should find the surface (WhatsApp through Kapso into the gateway), the run command (`start.sh` with a temp state directory), the drive (post a recorded inbound webhook, read outbound Kapso payloads), and the evidence (outbound payloads and the final WhatsApp text, secret-redacted). It writes `.agents/skills/verify-ada/` (the repo's skill location; `.claude/skills` points to it). The generator's default path is `.cursor/skills/`, so override it.
4. Seed the feature map with the Lexroom and Kapso flows only: research with link, per-sender ack and result, Lexroom connect and re-login, status endpoint. Leave digest, Gmail send and deadline intake as listed-but-not-drivable entries, each naming the blocker (hard-coded Google URLs).
5. Finish with the proof test below. Add `check:ada` as the last step of the skill's Evidence section once [#42](https://github.com/marianimatteo-lexroom/lexclaw/pull/42) lands.

Not covered even then: any live Lexroom, Google or WhatsApp behavior. That stays the opt-in smoke and Matteo's own test.

Success test for the skill: replaying the harness against the pre-#37 tree must show a final message with no link, and against the pre-#39 tree must show one sender receiving another's result. If it cannot reproduce those, it is not yet a verification skill.

### Layer 4: human review, last

By the time Matteo looks, layers 1 to 3 should have answered "does it compile, is it safe, did it follow the pattern." Review then covers what only a person can judge:

- Does this do what the lawyer needs, and is the WhatsApp wording right (the style he corrects most)?
- Is the confirmation gate still in front of every outbound side effect?
- Does the "not verified live" list match what he is about to rely on?

Changes to the process:

- **PR template** replaces the ad hoc sections agents already invent (`Evidence` in 30 PRs, `Assumptions (please check)` in 4, `How to verify` in 6): root cause, what changed, `check:ada` result, a "not verified live" list, how to verify live, env vars to set or delete.
- **Enable GitHub review for these PRs** so corrections land as comments. Today they live only in chats, which is why this plan had to mine transcripts. Each comment becomes input for the next `/correct` round.
- **Review is not the integration test.** Matteo currently finds Lexroom failures by running the bot (401, 502, 403, "link expired", then a missing link). The contract replay, mock stalls and live smoke exist so that stops being his job.
- **Independent review on large diffs.** A read-only review run already found 3 high-severity problems in the diff of [#23](https://github.com/marianimatteo-lexroom/lexclaw/pull/23) (for example, a long subject dropping a scan batch). Keep that for diffs over a size threshold, not every PR.

## Phased plan

Order matters more than dates. Effort is S (a few hours of agent work), M (about a day), L (multi-day, needs decisions).

| Phase | Work | Effort | Success metric | Depends on |
| --- | --- | --- | --- | --- |
| 0. Prove it | Done as drafts: [#42](https://github.com/marianimatteo-lexroom/lexclaw/pull/42) `check:ada` gate, [#41](https://github.com/marianimatteo-lexroom/lexclaw/pull/41) private-ID check, [#43](https://github.com/marianimatteo-lexroom/lexclaw/pull/43) typed Lexroom client with required timeouts. See [Prototypes](#prototypes) for what each did and did not prove. | S, S, M | Each prototype's check is shown on a real past state, with its limits stated. | none |
| 1. Make green mean something | Merge #42 (blocking steps first, the rest warn-only, per [the debt decision](#debt-decision-warn-only-ratchet-or-pay-down)). Merge #43, then add the madge step to `check:ada`. Matteo decides which of the 28 private-ID findings are real. Merge #41 as warn-only, then wire it into `check:ada` once clean. Typed fetch-mock helper. Per-file ratchet script for lint and test types. Matteo enables the ruleset on `check-ada` last. | S each, M for the ratchet script | `check-ada` is the single required status and `main` is green on it. Median time from open to merge is no shorter than the check time (about 4 min locally, lint is 157 s of that). Lint errors in `extensions/ada` stop rising, then fall from 106. Private-ID findings on `main`: 28 to 0. | Phase 0 |
| 2. Remove the guessing | Roll the contract owner across the remaining Lexroom calls (research and draft streams, with schemas for their fixtures). Roll the egress owner across the other modules, with `check:ada-egress`. Config single source and drift check. One hook registration owner. | M each | Zero global `fetch(` outside the egress module. Zero Lexroom paths or header literals outside the contract module. Lexroom fix PRs per week fall to 0 over a few weeks. The 8-file `answerTimeoutMs` drift is impossible by construction. | Phase 1 |
| 3. Prose and verification | `extensions/ada/AGENTS.md` with the rule table. Delete `PROGRESS.md`. PR template. Generate `verify-ada` as a follow-up once #43 lands (Lexroom and Kapso flows only; see [Can it be generated now](#can-it-be-generated-now)). Turn on review comments. | S, S, S, M, S | Every rule in the table names an enforcer. `verify-ada` reproduces the #37 and #39 failures on their parent commits. Live-found defects per merged PR fall (count from Matteo's pasted failures). | Phase 2 |
| 4. Strategic | Decide on extracting `@lexroom/ada`. Scenario harness. Split `index.ts` into feature modules each exporting tools, hooks and config schema. | L, M, M | Commits behind upstream is no longer a metric. "Merge origin/main" commits and `index.ts` touches per week fall. | Phases 1 to 3 |

Metrics to record at the start so progress is measurable (baseline from this document): 24/24 red PR runs, 103 Ada lint errors in CI (106 by the local gate, which adds 3 max-lines errors), 44 test type errors, 16 unformatted files, 28 private-ID findings in 9 files, 8 Lexroom fix PRs in 5 days, median merge 1.2 min against 7.5 min of Ada CI.

## Conflict note: merge and deploy authority

Matteo's older desktop sessions carry a standing rule: "always PR, merge to main and deploy Railway (if needed)" (agent run for #4 to #9, user turn 2139). Agents followed it and merged on their own. Several task prompts also grant per-task squash-merge authority.

That rule is **overridden for this work**. For everything in this plan, including the prototype PRs:

- Draft PRs only. No agent merges.
- No deploy.
- Nothing lands without Matteo's explicit say-so.

Once `check:ada` exists, the standing rule should be rewritten, not just kept or dropped: an agent may merge only when `check:ada` is green, the PR template is complete, and Matteo has approved that PR. Deploy stays a separate, explicit step. That rewrite is Matteo's decision and belongs in `extensions/ada/AGENTS.md`, not in a chat.

## Prototypes

Three draft PRs, each a proof that one enforcement works against a real past mistake. All three are drafts, none is merged, none changes production behavior, and none used live credentials. Numbers below are from each PR body and diff, read on 2026-10-17. I did not rerun them.

| Prototype | Draft PR | Size | CI on the PR |
| --- | --- | --- | --- |
| A. `check:ada` gate | [#42](https://github.com/marianimatteo-lexroom/lexclaw/pull/42) | 6 files, +133 / -13 | `check-ada` red (expected), `Labeler` red (missing App secret, unrelated) |
| B. Private-ID check | [#41](https://github.com/marianimatteo-lexroom/lexclaw/pull/41) | 4 files, +643 / -0 | `Ada CI` green (old workflow), `Labeler` red |
| C. Typed Lexroom client with required `timeoutMs` | [#43](https://github.com/marianimatteo-lexroom/lexclaw/pull/43) | 18 files, +460 / -160 | `Ada CI` green (old workflow), `Labeler` red |

### A. `check:ada` gate ([#42](https://github.com/marianimatteo-lexroom/lexclaw/pull/42))

What it is: `scripts/check-ada.mjs` runs six steps (oxfmt check, oxlint, production types, test types, core hook allowlist, tests), never stops at the first failure, prints a per-step summary and exits 1 if any failed. `Ada CI` now runs it as the job `check-ada`, on every PR and on pushes to `main`, with the path filter removed. A second commit adds the one trivial fix, the missing hook-allowlist entry for `research-link-outbound.ts`.

Evidence, run on `main` at the merge commit of [#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39) (`3ade8d9`), gate commit only:

| Step | Result | Matches the historical CI run |
| --- | --- | --- |
| format | 16 files | yes, 16 |
| lint | 106 errors (12 production) | 103 in CI; the 3 extra are `max-lines` errors CI catches through its line-cap ratchet |
| types | 2 errors (`index.ts`, `memory.worker.ts`) | yes, 2 |
| test-types | 46 errors (44 in tests plus the same 2) | yes, 44 plus 2 |
| hook-allowlist | `research-link-outbound.ts` unlisted | yes |
| tests | 55 files, 712 tests pass | `Ada CI` green |

Limits:

- It reproduces the failures at the head of #39, not at the head of [#16](https://github.com/marianimatteo-lexroom/lexclaw/pull/16). The first-PR claim in the plan is untested.
- It is red by design until the debt is paid. Four of six steps fail on `main`.
- About 4 min locally (lint alone is 157 s, mostly plugin-sdk type emit). The job timeout is 30 min. That is much slower than the median 1.2 min merge, so the gate only helps if merges wait for it.
- Left out to stay small: coercion-helper and mock-export ratchets, madge cycles, package-boundary compile. They are repo-wide scripts and need Ada-scoped filtering. After #43 removes the `lexroom-client` import cycle, the madge step is the cheapest to add.
- `check-ada` as a required status is not set. Rulesets are readable only with admin rights. `hook-allowlist` is a core-owned test, so an unrelated upstream hook change can turn it red.
- `pnpm check:workflows` was not run (needs a Python environment for the workflow linter). The PR's own `check-ada` run is the first real run of the workflow edit.

### B. Private-ID check ([#41](https://github.com/marianimatteo-lexroom/lexclaw/pull/41))

What it is: `pnpm check:private-ids` (`scripts/check-private-ids.mjs`, about 460 lines, no dependencies) scans tracked files on Ada's surface (`extensions/ada`, `deploy/railway`, `PROGRESS.md`, the Ada start test, the Ada workflow). Rules are by shape: phone numbers, WhatsApp IDs, emails, URL hosts outside reserved and public vendor domains, tokens, UUIDs, Railway hosts, Meta IDs. It embeds and prints no real value. Output is `path:line:col rule <masked shape> -> placeholder to use`. The allowlist file is empty on purpose, with a same-line `private-ids:allow` marker for one-offs. Placeholders (`example.*`, `.test`, low-entropy digits, word-like dummy tokens) pass without an entry.

Evidence:

| Tree | Result |
| --- | --- |
| `main` plus the PR (140 files, 0.2 s) | exit 1, 28 findings in 9 files: email 18, host 5, WhatsApp ID 3, phone 2, others 0 |
| Pre-scrub tree (parent of the #15 scrub commit) | 63 findings in 8 files, including 15 UUIDs, 2 Kapso-style IDs and 1 Railway host |
| Tests | 19 tests, about 2.1 s wall time, all synthetic values built from parts |

It re-finds the leak the hand count saw (the personal alias and the custom domain). The 28 are not all leaks: some emails are `<name>@<vendor domain>` in the `lexroom-*` tests, and one host is a negative-test hostname. Which are real is Matteo's call.

Limits:

- The check is red on `main` until someone cleans the 28 findings. The PR did not clean them, to stay small.
- Shape-based means false positives and misses. The `host` rule is the only one that sees a custom domain and needs a maintained public-domain list.
- A lint rule was ruled out: oxlint sees JS and TS syntax trees, and the leaks were in Markdown, tests, TOML and shell. The repo's existing `git-hooks/pre-commit` literal denylist only runs where `core.hooksPath` is set, which agent clones usually lack, so it cannot be the gate.
- Not wired into `check:ada`. That is the next step once both PRs land (see the debt decision above): add `pnpm check:private-ids` to `scripts/check-ada.mjs`, and widen the `Ada CI` triggers to include `PROGRESS.md`, `deploy/railway/**` and the Ada start test (moot if the path filter is removed as #42 does).
- Default surface is Ada-only, not `deploy/` as a whole or the root docs.

### C. Typed Lexroom client ([#43](https://github.com/marianimatteo-lexroom/lexclaw/pull/43))

What it is: a new `lexroom-api.ts`, the single owner of `POST /v1/login`, `GET /v1/user/modules` and `GET /v1/credits`. `timeoutMs` is a required field with no default. Replies are a union: `ok` (body checked against a Typebox schema), `http_error` (status, detail, code) or `unexpected_shape` (a 2xx body that fails the schema, logged as `<step>.unexpected_shape`). Headers, the ASCII-only JSON body and base URL normalization moved into it. `loginLexroomAccount` now requires `timeoutMs`, so the session and connect callers pass it explicitly. `LexroomLog` moved to its own file, which removes the `lexroom-client` and `lexroom-transport` import cycle. `lexroom-login.ts` is -97/+33, `lexroom-client.ts` went from 829 to 719 lines.

**Scope: only login, auth (credits probe) and modules are migrated.** The research and draft calls (`ask_me_anything`, drafts, the NDJSON streams) keep their guard-based timeouts, and their fixtures are not yet schema-checked. Google, Kapso, status reactions and deadline tools are untouched. Nothing stops a new module from calling `fetch` directly, so the generic egress owner and `fetch(` lint (pitfall rank 3) is still open.

Evidence:

| Check | Result |
| --- | --- |
| Type guard | A scratch file (not committed) with three wrong calls fails typecheck: missing `timeoutMs` on the client and on login, and an undeclared reply field. The same file written correctly passes. The committed `expectTypeOf` test fails if `timeoutMs` becomes optional. |
| Tests | `pnpm test extensions/ada --maxWorkers=1`: 56 files, 724 tests, 32 s. The new contract file alone: 12 tests, 1.4 s, fake timers, no sleeps. |
| Import cycles | `pnpm check:madge-import-cycles`: 0 cycles. |
| Types and lint | Production typecheck shows only the 2 errors already on `main`. Test typecheck (a different config from #42's) unchanged at 28 error lines before and after. No new lint findings in new or migrated files. |
| Contract fixtures | Five synthetic replies (login, 401, MFA-required, modules, credits) replaying the known-good `lexroom-bot` behavior from [#34](https://github.com/marianimatteo-lexroom/lexclaw/pull/34): exact method, URL, header set and ASCII body. |

Limits, as the PR states them and as I read the diff:

- The type stops a missing timeout and an undeclared field. It does not stop a wrong value (`timeoutMs: 1`), a schema that is itself a guess, or a caller that skips the module and calls `fetch`.
- The header test asserts the exact header set, so it would fail if `X-Client-Type` were dropped as in [#28](https://github.com/marianimatteo-lexroom/lexclaw/pull/28). That follows from the assertion. It was not run against #28's commit. The pre-#27 request shape was not replayed either.
- The fixtures are synthetic and encode what #34 observed. Nothing here calls live Lexroom. The `/v1/user/modules` schema is deliberately loose because only the string-array form is confirmed. If it were strict and wrong, modules would fall back to the full catalog, which is the old 403 trap.

### Cross-cutting results

- The three do not yet compose. #41 is not in `check:ada`. #42 leaves out the madge step that #43 makes passable. After all three land, `check:ada` would run seven or eight steps, and the wiring of #41 is a one-line change plus the cleanup.
- What the prototypes do not show, by design: a live Lexroom call (no credentials in the agent environment), a deploy, an extraction of Ada, or the required-status ruleset.
- #41 and #43 flag the conflict with Matteo's old standing rule and follow the draft-only rule here.

### Open questions for Matteo

1. Debt: take the per-step mode in [the debt decision](#debt-decision-warn-only-ratchet-or-pay-down) (blocking where green, warn-only with expiry where red, ratchet for lint and test types), or pay down everything before requiring `check-ada`?
2. Are `<name>@<vendor domain>` addresses in the `lexroom-*` tests acceptable fixtures (add the domain to the allowlist), or should they move to `example.com`? Who cleans the 28 findings?
3. Should the `host` rule stay, and should the surface grow to `deploy/` and root docs?
4. Can someone with Lexroom access paste a sanitized real `/v1/user/modules` reply so its schema can be strict? Should the login schema narrow from four token field aliases to one? Is reading the small credits body acceptable, or should the probe stay body-less?
5. Should the egress owner become generic (`AdaHttp` for Lexroom, Google, Kapso, and a `fetch(` lint), or stay Lexroom-only?
6. Is the ruleset requiring `check-ada` acceptable, and should the upstream `CI` workflow stop being treated as a signal? The `Labeler` job also fails on every PR for a missing App secret.
7. Does the live service still set any `VERA_*` environment variables? That decides whether the fallbacks can be deleted.
8. Is extracting `@lexroom/ada` wanted, and if so before or after Phase 2?
9. Who owns the live Lexroom smoke, Matteo or a credentialed job?

## Evidence index

Source reports live in the agent project store and are not part of the repo:

- Review feedback mining: GitHub counts, indirect signals, PR body conventions.
- Steering transcripts: 19 runs, 125 user turns, mistake classes C1 to C7.
- Pitfalls from commits and CI: CI classification, per-class counts, prototype candidates A to J.

Reproduce the main numbers with `gh pr list --state all`, the Actions API for workflows `CI` (id 377866817) and `Ada CI` (id 385717804), and `gh api repos/marianimatteo-lexroom/lexclaw/pulls/N/commits`. Per-run lint, type and ratchet counts were parsed from job logs and are not kept in the repo.
