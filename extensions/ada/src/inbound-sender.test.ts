import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const writeWake = vi.hoisted(() => vi.fn(async () => undefined));
const openAdaMemoryIfExistsFromApi = vi.hoisted(() => vi.fn());
vi.mock("./memory.js", () => ({
  openAdaMemoryFromApi: vi.fn(),
  openAdaMemoryIfExistsFromApi,
}));

import { isConfiguredLawyerSender, normalizeWhatsAppNumber } from "./google-notify.js";
import { recordSenderInbound } from "./service.js";

function config(defaultTo: string | undefined) {
  return { channels: { "kapso-whatsapp": defaultTo ? { defaultTo } : {} } };
}

function api(defaultTo: string | undefined) {
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return {
    api: { config: config(defaultTo), logger } as unknown as OpenClawPluginApi,
    logger,
  };
}

describe("normalizeWhatsAppNumber", () => {
  it("reduces E.164 and digit forms to the same digits", () => {
    for (const value of [
      "+390000000001",
      "390000000001",
      " +39 000 000 0001 ",
      "whatsapp:+390000000001",
      "kapso-whatsapp:390000000001",
      "390000000001@s.whatsapp.net",
    ]) {
      expect(normalizeWhatsAppNumber(value)).toBe("390000000001");
    }
  });

  it("rejects values that are not phone numbers", () => {
    for (const value of ["", "123", "120363000000000000@g.us", "lawyer", undefined, 5]) {
      expect(normalizeWhatsAppNumber(value)).toBeNull();
    }
  });
});

describe("isConfiguredLawyerSender", () => {
  it("matches across E.164 and digit forms", () => {
    expect(isConfiguredLawyerSender(config("+390000000001"), "390000000001")).toBe(true);
    expect(isConfiguredLawyerSender(config("390000000001"), "+390000000001")).toBe(true);
    expect(isConfiguredLawyerSender(config("+390000000001"), undefined, "+39 000 000 0001")).toBe(
      true,
    );
  });

  it("rejects another sender, no sender, and a missing defaultTo", () => {
    expect(isConfiguredLawyerSender(config("+390000000001"), "+390000000002")).toBe(false);
    expect(isConfiguredLawyerSender(config("+390000000001"))).toBe(false);
    expect(isConfiguredLawyerSender(config("+390000000001"), undefined, "")).toBe(false);
    expect(isConfiguredLawyerSender(config(undefined), "+390000000001")).toBe(false);
    expect(isConfiguredLawyerSender({}, "+390000000001")).toBe(false);
  });
});

describe("recordSenderInbound", () => {
  beforeEach(() => {
    writeWake.mockClear();
    openAdaMemoryIfExistsFromApi.mockReset();
    openAdaMemoryIfExistsFromApi.mockImplementation(async (_api: unknown, owner: string) =>
      owner === "390000000002"
        ? null
        : { readWake: async () => ({ heldPlanJson: null, heldBriefDay: null }), writeWake },
    );
  });

  it("opens the window of the sender who wrote, in that sender's own memory", async () => {
    const { api: ok } = api("+390000000001");
    await recordSenderInbound({
      api: ok,
      atMs: 1,
      channelId: "kapso-whatsapp",
      senders: ["390000000001"],
    });
    expect(writeWake).toHaveBeenCalledWith({ lastLawyerInboundAtMs: 1 });
    expect(openAdaMemoryIfExistsFromApi).toHaveBeenCalledExactlyOnceWith(ok, "390000000001");

    writeWake.mockClear();
    openAdaMemoryIfExistsFromApi.mockClear();
    await recordSenderInbound({
      api: ok,
      atMs: 4,
      channelId: "kapso-whatsapp",
      senders: ["+39 333 111 1111"],
    });
    expect(openAdaMemoryIfExistsFromApi).toHaveBeenCalledExactlyOnceWith(ok, "393331111111");
    expect(writeWake).toHaveBeenCalledWith({ lastLawyerInboundAtMs: 4 });
  });

  it("creates nothing for a sender with no memory yet, and says why", async () => {
    const { api: other, logger } = api("+390000000001");
    await recordSenderInbound({
      api: other,
      atMs: 2,
      channelId: "kapso-whatsapp",
      senders: ["+390000000002", undefined],
    });
    expect(writeWake).not.toHaveBeenCalled();
    const lines = logger.info.mock.calls.map(([line]) => String(line));
    expect(lines).toEqual([
      expect.stringContaining("stage=wake_window reason=no_digest_for_sender sender=+39…0002"),
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips other channels and senders that are not phone numbers, and logs each", async () => {
    const { api: other, logger } = api("+390000000001");
    await recordSenderInbound({
      api: other,
      atMs: 3,
      channelId: "telegram",
      senders: ["390000000001"],
    });
    await recordSenderInbound({ api: other, atMs: 3, senders: [] });
    await recordSenderInbound({ api: other, atMs: 3, senders: ["120363000000000000@g.us"] });
    expect(writeWake).not.toHaveBeenCalled();
    const lines = logger.info.mock.calls.map(([line]) => String(line));
    expect(lines[0]).toContain("reason=not_whatsapp_channel");
    expect(lines[1]).toContain("reason=sender_not_a_phone_number");
    expect(lines[2]).toContain("reason=sender_not_a_phone_number");
  });
});
