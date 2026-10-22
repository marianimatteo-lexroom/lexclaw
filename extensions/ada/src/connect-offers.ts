import { randomUUID } from "node:crypto";
import {
  CONNECT_FEATURES,
  connectDeclinedKey,
  LEXROOM_OFFER_DECLINED_KEY,
  type ConnectFeature,
} from "./memory-contract.js";

/**
 * When code (not the model) asks a person a question, or sends the morning digest, that message
 * is not in their session history, so the model would not know what a bare "sì" answers. The
 * question is remembered here for the next turn of that number only, and handed to the model as a
 * note; the model decides whether the reply is a yes, a no, or about something else. One run
 * reads it, so a question is never carried into later turns; the same run asking again (a retry
 * or fallback attempt) still gets it. A run whose message arrived before the question was
 * delivered does not read it: that person has not seen the question yet. It is kept in this
 * process only. An offer is kept per kind, so a later one of the same kind replaces the earlier:
 * of two accounts connected close together, only the last first look is remembered.
 */
export type ConnectOfferKind =
  | "lexroom"
  | "lexroom_nudge"
  | "lexroom_reconnect"
  | "google"
  | "connect_reminder"
  | "digest"
  | "first_look"
  | "research_result"
  | "welcome_question";

export type ConnectOffer = { kind: ConnectOfferKind; detail?: string };

/** What a delivered research was about, so a "yes, draft it" can build on that research. */
export type ResearchResultNote = { query: string; matterId?: string; researchId?: string };

const RESULT_QUERY_MAX = 120;
/** How many delivered results one number's note keeps: the most recent. */
const RESULT_NOTES_MAX = 5;

/** The detail of a `research_result` offer: the notes as one string, in this process only. */
export function researchResultDetail(notes: readonly ResearchResultNote[]): string {
  const kept: ResearchResultNote[] = [];
  for (const { query, matterId, researchId } of notes.slice(-RESULT_NOTES_MAX)) {
    const note: ResearchResultNote = {
      query: query.replace(/\s+/gu, " ").trim().slice(0, RESULT_QUERY_MAX),
    };
    if (matterId) {
      note.matterId = matterId;
    }
    if (researchId) {
      note.researchId = researchId;
    }
    kept.push(note);
  }
  return JSON.stringify(kept);
}

