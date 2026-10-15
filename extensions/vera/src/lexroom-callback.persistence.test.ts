import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LexroomAccountStore } from "./lexroom-account-contract.js";

const openVeraLexroomAccountFromApi = vi.hoisted(() => vi.fn());
vi.mock("./lexroom-account.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lexroom-account.js")>()),
  openVeraLexroomAccountFromApi,
}));

import { withLexroomStoreLogging } from "./lexroom-account.js";
import { createSqliteWorkerBackend } from "./lexroom-account.worker.js";
import { handleVeraLexroomConnect } from "./lexroom-connect-http.js";
import { createConnectState } from "./lexroom-connect.js";
import { executeVeraLexroomConnect } from "./lexroom-tools.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const SECRET = "0123456789abcdef";
const KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = new Date("2026-10-15T14:45:00.000Z");
const EMAIL = "matteo.mariani+verus@lexroom.ai";
const CONNECT_CONFIG = {
  lexroomConnectUri: "https://gateway.example/vera/lexroom/connect",
  lexroomStateSecret: SECRET,
};
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const api = { logger, runtimeSource: "/fake/index.ts", runtime: {} } as never;

function jwt(expiresInSec: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: NOW.getTime() / 1000 + expiresInSec }));
  return `header.${payload.toString("base64url")}.signature`;
}

type Backend = ReturnType<typeof createSqliteWorkerBackend>;

/** The real SQLite account backend, one connection each: what the route and a tool would hold. */
function connect(databasePath: string): { backend: Backend; store: LexroomAccountStore } {
  const backend = createSqliteWorkerBackend(undefined, { databasePath });
  const run = async (type: string, input: unknown) =>
    await Promise.resolve(backend.execute({ type, input } as never));
  const store: LexroomAccountStore = {
    replacePending: async (nonce, expiresAtMs) => {
      await run("replacePending", { nonce, expiresAtMs });
    },
    hasPending: async (nonce, nowMs) => (await run("hasPending", { nonce, nowMs })) as boolean,
    consumePending: async (nonce, nowMs) =>
      (await run("consumePending", { nonce, nowMs })) as boolean,
    upsertAccount: async (account) => {
      await run("upsertAccount", account);
    },
    readAccount: async () => (await run("readAccount", undefined)) as never,
    clearAccount: async () => {
      await run("clearAccount", undefined);
    },
  };
  return { backend, store };
}

function mockRes() {
  let body = "";
  const res = {
    statusCode: 200,
    setHeader() {},
    end(chunk?: string) {
      body = chunk ?? "";
    },
  };
  return { res: res as unknown as ServerResponse, body: () => body };
}

function mockReq(form: Record<string, string>): IncomingMessage {
  const chunks = [Buffer.from(new URLSearchParams(form).toString())];
  return {
    method: "POST",
    url: "/vera/lexroom/connect",
    headers: {},
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  } as unknown as IncomingMessage;
}

