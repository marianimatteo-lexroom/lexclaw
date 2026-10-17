// Shared plumbing for the verify-ada checks: loads Ada's real modules, points them at the mock
// Lexroom over real HTTP, gives each check an isolated real SQLite account store, and records
// results without ever throwing past the runner.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MockLexroom } from "./mock-lexroom.mts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, "../../../..");

/** The Ada plugin under test. `VERIFY_ADA_DIR` points at a mutated copy for the catch proof. */
export const ADA_DIR = path.resolve(
  process.env.VERIFY_ADA_DIR ?? path.join(REPO_ROOT, "extensions/ada"),
);

export const PRODUCTION_BASE_URL = "https://api.lexroom.ai";

async function load<T>(file: string): Promise<T> {
  return (await import(pathToFileURL(path.join(ADA_DIR, "src", file)).href)) as T;
}

export type Ada = Awaited<ReturnType<typeof loadAda>>;

export async function loadAda() {
  const [login, client, tools, jobs, links, push, account, session] = await Promise.all([
    load<typeof import("../../../../extensions/ada/src/lexroom-login.ts")>("lexroom-login.ts"),
    load<typeof import("../../../../extensions/ada/src/lexroom-client.ts")>("lexroom-client.ts"),
    load<typeof import("../../../../extensions/ada/src/lexroom-tools.ts")>("lexroom-tools.ts"),
    load<typeof import("../../../../extensions/ada/src/lexroom-jobs.ts")>("lexroom-jobs.ts"),
    load<typeof import("../../../../extensions/ada/src/research-link-outbound.ts")>(
      "research-link-outbound.ts",
    ),
    load<typeof import("../../../../extensions/ada/src/research-push.ts")>("research-push.ts"),
    load<typeof import("../../../../extensions/ada/src/lexroom-account.ts")>("lexroom-account.ts"),
    load<typeof import("../../../../extensions/ada/src/lexroom-session.ts")>("lexroom-session.ts"),
  ]);
  return { login, client, tools, jobs, links, push, account, session };
}

/**
 * Real `fetch`, with Lexroom's production origin rewritten to the mock's loopback port. Ada
 * keeps its production base URL, so the research link (which only exists for lexroom.ai hosts)
 * is built exactly as in production, while every byte still crosses a real socket.
 */
export function mockFetch(mock: MockLexroom): typeof fetch {
  return (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const rewritten = raw.startsWith(PRODUCTION_BASE_URL)
      ? `${mock.baseUrl}${raw.slice(PRODUCTION_BASE_URL.length)}`
      : raw;
    return fetch(rewritten, init);
  };
}

export type CheckContext = {
  mock: MockLexroom;
  ada: Ada;
  fetchImpl: typeof fetch;
};

export type Assertion = { label: string; ok: boolean; detail?: string };

/** What one check does with its assertions. A failed assertion never stops the check. */
export type Recorder = {
  ok(label: string, condition: unknown, detail?: string): void;
  eq(label: string, actual: unknown, expected: unknown): void;
  note(text: string): void;
  assertions: Assertion[];
  notes: string[];
};

export function recorder(): Recorder {
  const assertions: Assertion[] = [];
  const notes: string[] = [];
  return {
    assertions,
    notes,
    ok(label, condition, detail) {
      assertions.push({ label, ok: Boolean(condition), ...(detail ? { detail } : {}) });
    },
    eq(label, actual, expected) {
      const same = JSON.stringify(actual) === JSON.stringify(expected);
      assertions.push({
        label,
        ok: same,
        ...(same
          ? {}
          : { detail: `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}` }),
      });
    },
    note(text) {
      notes.push(text);
    },
  };
}

export type CheckResult = {
  id: string;
  title: string;
  /** The past failure class this check exists to catch. */
  guards: string;
  status: "pass" | "fail";
  ms: number;
  assertions: Assertion[];
  notes: string[];
  /** Set when the check itself crashed or hung rather than an assertion failing. */
  error?: string;
};

export type CheckDefinition = {
  id: string;
  title: string;
  guards: string;
  run(t: Recorder, ctx: CheckContext): Promise<void>;
};

