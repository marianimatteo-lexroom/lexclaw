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

/** Handed to the model on the one turn of a day that may carry the offer, which opens the reply. */
export const LEXROOM_NUDGE_NOTE = [
  "# Offer to connect Lexroom (this turn only)",
  "This person has not connected their Lexroom account. If their message is a legal question (about the law, a case, a statute, a contract or a procedure), open your reply with one or two short, natural sentences: with Lexroom connected, your answers are grounded in Lexroom's case law and doctrine research, with the sources. Call ada_lexroom_connect first and put the short link it returns in that opening; if the call fails, offer to send the link instead.",
  "Then, in the same reply, give your full answer to the question as usual: the answer never waits for them to connect or to reply to the offer. Never tell them to type a word or phrase, and do not press or repeat the offer. Write in the language of their latest message and do not sign the message.",
  "If their message is not a legal question (a greeting, thanks, a scheduling, mail or calendar matter, small talk), do not mention Lexroom at all and do not call the tool.",
].join("\n");

/**
 * Handed to the model on every person's own turn while Lexroom is connected: Lexroom answers
 * legal questions, and Ada's own knowledge is only the fallback when Lexroom cannot.
 */
export const LEXROOM_RESEARCH_FIRST_NOTE = [
  "# Lexroom research first",
  'This person has Lexroom connected, and Lexroom is always the preferred way to answer a legal question. If their message is a legal question (about the law, a case, a statute, a contract or a procedure), call ada_research before you write any answer, and do not answer from your own knowledge first. Put the question and the facts it needs in query, in the language they wrote it; use the matter id of the matter it concerns when your memory knows it, otherwise "general"; pass modules only when the question clearly belongs to one area. Ada sends the researched answer with its sources herself: follow the tool result, which tells you to end the turn with exactly NO_REPLY when the person was already told the research is running.',
  "Only if ada_research cannot start or returns an error, or reason timeout, answer from your own knowledge, and say so in one short sentence in their language: that Lexroom did not answer and this comes from general knowledge, with no invented sources, case citations or quotations. A not_connected or forbidden result means the connection is the problem: follow the Lexroom connect rules instead.",
  "A follow-up that only asks you to clarify, shorten, translate or reformat an answer already given needs no new research. For everything that is not a legal question (a greeting, thanks, scheduling, mail, calendar, small talk) do not call it. Write in the language of their latest message and do not sign the message.",
].join("\n");

async function lexroomConnected(api: OpenClawPluginApi, owner: string): Promise<boolean> {
  if (await (await openAdaLexroomAccountFromApi(api, owner)).readAccount()) {
    return true;
  }
  const staticToken = lexroomConnectConfigFrom(api.pluginConfig).accessToken?.trim();
  return owner === lawyerOwner(api.config) && Boolean(staticToken);
}

/**
 * Adds to the prompt of a person's own turn: the Lexroom-first instruction while Lexroom is
 * connected, otherwise, when it is due, the offer to connect. The slot of the day is
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
        if (!authority) {
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
        const connected = await lexroomConnected(api, owner);
        if (connected) {
          return authority.allows("ada_research")
            ? { prependContext: LEXROOM_RESEARCH_FIRST_NOTE }
            : undefined;
        }
        const linkLive = hasLiveShortLink("l", owner, clock);
        if (
          linkLive ||
          !authority.allows("ada_lexroom_connect") ||
          !readLexroomConnectConfig(lexroomConnectConfigFrom(api.pluginConfig)).ok
        ) {
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
