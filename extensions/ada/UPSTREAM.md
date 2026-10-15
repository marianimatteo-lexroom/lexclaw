# Ada and upstream OpenClaw

How this fork relates to `openclaw/openclaw`, what it costs to keep in sync, and
two ways forward: extract Ada into a standalone `@lexroom/ada` package
(recommended), or keep merging upstream once a month (fallback).

Measured on 2026-10-14 against `openclaw/openclaw` `main`.

## Where the fork stands

| Fact                    | Value                                                    |
| ----------------------- | -------------------------------------------------------- |
| Fork ahead of upstream  | 19 commits, all Ada, docs, or deploy notes              |
| Fork behind upstream    | 3,698 commits                                            |
| Deployed image          | `openclaw/openclaw:2026.9.9` plus an Ada bundle         |
| Latest upstream release | `2026.10.3` (npm `latest`); `2026.10.5-beta.3` is `beta` |
| Files the fork changed  | 60 files, almost all under `extensions/ada/`            |

Files changed outside `extensions/ada/`:

- `package.json`: one line, `"!dist/extensions/ada/**"` in `files`.
- `pnpm-lock.yaml`: the 10-line importer entry for `extensions/ada`.
- `docs/plugins/plugin-inventory.md`, `docs/plugins/reference.md`,
  `docs/plugins/reference/ada.md`: generated plugin reference pages.
- `PROGRESS.md`: handoff notes.

### Dry-run merge into upstream `main`

A scratch merge of `HEAD` with upstream `main` (`2026.10.3`) produced:

- One textual conflict: `docs/plugins/reference.md` (a generated plugin count).
  Taking upstream's version resolves it.
- `package.json` and `pnpm-lock.yaml` merged without conflict, but
  `pnpm install --frozen-lockfile` then failed: upstream moved `typebox` to
  `1.3.35` and Ada still pins `1.3.34`. Changing the pin in
  `extensions/ada/package.json` and running `pnpm install --lockfile-only`
  fixed it.
- After that fix, `pnpm test extensions/ada` passed on the merged tree:
  18 files, 77 tests, about 35 seconds.

So the merge itself is cheap today. The cost is that it has not been done for
3,698 commits, and the deployed runtime is an image that is one release behind
the tree Ada was built and tested against.

## Is the plugin SDK published to npm?

Not as its own package. Details, checked against the npm registry:

- `@openclaw/plugin-sdk` returns 404. In this repo it is the private workspace
  package `packages/plugin-sdk` (`0.0.0-private`).
- The SDK ships inside the `openclaw` package. `openclaw@2026.10.3` exports 344
  `./plugin-sdk/*` subpaths. `2026.9.9` and `2026.10.2` are published too.
  dist-tags: `latest` `2026.10.3`, `beta` `2026.10.5-beta.3`,
  `extended-stable` `2026.8.35`.
- The plugin docs (`docs/plugins/building-plugins.md`) describe
  external plugins that depend on `openclaw` as a peer dependency, declare
  `openclaw.compat.pluginApi`, and install with `openclaw plugins install`.
  Plugin APIs are documented as experimental (`docs/plugins/compatibility.md`):
  pin one host version and test each version you declare compatible.

Gaps that matter for Ada. Ada imports `plugin-entry`, `tool-plugin`,
`sqlite-runtime`, `sqlite-worker-runtime`, `plugin-state-runtime`, and, in tests
only, `test-env` and `plugin-test-api`:

1. `sqlite-runtime`, `sqlite-worker-runtime`, and `plugin-state-runtime` are
   exported with a `default` condition only. There is no `types` condition, so
   TypeScript cannot see their types from the published package.
2. `test-env` and `plugin-test-api` are not in the published exports at all.
   Two Ada tests (`google-account.test.ts`, `memory.worker.test.ts`) use
   `useAutoCleanupTempDirTracker`, and `index.test.ts` uses
   `createTestPluginApi`.
3. Ada's SQLite workers cannot resolve a bare `openclaw/*` import when the
   plugin is installed outside the OpenClaw package. `importOpenClawSdk` in
   `src/google-account.worker.ts` (and its siblings) works around that by
   resolving from the image's `openclaw.mjs`. This must be re-proven on the
   stock image for a packaged install.

## Plan A (recommended): standalone `@lexroom/ada` on the stock image

Goal: Ada lives in its own repository, builds to JavaScript against a pinned
published `openclaw` version, and runs on an unmodified upstream image. The fork
goes away.

### 0. Before extraction (in this fork)

- Land `.github/workflows/ada-ci.yml` so Ada has a test gate.
- Align `typebox` with upstream (`1.3.35`) so the first merge installs cleanly.
- Move `Dockerfile` and `start.sh` out of the `PROGRESS.md` snippets into version
  control (a `deploy/` directory in the new repo). Today they exist only as text.

### 1. What moves

New repository, for example `<org>/ada`, created with history:

```bash
git clone <fork-url> ada-extract && cd ada-extract
git filter-repo --subdirectory-filter extensions/ada
```

