#!/usr/bin/env node
// Proves the checks can fail: re-creates each past failure class in a throwaway copy of the Ada
// plugin and shows which check goes red. The working tree is never modified; the copy is removed
// afterwards. Always exits 0 (advisory).
//
//   scripts/prove-catches.sh [--only <mutation-id>]
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../..");
const adaDir = path.join(repo, "extensions/ada");

type Mutation = {
  id: string;
  recreates: string;
  file: string;
  from: string;
  to: string;
  /** Checks that must fail for the mutation to count as caught. */
  expect: string[];
};

const MUTATIONS: Mutation[] = [
  {
    id: "pre-37-link-left-to-model",
    recreates: "#36/#37: no code appends the research link, so the final WhatsApp reply has none",
    file: "src/research-link-outbound.ts",
    from: "  const missing: string[] = [];\n  for (const [url, markedAtMs] of ready) {",
    to: "  const missing: string[] = [];\n  ready.clear();\n  for (const [url, markedAtMs] of ready) {",
    expect: ["link.appended"],
  },
  {
    id: "pre-37-link-never-ready",
    recreates: "#36/#37: reading the finished job never tells the link hook there is a link to add",
    file: "src/lexroom-jobs.ts",
    from: "    markResearchLinkReady(url, now());",
    to: "    void url;",
    expect: ["link.appended"],
  },
  {
    id: "pre-39-result-to-fixed-number",
    recreates: "#38/#39: ack and result go to one configured number, not the sender who asked",
    file: "src/lexroom-tools.ts",
    from: "const recipient = onKapso ? senderNumber(params.requester?.senderId) : null;",
    to: 'const recipient = onKapso && params.requester?.senderId ? "390000000001" : null;',
    expect: ["push.per-sender"],
  },
  {
    id: "403-reads-as-lost-sign-in",
    recreates:
      "a 403 (missing module permission) treated as a rejected bearer: re-login and cleared account",
    file: "src/lexroom-client.ts",
    from: "    return new LexroomError(deniedMessage(detail, call.modules), undefined, http);",
    to: '    return new LexroomError(deniedMessage(detail, call.modules), "not_connected", http);',
    expect: ["relogin.edges", "research.failures"],
  },
  {
    id: "unbounded-login-and-gets",
    recreates:
      "modules and credits calls without a request limit: a silent Lexroom hangs them (login also has its own flow limit)",
    file: "src/lexroom-transport.ts",
    from: "      idleMs: params.timeoutMs,\n      totalMs: params.timeoutMs,",
    to: "      idleMs: 3_600_000,\n      totalMs: 3_600_000,",
    expect: ["research.timeouts"],
  },
  {
    id: "pre-48-legacy-login-only",
    recreates:
      "#48: the 403 auth0_login_required answer is read as a refusal, so the web sign-in never runs",
    file: "src/lexroom-login.ts",
    from: '      return "auth0_required";',
    to: '      return { ok: false, reason: "forbidden", error: "forbidden" };',
    expect: ["login.ok", "relogin.auto"],
  },
  {
    id: "pre-48-captcha-unrecognized",
    recreates:
      "#48: a captcha page on the Auth0 form is not recognized and reads as a wrong password",
    file: "src/lexroom-web-login.ts",
    from: '  if (/<div\\b[^>]*data-captcha-sitekey/iu.test(body) || /name="captcha"/iu.test(body)) {',
    to: "  if (false) {",
    expect: ["login.failures", "relogin.edges"],
  },
  {
    id: "unbounded-research-stream",
    recreates:
      "a research stream with no idle, answer or total limit: a stalled stream hangs the job",
    file: "src/lexroom-client.ts",
    from: "  const answerMs = positiveMs(input.config.answerTimeoutMs, lexroomTimeoutMs());\n  const guard = createGuard({ ...limits(input.config), answerMs, signal: input.signal });",
    to: "  const answerMs = 3_600_000;\n  const guard = createGuard({ idleMs: 3_600_000, totalMs: 3_600_000, answerMs, signal: input.signal });",
    expect: ["research.timeouts", "job.stall"],
  },
  {
    id: "no-auto-relogin",
    recreates: "a rejected bearer is reported instead of renewed from the saved password",
    file: "src/lexroom-tools.ts",
    from: '  if (first.ok || first.reason !== "not_connected" || resolved.source !== "account") {',
    to: "  if (true) {",
    expect: ["relogin.auto"],
  },
];

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

function copyAda(id: string): string {
  const dest = path.join(repo, "extensions", `.verify-ada-mutant-${id}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(adaDir, dest, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
  fs.symlinkSync(path.join(adaDir, "node_modules"), path.join(dest, "node_modules"));
  return dest;
}

function runChecks(dir: string, only?: string): { failed: string[]; timedOut: boolean } {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      ".agents/skills/verify-ada/scripts/verify.mts",
      "--no-live",
      "--json",
      ...(only ? ["--only", only] : []),
    ],
    {
      cwd: repo,
      env: { ...process.env, VERIFY_ADA_DIR: dir },
      encoding: "utf8",
      timeout: 15 * 60_000,
    },
  );
  const line = result.stdout.split("\n").findLast((l) => l.startsWith("{"));
  if (!line) {
    throw new Error(`no report from the runner: ${result.stderr.slice(0, 300)}`);
  }
  const report = JSON.parse(line) as { checks: Array<{ id: string; status: string }> };
  return {
    failed: report.checks.filter((c) => c.status === "fail").map((c) => c.id),
    timedOut: result.error !== undefined,
  };
}

const rows: string[] = [];
let caught = 0;
const selected = MUTATIONS.filter((m) => !only || m.id === only);
try {
  if (!only) {
    const baseline = runChecks(adaDir);
    rows.push(
      `baseline (unmodified tree): ${baseline.failed.length === 0 ? "all checks pass" : `FAILING: ${baseline.failed.join(", ")}`}`,
    );
  }
  for (const mutation of selected) {
    const dir = copyAda(mutation.id);
    try {
      const file = path.join(dir, mutation.file);
      const source = fs.readFileSync(file, "utf8");
      if (!source.includes(mutation.from)) {
        rows.push(
          `${mutation.id}: SKIPPED, the code this mutation edits has moved (update prove-catches.mts)`,
        );
        continue;
      }
      fs.writeFileSync(
        file,
        source.replace(mutation.from, () => mutation.to),
      );
      const { failed } = runChecks(dir);
      const missed = mutation.expect.filter((id) => !failed.includes(id));
      const ok = missed.length === 0;
      caught += ok ? 1 : 0;
      rows.push(
        `${ok ? "CAUGHT" : "MISSED"}  ${mutation.id}\n        recreates: ${mutation.recreates}\n        red checks: ${failed.join(", ") || "none"}${ok ? "" : `\n        expected but green: ${missed.join(", ")}`}`,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
} catch (error) {
  rows.push(
    `ADVISORY: catch proof could not finish: ${error instanceof Error ? error.message : String(error)}`,
  );
}
console.log(
  [
    "prove-catches (advisory)",
    "",
    ...rows,
    "",
    `${caught}/${selected.length} past failure classes caught`,
  ].join("\n"),
);
process.exit(0);
