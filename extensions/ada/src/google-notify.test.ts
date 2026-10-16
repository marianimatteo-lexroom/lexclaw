import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  googleConnectedText,
  readAdaWhatsAppTarget,
  sendAdaWhatsAppText,
  sendGoogleConnectedNotice,
} from "./google-notify.js";

const config = {
  channels: {
    "kapso-whatsapp": { defaultTo: " +390000000000 " },
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
    expect(readAdaWhatsAppTarget(config)).toBe("+390000000000");
    expect(sendText).toHaveBeenCalledWith({
      cfg: config,
      to: "+390000000000",
      text: "Gmail and Calendar are connected. I can send mail when you say so.",
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
      "Gmail and Calendar are connected. I can send mail when you say so.",
    );
    expect(googleConnectedText("lawyer\n@example.com")).not.toContain("@");
    expect(sendText).not.toHaveBeenCalled();
  });
});

describe("sendAdaWhatsAppText", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const apiWith = (loadAdapter: () => Promise<unknown>, cfg: unknown = config) =>
    ({
      config: cfg,
      runtime: { channel: { outbound: { loadAdapter } } },
    }) as unknown as Pick<OpenClawPluginApi, "config" | "runtime">;

  it("texts the configured lawyer through the Kapso adapter", async () => {
    const sendText = vi.fn(async () => undefined);
    const result = await sendAdaWhatsAppText({
      api: apiWith(async () => ({ sendText })),
      text: "Ciao",
    });
    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith({ cfg: config, to: "+390000000000", text: "Ciao" });
  });

  it("reports a missing destination, a missing adapter and a failing send without throwing", async () => {
    expect(await sendAdaWhatsAppText({ api: apiWith(async () => ({}), {}), text: "x" })).toEqual({
      ok: false,
      error: "kapso-whatsapp defaultTo is not set",
    });
    expect(await sendAdaWhatsAppText({ api: apiWith(async () => null), text: "x" })).toEqual({
      ok: false,
      error: "kapso-whatsapp outbound is unavailable",
    });
    expect(
      await sendAdaWhatsAppText({
        api: apiWith(async () => ({
          sendText: async () => {
            throw new Error("kapso 500");
          },
        })),
        text: "x",
      }),
    ).toEqual({ ok: false, error: "kapso 500" });
  });

  it("gives up on a send that never finishes, instead of waiting forever", async () => {
    vi.useFakeTimers();
    const pending = sendAdaWhatsAppText({
      api: apiWith(async () => ({
        sendText: () =>
          new Promise<void>(() => {
            // Never settles.
          }),
      })),
      text: "x",
      timeoutMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "whatsapp send did not finish within 5s",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});
