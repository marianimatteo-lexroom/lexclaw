import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ append: vi.fn() }));
vi.mock("openclaw/plugin-sdk/session-transcript-runtime", () => ({
  appendAssistantMirrorMessageByIdentity: mocks.append,
}));

import { mirrorSentText, mirrorToSessionKey } from "./transcript-mirror.js";

const ANNA = "393331111111";
const BRUNO = "393332222222";
const keyOf = (owner: string) => `agent:main:kapso-whatsapp:direct:${owner}`;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function apiWith(sessions: Array<{ owner: string; sessionId: string }>, entry?: unknown) {
  return {
    config: {},
    logger,
    runtime: {
      agent: {
        session: {
          listSessionEntries: () =>
            sessions.map(({ owner, sessionId }) => ({
              sessionKey: keyOf(owner),
              entry: { sessionId, updatedAt: 1 },
            })),
          getSessionEntry: () => entry,
        },
      },
    },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.append.mockResolvedValue({ ok: true, messageId: "m1" });
});

describe("writing what code sent into the conversation", () => {
  it("writes the text into the session of the number it was sent to, as something Ada said", async () => {
    const api = apiWith([
      { owner: ANNA, sessionId: "s-anna" },
      { owner: BRUNO, sessionId: "s-bruno" },
    ]);
    expect(await mirrorSentText(api, BRUNO, "Reminder: call Rossi", "ada-key-1")).toBe(true);
    expect(mocks.append).toHaveBeenCalledExactlyOnceWith({
      agentId: "main",
      sessionKey: keyOf(BRUNO),
      sessionId: "s-bruno",
      text: "Reminder: call Rossi",
      idempotencyKey: "ada-key-1",
      updateMode: "none",
    });
  });

  it("writes nothing for a number with no conversation yet", async () => {
    expect(await mirrorSentText(apiWith([{ owner: ANNA, sessionId: "s" }]), BRUNO, "x", "k")).toBe(
      false,
    );
    expect(mocks.append).not.toHaveBeenCalled();
  });

  it("reports false, and never throws, when the session cannot be written", async () => {
    mocks.append.mockRejectedValue(new Error("locked"));
    expect(await mirrorSentText(apiWith([{ owner: ANNA, sessionId: "s" }]), ANNA, "x", "k")).toBe(
      false,
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    mocks.append.mockResolvedValue({ ok: false, reason: "missing active session" });
    expect(await mirrorSentText(apiWith([{ owner: ANNA, sessionId: "s" }]), ANNA, "x", "k")).toBe(
      false,
    );
  });

  it("writes by session key when the id is looked up, and skips a key with no session", async () => {
    const api = apiWith([], { sessionId: "s-new" });
    expect(await mirrorToSessionKey(api, keyOf(ANNA), "Welcome", "ada-welcome:1")).toBe(true);
    expect(mocks.append).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s-new" }));
    mocks.append.mockClear();
    expect(await mirrorToSessionKey(apiWith([], undefined), keyOf(ANNA), "Welcome", "k")).toBe(
      false,
    );
    expect(mocks.append).not.toHaveBeenCalled();
  });
});
