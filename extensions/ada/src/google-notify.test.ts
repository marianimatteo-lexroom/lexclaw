import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  googleConnectedText,
  readAdaWhatsAppTarget,
  sendAdaWhatsAppText,
  sendGoogleConnectedNotice,
} from "./google-notify.js";
import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";

const config = {
  channels: {
    "kapso-whatsapp": { defaultTo: " +390000000000 " },
  },
} as OpenClawPluginApi["config"];

describe("sendGoogleConnectedNotice", () => {
  const OWNER = "393331111111";
  beforeEach(() => {
    clearInboundLanguages();
  });

  async function confirmation(owner = OWNER): Promise<string> {
    const sendText = vi.fn(async () => ({ ok: true }));
    const result = await sendGoogleConnectedNotice({
      config,
      owner,
      email: "anna@example.com",
      loadAdapter: async () => ({ sendText }),
    });
    expect(result).toMatchObject({ ok: true, text: expect.any(String) });
    expect(sendText).toHaveBeenCalledExactlyOnceWith({
      cfg: config,
      to: `+${owner}`,
      text: expect.any(String),
    });
    return (sendText.mock.calls[0] as unknown as [{ text: string }])[0].text;
  }

  it("texts the number that connected the account, and never the configured lawyer", async () => {
    recordInboundLanguage(OWNER, "Give me a new link");
    expect(readAdaWhatsAppTarget(config)).toBe("+390000000000");
    expect(await confirmation()).toBe(
      "Gmail and Calendar are connected: I can read them and, with your yes, send email. Want me to look at today's calendar and inbox?",
    );
  });

  it("confirms in the language of the latest message, and keeps it through an ambiguous one", async () => {
    recordInboundLanguage(OWNER, "Give me a new link");
    recordInboundLanguage(OWNER, "Ok e Google?");
    expect(await confirmation()).toBe(googleConnectedText("it"));
    recordInboundLanguage(OWNER, "ok");
    recordInboundLanguage(OWNER, "https://example.com/neu 👍");
    expect(await confirmation()).toBe(googleConnectedText("it"));
    recordInboundLanguage(OWNER, "Run a digest for me now");
    recordInboundLanguage(OWNER, "ok");
    expect(await confirmation()).toBe(googleConnectedText("en"));
  });

  it("keeps each number's language apart, and falls back to Italian when none is known", async () => {
    recordInboundLanguage(OWNER, "Run a digest for me now");
    expect(await confirmation("393332222222")).toBe(googleConnectedText("it"));
    expect(await confirmation(OWNER)).toBe(googleConnectedText("en"));
  });

  it("has a variant in every language, never carrying the address", () => {
    const texts = (["it", "en", "es", "fr", "de"] as const).map(googleConnectedText);
    expect(new Set(texts).size).toBe(5);
    expect(texts.join("")).not.toContain("@");
  });

  it("does not send when the adapter is missing", async () => {
    expect(
      await sendGoogleConnectedNotice({
        config,
        owner: OWNER,
        email: "lawyer\n@example.com",
        loadAdapter: async () => undefined,
      }),
    ).toEqual({ ok: false, error: "kapso-whatsapp outbound is unavailable" });
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
    expect(result).toEqual({ ok: true, text: "Ciao" });
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
