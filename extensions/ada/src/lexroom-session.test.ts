import { describe, expect, it, vi } from "vitest";
import type { LexroomAccountRecord, LexroomAccountStore } from "./lexroom-account-contract.js";
import { needsReconnect, renewLexroomAccount } from "./lexroom-session.js";

const NOW = new Date("2026-10-17T06:00:00.000Z");
const PASSWORD = "correct horse battery staple 9";

const account = (overrides: Partial<LexroomAccountRecord> = {}): LexroomAccountRecord => ({
  email: "lawyer@example.com",
  accessToken: "stale-token-aaaaaaaa",
  password: PASSWORD,
  refreshToken: "",
  accessExpiresAtMs: NOW.getTime() - 1000,
  connectedAtMs: 1,
  ...overrides,
});

function harness(
  respond: () => Response | Promise<Response>,
  overrides: Partial<LexroomAccountRecord> = {},
) {
  const store: LexroomAccountStore = {
    replacePending: vi.fn(async () => {}),
    hasPending: vi.fn(async () => false),
    consumePending: vi.fn(async () => false),
    upsertAccount: vi.fn(async () => {}),
    readAccount: vi.fn(async () => account(overrides)),
    clearAccount: vi.fn(async () => {}),
  };
  const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
  const fetchImpl = vi.fn(async () => await respond()) as unknown as typeof fetch;
  const renew = () =>
    renewLexroomAccount(account(overrides), {
      store,
      fetchImpl,
      log: (event, fields) => events.push({ event, fields }),
      now: NOW,
      why: "expired",
    });
  return { store, events, fetchImpl, renew };
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("a refused re-login", () => {
  it("is forbidden, not 'did not answer', and keeps the saved sign-in", async () => {
    const { store, renew } = harness(() =>
      json({ detail: "You do not have permission to perform this action." }, 403),
    );
    const result = await renew();
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    if (result.ok) {
      throw new Error("expected a failure");
    }
    expect(result.error).toContain("answered and refused");
    expect(result.error).not.toContain("did not answer");
    expect(result.error).toContain("ada_lexroom_connect");
    expect(needsReconnect(result)).toBe(false);
    expect(store.clearAccount).not.toHaveBeenCalled();
    expect(store.upsertAccount).not.toHaveBeenCalled();
  });

  it("does not retry a refusal", async () => {
    const { fetchImpl, renew } = harness(() => json({ detail: "no" }, 403));
    await renew();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("logs relogin.failed with the status, code and detail Lexroom gave, and no secret", async () => {
    const { events, renew } = harness(() =>
      json(
        {
          code: "account_blocked",
          detail: `User lawyer@example.com blocked, password ${PASSWORD}, token stale-token-aaaaaaaa-0123456789`,
        },
        403,
      ),
    );
    await renew();
    const failed = events.find((entry) => entry.event === "relogin.failed");
    expect(failed?.fields).toMatchObject({
      why: "expired",
      reason: "forbidden",
      status: 403,
      code: "account_blocked",
      detail: "User [redacted] blocked, password [redacted], token [redacted]",
    });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("lawyer@example.com");
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain("stale-token-aaaaaaaa");
  });

  it("is the same for any other refusal such as a 404 or a 422", async () => {
    for (const status of [400, 404, 422]) {
      const { renew } = harness(() => json({}, status));
      await expect(renew()).resolves.toMatchObject({ ok: false, reason: "forbidden" });
    }
  });
});

describe("a re-login Lexroom never answered", () => {
  it.each([
    ["a 503", () => json({}, 503)],
    ["a 502", () => json({}, 502)],
    ["a 429", () => json({}, 429)],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("stays unavailable for %s, and says Lexroom did not answer", async (_label, respond) => {
    const { store, events, renew } = harness(respond);
    const result = await renew();
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
    expect(result).toMatchObject({ error: expect.stringContaining("did not answer") });
    expect(needsReconnect(result as never)).toBe(false);
    expect(store.clearAccount).not.toHaveBeenCalled();
    const failed = events.find((entry) => entry.event === "relogin.failed");
    expect(failed?.fields).not.toHaveProperty("detail");
  });
});

describe("the other reasons are unchanged", () => {
  it("clears the account for a wrong password, and asks to reconnect", async () => {
    const { store, renew } = harness(() =>
      json({ detail: "No active account", code: "authentication_failed" }, 401),
    );
    const result = await renew();
    expect(result).toMatchObject({ ok: false, reason: "invalid_credentials" });
    expect(needsReconnect(result as never)).toBe(true);
    expect(store.clearAccount).toHaveBeenCalledTimes(1);
  });
});
