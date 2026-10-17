import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  lexroomCreditsProbe,
  lexroomLogin,
  lexroomUserModules,
  type LexroomCall,
} from "./lexroom-api.js";
import { LexroomTimeoutError } from "./lexroom-guard.js";
import { normalizeModules } from "./lexroom-modules.js";
import { createTrace } from "./lexroom-transport.js";

// Synthetic replays of the known-good lexroom-bot behavior described in PR #34.
function fixture(name: string): string {
  return readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8");
}

function replay(body: string, status = 200) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(body, { status, headers: { "content-type": "application/json" } }),
  );
}

function callWith(fetchImpl: typeof fetch): LexroomCall {
  return {
    baseUrl: "https://api.lexroom.test",
    timeoutMs: 1000,
    fetchImpl,
    trace: createTrace(undefined, "contract"),
  };
}

describe("lexroom api contract", () => {
  it("requires timeoutMs: a call without it does not typecheck", () => {
    expectTypeOf<LexroomCall["timeoutMs"]>().toEqualTypeOf<number>();
    expectTypeOf<LexroomCall>().not.toEqualTypeOf<Omit<LexroomCall, "timeoutMs">>();
  });

  it("logs in the way lexroom-bot does and reads the recorded reply", async () => {
    const fetchImpl = replay(fixture("lexroom-login.json"));
    const reply = await lexroomLogin(callWith(fetchImpl), {
      email: "lawyer@example.test",
      password: "pässwörd",
    });
    expect(reply).toMatchObject({
      kind: "ok",
      status: 200,
      body: { refresh_token: "synthetic-refresh-token", email: "lawyer@example.test" },
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.lexroom.test/v1/login");
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      "content-type": "application/json",
      "x-client-type": "app_lex",
    });
    expect(init?.body).toBe('{"email":"lawyer@example.test","password":"p\\u00e4ssw\\u00f6rd"}');
  });

  it("maps the recorded rejections to their status, detail and code", async () => {
    const call = (name: string, status: number) =>
      lexroomLogin(callWith(replay(fixture(name), status)), { email: "a@b.test", password: "x" });
    await expect(call("lexroom-login-401.json", 401)).resolves.toEqual({
      kind: "http_error",
      status: 401,
      detail: "Invalid credentials",
      code: "authentication_failed",
    });
    await expect(call("lexroom-login-mfa.json", 403)).resolves.toMatchObject({
      kind: "http_error",
      detail: "mfa_required",
    });
  });

  it("reads a 422 list `detail` as absent instead of guessing a string", async () => {
    const reply = await lexroomLogin(
      callWith(replay('{"detail":[{"loc":["body","email"],"msg":"field required"}]}', 422)),
      { email: "a@b.test", password: "x" },
    );
    expect(reply).toEqual({ kind: "http_error", status: 422, detail: "", code: "" });
  });

  it.each([
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"ok"'],
    ["a token that is not text", '{"access_token":42}'],
    ["an empty body", ""],
  ])("flags a 200 login reply that is %s as an unexpected shape", async (_label, body) => {
    const events: string[] = [];
    const call = {
      ...callWith(replay(body)),
      trace: (event: string) => void events.push(event),
    };
    await expect(lexroomLogin(call, { email: "a@b.test", password: "x" })).resolves.toEqual({
      kind: "unexpected_shape",
      status: 200,
    });
    expect(events).toContain("login.unexpected_shape");
  });

  it("sends the user-modules and credits requests with the bearer and nothing the bot does not send", async () => {
    const modules = replay(fixture("lexroom-user-modules.json"));
    const reply = await lexroomUserModules(callWith(modules), "synthetic-token");
    expect(reply.kind === "ok" && normalizeModules(reply.body)).toEqual([
      "Civile",
      "Lavoro",
      "Societario",
    ]);
    const credits = replay(fixture("lexroom-credits.json"));
    await expect(lexroomCreditsProbe(callWith(credits), "synthetic-token")).resolves.toMatchObject({
      kind: "ok",
    });
    for (const [fetchImpl, path] of [
      [modules, "/v1/user/modules"],
      [credits, "/v1/credits"],
    ] as const) {
      const [url, init] = fetchImpl.mock.calls[0] ?? [];
      expect(url).toBe(`https://api.lexroom.test${path}`);
      expect(init?.method).toBe("GET");
      expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
        authorization: "Bearer synthetic-token",
        "x-client-type": "app_lex",
      });
    }
  });

  it("flags a modules reply that is not JSON data", async () => {
    await expect(lexroomUserModules(callWith(replay("42")), "t")).resolves.toEqual({
      kind: "unexpected_shape",
      status: 200,
    });
  });

  it("ends a request that never answers at timeoutMs, not later", async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const reason: unknown = init.signal?.reason;
              reject(reason instanceof Error ? reason : new Error("aborted"));
            });
          }),
      );
      const pending = lexroomCreditsProbe({ ...callWith(hung), timeoutMs: 2000 }, "t");
      const assertion = expect(pending).rejects.toBeInstanceOf(LexroomTimeoutError);
      await vi.advanceTimersByTimeAsync(1999);
      expect(hung).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