/** Runs the sign-in callback against `store` the way the HTTP route does. */
async function signIn(
  store: LexroomAccountStore,
  login: { email?: string; accessToken: string; accessExpiresAtMs: number | null },
  options: { notify?: () => Promise<{ ok: true }> } = {},
) {
  const issued = createConnectState(SECRET, NOW);
  await store.replacePending(issued.nonce, issued.expiresAtMs);
  const out = mockRes();
  await handleVeraLexroomConnect(
    mockReq({ state: issued.state, email: "Matteo.Mariani+Verus@Lexroom.ai ", password: "pw" }),
    out.res,
    {
      config: CONNECT_CONFIG,
      now: () => NOW,
      store,
      log: logger,
      notifyConnected: options.notify,
      login: async () => ({
        ok: true,
        email: login.email ?? EMAIL,
        accessToken: login.accessToken,
        refreshToken: "",
        accessExpiresAtMs: login.accessExpiresAtMs,
      }),
    },
  );
  return { status: out.res.statusCode, html: out.body() };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("VERA_TOKEN_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a completed Lexroom callback", () => {
  it("leaves vera_lexroom_connect reporting connected on the very next call, from another connection", async () => {
    const dbPath = path.join(tempDirs.make("vera-lexroom-"), "vera", "lexroom-account.sqlite");
    const route = connect(dbPath);
    const tool = connect(dbPath);
    openVeraLexroomAccountFromApi.mockResolvedValue(tool.store);
    try {
      const token = jwt(3600);
      const page = await signIn(route.store, {
        accessToken: token,
        accessExpiresAtMs: NOW.getTime() + 3_600_000,
      });
      expect(page.status).toBe(200);
      expect(page.html).toContain("Connected");

      const fetchImpl = vi.fn(async () => json({ credits: 5 })) as unknown as typeof fetch;
      const status = await executeVeraLexroomConnect(CONNECT_CONFIG, api, NOW, { fetchImpl });
      expect(status).toEqual({ ok: true, connected: true, email: EMAIL });
    } finally {
      route.backend.close();
      tool.backend.close();
    }
  });

  it("still reports connected when the live check answers 403 (and nothing is wiped)", async () => {
    const dbPath = path.join(tempDirs.make("vera-lexroom-"), "vera", "lexroom-account.sqlite");
    const route = connect(dbPath);
    const tool = connect(dbPath);
    openVeraLexroomAccountFromApi.mockResolvedValue(tool.store);
    try {
      await signIn(route.store, {
        accessToken: jwt(3600),
        accessExpiresAtMs: NOW.getTime() + 3_600_000,
      });
      const fetchImpl = vi.fn(async () =>
        json({ detail: "You do not have permission to perform this action." }, 403),
      ) as unknown as typeof fetch;
      for (let call = 0; call < 3; call += 1) {
        expect(await executeVeraLexroomConnect(CONNECT_CONFIG, api, NOW, { fetchImpl })).toEqual({
          ok: true,
          connected: true,
          email: EMAIL,
        });
      }
      expect(await route.store.readAccount()).toMatchObject({ email: EMAIL });
    } finally {
      route.backend.close();
      tool.backend.close();
    }
  });

  it("round-trips a plus-alias address under one fixed storage key", async () => {
    const dbPath = path.join(tempDirs.make("vera-lexroom-"), "vera", "lexroom-account.sqlite");
    const route = connect(dbPath);
    const tool = connect(dbPath);
    try {
      await signIn(route.store, {
        accessToken: jwt(3600),
        accessExpiresAtMs: NOW.getTime() + 3_600_000,
      });
      expect((await tool.store.readAccount())?.email).toBe(EMAIL);
      await tool.store.clearAccount();
      expect(await route.store.readAccount()).toBeNull();
    } finally {
      route.backend.close();
      tool.backend.close();
    }
  });
});

describe("the same credential from another process", () => {
  const loader = path.resolve(import.meta.dirname, "../../../scripts/tsx.mjs");
  const workerUrl = pathToFileURL(
    path.resolve(import.meta.dirname, "lexroom-account.worker.ts"),
  ).href;

  function inChild(databasePath: string, body: string): string {
    return execFileSync(
      process.execPath,
      [
        "--import",
        loader,
        "--input-type=module",
        "-e",
        `const { createSqliteWorkerBackend } = await import(${JSON.stringify(workerUrl)});
         const backend = createSqliteWorkerBackend(undefined, { databasePath: ${JSON.stringify(databasePath)} });
         try { ${body} } finally { backend.close(); }`,
      ],
      { env: { ...process.env, NODE_ENV: "test", VERA_TOKEN_KEY: KEY }, encoding: "utf8" },
    );
  }

  it("reads what this process wrote, and this process reads what the child wrote", async () => {
    const dbPath = path.join(tempDirs.make("vera-lexroom-"), "vera", "lexroom-account.sqlite");
    const mine = connect(dbPath);
    try {
      await mine.store.upsertAccount({
        email: EMAIL,
        accessToken: "token-written-by-parent-0001",
        refreshToken: "",
        accessExpiresAtMs: null,
        connectedAtMs: 1,
      });
      const seenByChild = JSON.parse(
        inChild(
          dbPath,
          `process.stdout.write(JSON.stringify(backend.execute({ type: "readAccount", input: undefined })));`,
        ),
      ) as { email: string; accessToken: string };
      expect(seenByChild).toMatchObject({
        email: EMAIL,
        accessToken: "token-written-by-parent-0001",
      });

      inChild(
        dbPath,
        `backend.execute({ type: "upsertAccount", input: { email: ${JSON.stringify(EMAIL)}, accessToken: "token-written-by-child-0002", refreshToken: "", accessExpiresAtMs: null, connectedAtMs: 2 } });`,
      );
      expect(mine.backend.execute({ type: "readAccount", input: undefined })).toMatchObject({
        accessToken: "token-written-by-child-0002",
      });
    } finally {
      mine.backend.close();
    }
  }, 30_000);
});

describe("the success page", () => {
  it("is not shown when the write fails, and says so", async () => {
    const dbPath = path.join(tempDirs.make("vera-lexroom-"), "vera", "lexroom-account.sqlite");
    const real = connect(dbPath);
    const notify = vi.fn(async () => ({ ok: true as const }));
    try {
      const store: LexroomAccountStore = {
        ...real.store,
        upsertAccount: async () => {
          throw new Error("disk full");
        },
      };
      const page = await signIn(
        store,
        { accessToken: jwt(3600), accessExpiresAtMs: NOW.getTime() + 3_600_000 },
        { notify },
      );
      expect(page.status).toBe(500);
      expect(page.html).not.toContain("Connected");
      expect(page.html).toContain("Could not connect");
      expect(page.html).toContain('class="badge error"');
      expect(notify).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        "vera lexroom connect could not save the credential: disk full",
      );
    } finally {
      real.backend.close();
    }
  });

  it("is not shown when the credential cannot be read back", async () => {
    const dbPath = path.join(tempDirs.make("vera-lexroom-"), "vera", "lexroom-account.sqlite");
    const real = connect(dbPath);
    try {
      const store: LexroomAccountStore = { ...real.store, upsertAccount: async () => {} };
      const page = await signIn(store, {
        accessToken: jwt(3600),
        accessExpiresAtMs: NOW.getTime() + 3_600_000,
      });
      expect(page.status).toBe(500);
      expect(page.html).not.toContain("Connected");
      expect(await real.store.readAccount()).toBeNull();
    } finally {
      real.backend.close();
    }
  });

  it("is not shown for a sign-in Vera would treat as already expired", async () => {
    const dbPath = path.join(tempDirs.make("vera-lexroom-"), "vera", "lexroom-account.sqlite");
    const real = connect(dbPath);
    try {
      const page = await signIn(real.store, {
        accessToken: jwt(30),
        accessExpiresAtMs: NOW.getTime() + 30_000,
      });
      expect(page.status).toBe(500);
      expect(page.html).not.toContain("Connected");
      expect(page.html).toContain("expires almost immediately");
    } finally {
      real.backend.close();
    }
  });
});

