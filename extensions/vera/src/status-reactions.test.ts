import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStatusReactions, readStatusReactionSettings } from "./status-reactions.js";

const MESSAGE_ID = "wamid.HBgMMzkwMDAwMDAwMDAwFQIAEhgUM0IyMjUwOEJBREUwODEyNEQ2MDkA";
const SESSION = "agent:main:kapso-whatsapp:direct:390000000000";
const RUN = "run-1";

const config = {
  channels: {
    "kapso-whatsapp": { apiKey: "kapso_test_key", phoneNumberId: "100000000000000" },
  },
};

const inbound = {
  sessionKey: SESSION,
  channelId: "kapso-whatsapp",
  messageId: MESSAGE_ID,
  senders: ["390000000000", "+390000000000"],
};

let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
const logger = { warn: vi.fn() };

function make(env: NodeJS.ProcessEnv = {}) {
  return createStatusReactions({ config: () => config, logger, env, fetchImpl });
}

function emojis(): string[] {
  return fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).reaction.emoji);
}

beforeEach(() => {
  vi.useFakeTimers();
  logger.warn.mockReset();
  fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 200 }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("status reactions", () => {
  it("reacts on the inbound message 👀, ⏳ while working, then ✅", async () => {
    const reactions = make();
    reactions.received(inbound);
    reactions.thinking({ sessionKey: SESSION, runId: RUN, trigger: "user", bind: true });
    reactions.thinking({ sessionKey: SESSION, runId: RUN });
    await vi.advanceTimersByTimeAsync(1_000);
    await reactions.finished({ sessionKey: SESSION, runId: RUN, trigger: "user", success: true });

    expect(emojis()).toEqual(["👀", "⏳", "✅"]);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.kapso.ai/meta/whatsapp/v23.0/100000000000000/messages");
    expect(init).toMatchObject({ headers: { "X-API-Key": "kapso_test_key" } });
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "390000000000",
      type: "reaction",
      reaction: { message_id: MESSAGE_ID, emoji: "👀" },
    });
  });

  it("skips ⏳ when the reply completes within the debounce window", async () => {
    const reactions = make();
    reactions.received(inbound);
    reactions.thinking({ sessionKey: SESSION, runId: RUN, trigger: "user", bind: true });
    await vi.advanceTimersByTimeAsync(400);
    await reactions.finished({ sessionKey: SESSION, runId: RUN, trigger: "user", success: true });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(emojis()).toEqual(["👀", "✅"]);
  });

  it("ends on ❌ when the run fails, including a failure before the model was called", async () => {
    const reactions = make();
    reactions.received(inbound);
    reactions.thinking({ sessionKey: SESSION, runId: RUN, trigger: "user", bind: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await reactions.finished({ sessionKey: SESSION, runId: RUN, trigger: "user", success: false });
    expect(emojis()).toEqual(["👀", "⏳", "❌"]);

    fetchImpl.mockClear();
    reactions.received(inbound);
    await reactions.finished({ sessionKey: SESSION, trigger: "user", success: false });
    expect(emojis()).toEqual(["👀", "❌"]);
  });

  it("stays silent after the run is finished or for other runs and triggers", async () => {
    const reactions = make();
    reactions.received(inbound);
    reactions.thinking({ sessionKey: SESSION, runId: RUN, trigger: "user", bind: true });
    reactions.thinking({ sessionKey: SESSION, runId: "cron-run", trigger: "cron", bind: true });
    await reactions.finished({
      sessionKey: SESSION,
      runId: "cron-run",
      trigger: "cron",
      success: false,
    });
    await reactions.finished({ sessionKey: SESSION, runId: "other", success: false });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(emojis()).toEqual(["👀", "⏳"]);

    await reactions.finished({ sessionKey: SESSION, runId: RUN, trigger: "user", success: true });
    await reactions.finished({ sessionKey: SESSION, runId: RUN, trigger: "user", success: false });
    expect(emojis()).toEqual(["👀", "⏳", "✅"]);
  });

  it("sends nothing when VERA_STATUS_REACTIONS is false", async () => {
    const reactions = make({ VERA_STATUS_REACTIONS: " FALSE " });
    reactions.received(inbound);
    reactions.thinking({ sessionKey: SESSION, runId: RUN, trigger: "user", bind: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await reactions.finished({ sessionKey: SESSION, runId: RUN, trigger: "user", success: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the emoji overrides", async () => {
    const reactions = make({
      VERA_REACTION_ACK: "📨",
      VERA_REACTION_THINKING: "🤔",
      VERA_REACTION_DONE: "👍",
      VERA_REACTION_ERROR: "⚠️",
    });
    reactions.received(inbound);
    reactions.thinking({ sessionKey: SESSION, runId: RUN, trigger: "user", bind: true });
    await vi.advanceTimersByTimeAsync(1_000);
    await reactions.finished({ sessionKey: SESSION, runId: RUN, trigger: "user", success: false });
    expect(emojis()).toEqual(["📨", "🤔", "⚠️"]);
  });

  it("ignores other channels, synthetic message ids, and unknown senders", () => {
    const reactions = make();
    reactions.received({ ...inbound, channelId: "telegram" });
    reactions.received({ ...inbound, messageId: "390000000000:1791674081" });
    reactions.received({ ...inbound, senders: ["120363000000000000@g.us"] });
    reactions.received({ ...inbound, sessionKey: undefined });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never throws or blocks on Kapso failures and does not leak the API key", async () => {
    fetchImpl.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    fetchImpl.mockRejectedValueOnce(new Error("ECONNRESET kapso_test_key"));
    const reactions = make();
    reactions.received(inbound);
    await expect(
      reactions.finished({ sessionKey: SESSION, trigger: "user", success: true }),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith("vera whatsapp reaction failed: HTTP 500");
    expect(logger.warn).toHaveBeenCalledWith("vera whatsapp reaction failed: network");
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("kapso_test_key");
  });

  it("does nothing without Kapso credentials", async () => {
    const reactions = createStatusReactions({ config: () => ({}), logger, env: {}, fetchImpl });
    reactions.received(inbound);
    await reactions.finished({ sessionKey: SESSION, trigger: "user", success: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe("readStatusReactionSettings", () => {
  it("defaults on and falls back to the default emoji for blank overrides", () => {
    expect(readStatusReactionSettings({ VERA_REACTION_ACK: "  " })).toEqual({
      ack: "👀",
      thinking: "⏳",
      done: "✅",
      error: "❌",
    });
    expect(readStatusReactionSettings({ VERA_STATUS_REACTIONS: "true" })).not.toBeNull();
    expect(readStatusReactionSettings({ VERA_STATUS_REACTIONS: "false" })).toBeNull();
  });
});
