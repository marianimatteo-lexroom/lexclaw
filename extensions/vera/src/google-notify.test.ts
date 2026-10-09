import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  googleConnectedText,
  readVeraWhatsAppTarget,
  sendGoogleConnectedNotice,
} from "./google-notify.js";

const config = {
  channels: {
    "kapso-whatsapp": { defaultTo: " +393403055911 " },
  },
} as OpenClawPluginApi["config"];

describe("sendGoogleConnectedNotice", () => {
  it("texts the configured WhatsApp destination", async () => {
    const sendText = vi.fn(async () => ({ ok: true }));
    const result = await sendGoogleConnectedNotice({
      config,
      email: "lawyer@example.com",
      loadAdapter: async () => ({ sendText }),
    });
    expect(result).toEqual({ ok: true });
    expect(readVeraWhatsAppTarget(config)).toBe("+393403055911");
    expect(sendText).toHaveBeenCalledWith({
      cfg: config,
      to: "+393403055911",
      text: "Gmail and Google Calendar are connected to Vera for lawyer@example.com.",
    });
  });

  it("does not send when the destination or adapter is missing", async () => {
    const sendText = vi.fn();
    expect(
      await sendGoogleConnectedNotice({
        config: {} as OpenClawPluginApi["config"],
        email: "lawyer@example.com",
        loadAdapter: async () => ({ sendText }),
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp defaultTo is not set" });
    expect(
      await sendGoogleConnectedNotice({
        config,
        email: "lawyer\n@example.com",
        loadAdapter: async () => undefined,
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp outbound is unavailable" });
    expect(googleConnectedText("lawyer\n@example.com")).toBe(
      "Gmail and Google Calendar are connected to Vera for lawyer @example.com.",
    );
    expect(sendText).not.toHaveBeenCalled();
  });
});