/** Rejects with a clear message when `work` outlives `ms`: a hung call is a finding, not a hang. */
export function watchdog<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms}ms (hung)`)), ms);
  });
  return Promise.race([work, hung]).finally(() => clearTimeout(timer));
}

export async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const startedAt = Date.now();
  const value = await work;
  return { value, ms: Date.now() - startedAt };
}

export async function runCheck(def: CheckDefinition, ctx: CheckContext): Promise<CheckResult> {
  const t = recorder();
  const startedAt = Date.now();
  let error: string | undefined;
  try {
    await def.run(t, ctx);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const failed = error !== undefined || t.assertions.some((a) => !a.ok);
  return {
    id: def.id,
    title: def.title,
    guards: def.guards,
    status: failed ? "fail" : "pass",
    ms: Date.now() - startedAt,
    assertions: t.assertions,
    notes: t.notes,
    ...(error ? { error } : {}),
  };
}

export type CapturedLogs = { lines: string[] };

export type Sandbox = {
  api: never;
  stateDir: string;
  logs: CapturedLogs;
  store: Awaited<ReturnType<Ada["account"]["openAdaLexroomAccountFromApi"]>>;
  cleanup(): void;
};

/** One real Ada account store (SQLite worker) in a throwaway state dir, plus a log-capturing api. */
export async function sandbox(ada: Ada): Promise<Sandbox> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-ada-"));
  const logs: CapturedLogs = { lines: [] };
  const push = (line: string) => void logs.lines.push(line);
  const api = {
    config: {},
    runtimeSource: path.join(ADA_DIR, "index.ts"),
    runtime: { state: { resolveStateDir: () => stateDir } },
    logger: { info: push, warn: push, error: push, debug: push },
  } as never;
  const store = await ada.account.openAdaLexroomAccountFromApi(api);
  return {
    api,
    stateDir,
    logs,
    store,
    cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }),
  };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A JWT-shaped bearer the mock never issued, valid for years by its `exp`, so Ada trusts it until a 401. */
export function staleToken(label: string): string {
  return `${b64({ alg: "HS256" })}.${b64({ exp: 4102444800, jti: `stale-${label}` })}.c3RhbGU`;
}

/** A bearer whose `exp` has passed: Ada must renew it before the first call. */
export function expiredToken(label: string): string {
  return `${b64({ alg: "HS256" })}.${b64({ exp: 1_600_000_000, jti: `expired-${label}` })}.ZXhwaXJlZA`;
}

export const MOCK_EMAIL = "lawyer@example.test";
export const MOCK_PASSWORD = "mock-password-not-a-secret";

export async function seedAccount(
  box: Sandbox,
  account: { accessToken: string; password?: string; accessExpiresAtMs?: number | null },
): Promise<void> {
  await box.store.upsertAccount({
    email: MOCK_EMAIL,
    accessToken: account.accessToken,
    password: account.password ?? MOCK_PASSWORD,
    refreshToken: "",
    accessExpiresAtMs: account.accessExpiresAtMs ?? null,
    connectedAtMs: Date.now(),
  });
}

/** Masks anything that looks like a credential, a bearer or a phone number before it is printed. */
export function maskSecrets(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length >= 4) {
      result = result.split(secret).join("[masked]");
    }
  }
  return result
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gu, "Bearer [masked]")
    .replace(/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/gu, "[masked-jwt]")
    .replace(/\+?\d[\d ()-]{8,}\d/gu, "[masked-number]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, (email) => maskEmail(email));
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`;
}

/** The pushed WhatsApp messages for one number, in order. */
export function fakeWhatsApp(ada: Ada) {
  const sent = new Map<string, string[]>();
  const times = new Map<string, number[]>();
  const depsFor = (recipient: string) =>
    ({
      recipient,
      send: async (text: string) => {
        sent.set(recipient, [...(sent.get(recipient) ?? []), text]);
        times.set(recipient, [...(times.get(recipient) ?? []), Date.now()]);
        return { ok: true as const };
      },
      windowOpen: async () => true,
      nudge: async () => "sent" as const,
      log: () => undefined,
      retryDelayMs: 0,
    }) satisfies Parameters<typeof ada.push.pushResearchResult>[1];
  return { sent, times, depsFor, to: (recipient: string) => sent.get(recipient) ?? [] };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
