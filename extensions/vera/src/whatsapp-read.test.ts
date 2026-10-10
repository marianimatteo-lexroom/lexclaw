import { describe, expect, it, vi } from "vitest";
import { markKapsoMessageRead, readInboundChannelId, readInboundMessageId } from "./whatsapp-read.js";

const MESSAGE_ID = "wamid.HBgMMzkzNDAzMDU1OTExFQIAEhgUM0IyMjUwOEJBREUwODEyNEQ2MDkA";

const config = {
  channels: {
    "kapso-whatsapp": {
      apiKey: "kapso_test_key",
      phoneNumberId: "1197866140067824",
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
    expect(url).toBe(
      "https://api.kapso.ai/meta/whatsapp/v23.0/1197866140067824/messages",
    );
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
              lawyer: { phoneNumberId: 1197866140067824 },
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
        messageId: "393403055911:1791674081",
        env: {},
        fetchImpl,
      }),
    ).toEqual({ ok: true, skipped: "not-a-whatsapp-id" });
    expect(
      await markKapsoMessageRead({
        config: {
          channels: { "kapso-whatsapp": { ...config.channels["kapso-whatsapp"], sendReadReceipts: false } },
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

  it("reads the channel and message id from the hook context", () => {
    expect(
      readInboundChannelId({ channel: "legacy" }, { channelId: "kapso-whatsapp" }),
    ).toBe("kapso-whatsapp");
    expect(readInboundMessageId({ messageId: "from-event" }, { messageId: MESSAGE_ID })).toBe(
      MESSAGE_ID,
    );
  });
});
