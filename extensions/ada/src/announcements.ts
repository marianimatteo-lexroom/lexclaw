import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import { appendAssistantMirrorMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { whatsappWindowOpen } from "./collector.js";
import { adminNumberView } from "./feedback.js";
import { openAdaGoogleAccountFromApi } from "./google-account.js";
import { sendAdaWhatsAppText } from "./google-notify.js";
import { openAdaGranolaAccountFromApi } from "./granola-account.js";
import { maskNumber } from "./inbound-log.js";
import { openAdaLexroomAccountFromApi } from "./lexroom-account.js";
import {
  ANNOUNCEMENTS_OFF_KEY,
  type Announcement,
  type AnnouncementDelivery,
} from "./memory-contract.js";
import {
  openAdaMemoryIfExistsFromApi,
  openAdaRegistryFromApi,
  type MemoryStore,
} from "./memory.js";
import { openAdaOutlookAccountFromApi } from "./outlook-account.js";
import { sessionKeyOwner, toOwner } from "./owner.js";
import { resolveLanguage, type Language } from "./research-link-outbound.js";
import { lastSenderInboundAt } from "./research-push.js";
import { stripTrailingSignature } from "./signature.js";
import { ADA_WHATSAPP_CHANNEL } from "./whatsapp-number.js";

/**
 * Product news ("what's new") reaches each known WhatsApp number once, as a message Ada herself
 * sent: it is written into that number's conversation as an assistant turn, so a reply such as
 * "yes, send me the link" is understood. The team creates an announcement through the admin
 * endpoint; the registry file holds the announcement and one delivery row per number, which is
 * the dedupe.
 *
 * Delivery is free text, so it only goes out inside the number's 24-hour WhatsApp window. A number
 * outside it simply stays without a row and gets the announcement right after Ada answers its
 * next message, which is when the window is open again. The morning brief is not used for this:
 * it only exists for numbers with Google connected.
 */

export const ANNOUNCEMENT_LANGUAGES: readonly Language[] = ["it", "en", "es", "fr", "de"];
export const ANNOUNCEMENT_MAX_TEXT_CHARS = 1500;
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const MAX_EXCLUDED = 1000;

type FeatureProbe = (api: DeliveryApi, owner: string) => Promise<boolean>;

/** The features an announcement can be about, and how to tell that a number already has one. */
const FEATURE_PROBES: Record<string, FeatureProbe> = {
  granola: async (api, owner) =>
    (await (await openAdaGranolaAccountFromApi(api, owner)).readAccount()) !== null,
  google: async (api, owner) =>
    (await (await openAdaGoogleAccountFromApi(api, owner)).readAccount()) !== null,
  lexroom: async (api, owner) =>
    (await (await openAdaLexroomAccountFromApi(api, owner)).readAccount()) !== null,
  outlook: async (api, owner) =>
    (await (await openAdaOutlookAccountFromApi(api, owner)).readAccount()) !== null,
};

export const ANNOUNCEMENT_FEATURES = Object.keys(FEATURE_PROBES);

export type AnnouncementInput =
  | { ok: true; announcement: Announcement; dryRun: boolean; exclude: string[] }
  | { ok: false; error: string };

/** The announcement an admin request body describes, or the reason it is refused. */
export function parseAnnouncementInput(body: unknown, nowMs: number): AnnouncementInput {
  const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!ID.test(id)) {
    return { ok: false, error: "id must be a slug: lower-case letters, digits, - or _" };
  }
  const rawTexts =
    input.texts && typeof input.texts === "object" ? (input.texts as Record<string, unknown>) : {};
  const texts: Record<string, string> = {};
  for (const [language, value] of Object.entries(rawTexts)) {
    if (!(ANNOUNCEMENT_LANGUAGES as readonly string[]).includes(language)) {
      return { ok: false, error: `texts.${language} is not a supported language` };
    }
    const text = typeof value === "string" ? value.trim() : "";
    if (!text || text.length > ANNOUNCEMENT_MAX_TEXT_CHARS) {
      return {
        ok: false,
        error: `texts.${language} must be 1 to ${ANNOUNCEMENT_MAX_TEXT_CHARS} characters`,
      };
    }
    texts[language] = text;
  }
  if (!texts.it || !texts.en) {
    return { ok: false, error: "texts needs at least it and en" };
  }
  const feature = typeof input.feature === "string" && input.feature.trim() ? input.feature : null;
  if (feature !== null && !ANNOUNCEMENT_FEATURES.includes(feature)) {
    return { ok: false, error: `feature must be one of ${ANNOUNCEMENT_FEATURES.join(", ")}` };
  }
  const rawExclude = input.exclude ?? [];
  if (!Array.isArray(rawExclude) || rawExclude.length > MAX_EXCLUDED) {
    return { ok: false, error: `exclude must be a list of at most ${MAX_EXCLUDED} numbers` };
  }
  const exclude: string[] = [];
  for (const value of rawExclude) {
    const number =
      typeof value === "string" || typeof value === "number" ? toOwner(String(value)) : null;
    if (!number) {
      return {
        ok: false,
        error: "exclude must hold numbers in E.164 digits, such as 393331234567",
      };
    }
    if (!exclude.includes(number)) {
      exclude.push(number);
    }
  }
  return {
    ok: true,
    announcement: { id, texts, feature, createdAtMs: nowMs },
    dryRun: input.dryRun === true,
    exclude,
  };
}

