import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { deadlineDueLabel } from "./deadline-intake.js";
import { diffDaysIso, localIsoDate } from "./deadline-time.js";
import { maskNumber } from "./inbound-log.js";
import { WORK_PROFILE_KEY, type DeadlineItem } from "./memory-contract.js";
import { openAdaMemoryIfExistsFromApi } from "./memory.js";
import { resolveHookTurnOwner } from "./owner.js";
import { markMentioned, mentionedOn, readMarker, writeMarker } from "./proactive-store.js";
import { effectiveTimeZone } from "./schedule.js";

/**
 * Two one-shot notes that ride on an answered turn, inside the 24-hour window the number just
 * opened by writing: the single most time-sensitive open item that was not yet mentioned today
 * (piggyback), and, once after about two weeks of use, an offer to save what Ada learned about how
 * the person works. Neither is a message of its own: the model adds them after answering.
 * A retry of the same run gets the same note again, and no other run does.
 */

/** How long a number has been using Ada before the work-profile offer may come. */
export const WORK_PROFILE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_RUNS = 1000;

/** The open deadline or hearing due today or tomorrow, not yet over, not yet mentioned today. */
export function pickPiggybackItem(params: {
  deadlines: readonly DeadlineItem[];
  mentioned: ReadonlySet<string>;
  nowMs: number;
  timeZone: string;
}): DeadlineItem | null {
  const today = localIsoDate(params.nowMs, params.timeZone);
  return (
    params.deadlines
      .filter((item) => {
        const daysLeft = diffDaysIso(today, item.dueDate);
        return (
          (item.status === "tracked" || item.status === "candidate") &&
          item.dueAtMs > params.nowMs &&
          daysLeft >= 0 &&
          daysLeft <= 1 &&
          !params.mentioned.has(item.id)
        );
      })
      .toSorted(
        (a, b) =>
          a.dueAtMs - b.dueAtMs || Number(b.status === "tracked") - Number(a.status === "tracked"),
      )[0] ?? null
  );
}

function piggybackNote(item: DeadlineItem, matterLabel: string, today: string): string {
  const kind = item.type === "hearing" ? "hearing" : "deadline";
  const when = item.dueDate === today ? "today" : "tomorrow";
  const state =
    item.status === "tracked" ? "tracked" : "found in their mail or calendar and not yet confirmed";
  return [
    "# One open item to mention (this turn only)",
    `Open and time-sensitive: ${kind} for ${JSON.stringify(matterLabel)}, ${when} (${deadlineDueLabel(item)}): ${JSON.stringify(item.title)}. It is ${state}, and it has not been mentioned to them today.`,
    "First answer what they asked, in full. Then add one short line about this item, in the language of their latest message, with no heading, as the last thing you write. Skip it when their message is already about this item, and add nothing else. If they reply to it, use ada_deadline_list and ada_deadline_reply.",
  ].join("\n");
}

/** Handed to the model once, after about two weeks of use. Saving needs their yes. */
export const WORK_PROFILE_NOTE = [
  "# Offer to save what you learned about them (this turn only)",
  "This person has been working with you for about two weeks. After you have answered what they asked, propose once, in the language of their latest message, a short picture of how they work: in your own words, at most three short lines and 300 characters, built only from what you really know (their standing preferences, their matters, how and when they write to you). Then ask whether you should save it.",
  `Save it with ada_set_preference using the key ${WORK_PROFILE_KEY} only after they say yes in any form; if they correct it, save the corrected text; if they say no, save nothing and do not offer again. If you cannot say anything specific and true, skip this offer silently. Never mention this note.`,
].join("\n");

export function registerTurnNotes(
  api: OpenClawPluginApi,
  now: () => Date = () => new Date(),
): void {
  /** The note each number's last run was handed, so a retry of that run gets it again. */
  const handed = new Map<string, { runId: string; note: string }>();
  api.on(
    "before_prompt_build",
    async (_event, ctx) => {
      try {
        if (ctx.trigger !== undefined && ctx.trigger !== "user") {
          return undefined;
        }
        const authority = ctx.toolAuthority;
        const turn = resolveHookTurnOwner(ctx);
        if (!authority || !turn.ok) {
          return undefined;
        }
        const { owner } = turn;
        const earlier = handed.get(owner);
        if (earlier && ctx.runId !== undefined && earlier.runId === ctx.runId) {
          return { prependContext: earlier.note };
        }
        const memory = await openAdaMemoryIfExistsFromApi(api, owner);
        if (!memory) {
          return undefined;
        }
        const nowMs = now().getTime();
        const firstSeenMs = await readMarker(memory, "first_seen");
        if (firstSeenMs === null) {
          await writeMarker(memory, "first_seen", nowMs);
        }
        const timeZone = effectiveTimeZone((await memory.readProfile())?.timezone);
        const day = localIsoDate(nowMs, timeZone);
        let note: string | undefined;
        if (authority.allows("ada_deadline_reply")) {
          const item = pickPiggybackItem({
            deadlines: await memory.listDeadlines(),
            mentioned: await mentionedOn(memory, day),
            nowMs,
            timeZone,
          });
          if (item) {
            const aliases = await memory.listMatterAliases();
            authority.assertActive();
            await markMentioned(memory, [item.id], day, nowMs);
            note = piggybackNote(
              item,
              aliases.find((entry) => entry.matterId === item.matterId)?.title ?? item.matterId,
              day,
            );
          }
        }
        if (
          !note &&
          authority.allows("ada_set_preference") &&
          firstSeenMs !== null &&
          nowMs - firstSeenMs >= WORK_PROFILE_AFTER_MS &&
          (await readMarker(memory, "work_profile")) === null &&
          !(await memory.listPreferences()).some((entry) => entry.key === WORK_PROFILE_KEY)
        ) {
          authority.assertActive();
          await writeMarker(memory, "work_profile", nowMs);
          note = WORK_PROFILE_NOTE;
        }
        if (!note) {
          return undefined;
        }
        handed.delete(owner);
        handed.set(owner, { runId: ctx.runId ?? "", note });
        if (handed.size > MAX_RUNS) {
          handed.delete(handed.keys().next().value ?? owner);
        }
        return { prependContext: note };
      } catch (error) {
        api.logger.error(
          `ada turn note failed owner=${maskNumber(ctx.sessionKey)}: ${error instanceof Error ? error.message : "unknown"}`,
        );
        return undefined;
      }
    },
    { requiresToolAuthority: true },
  );
}