function readResearchResults(detail: string | undefined): Partial<ResearchResultNote>[] {
  try {
    const parsed: unknown = detail ? JSON.parse(detail) : [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(
      (item): item is Partial<ResearchResultNote> => typeof item === "object" && item !== null,
    );
  } catch {
    return [];
  }
}

function researchIds(note: Partial<ResearchResultNote>): string {
  const ids = [
    note.matterId ? `matterId ${JSON.stringify(note.matterId)}` : "",
    note.researchId ? `parentResearchId ${JSON.stringify(note.researchId)}` : "",
  ].filter(Boolean);
  return ids.length ? ` with ${ids.join(" and ")}` : "";
}

function researchResultLine(detail: string | undefined): string {
  const notes = readResearchResults(detail);
  const [only] = notes;
  const many = notes.length > 1;
  const sent = many
    ? `the results of ${notes.length} Lexroom researches, each as a message of its own and each ending with an offer to turn it into a draft:\n${notes
        .map(
          (note, index) =>
            `  ${index + 1}. ${note.query ? JSON.stringify(note.query) : "(no question recorded)"}${researchIds(note)}`,
        )
        .join("\n")}`
    : `the result of a Lexroom research${only?.query ? ` on ${JSON.stringify(only.query)}` : ""} as a message of its own, ending with an offer to turn it into a draft`;
  const which = many
    ? " If a bare yes or a follow-up could mean more than one of them, ask which one first, then use the ids of that one."
    : "";
  const withIds = many ? " with the ids of that research" : researchIds(only ?? {});
  return `- You sent them ${sent}. If that text is not in the conversation above and you cannot read it, never claim to know what it said.${which} If their message says yes in any form, start that draft: ask in one short question for what is missing, and call ada_draft${withIds}, with confirmed true only after they agree. If they ask a follow-up about a result, either ask what they need to know, or, for a new question on the same matter, call ada_research${withIds}; never research without a question from them. If their message is about something else, answer that.`;
}

type Offer = { at: number; detail?: string; consumedByRunId?: string };

const OFFER_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_OWNERS = 1000;

const offers = new Map<string, Map<ConnectOfferKind, Offer>>();

/** Call only once the message has been delivered: `nowMs` is when the person could first see it. */
export function noteConnectOffer(
  owner: string,
  kind: ConnectOfferKind,
  nowMs = Date.now(),
  detail?: string,
): void {
  const kinds = offers.get(owner) ?? new Map<ConnectOfferKind, Offer>();
  kinds.set(kind, { at: nowMs, ...(detail ? { detail } : {}) });
  offers.delete(owner);
  offers.set(owner, kinds);
  if (offers.size > MAX_OWNERS) {
    offers.delete(offers.keys().next().value ?? owner);
  }
}

/**
 * A delivered research joins the results `owner` has not yet answered, newest last and capped, so
 * several released together are all remembered. A run that already read the earlier ones starts
 * the list afresh.
 */
export function noteResearchResult(
  owner: string,
  note: ResearchResultNote,
  nowMs = Date.now(),
): void {
  const earlier = offers.get(owner)?.get("research_result");
  const kept =
    earlier && earlier.consumedByRunId === undefined && nowMs - earlier.at <= OFFER_TTL_MS
      ? readResearchResults(earlier.detail)
      : [];
  noteConnectOffer(
    owner,
    "research_result",
    nowMs,
    researchResultDetail([...(kept as ResearchResultNote[]), note]),
  );
}

/**
 * What was asked of `owner` and not yet shown to the model. The first run to read an offer owns
 * it: only that run reads it again, and no later run does. `inboundAtMs` is when the message
 * that started the run arrived; a run for a message older than the offer, or with no known
 * arrival, leaves it for the next.
 */
export function takeConnectOffers(
  owner: string,
  options: { runId?: string; inboundAtMs?: number; nowMs?: number } = {},
): ConnectOffer[] {
  const kinds = offers.get(owner);
  if (!kinds) {
    return [];
  }
  const nowMs = options.nowMs ?? Date.now();
  const claim = options.runId ?? randomUUID();
  const taken: ConnectOffer[] = [];
  for (const [kind, offer] of kinds) {
    if (nowMs - offer.at > OFFER_TTL_MS) {
      kinds.delete(kind);
    } else if (offer.consumedByRunId === claim) {
      taken.push({ kind, detail: offer.detail });
    } else if (
      offer.consumedByRunId === undefined &&
      options.inboundAtMs !== undefined &&
      options.inboundAtMs >= offer.at
    ) {
      offer.consumedByRunId = claim;
      taken.push({ kind, detail: offer.detail });
    }
  }
  if (kinds.size === 0) {
    offers.delete(owner);
  }
  return taken;
}

/** What each connectable account is called to the model, and which tool connects it. */
export const CONNECT_FEATURE_NAMES: Record<ConnectFeature, { account: string; call: string }> = {
  google: { account: "their Gmail and Google Calendar", call: "ada_google_connect" },
  lexroom: { account: "their Lexroom account", call: "ada_lexroom_connect" },
  granola: { account: "their Granola meeting notes", call: "ada_granola_connect" },
};

const NAMES: Record<
  Exclude<
    ConnectOfferKind,
    "digest" | "connect_reminder" | "first_look" | "research_result" | "welcome_question"
  >,
  { account: string; call: string }
> = {
  lexroom: { account: "their Lexroom account", call: "ada_lexroom_connect" },
  lexroom_nudge: { account: "their Lexroom account", call: "ada_lexroom_connect" },
  lexroom_reconnect: {
    account: "their Lexroom account again (Lexroom refused the saved sign-in)",
    call: "ada_lexroom_connect with force true, because the saved sign-in is still on file and would otherwise be reported as connected",
  },
  google: { account: "their Gmail and Google Calendar", call: "ada_google_connect" },
};

function reminderLine(detail: string | undefined): string {
  const feature = CONNECT_FEATURES.find((candidate) => candidate === detail);
  if (!feature) {
    return "";
  }
  const { account, call } = CONNECT_FEATURE_NAMES[feature];
  return `- Your last reply may have ended with a line saying that connecting ${account} was not finished, and offering a new link; ignore this if it did not. If their message says yes in any form, call ${call} and send the link. If it says no in any form, drop it and call ada_set_preference with key ${connectDeclinedKey(feature)} and one short sentence saying they declined, then do not bring it up again.`;
}

const REQUEST_CONNECT_TTL_MS = 35 * 60 * 1000;
const requestConnects = new Map<string, number>();

export type RequestConnectFeature = "google" | "outlook" | "lexroom";

/**
 * A connect link was issued for a request already in progress (the model says so, or an account
 * lacks the permission a mail or a calendar change needs), so the confirmation that follows
 * continues that request instead of offering a first look. Kept in this process only, for the
 * life of the link.
 */
export function noteRequestConnect(
  owner: string,
  feature: RequestConnectFeature,
  nowMs = Date.now(),
): void {
  const key = `${owner}:${feature}`;
  requestConnects.delete(key);
  requestConnects.set(key, nowMs);
  if (requestConnects.size > MAX_OWNERS) {
    requestConnects.delete(requestConnects.keys().next().value ?? key);
  }
}

/** Whether the connect that just finished was for a request in progress; reads it once. */
export function takeRequestConnect(
  owner: string,
  feature: RequestConnectFeature,
  nowMs = Date.now(),
): boolean {
  const key = `${owner}:${feature}`;
  const at = requestConnects.get(key);
  requestConnects.delete(key);
  return at !== undefined && nowMs - at <= REQUEST_CONNECT_TTL_MS;
}

/**
 * Runs a connect tool with its `forPendingRequest` argument. A leftover flag from an earlier link
 * is cleared first, so a later plain connect gets its first look; the flag is set again only when
 * the model says the connect carries out something the person already asked for and a link is
 * issued. A flag the tool sets itself while it runs (a permission upgrade) is kept. The result is
 * returned unchanged.
 */
export async function withRequestConnect<T>(
  owner: string,
  feature: RequestConnectFeature,
  forPendingRequest: boolean | undefined,
  run: () => Promise<T>,
): Promise<T> {
  takeRequestConnect(owner, feature);
  const result = await run();
  const issued = result as { ok?: unknown; connected?: unknown } | null;
  if (forPendingRequest === true && issued?.ok === true && issued.connected === false) {
    noteRequestConnect(owner, feature);
  }
  return result;
}

/** What a first look does for each account that Ada's connected message offers one for. */
const FIRST_LOOKS: Record<string, string> = {
  google: "today's calendar and inbox: call ada_read_calendar and ada_read_inbox",
  outlook: "today's calendar and inbox: call ada_outlook_read_calendar and ada_outlook_read_inbox",
  granola: "the notes of their latest meeting: call ada_granola_tools, then ada_granola_call",
  lexroom:
    "a first research: take their reply, or the legal question they asked earlier, and call ada_research",
};

function firstLookLine(detail: string | undefined): string {
  const look = detail === undefined ? undefined : FIRST_LOOKS[detail];
  return look
    ? `- You sent them a message confirming an account is connected, ending with a question offering a first look. Doing it means ${look}. If their message says yes in any form, do it now and keep the answer short. If it says no, drop it. If the conversation shows a request that needed this connection (a mail to send, a calendar change), carry that request out instead and ignore the first look.`
    : "";
}

/** The note for the model; it is only a reminder of a question already asked. */
export function connectOfferNote(offers: readonly ConnectOffer[]): string | undefined {
  if (offers.length === 0) {
    return undefined;
  }
  const lines = offers.map(({ kind, detail }) =>
    kind === "digest"
      ? [
          "- You sent them the morning digest. It offered:",
          detail ?? "",
          "  If their message answers it in any form, read it against this list. For a numbered item call ada_deadline_list for the current numbers, then ada_deadline_reply with track (an item marked to be confirmed: confirm tracking only, no research), research, brief or dismiss. For the research or the draft follow the morning digest skill. If several things are open and it is not clear which one they mean, ask which one in natural language and do not act on a guess.",
        ]
          .filter(Boolean)
          .join("\n")
      : kind === "connect_reminder"
        ? reminderLine(detail)
        : kind === "first_look"
          ? firstLookLine(detail)
          : kind === "welcome_question"
            ? "- You welcomed them and asked what they are working on; that welcome is not in the conversation. Read their message as the answer: help with what they say, and do not repeat the welcome or the question."
            : kind === "research_result"
              ? researchResultLine(detail)
              : kind === "lexroom_nudge"
                ? `- Your last reply may have opened with an offer to connect ${NAMES[kind].account}, with its link or an offer to send it; ignore this if it did not. If their message says yes in any form and you did not send the link, call ${NAMES[kind].call} and send it. If it says no in any form, drop it and call ada_set_preference with key ${LEXROOM_OFFER_DECLINED_KEY} and one short sentence saying they declined connecting Lexroom, then do not bring it up again.`
                : `- You asked whether they want to connect ${NAMES[kind].account}. If their message says yes in any form, call ${NAMES[kind].call} and send the link. If it says no, drop it and do not ask again.`,
  );
  if (lines.every((line) => !line)) {
    return undefined;
  }
  return [
    "# Question you just asked",
    "Ada's code sent this person a message that is not in the conversation above:",
    ...lines.filter(Boolean),
    "If their message is about something else, answer that and do not repeat the question.",
  ].join("\n");
}
