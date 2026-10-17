#!/usr/bin/env node

// Single mergeability gate for Ada, the only code this fork owns. It runs every
// step even after a failure, so one red upstream-shaped check cannot hide a
// different Ada regression, and exits non-zero if any step failed.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ADA_PATHS = [
  "extensions/ada",
  "deploy/railway",
  "test/scripts/ada-railway-start.test.ts",
  "PROGRESS.md",
];

const ADA_STEPS = [
  { name: "format", args: ["oxfmt", "--check", ...ADA_PATHS] },
  {
    name: "lint",
    args: [
      "node",
      "scripts/run-oxlint.mjs",
      "--tsconfig",
      "extensions/tsconfig.json",
      "extensions/ada",
      "test/scripts/ada-railway-start.test.ts",
    ],
  },
  {
    name: "types",
    args: [
      "node",
      "scripts/run-tsgo.mjs",
      "-p",
      "tsconfig.ada.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/ada.tsbuildinfo",
    ],
  },
  {
    name: "test-types",
    args: [
      "node",
      "scripts/run-tsgo.mjs",
      "-p",
      "test/tsconfig/tsconfig.ada.test.json",
      "--incremental",
      "--tsBuildInfoFile",
      ".artifacts/tsgo-cache/ada-test.tsbuildinfo",
    ],
  },
  {
    // Core-owned allowlist of plugins that register typed hooks; Ada must be listed.
    name: "hook-allowlist",
    args: ["node", "scripts/run-vitest.mjs", "src/plugins/contracts/boundary-invariants.test.ts"],
  },
  {
    name: "tests",
    args: [
      "node",
      "scripts/run-vitest.mjs",
      "extensions/ada",
      "test/scripts/ada-railway-start.test.ts",
    ],
  },
];

function runStep(step) {
  const [command, ...args] = step.args;
  const bin =
    command === "node" ? process.execPath : path.join(repoRoot, "node_modules", ".bin", command);
  console.log(`\n== check:ada ${step.name}`);
  const startedAt = Date.now();
  const result = spawnSync(bin, args, { cwd: repoRoot, stdio: "inherit" });
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  const ok = result.status === 0;
  console.log(`check:ada ${step.name}: ${ok ? "ok" : "FAILED"} (${seconds}s)`);
  return { name: step.name, ok, seconds };
}

function main() {
  const results = ADA_STEPS.map(runStep);
  console.log("\ncheck:ada summary");
  for (const { name, ok, seconds } of results) {
    console.log(`  ${ok ? "ok    " : "FAILED"} ${name} (${seconds}s)`);
  }
  const failed = results.filter((result) => !result.ok).map((result) => result.name);
  if (failed.length > 0) {
    console.error(`\ncheck:ada failed: ${failed.join(", ")}`);
    process.exit(1);
  }
}

main();
