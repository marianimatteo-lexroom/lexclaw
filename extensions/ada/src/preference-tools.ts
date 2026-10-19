import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  adaForgetPreferenceDefinition,
  adaReportFeedbackDefinition,
  adaSetPreferenceDefinition,
} from "./account-tool-definitions.js";
import { executeAdaReportFeedback } from "./feedback.js";
import { maskNumber } from "./inbound-log.js";
import { PREFERENCE_LIMITS, type Preference } from "./memory-contract.js";
import { openAdaMemoryFromApi } from "./memory.js";
import { ownerToolFactory } from "./owner-tool.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger" | "config">;

/** A topic key such as `signature` or `address_form`: lower-case words joined by underscores. */
export function normalizePreferenceKey(raw: string): string | null {
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return key && key.length <= PREFERENCE_LIMITS.maxKeyChars ? key : null;
}

type PreferenceView = Array<{ key: string; text: string }>;

const view = (preferences: readonly Preference[]): PreferenceView =>
  preferences.map(({ key, text }) => ({ key, text }));

/** Saves or replaces one standing preference on the asking number's own memory. */
export async function executeAdaSetPreference(
  api: StoreApi,
  owner: string,
  params: { key: string; text: string },
  now: Date = new Date(),
) {
  const key = normalizePreferenceKey(params.key);
  const text = params.text.replace(/\s+/gu, " ").trim();
  if (!key) {
    return {
      ok: false as const,
      error: `The key must be a short topic of at most ${PREFERENCE_LIMITS.maxKeyChars} letters, digits or underscores, such as signature or length.`,
    };
  }
  if (!text || text.length > PREFERENCE_LIMITS.maxTextChars) {
    return {
      ok: false as const,
      error: `The preference must be one sentence of at most ${PREFERENCE_LIMITS.maxTextChars} characters. Shorten it and try again.`,
    };
  }
  try {
    const memory = await openAdaMemoryFromApi(api, owner);
    const saved = await memory.setPreference(key, text, now.getTime());
    const preferences = view(await memory.listPreferences());
    if (!saved.ok) {
      return {
        ok: false as const,
        error: `Already ${PREFERENCE_LIMITS.maxCount} preferences saved. Ask which one to drop, then call ada_forget_preference for it.`,
        preferences,
      };
    }
    return { ok: true as const, key, replaced: saved.replaced, preferences };
  } catch (error) {
    api.logger.error(
      `ada preference not saved owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not save the preference." };
  }
}

/** Removes one standing preference of the asking number. */
export async function executeAdaForgetPreference(
  api: StoreApi,
  owner: string,
  params: { key: string },
) {
  const key = normalizePreferenceKey(params.key);
  if (!key) {
    return { ok: false as const, error: "Name the key of a saved preference." };
  }
  try {
    const memory = await openAdaMemoryFromApi(api, owner);
    const removed = await memory.removePreference(key);
    return {
      ok: true as const,
      key,
      removed,
      preferences: view(await memory.listPreferences()),
    };
  } catch (error) {
    api.logger.error(
      `ada preference not removed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false as const, error: "Ada could not remove the preference." };
  }
}

/** The model-facing tools that save a person's preferences and pass their product feedback on. */
export const adaPreferenceTools = {
  set: {
    ...adaSetPreferenceDefinition,
    optional: true as const,
    factory: ownerToolFactory(adaSetPreferenceDefinition, (args, { owner, api }) =>
      executeAdaSetPreference(api, owner, args),
    ),
  },
  forget: {
    ...adaForgetPreferenceDefinition,
    optional: true as const,
    factory: ownerToolFactory(adaForgetPreferenceDefinition, (args, { owner, api }) =>
      executeAdaForgetPreference(api, owner, args),
    ),
  },
  reportFeedback: {
    ...adaReportFeedbackDefinition,
    optional: true as const,
    factory: ownerToolFactory(adaReportFeedbackDefinition, (args, { owner, api }) =>
      executeAdaReportFeedback(api, owner, args),
    ),
  },
};
