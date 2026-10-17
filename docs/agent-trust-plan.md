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

Status: draft for review. Nothing in this plan has been adopted. Prototype results are placeholders until the three prototype draft PRs are folded in (see [Prototypes](#prototypes)).

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
| Private data re-leaks. [#15](https://github.com/marianimatteo-lexroom/lexclaw/pull/15) scrubbed personal data and infra IDs by hand over 3 files. Five references are back on `main` (values deliberately not reproduced here). Every task prompt repeats "never add personal numbers or IDs", which means nothing enforces it. | pitfalls report, transcripts |
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
| 9 (tie) | Private data and infra IDs committed, scrubbed, re-leaked | #15 scrub; 5 references back | 4 | 8 | CI: a denylist whose error names the placeholder |
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
| **One Lexroom contract owner**: a single module holds paths, headers, and Typebox request and response schemas. Every Lexroom call goes through it. Responses stop being `unknown` plus hand parsing. | Lexroom chain | Create the module and move the three sources of truth (the guess, web captures, the `lexroom-bot` client) into fixtures and a header snapshot. | Generate the schemas from a shared package that `lexroom-bot` and Ada both consume. |
| **One egress owner**: `AdaHttp.request({ service, url, timeoutMs, ... })` is the only way to call out, and `timeoutMs` is a required field. A caller signal can shorten the timeout but never replace it. | Unbounded calls | Wrap the three modules #35 fixed, then migrate the rest. | None needed. |
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
| `pnpm check:ada`: oxfmt check, oxlint, extension types for production and tests, coercion-helper and mock-export ratchets, madge import cycles, hook allowlist, then `pnpm test extensions/ada`. | The state of [#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39)'s head and of [#16](https://github.com/marianimatteo-lexroom/lexclaw/pull/16)'s head, with the exact lists above. | Each guard's existing message (they already name the fix). |
| Debt baseline: record today's counts, fail only on increases, burn down in later PRs. | Any PR that adds an error in a new or touched file, or raises a total. | The rule and the count delta. |
| `Ada CI` runs `check:ada`, and a repository ruleset requires it. | A merge before it finishes. | The failing check. |
| `check:no-private-ids`: a denylist file of identifier shapes (personal phone and email forms, infra IDs, custom domains), scanning the diff and the tree. | The tree before the #15 scrub and `main` today. | The placeholder to use (for example `+390000000000`, `<RAILWAY_PROJECT_ID>`). |
| `check:ada-egress`: global `fetch(` is allowed only inside the egress module and its adapters. | The unbounded call sites #35 found. | `use AdaHttp.request with timeoutMs`. |
| Generated-file drift: regenerate the manifest schema and README config table, then `git diff --exit-code`. | An edit to one of the 8 `answerTimeoutMs` locations. | `edit config.ts, then run the generator`. |
| Ratchet extension: new `vi.mock` of a module without `importOriginal`, and new `as unknown as` in tests. | Both are in the debt list. | The typed helper to use. |
| Post-deploy status check: the status endpoint added in [#20](https://github.com/marianimatteo-lexroom/lexclaw/pull/20) reports the running commit, compared with `main`. | A merge not yet deployed, or deployed from the wrong commit. | The deploy command. |
| Live Lexroom smoke: an opt-in command run by a human or a credentialed job after deploy. It is not part of the merge gate because it needs credentials. | The class of failure in #27, #28, #34. | Which call failed and with which status. |

Repo settings that need Matteo (agents cannot or should not change them): the ruleset that requires `check:ada`, and whether to stop treating the upstream `CI` workflow as a signal. The workflow fails on fork-environment jobs too (7 runs on `checks-node-core-tooling-*`, 6 on `checks-node-release-packed-*`, not root-caused), and red noise trains people to ignore red.

Exceptions go on the offending line with a reason, an expiry date, and a human's approval, per the `/correct` recipe. No blanket baselines.

### Layer 3: minimal prose

Prose is for judgment calls that nothing fails when skipped. Everything else belongs in layers 1 and 2. Keep it short and put a rule table first: each rule beside what enforces it. A rule with no enforcer is a repeat to fix at a higher level in the same change.

**`extensions/ada/AGENTS.md`** (new, about 40 lines). Contents:

- The rule table. Draft rows: "No private numbers or IDs in the repo" enforced by `check:no-private-ids`; "Every outbound call has a timeout" by the egress type and lint; "Lexroom wire shapes live in the contract module" by the module boundary and contract test; "Mandatory reply content lives in a hook" by the scenario test; "Config has one source" by generated-file drift.
- Judgment rules with no enforcer, kept short: WhatsApp replies are plain chat (no asterisks, emoji, em dashes or status cards) in the lawyer's language, usually Italian ([#9](https://github.com/marianimatteo-lexroom/lexclaw/pull/9)); never send mail or change the calendar without an exact-text confirmation; one sender never reads another's data ([#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39)); say plainly what was not verified live.
- Product rules moved out of `PROGRESS.md` (one agent per lawyer, silent reply exactly `NO_REPLY`, the model phrases only when `deliver: true`).
- Merge and deploy authority, stated once (see [Conflict note](#conflict-note-merge-and-deploy-authority)).

**Rules.** None beyond `extensions/ada/AGENTS.md`. The root `AGENTS.md` is upstream's and stays untouched, so a sync does not conflict.

**Skills.** Ada's existing `extensions/ada/skills/` are runtime skills for the product (digest, connect flows, deadline intake). Agent-development skills are different and go in `.agents/skills/` (the repo convention; `.claude/skills` points there). Two are worth adding, and only one is urgent:

1. `/create-verification-skill` for Ada, producing `.agents/skills/verify-ada/` (proposal below). This replaces the part of verification that Matteo does by hand today.
2. A small `/correct` loop note in the same `AGENTS.md`: when Matteo corrects a mistake, add the rule and its enforcer in the same change. No separate skill needed until the table has more than a screen of rules.

#### Proposal: `/create-verification-skill` for Ada

The recipe's skill interviews the repo, then generates a project-local skill that drives the real app and captures evidence. This is a proposal. Do not generate it until prototypes B and C land, because the mock Lexroom server they enable is the core of the Drive section. Findings from reading the repo (to be confirmed by the generator):

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
| 0. Prove it | The three prototype draft PRs: `check:ada` gate, private-ID denylist, Lexroom contract client with required timeouts. Each must fail on a real past mistake. | S, S, M | Each prototype's check fails on the named historical commit and passes on the PR head. | none |
| 1. Make green mean something | Merge `check:ada` and the baseline. Ada CI runs it. Matteo enables the ruleset. Add `check:no-private-ids`. Typed fetch-mock helper. | S each | `check:ada` is the single required status. Median time from open to merge is no shorter than the check time. Lint errors in `extensions/ada` stop rising, then fall from 103. Private-ID references on `main`: 5 to 0. | Phase 0 |
| 2. Remove the guessing | Roll the contract owner across every Lexroom call. Roll the egress owner across the other modules, with `check:ada-egress`. Config single source and drift check. One hook registration owner. | M each | Zero global `fetch(` outside the egress module. Zero Lexroom paths or header literals outside the contract module. Lexroom fix PRs per week fall to 0 over a few weeks. The 8-file `answerTimeoutMs` drift is impossible by construction. | Phase 1 |
| 3. Prose and verification | `extensions/ada/AGENTS.md` with the rule table. Delete `PROGRESS.md`. PR template. Generate `verify-ada` once the mock Lexroom server exists. Turn on review comments. | S, S, S, M, S | Every rule in the table names an enforcer. `verify-ada` reproduces the #37 and #39 failures on their parent commits. Live-found defects per merged PR fall (count from Matteo's pasted failures). | Phase 2 |
| 4. Strategic | Decide on extracting `@lexroom/ada`. Scenario harness. Split `index.ts` into feature modules each exporting tools, hooks and config schema. | L, M, M | Commits behind upstream is no longer a metric. "Merge origin/main" commits and `index.ts` touches per week fall. | Phases 1 to 3 |

Metrics to record at the start so progress is measurable (baseline from this document): 24/24 red PR runs, 103 Ada lint errors, 44 test type errors, 16 unformatted files, 5 private-ID references, 8 Lexroom fix PRs in 5 days, median merge 1.2 min against 7.5 min of Ada CI.

## Conflict note: merge and deploy authority

Matteo's older desktop sessions carry a standing rule: "always PR, merge to main and deploy Railway (if needed)" (agent run for #4 to #9, user turn 2139). Agents followed it and merged on their own. Several task prompts also grant per-task squash-merge authority.

That rule is **overridden for this work**. For everything in this plan, including the prototype PRs:

- Draft PRs only. No agent merges.
- No deploy.
- Nothing lands without Matteo's explicit say-so.

Once `check:ada` exists, the standing rule should be rewritten, not just kept or dropped: an agent may merge only when `check:ada` is green, the PR template is complete, and Matteo has approved that PR. Deploy stays a separate, explicit step. That rewrite is Matteo's decision and belongs in `extensions/ada/AGENTS.md`, not in a chat.

## Prototypes

Three draft PRs are being built in parallel. Each is a proof that one enforcement can fail on a real past mistake. None is merged, and none changes production behavior. Results are placeholders until the PRs are folded in.

| Prototype | Draft PR | What it must prove | Result |
| --- | --- | --- | --- |
| A. `check:ada` gate | TBD | Fails on the head of [#39](https://github.com/marianimatteo-lexroom/lexclaw/pull/39) ([run 38836224811](https://github.com/marianimatteo-lexroom/lexclaw/actions/runs/38836224811)) and on the first PR in the CI data ([#16](https://github.com/marianimatteo-lexroom/lexclaw/pull/16), commit [`5a3f69c`](https://github.com/marianimatteo-lexroom/lexclaw/commit/5a3f69c2641f)) with the lists in this document. Same command locally and in `Ada CI`. | TBD: command, baseline counts, historical failures reproduced, wall time. |
| B. Private-ID denylist | TBD | Fails on the tree before the [#15](https://github.com/marianimatteo-lexroom/lexclaw/pull/15) scrub and on `main` today. The error names the placeholder to use. The denylist file itself contains no real identifiers. | TBD: patterns, hits on each tree (counts only), false positives. |
| C. Lexroom contract client with required timeouts | TBD | Replaying the pre-#27 request shape is rejected. A header snapshot fails on #28's `X-Client-Type` removal. A call without `timeoutMs` does not compile. Stall tests: headers then nothing, nothing at all. | TBD: module surface, tests, what the fixtures prove, what is still unverified live. |

What the prototypes do not show, by design: a live Lexroom call (no credentials in the agent environment), a deploy, or an extraction of Ada.

Open questions for Matteo:

1. Is the ruleset requiring `check:ada` acceptable, and should the upstream `CI` workflow stop being treated as a signal?
2. Does the live service still set any `VERA_*` environment variables? That decides whether the fallbacks can be deleted.
3. Is extracting `@lexroom/ada` wanted, and if so before or after Phase 2?
4. Should Matteo or a credentialed job own the live Lexroom smoke?

## Evidence index

Source reports live in the agent project store and are not part of the repo:

- Review feedback mining: GitHub counts, indirect signals, PR body conventions.
- Steering transcripts: 19 runs, 125 user turns, mistake classes C1 to C7.
- Pitfalls from commits and CI: CI classification, per-class counts, prototype candidates A to J.

Reproduce the main numbers with `gh pr list --state all`, the Actions API for workflows `CI` (id 377866817) and `Ada CI` (id 385717804), and `gh api repos/marianimatteo-lexroom/lexclaw/pulls/N/commits`. Per-run lint, type and ratchet counts were parsed from job logs and are not kept in the repo.