/** A conversation Ada has with one number: where the announcement is sent and written down. */
export type AnnouncementRecipient = { owner: string; sessionKey: string; sessionId: string };

type DeliveryApi = Pick<
  OpenClawPluginApi,
  "config" | "logger" | "runtime" | "runtimeSource" | "pluginConfig"
>;

/** What delivery needs from the running Ada, injectable so the rules can be tested alone. */
export type AnnouncementDeps = {
  registry: () => Promise<MemoryStore>;
  now: () => number;
  windowOpen: (owner: string) => Promise<boolean>;
  optedOut: (owner: string) => Promise<boolean>;
  hasFeature: (feature: string, owner: string) => Promise<boolean>;
  language: (owner: string) => Promise<Language>;
  send: (owner: string, text: string) => Promise<{ ok: boolean; error?: string }>;
  recordInHistory: (
    recipient: AnnouncementRecipient,
    announcementId: string,
    text: string,
  ) => Promise<boolean>;
  log: Pick<OpenClawPluginApi["logger"], "error" | "info">;
};

/** The words of `announcement` for `language`, Italian when it has none for it, without a signature. */
export function resolveAnnouncementText(announcement: Announcement, language: Language): string {
  const text = announcement.texts[language] ?? announcement.texts.it ?? "";
  return stripTrailingSignature(text);
}

export type AnnouncementOutcome = {
  status: "sent" | "skipped" | "pending" | "would_send";
  reason: string | null;
  language: string | null;
  /** The message for the number, present while it is still to be sent or was just sent. */
  text: string | null;
  recordedInHistory?: boolean;
};

const recorded = (delivery: AnnouncementDelivery): AnnouncementOutcome => ({
  status: delivery.status,
  reason: delivery.reason,
  language: null,
  text: null,
});

/**
 * What happens to one number for one announcement, in this order: an earlier delivery stands; a
 * number the team excluded (already told by hand) is skipped for good; a number that opted out or already has the feature is skipped for good; a closed window leaves
 * it pending; otherwise it is sent. With `dryRun` nothing is sent or recorded.
 */
