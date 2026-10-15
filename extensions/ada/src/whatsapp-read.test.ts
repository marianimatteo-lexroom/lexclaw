import { describe, expect, it, vi } from "vitest";
import {
  markKapsoMessageRead,
  readInboundChannelId,
  readInboundMessageId,
} from "./whatsapp-read.js";

const MESSAGE_ID = "wamid.HBgMMzkwMDAwMDAwMDAwFQIAEhgUM0IyMjUwOEJBREUwODEyNEQ2MDkA";

const config = {
  channels: {
    "kapso-whatsapp": {
      apiKey: "kapso_test_key",
      phoneNumberId: "100000000000000",
      baseUrl: "https://api.kapso.ai/meta/whatsapp/",
    },
  },
};

function jsonResponse(status: number): Response {
  return new Response("{}", { status });
}

describe("markKapsoMessageRead", () => {
  it("marks an inbound WhatsApp message read through Kapso", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const result = await markKapsoMessageRead({
      config,
      channelId: "kapso-whatsapp",
      messageId: ` ${MESSAGE_ID} `,
      env: {},
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.kapso.ai/meta/whatsapp/v23.0/100000000000000/messages");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": "kapso_test_key",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      status: "read",
      message_id: MESSAGE_ID,
    });
  });

  it("uses the selected account and falls back to env credentials", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    await markKapsoMessageRead({
      config: {
        channels: {
          "kapso-whatsapp": {
            accounts: {
              lawyer: { phoneNumberId: 100000000000000 },
            },
          },
        },
      },
      channelId: "kapso-whatsapp",
      accountId: "lawyer",
      messageId: MESSAGE_ID,
      env: { KAPSO_API_KEY: "kapso_from_env" },
      fetchImpl,
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.headers).toMatchObject({ "X-API-Key": "kapso_from_env" });
  });

  it("skips other channels, synthetic ids, disabled receipts, and missing credentials", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    expect(
      await markKapsoMessageRead({
        config,
        channelId: "whatsapp",
        messageId: MESSAGE_ID,
        env: {},
        fetchImpl,
      }),
    ).toEqual({ ok: true, skipped: "not-whatsapp" });
    expect(
      await markKapsoMessageRead({
        config,
        channelId: "kapso-whatsapp",
        messageId: "390000000000:1791674081",
        env: {},
        fetchImpl,
      }),
    ).toEqual({ ok: true, skipped: "not-a-whatsapp-id" });
    expect(
      await markKapsoMessageRead({
        config: {
          channels: {
            "kapso-whatsapp": { ...config.channels["kapso-whatsapp"], sendReadReceipts: false },
          },
        },
        channelId: "kapso-whatsapp",
        messageId: MESSAGE_ID,
        env: {},
        fetchImpl,
      }),
    ).toEqual({ ok: true, skipped: "receipts-disabled" });
    expect(
      await markKapsoMessageRead({
        config: {},
        channelId: "kapso-whatsapp",
        messageId: MESSAGE_ID,
        env: {},
        fetchImpl,
      }),
    ).toEqual({ ok: true, skipped: "missing-credentials" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports HTTP failures without the API key", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401));
    const result = await markKapsoMessageRead({
      config,
      channelId: "kapso-whatsapp",
      messageId: MESSAGE_ID,
      env: {},
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: "kapso read receipt returned HTTP 401" });
    expect(JSON.stringify(result)).not.toContain("kapso_test_key");
  });

  it.each([400, 403, 404, 429, 500, 502, 503])(
    "returns a failure for Kapso HTTP %i without leaking the API key",
    async (status) => {
      const fetchImpl = vi.fn(async () => jsonResponse(status));
      const result = await markKapsoMessageRead({
        config,
        channelId: "kapso-whatsapp",
        messageId: MESSAGE_ID,
        env: {},
        fetchImpl,
      });
      expect(result).toEqual({ ok: false, error: `kapso read receipt returned HTTP ${status}` });
      expect(JSON.stringify(result)).not.toContain("kapso_test_key");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("returns a generic failure when the request throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED kapso_test_key");
    });
    const result = await markKapsoMessageRead({
      config,
      channelId: "kapso-whatsapp",
      messageId: MESSAGE_ID,
      env: {},
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: "kapso read receipt request failed" });
  });

  it("aborts and reports a timeout after 10 seconds", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn(
        (_url: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const pending = markKapsoMessageRead({
        config,
        channelId: "kapso-whatsapp",
        messageId: MESSAGE_ID,
        env: {},
        fetchImpl: fetchImpl as typeof fetch,
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(await pending).toEqual({ ok: false, error: "kapso read receipt timed out" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the request and reports a timeout when the caller aborts", async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = markKapsoMessageRead({
      config,
      channelId: "kapso-whatsapp",
      messageId: MESSAGE_ID,
      env: {},
      fetchImpl: fetchImpl as typeof fetch,
      signal: caller.signal,
    });
    caller.abort();
    expect(await pending).toEqual({ ok: false, error: "kapso read receipt timed out" });
  });

  it("rejects a non-https base URL and a malformed phone number id without calling out", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const account = config.channels["kapso-whatsapp"];
    expect(
      await markKapsoMessageRead({
        config: { channels: { "kapso-whatsapp": { ...account, baseUrl: "http://api.kapso.ai" } } },
        channelId: "kapso-whatsapp",
        messageId: MESSAGE_ID,
        env: {},
        fetchImpl,
      }),
    ).toEqual({ ok: false, error: "kapso base URL is invalid" });
    expect(
      await markKapsoMessageRead({
        config: { channels: { "kapso-whatsapp": { ...account, phoneNumberId: "not-a-number" } } },
        channelId: "kapso-whatsapp",
        messageId: MESSAGE_ID,
        env: {},
        fetchImpl,
      }),
    ).toEqual({ ok: false, error: "kapso phoneNumberId is invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads the channel and message id from the hook context", () => {
    expect(readInboundChannelId({ channel: "legacy" }, { channelId: "kapso-whatsapp" })).toBe(
      "kapso-whatsapp",
    );
    expect(readInboundMessageId({ messageId: "from-event" }, { messageId: MESSAGE_ID })).toBe(
      MESSAGE_ID,
    );
  });
});
