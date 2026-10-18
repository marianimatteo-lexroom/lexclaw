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
  it("texts the number that connected the account, and never the configured lawyer", async () => {
    const sendText = vi.fn(async () => ({ ok: true }));
    const result = await sendGoogleConnectedNotice({
      config,
      owner: "393331111111",
      email: "anna@example.com",
      loadAdapter: async () => ({ sendText }),
    });
    expect(result).toEqual({ ok: true });
    expect(readAdaWhatsAppTarget(config)).toBe("+390000000000");
    expect(sendText).toHaveBeenCalledExactlyOnceWith({
      cfg: config,
      to: "+393331111111",
      text: "Gmail and Calendar are connected. I can send mail when you say so.",
    });
  });

  it("does not send when the adapter is missing", async () => {
    const sendText = vi.fn();
    expect(
      await sendGoogleConnectedNotice({
        config,
        owner: "393331111111",
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

  it("texts the number it is given through the Kapso adapter", async () => {
    const sendText = vi.fn(async () => undefined);
    const result = await sendAdaWhatsAppText({
      api: apiWith(async () => ({ sendText })),
      to: "+393331111111",
      text: "Ciao",
    });
    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith({ cfg: config, to: "+393331111111", text: "Ciao" });
  });

  it("reports a missing adapter and a failing send without throwing", async () => {
    expect(
      await sendAdaWhatsAppText({ api: apiWith(async () => null), to: "+393331111111", text: "x" }),
    ).toEqual({
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
        to: "+393331111111",
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
      to: "+393331111111",
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
