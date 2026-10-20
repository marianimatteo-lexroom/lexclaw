import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { noteConnectOffer } from "./connect-offers.js";
import { localIsoDate } from "./deadline-time.js";
import { openAdaLexroomAccountFromApi } from "./lexroom-account.js";
import { lexroomConnectConfigFrom, readLexroomConnectConfig } from "./lexroom-connect.js";
import { LEXROOM_OFFER_DECLINED_KEY } from "./memory-contract.js";
import { openAdaMemoryFromApi } from "./memory.js";
import { lawyerOwner, resolveHookTurnOwner } from "./owner.js";
import { effectiveTimeZone } from "./schedule.js";
import { hasLiveShortLink } from "./short-links.js";

/** After a "no", the offer stays quiet this long. */
export const LEXROOM_OFFER_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GRANTS = 1000;

export type LexroomNudgeFacts = {
  nowMs: number;
  /** The number's own zone: "once a day" means once per day on that person's clock. */
  timeZone: string;
  connected: boolean;
  /** A connect link was sent and has not expired or been used. */
  linkLive: boolean;
  lastNudgeAtMs: number | null;
  declinedAtMs: number | null;
};

/** The deterministic part of the offer: whether this turn may carry it. The model judges the rest. */
export function lexroomNudgeDue(facts: LexroomNudgeFacts): boolean {
  if (facts.connected || facts.linkLive) {
    return false;
  }
  if (facts.declinedAtMs !== null && facts.nowMs - facts.declinedAtMs < LEXROOM_OFFER_COOLDOWN_MS) {
    return false;
  }
  return (
    facts.lastNudgeAtMs === null ||
    localIsoDate(facts.lastNudgeAtMs, facts.timeZone) !== localIsoDate(facts.nowMs, facts.timeZone)
  );
}

/** Handed to the model on the one turn of a day that may carry the offer. */
export const LEXROOM_NUDGE_NOTE = [
  "# Offer to connect Lexroom (this turn only)",
  "This person has not connected their Lexroom account. If their message is a legal question that you answer in this turn (about the law, a case, a statute, a contract or a procedure), answer it as usual first, then end the same message with a short, natural offer, one or two sentences: with Lexroom connected, your answers are grounded in Lexroom's case law and doctrine research, with the sources. Ask whether they would like to connect it.",
  "Do not call ada_lexroom_connect and do not write a link yet: send the link only after they say yes. Never tell them to type a word or phrase; they answer in their own words. Write in the language of their latest message, do not sign the message, and do not press or repeat the offer.",
  "If their message is not a legal question (a greeting, thanks, a scheduling, mail or calendar matter, small talk), do not mention Lexroom at all.",
].join("\n");

async function lexroomConnected(api: OpenClawPluginApi, owner: string): Promise<boolean> {
  if (await (await openAdaLexroomAccountFromApi(api, owner)).readAccount()) {
    return true;
  }
  const staticToken = lexroomConnectConfigFrom(api.pluginConfig).accessToken?.trim();
  return owner === lawyerOwner(api.config) && Boolean(staticToken);
}

/**
 * Adds the offer to the prompt of a person's own turn when it is due. The slot of the day is
 * spent when the note is handed out, so a retry of the same run still gets it and no other run
 * does; the model decides whether the message was a legal question worth the offer.
 */
export function registerLexroomNudge(
  api: OpenClawPluginApi,
  now: () => Date = () => new Date(),
): void {
  const grants = new Map<string, string>();
  api.on(
    "before_prompt_build",
    async (_event, ctx) => {
      try {
        if (ctx.trigger !== undefined && ctx.trigger !== "user") {
          return undefined;
        }
        const authority = ctx.toolAuthority;
        if (!authority?.allows("ada_lexroom_connect")) {
          return undefined;
        }
        const turn = resolveHookTurnOwner(ctx);
        if (!turn.ok) {
          return undefined;
        }
        const { owner } = turn;
        if (ctx.runId && grants.get(owner) === ctx.runId) {
          return { prependContext: LEXROOM_NUDGE_NOTE };
        }
        const clock = now();
        if (!readLexroomConnectConfig(lexroomConnectConfigFrom(api.pluginConfig)).ok) {
          return undefined;
        }
        const linkLive = hasLiveShortLink("l", owner, clock);
        const connected = linkLive ? false : await lexroomConnected(api, owner);
        if (linkLive || connected) {
          return undefined;
        }
        const memory = await openAdaMemoryFromApi(api, owner);
        const [wake, preferences, profile] = await Promise.all([
          memory.readWake(),
          memory.listPreferences(),
          memory.readProfile(),
        ]);
        const due = lexroomNudgeDue({
          nowMs: clock.getTime(),
          timeZone: effectiveTimeZone(profile?.timezone),
          connected,
          linkLive,
          lastNudgeAtMs: wake.lastConnectNudgeAtMs,
          declinedAtMs:
            preferences.find((entry) => entry.key === LEXROOM_OFFER_DECLINED_KEY)?.updatedAtMs ??
            null,
        });
        if (!due) {
          return undefined;
        }
        authority.assertActive();
        await memory.writeWake({ lastConnectNudgeAtMs: clock.getTime() });
        noteConnectOffer(owner, "lexroom_nudge", clock.getTime());
        if (ctx.runId) {
          grants.delete(owner);
          grants.set(owner, ctx.runId);
          if (grants.size > MAX_GRANTS) {
            grants.delete(grants.keys().next().value ?? owner);
          }
        }
        return { prependContext: LEXROOM_NUDGE_NOTE };
      } catch (error) {
        api.logger.error(
          `ada lexroom offer check failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
        return undefined;
      }
    },
    { requiresToolAuthority: true },
  );
}