export async function deliverAnnouncement(
  deps: AnnouncementDeps,
  announcement: Announcement,
  recipient: AnnouncementRecipient,
  earlier: AnnouncementDelivery | undefined,
  options: { dryRun?: boolean; exclude?: ReadonlySet<string> } = {},
): Promise<AnnouncementOutcome> {
  if (earlier) {
    return recorded(earlier);
  }
  const { owner } = recipient;
  const registry = await deps.registry();
  const skip = async (reason: string): Promise<AnnouncementOutcome> => {
    if (!options.dryRun) {
      await registry.claimAnnouncementDelivery({
        announcementId: announcement.id,
        number: owner,
        status: "skipped",
        reason,
        atMs: deps.now(),
      });
    }
    return { status: "skipped", reason, language: null, text: null };
  };
  if (options.exclude?.has(owner)) {
    return await skip("excluded");
  }
  if (await deps.optedOut(owner)) {
    return await skip("announcements_off");
  }
  if (announcement.feature && (await deps.hasFeature(announcement.feature, owner))) {
    return await skip("feature_connected");
  }
  const language = await deps.language(owner);
  const text = resolveAnnouncementText(announcement, language);
  const pending = (reason: string): AnnouncementOutcome => ({
    status: "pending",
    reason,
    language,
    text,
  });
  if (!(await deps.windowOpen(owner))) {
    return pending("window_closed");
  }
  if (options.dryRun) {
    return { status: "would_send", reason: null, language, text };
  }
  const claimed = await registry.claimAnnouncementDelivery({
    announcementId: announcement.id,
    number: owner,
    status: "sent",
    reason: null,
    atMs: deps.now(),
  });
  if (!claimed) {
    return pending("delivery_in_progress");
  }
  const sent = await deps.send(owner, text);
  if (!sent.ok) {
    await registry.releaseAnnouncementDelivery(announcement.id, owner);
    deps.log.error(
      `ada announcement not sent id=${announcement.id} owner=${maskNumber(owner)}: ${sent.error ?? "unknown"}`,
    );
    return pending("send_failed");
  }
  const recordedInHistory = await deps
    .recordInHistory(recipient, announcement.id, text)
    .catch((error: unknown) => {
      deps.log.error(
        `ada announcement not in history id=${announcement.id} owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return false;
    });
  return { status: "sent", reason: null, language, text, recordedInHistory };
}

/** The delivery rows by announcement id and number. */
export function indexDeliveries(deliveries: readonly AnnouncementDelivery[]) {
  const index = new Map<string, AnnouncementDelivery>();
  for (const delivery of deliveries) {
    index.set(`${delivery.announcementId}\n${delivery.number}`, delivery);
  }
  return (announcementId: string, number: string) => index.get(`${announcementId}\n${number}`);
}

/**
 * Runs `announcement` over `recipients`, one at a time so a failing number never holds up another.
 * The sends are free text: a number outside its 24-hour window stays pending.
 */
export async function deliverToRecipients(
  deps: AnnouncementDeps,
  announcement: Announcement,
  recipients: readonly AnnouncementRecipient[],
  options: { dryRun?: boolean; exclude?: readonly string[] } = {},
) {
  const deliveryOf = indexDeliveries(await (await deps.registry()).listAnnouncementDeliveries());
  const exclude = new Set(options.exclude ?? []);
  // An excluded number with no conversation yet is marked too, or it would get the news later.
  const known = new Set(recipients.map((recipient) => recipient.owner));
  const everyone = [
    ...recipients,
    ...[...exclude]
      .filter((owner) => !known.has(owner))
      .toSorted()
      .map((owner) => ({ owner, sessionKey: "", sessionId: "" })),
  ];
  const results: Array<{ recipient: AnnouncementRecipient; outcome: AnnouncementOutcome }> = [];
  for (const recipient of everyone) {
    const outcome = await deliverAnnouncement(
      deps,
      announcement,
      recipient,
      deliveryOf(announcement.id, recipient.owner),
      { dryRun: options.dryRun, exclude },
    );
    results.push({ recipient, outcome });
  }
  return results;
}

/** What the admin endpoint shows of one number's outcome. */
export function outcomeView(owner: string, outcome: AnnouncementOutcome) {
  return {
    ...adminNumberView(owner),
    status: outcome.status,
    reason: outcome.reason,
    language: outcome.language,
    text: outcome.text,
    ...(outcome.recordedInHistory === undefined
      ? {}
      : { recordedInHistory: outcome.recordedInHistory }),
  };
}

/**
 * The numbers Ada has a private WhatsApp conversation with: one per direct session of the channel,
 * the most recently used when a number has several.
 */
export function listAnnouncementRecipients(
  api: Pick<OpenClawPluginApi, "runtime" | "config">,
): AnnouncementRecipient[] {
  const latest = new Map<string, AnnouncementRecipient & { updatedAt: number }>();
  // The session store is per agent and refuses a listing that names none.
  const entries = listAgentIds(api.config).flatMap((agentId) =>
    api.runtime.agent.session.listSessionEntries({
      agentId,
      readOnly: true,
      includeParticipants: false,
    }),
  );
  for (const { sessionKey, entry } of entries) {
    const owner = sessionKeyOwner(sessionKey);
    if (!owner || !sessionKey.split(":").includes(ADA_WHATSAPP_CHANNEL) || !entry.sessionId) {
      continue;
    }
    const updatedAt = entry.updatedAt ?? 0;
    if (updatedAt >= (latest.get(owner)?.updatedAt ?? -1)) {
      latest.set(owner, { owner, sessionKey, sessionId: entry.sessionId, updatedAt });
    }
  }
  return [...latest.values()]
    .toSorted((a, b) => a.owner.localeCompare(b.owner))
    .map(({ owner, sessionKey, sessionId }) => ({ owner, sessionKey, sessionId }));
}

/** Delivery wired to the running Ada: her WhatsApp channel, per-number memory and sessions. */
export function liveAnnouncementDeps(api: DeliveryApi): AnnouncementDeps {
  return {
    registry: () => openAdaRegistryFromApi(api),
    now: () => Date.now(),
    windowOpen: async (owner) => {
      const memory = await openAdaMemoryIfExistsFromApi(api, owner).catch(() => null);
      const wake = memory ? await memory.readWake() : null;
      const inbound = Math.max(lastSenderInboundAt(owner) ?? 0, wake?.lastLawyerInboundAtMs ?? 0);
      return inbound > 0 && whatsappWindowOpen(inbound, Date.now());
    },
    optedOut: async (owner) => {
      const memory = await openAdaMemoryIfExistsFromApi(api, owner);
      const preferences = (await memory?.listPreferences()) ?? [];
      return preferences.some((preference) => preference.key === ANNOUNCEMENTS_OFF_KEY);
    },
    hasFeature: (feature, owner) => FEATURE_PROBES[feature]?.(api, owner) ?? Promise.resolve(false),
    language: async (owner) =>
      await resolveLanguage(
        "",
        async () =>
          (await (await openAdaMemoryIfExistsFromApi(api, owner))?.readProfile())?.language,
        owner,
      ),
    send: (owner, text) => sendAdaWhatsAppText({ api, to: `+${owner}`, text }),
    recordInHistory: async ({ sessionKey, sessionId }, announcementId, text) => {
      const result = await appendAssistantMirrorMessageByIdentity({
        agentId: resolveAgentIdFromSessionKey(sessionKey),
        sessionKey,
        sessionId,
        text,
        idempotencyKey: `ada-announcement:${announcementId}`,
        updateMode: "none",
      });
      return result.ok;
    },
    log: api.logger,
  };
}

/**
 * Sends the oldest announcement a number has not had yet, if there is one. One per call so a
 * number that was away for a while is not handed a stack of news at once; the next one follows
 * after the next answer.
 */
export async function releasePendingAnnouncement(
  deps: AnnouncementDeps,
  recipient: AnnouncementRecipient,
): Promise<void> {
  const registry = await deps.registry();
  const [announcements, deliveries] = await Promise.all([
    registry.listAnnouncements(),
    registry.listAnnouncementDeliveries(),
  ]);
  const deliveryOf = indexDeliveries(deliveries);
  for (const announcement of announcements) {
    if (deliveryOf(announcement.id, recipient.owner)) {
      continue;
    }
    const outcome = await deliverAnnouncement(deps, announcement, recipient, undefined);
    if (outcome.status !== "skipped") {
      return;
    }
  }
}

/**
 * How long a number's conversation must stay quiet after Ada's last delivered message before the
 * announcement follows. One answer can be several WhatsApp messages (an attachment and its text,
 * a reply to each of two quick questions, a message-tool send before the final answer): the
 * announcement waits for the last of them, so it never lands before or inside the answer.
 */
export const ANNOUNCEMENT_SETTLE_MS = 8_000;

/**
 * After Ada's answer to a number has gone out (so the news never lands before the answer), sends
 * that number the announcement it is still owed. The number's window is open: it just wrote.
 * Every delivered message restarts that number's wait, so the release runs once, after the last;
 * a message received from the number cancels the wait until Ada has answered it.
 */
export function registerAnnouncementRelease(
  api: OpenClawPluginApi,
  options: { settleMs?: number } = {},
): void {
  const deps = liveAnnouncementDeps(api);
  const settleMs = options.settleMs ?? ANNOUNCEMENT_SETTLE_MS;
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  const release = async (owner: string, sessionKey: string) => {
    try {
      const { session } = api.runtime.agent;
      const entry = await (
        session.getSessionEntryAsync ?? ((params) => session.getSessionEntry(params))
      )({ agentId: resolveAgentIdFromSessionKey(sessionKey), sessionKey });
      if (entry?.sessionId) {
        await releasePendingAnnouncement(deps, { owner, sessionKey, sessionId: entry.sessionId });
      }
    } catch (error) {
      api.logger.error(
        `ada announcement release failed owner=${maskNumber(owner)}: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
  };
  // A message from the number means Ada has another answer to give: the announcement waits for
  // the last message of that one, so it never lands between two answers however long they take.
  api.on("message_received", (event, ctx) => {
    if (ctx.channelId !== undefined && ctx.channelId !== ADA_WHATSAPP_CHANNEL) {
      return;
    }
    const owner = toOwner(event.from) ?? toOwner(ctx.senderId) ?? sessionKeyOwner(ctx.sessionKey);
    if (owner) {
      clearTimeout(waiting.get(owner));
      waiting.delete(owner);
    }
  });
  api.on("message_sent", async (event, ctx) => {
    if (!event.success || !event.runId || ctx.channelId !== ADA_WHATSAPP_CHANNEL) {
      return;
    }
    const sessionKey = event.sessionKey ?? ctx.sessionKey;
    const owner = sessionKeyOwner(sessionKey) ?? toOwner(event.to);
    if (!sessionKey || !owner) {
      return;
    }
    clearTimeout(waiting.get(owner));
    const timer = setTimeout(() => {
      waiting.delete(owner);
      void release(owner, sessionKey);
    }, settleMs);
    timer.unref?.();
    waiting.set(owner, timer);
  });
}
