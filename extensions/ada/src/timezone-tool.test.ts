import { beforeEach, describe, expect, it, vi } from "vitest";

const memory = vi.hoisted(() => ({
  opened: [] as string[],
  setProfileTimezone: vi.fn(),
  open: vi.fn(),
}));
vi.mock("./memory.js", () => ({ openAdaMemoryFromApi: memory.open }));

import { clearInboundLanguages, recordInboundLanguage } from "./research-link-outbound.js";
import { executeAdaSetTimezone } from "./timezone-tool.js";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const api = { logger, runtimeSource: "/fake/index.ts", runtime: {}, config: {} } as never;
const OWNER = "393331111111";
const NOW = new Date("2026-10-06T03:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  clearInboundLanguages();
  memory.opened.length = 0;
  memory.setProfileTimezone.mockResolvedValue(undefined);
  memory.open.mockImplementation(async (_api: unknown, owner: string) => {
    memory.opened.push(owner);
    return { setProfileTimezone: memory.setProfileTimezone };
  });
});

describe("ada_set_timezone", () => {
  it("saves the zone on the asking number's own memory and says when the brief comes", async () => {
    const result = await executeAdaSetTimezone(api, OWNER, { timezone: "Asia/Shanghai" }, NOW);
    expect(result).toEqual({
      ok: true,
      timezone: "Asia/Shanghai",
      nextBriefAt: "2026-10-06T23:40:00.000Z",
    });
    expect(memory.opened).toEqual([OWNER]);
    expect(memory.setProfileTimezone).toHaveBeenCalledWith(
      "Asia/Shanghai",
      NOW.getTime(),
      undefined,
    );
  });

  it("passes the language the number last wrote in, and only that number's", async () => {
    recordInboundLanguage(OWNER, "Hello, I am in Shanghai for the next two weeks");
    recordInboundLanguage("393332222222", "Buongiorno, sono a Milano");
    await executeAdaSetTimezone(api, OWNER, { timezone: "Asia/Shanghai" }, NOW);
    expect(memory.setProfileTimezone).toHaveBeenCalledWith("Asia/Shanghai", NOW.getTime(), "en");
  });

  it("stores the canonical spelling of a zone written in another case", async () => {
    const result = await executeAdaSetTimezone(api, OWNER, { timezone: " europe/rome " }, NOW);
    expect(result).toMatchObject({ ok: true, timezone: "Europe/Rome" });
    expect(memory.setProfileTimezone).toHaveBeenCalledWith("Europe/Rome", NOW.getTime(), undefined);
  });

  it.each(["Mars/Olympus", "", "+08:00", "Shanghai time"])(
    "refuses %j and saves nothing",
    async (timezone) => {
      const result = await executeAdaSetTimezone(api, OWNER, { timezone }, NOW);
      expect(result).toMatchObject({ ok: false });
      expect(memory.open).not.toHaveBeenCalled();
    },
  );

  it("reports a store failure without its cause", async () => {
    memory.setProfileTimezone.mockRejectedValue(new Error("sqlite locked at /secret/path"));
    const result = await executeAdaSetTimezone(api, OWNER, { timezone: "Asia/Shanghai" }, NOW);
    expect(result).toEqual({ ok: false, error: "Ada could not save the time zone." });
    expect(JSON.stringify(result)).not.toContain("/secret");
  });
});
