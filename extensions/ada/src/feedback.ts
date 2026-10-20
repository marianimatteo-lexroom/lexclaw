import { createHash } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { maskNumber } from "./inbound-log.js";
import {
  FEEDBACK_MAX_TEXT_CHARS,
  type FeedbackCategory,
  type FeedbackEntry,
} from "./memory-contract.js";
import { openAdaRegistryFromApi } from "./memory.js";
import { inboundLanguage } from "./research-link-outbound.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

/**
 * Records a product problem (a bug, a missing feature, a wrong answer, a complaint) for the team.
 * It goes to the registry file on the volume, which holds every number's reports side by side;
 * nothing is sent to anyone. The reporting number comes from the host, never from the model.
 */
export async function executeAdaReportFeedback(
  api: StoreApi,
  owner: string,
  params: { category: FeedbackCategory; text: string },
  now: Date = new Date(),
) {
  const text = params.text.replace(/\s+/gu, " ").trim();
  if (!text || text.length > FEEDBACK_MAX_TEXT_CHARS) {
    return {
      ok: false as const,
      error: `Describe the problem in at most ${FEEDBACK_MAX_TEXT_CHARS} characters and try again.`,
    };
  }
  try {
    const registry = await openAdaRegistryFromApi(api);
    await registry.addFeedback({
      number: owner,
      atMs: now.getTime(),
      category: params.category,
      text,
      language: inboundLanguage(owner) ?? "",
    });
  } catch (error) {
    api.logger.error(
      `ada feedback not saved owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not record the feedback." };
  }
  return { ok: true as const, passedToTeam: true as const };
}

/**
 * What the admin endpoints show of a number: the last four digits and a stable pseudonym to
 * group one person's rows across them. The hash is not a secret (phone numbers are a small
 * space); it only keeps the full number out of what an endpoint returns.
 */
export function adminNumberView(number: string) {
  return {
    numberLast4: number.slice(-4),
    numberHash: createHash("sha256").update(`ada-feedback:${number}`).digest("hex").slice(0, 12),
  };
}

/** What the admin endpoint shows of a report. */
export function feedbackView(entry: FeedbackEntry) {
  return {
    id: entry.id,
    ...adminNumberView(entry.number),
    at: new Date(entry.atMs).toISOString(),
    atMs: entry.atMs,
    category: entry.category,
    text: entry.text,
    language: entry.language || null,
    status: entry.status,
  };
}
