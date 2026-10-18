import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";

const writeWake = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./memory.js", () => ({
  openAdaMemoryFromApi: vi.fn(async () => ({
    readWake: async () => ({ heldPlanJson: null }),
    writeWake,
  })),
}));

import { isConfiguredLawyerSender, normalizeWhatsAppNumber } from "./google-notify.js";
import { recordLawyerInbound } from "./service.js";

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

describe("recordLawyerInbound", () => {
  beforeEach(() => {
    writeWake.mockClear();
  });

  it("records the wake only for the configured lawyer", async () => {
    const { api: ok } = api("+390000000001");
    await recordLawyerInbound({
      api: ok,
      atMs: 1,
      channelId: "kapso-whatsapp",
      senders: ["390000000001"],
    });
    expect(writeWake).toHaveBeenCalledWith({ lastLawyerInboundAtMs: 1 });
  });

  it("does not record any other sender, quietly: they chat normally but never open the window", async () => {
    const { api: other, logger } = api("+390000000001");
    await recordLawyerInbound({
      api: other,
      atMs: 2,
      channelId: "kapso-whatsapp",
      senders: ["+390000000002", undefined],
    });
    await recordLawyerInbound({ api: other, atMs: 3, senders: [] });
    expect(writeWake).not.toHaveBeenCalled();
    const lines = logger.info.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(
      "stage=wake_window reason=not_the_configured_lawyer sender=+39…0002",
    );
    expect(lines[1]).toContain("reason=not_the_configured_lawyer sender=unknown");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