describe("credential logging", () => {
  it("records every write, read and clear with key, backend, process and normalization, never the token", async () => {
    const dbPath = path.join(tempDirs.make("vera-lexroom-"), "vera", "lexroom-account.sqlite");
    const real = connect(dbPath);
    const lines: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const store = withLexroomStoreLogging(real.store, {
      log: (event, fields) => lines.push({ event, fields }),
      databasePath: dbPath,
    });
    try {
      const secret = "very-secret-access-token-value-123456";
      const page = await signIn(store, {
        accessToken: secret,
        accessExpiresAtMs: NOW.getTime() + 3_600_000,
      });
      expect(page.status).toBe(200);
      await store.readAccount();
      await store.clearAccount();

      expect(lines.map((line) => line.event)).toEqual([
        "store.write",
        "store.read",
        "store.read",
        "store.clear",
      ]);
      expect(lines[0]?.fields).toMatchObject({
        storageKey: "lawyer",
        backend: "sqlite-worker",
        db: dbPath,
        email: EMAIL,
        tokenPresent: true,
        pid: process.pid,
      });
      expect(lines[0]?.fields).toHaveProperty("host");
      expect(lines[0]?.fields).toHaveProperty("replica");
      expect(lines[0]?.fields).toHaveProperty("instance");
      expect(JSON.stringify(lines)).not.toContain(secret);
      expect(JSON.stringify(lines)).not.toContain("secret");

      const warned = logger.info.mock.calls.map((call) => String(call[0])).join("\n");
      expect(warned).toContain("connect.callback.write emailInput=Matteo.Mariani+Verus@Lexroom.ai");
      expect(warned).toContain(`emailStored=${EMAIL}`);
      expect(warned).toContain("connect.callback.confirmed");
      expect(warned).not.toContain(secret);
    } finally {
      real.backend.close();
    }
  });
});
