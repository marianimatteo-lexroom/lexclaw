#!/usr/bin/env node
// Advisory verification of Ada's Lexroom integration. Always exits 0: a red result is a
// finding to read, never a merge gate. See ../SKILL.md.
//
//   scripts/run.sh [--doctor] [--only <id-prefix>] [--no-live] [--live-only] [--json]
import fs from "node:fs";
import path from "node:path";
import { CHECKS, capturedLogs } from "./checks.mts";
import {
  ADA_DIR,
  loadAda,
  maskSecrets,
  mockFetch,
  MOCK_PASSWORD,
  REPO_ROOT,
  runCheck,
  type CheckResult,
} from "./lib.mts";
import { LIVE_ENV, runLive, type LiveResult } from "./live.mts";
import { startMockLexroom } from "./mock-lexroom.mts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : undefined;

type Report = {
  generatedAt: string;
  adaDir: string;
  advisory: true;
  checks: CheckResult[];
  live: LiveResult;
};

async function main(): Promise<Report> {
  const report: Report = {
    generatedAt: new Date().toISOString(),
    adaDir: path.relative(REPO_ROOT, ADA_DIR) || ".",
    advisory: true,
    checks: [],
    live: { status: "skip", lines: ["live step not run (--no-live)"] },
  };
  const ada = await loadAda();

  if (!flag("--live-only")) {
    const original = process.env.ADA_LEXROOM_TIMEOUT_MS;
    process.env.ADA_LEXROOM_TIMEOUT_MS = "1000";
    const mock = await startMockLexroom();
    try {
      const ctx = { mock, ada, fetchImpl: mockFetch(mock) };
      for (const def of CHECKS.filter((c) => !only || c.id.startsWith(only))) {
        report.checks.push(await runCheck(def, ctx));
      }
      if (!only) {
        report.checks.push(secretsCheck(mock));
      }
    } finally {
      await mock.close();
      if (original === undefined) {
        delete process.env.ADA_LEXROOM_TIMEOUT_MS;
      } else {
        process.env.ADA_LEXROOM_TIMEOUT_MS = original;
      }
    }
  }

  if (!flag("--no-live") && !only) {
    report.live = await runLive(ada);
  }
  return report;
}

/** Everything Ada logged during the run, and the mock's request log, must be free of credentials. */
function secretsCheck(mock: Awaited<ReturnType<typeof startMockLexroom>>): CheckResult {
  const haystack = [
    ...capturedLogs.flatMap((box) => box.logs.lines),
    JSON.stringify(mock.requests()),
  ].join("\n");
  const leaks = [MOCK_PASSWORD, ...mock.issuedTokens()].filter((secret) =>
    haystack.includes(secret),
  );
  return {
    id: "secrets.no-leak",
    title: "No password or issued bearer appears in Ada's logs or the mock's request log",
    guards: "credentials in logs",
    status: leaks.length === 0 ? "pass" : "fail",
    ms: 0,
    assertions: [
      {
        label: `scanned ${haystack.split("\n").length} log lines for the saved password and ${mock.issuedTokens().length} issued bearers`,
        ok: leaks.length === 0,
        ...(leaks.length ? { detail: `${leaks.length} secret value(s) found in logs` } : {}),
      },
    ],
    notes: [],
  };
}

function render(report: Report): string {
  const out: string[] = ["verify-ada (advisory: this report never blocks a merge)", ""];
  for (const check of report.checks) {
    out.push(
      `${check.status === "pass" ? "PASS" : "FAIL"}  ${check.id}  (${check.ms}ms)  ${check.title}`,
    );
    if (check.status === "fail") {
      out.push(`      guards: ${check.guards}`);
      if (check.error) {
        out.push(`      error: ${maskSecrets(check.error)}`);
      }
      for (const a of check.assertions.filter((x) => !x.ok)) {
        out.push(
          `      x ${maskSecrets(a.label)}${a.detail ? ` -- ${maskSecrets(a.detail)}` : ""}`,
        );
      }
    }
  }
  const failed = report.checks.filter((c) => c.status === "fail");
  const assertions = report.checks.reduce((n, c) => n + c.assertions.length, 0);
  out.push(
    "",
    ...(report.checks.length
      ? [
          `mock checks: ${report.checks.length - failed.length}/${report.checks.length} passed (${assertions} assertions)`,
          "",
        ]
      : []),
    `LIVE  ${report.live.status.toUpperCase()}`,
    ...report.live.lines.map((line) => `      ${line}`),
    "",
    failed.length || report.live.status === "fail"
      ? "ADVISORY: findings above. Nothing was blocked; read them before trusting the change."
      : "ADVISORY: no findings.",
  );
  return out.join("\n");
}

function doctor(): string {
  const has = (name: string) => (process.env[name]?.trim() ? "set" : "not set");
  const files = [
    "src/lexroom-client.ts",
    "src/lexroom-login.ts",
    "src/lexroom-jobs.ts",
    "src/research-link-outbound.ts",
  ];
  return [
    `node ${process.version} (needs 24+)`,
    `ada plugin: ${path.relative(REPO_ROOT, ADA_DIR) || "."}`,
    ...files.map((f) => `${fs.existsSync(path.join(ADA_DIR, f)) ? "ok     " : "MISSING"} ${f}`),
    `node_modules: ${fs.existsSync(path.join(REPO_ROOT, "node_modules")) ? "present" : "MISSING (run pnpm install)"}`,
    `${LIVE_ENV.email}: ${has(LIVE_ENV.email)}`,
    `${LIVE_ENV.password}: ${has(LIVE_ENV.password)}`,
    `live step would ${has(LIVE_ENV.email) === "set" && has(LIVE_ENV.password) === "set" ? "RUN one real query" : "be SKIPPED"}`,
  ].join("\n");
}

let exit = 0;
if (flag("--doctor")) {
  console.log(doctor());
  process.exit(0);
}
try {
  const report = await main();
  const stamp = report.generatedAt.replace(/[:.]/gu, "-");
  const dir = path.join(REPO_ROOT, ".artifacts/verify-ada", stamp);
  fs.mkdirSync(dir, { recursive: true });
  const text = render(report);
  fs.writeFileSync(path.join(dir, "report.txt"), `${text}\n`);
  fs.writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (flag("--json")) {
    console.log(JSON.stringify(report));
  } else {
    console.log(text);
    console.log(`\nevidence: ${path.relative(REPO_ROOT, dir)}/report.{txt,json}`);
  }
} catch (error) {
  console.log(
    `ADVISORY: verify-ada could not run (${maskSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error))}). Nothing was verified.`,
  );
  exit = 0;
}
// Open worker threads and sockets must not keep a warn-only tool alive.
process.exit(exit);
