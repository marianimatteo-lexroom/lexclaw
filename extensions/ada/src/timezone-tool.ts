import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { maskNumber } from "./inbound-log.js";
import { openAdaMemoryFromApi } from "./memory.js";
import { inboundLanguage } from "./research-link-outbound.js";
import { nextSlotMs, validTimeZone } from "./schedule.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

/** The IANA name the runtime resolves `name` to, or null when it is not a named zone. */
function canonicalZone(name: string): string | null {
  const zone = name.trim();
  if (!zone || /^[+-]/u.test(zone) || !validTimeZone(zone)) {
    return null;
  }
  return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
}

/**
 * Saves the time zone of the person asking: their morning brief is sent at 07:40 on that clock,
 * from the next poll on. Writes only that number's own profile.
 */
export async function executeAdaSetTimezone(
  api: StoreApi,
  owner: string,
  params: { timezone: string },
  now: Date = new Date(),
) {
  const zone = canonicalZone(params.timezone);
  if (!zone) {
    return {
      ok: false as const,
      error: `"${params.timezone}" is not an IANA time zone. Use a name such as Europe/Rome or Asia/Shanghai.`,
    };
  }
  try {
    const memory = await openAdaMemoryFromApi(api, owner);
    // Only used if this creates the profile: the language the number last wrote in, so the
    // brief is not forced into Italian after a restart.
    await memory.setProfileTimezone(zone, now.getTime(), inboundLanguage(owner));
  } catch (error) {
    api.logger.error(
      `ada time zone not saved owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not save the time zone." };
  }
  return {
    ok: true as const,
    timezone: zone,
    nextBriefAt: new Date(nextSlotMs(now.getTime(), zone)).toISOString(),
  };
}