| Moves to the new repo                                                               | Stays or is deleted with the fork                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------- |
| `index.ts`, `index.test.ts`, `src/`, `skills/`, `openclaw.plugin.json`              | Everything else in the upstream tree                |
| `README.md`, this file (rewritten for the new layout)                               | `package.json` `!dist/extensions/ada/**` line      |
| Deploy assets: `Dockerfile`, `start.sh`, redeploy and env sections of `PROGRESS.md` | Lockfile importer, generated plugin reference pages |

`PROGRESS.md` deploy content becomes the new repo's runbook. Keep secrets and
infra identifiers out of it, as today.

### 2. Package metadata

`package.json` in the new repo (versions are illustrative; pin to the host
release you deploy):

```json
{
  "name": "@lexroom/ada",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist", "openclaw.plugin.json", "skills", "README.md"],
  "dependencies": { "typebox": "1.3.35" },
  "peerDependencies": { "openclaw": ">=2026.10.3" },
  "devDependencies": { "openclaw": "2026.10.3", "vitest": "5.0.1", "esbuild": "<pin>" },
  "openclaw": {
    "extensions": ["./index.ts"],
    "runtimeExtensions": ["./dist/index.js"],
    "compat": { "pluginApi": ">=2026.10.3" },
    "install": { "minHostVersion": ">=2026.10.3" },
    "build": {
      "openclawVersion": "2026.10.3",
      "pluginSdkVersion": "2026.10.3",
      "workerEntries": [
        "./dist/src/google-account.worker.js",
        "./dist/src/lexroom-account.worker.js",
        "./dist/src/memory.worker.js"
      ]
    }
  }
}
```

Rules:

- **SDK version pin.** `devDependencies.openclaw` is an exact version equal to
  the image tag in `Dockerfile`. They change together in one PR. The peer range
  and `compat.pluginApi` state the oldest host Ada was tested on; raise them
  only after testing. Do not use a caret range for the dev pin.
- Keep `typebox` in `dependencies` at the version the host uses. Anything the
  runtime imports must be in `dependencies`, not `devDependencies`.
- Check `workerEntries` against the built paths. The in-repo values point at
  `.ts` sources today.
- Drop `private`. Publishing stays private (step 6).

### 3. Close the SDK gaps

- **Types.** Preferred: ask upstream to add `types` conditions for the three
  runtime subpaths. Meanwhile add `src/openclaw-sdk-runtime.d.ts` with
  `declare module` blocks for only the symbols Ada uses (the
  `sqlite-worker-runtime` and `plugin-state-runtime` names imported in the
  `*.worker.ts` files, plus the `sqlite-runtime` helpers). Keep it small and
  re-check it on each SDK bump.
- **Test helpers.** Replace `test-env` with a local temp-directory tracker
  (create in `beforeEach`, remove in `afterEach`). Replace `createTestPluginApi`
  with a local stub that implements only what `index.test.ts` calls. Both are
  under about 50 lines.
- **Test runner.** Use `vitest` directly with Node 24 (`node:sqlite` is required).
  The repo's `pnpm test` wrapper does not exist outside the monorepo.
- **Typecheck.** Add a `tsc --noEmit` step. It is the only automatic signal that
  an SDK bump changed a type Ada uses, and it replaces the monorepo's boundary
  checks.

### 4. Build

Use the esbuild recipe from `PROGRESS.md`, moved into `pnpm build`:

- Bundle `index.ts` and each `src/*.worker.ts` to `dist/` as ESM for Node 24.
- Mark every `openclaw/plugin-sdk/*` import external; the host provides them.
- Emit the worker files at the paths `workerEntries` declares, next to the entry,
  because the plugin resolves workers relative to its own entry URL.

### 5. Pack and prove the install shape

```bash
pnpm build && npm pack --pack-destination /tmp
# in a container from the pinned stock image:
node openclaw.mjs plugins install npm-pack:/tmp/lexroom-ada-0.1.0.tgz --force
node openclaw.mjs plugins inspect ada --runtime --json
```

Acceptance for the first release:

- The plugin loads, registers its 14 tools and the wake service, and serves
  `/ada/google/callback` and `/ada/lexroom/connect`.
- The three SQLite workers start (the `importOpenClawSdk` fallback works in the
  packaged layout).
- Plugin files are owned by `root:root`; a `node`-owned copy is rejected as
  suspicious ownership.
- A WhatsApp round trip and one digest or wake pass work on a staging volume.

### 6. Distribution

Ada contains Lexroom-specific logic, so do not publish it to public npm or
ClawHub. Recommended: a CI job builds the package on a version tag and attaches
`lexroom-ada-<version>.tgz` plus its SHA-256 to a GitHub Release. The image
build downloads it with a build-time token and verifies the checksum. A private
npm scope on GitHub Packages also works but needs an npm token inside the build.

### 7. Deploy change

The runtime flow already installs from a directory at boot, so the change is
small:

```dockerfile
FROM docker.io/openclaw/openclaw:2026.10.3@sha256:<digest>
USER root
ARG ADA_VERSION
ARG ADA_SHA256
# download the release tarball, verify ADA_SHA256, then:
RUN mkdir -p /opt/lexroom/ada \
 && tar -xzf /tmp/ada.tgz -C /opt/lexroom/ada --strip-components=1
COPY start.sh /opt/lexroom/start.sh
RUN chmod 755 /opt/lexroom/start.sh && chown -R root:root /opt/lexroom
ENTRYPOINT ["tini", "-s", "--"]
CMD ["/opt/lexroom/start.sh"]
```

- `start.sh` is unchanged: `plugins install /opt/lexroom/ada --force` runs at
  boot because the state volume hides anything installed at build time.
- The image jumps from `2026.9.9` to `2026.10.3`. Snapshot the Railway volume
  first. Upgrade state migrations run on the existing volume at first boot, and a
  rollback to the old image may not be able to read migrated state. Rolling back
  the plugin alone is safe (redeploy with the previous `ADA_VERSION`).
- Environment variables, domain, and volume mount do not change.
- Confirm after boot: `GET /healthz`, the plugin list, a WhatsApp reply, and the
  Google and Lexroom connect links.

### 8. Ongoing CI in the new repo

- PR gate: build, typecheck, tests, `npm pack` install smoke on the pinned image.
- Nightly, non-blocking: the same suite against the `openclaw` `latest` and
  `beta` dist-tags. This replaces the upstream-sync workflow and gives early
  warning of SDK drift.
- Bump PRs (Renovate or a small script) change the `openclaw` dev pin,
  `Dockerfile` tag, `compat.pluginApi`, and `build.*Version` together.

### 9. Cutover and rollback

1. Build `@lexroom/ada@0.1.0` from the extracted repo and deploy it to staging
   on the current `2026.9.9` image first, to separate packaging problems from
   the host upgrade.
2. Deploy the same package on `2026.10.3` to staging, then production.
3. Keep the fork readable for 30 days, then archive it. Remove the
   `extensions/ada` lockfile importer and generated docs only if the fork is
   kept as a mirror.
4. Rollback at any step: redeploy the previous image and `ADA_VERSION`; restore
   the volume snapshot if the host upgrade was the problem.

### Risks

| Risk                                                         | Mitigation                                                 |
| ------------------------------------------------------------ | ---------------------------------------------------------- |
| SDK subpaths change between releases (APIs are experimental) | Exact pin, nightly canary against `latest` and `beta`      |
| Missing published types for three runtime subpaths           | Local `.d.ts` now, upstream `types` conditions later       |
| Worker SDK resolution outside the OpenClaw package           | Keep `importOpenClawSdk` fallback; test the packed install |
| Private distribution plumbing                                | GitHub Release asset plus checksum                         |
| Host upgrade migrates volume state                           | Volume snapshot before first `2026.10.x` boot              |

## Plan B (fallback): merge upstream monthly

Use this until Plan A ships, or if extraction stalls.

- Automation: `.github/workflows/upstream-sync.yml` runs every Monday and on
  demand. It merges upstream into `upstream-sync/<date>`, runs
  `pnpm install --frozen-lockfile` and `pnpm test extensions/ada` on the merged
  tree, then opens a PR, or an issue that lists the conflicts or failures.
  It uses only `GITHUB_TOKEN`.
- Cadence: one merge a month, onto a stable release tag rather than `main`. Run
  the workflow manually with `upstream_ref` set to a tag such as `v2026.10.3`.
  The scheduled run follows `main`, so close its PR if you prefer to stay on tags.
- Repository setting, once: Settings > Actions > General > "Allow GitHub
  Actions to create and approve pull requests".
- `GITHUB_TOKEN` cannot push changes to `.github/workflows`. The job restores
  this fork's workflow directory in the merge commit and drops upstream's. If
  GitHub still rejects the push, the job opens an issue and the merge is done by
  hand (the issue lists the commands).
- PRs opened with `GITHUB_TOKEN` do not trigger other workflows, so the Ada
  tests that gate the PR are the ones the sync job ran. Re-run `Ada CI` by
  closing and reopening the PR if you want a second check.
- Merge, never squash or rebase, so the next sync sees shared history.

Conflict policy:

| Path                             | Resolution                                                 |
| -------------------------------- | ---------------------------------------------------------- |
| `docs/plugins/*` generated pages | Take upstream, then regenerate with the repo docs script   |
| `pnpm-lock.yaml`                 | Take upstream, then `pnpm install --lockfile-only`         |
| `package.json` `files` list      | Keep both; the Ada exclusion line is the only fork change |
| `extensions/ada/**`             | Keep ours; fix any SDK drift in Ada, not in `src/`        |
| Anything else                    | Take upstream; the fork should not own it                  |

After a merge:

1. Align `extensions/ada/package.json` pins (for example `typebox`) with the
   merged lockfile.
2. Bump the deploy image tag to the release the tree now matches, snapshot the
   volume, and redeploy the bundle built from the merged tree.
3. Update `PROGRESS.md` with the new version.

Plan B's recurring cost is the merge, the image bump, and re-bundling by hand.
Plan A removes all three.
