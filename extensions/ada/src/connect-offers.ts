import { randomUUID } from "node:crypto";
import { LEXROOM_OFFER_DECLINED_KEY } from "./memory-contract.js";

/**
 * When code (not the model) asks a person a question, or sends the morning digest, that message
 * is not in their session history, so the model would not know what a bare "sì" answers. The
 * question is remembered here for the next turn of that number only, and handed to the model as a
 * note; the model decides whether the reply is a yes, a no, or about something else. One run
 * reads it, so a question is never carried into later turns; the same run asking again (a retry
 * or fallback attempt) still gets it. A run whose message arrived before the question was
 * delivered does not read it: that person has not seen the question yet. It is kept in this
 * process only.
 */
export type ConnectOfferKind =
  | "lexroom"
  | "lexroom_nudge"
  | "lexroom_reconnect"
  | "google"
  | "digest";

export type ConnectOffer = { kind: ConnectOfferKind; detail?: string };

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

const NAMES: Record<Exclude<ConnectOfferKind, "digest">, { account: string; call: string }> = {
  lexroom: { account: "their Lexroom account", call: "ada_lexroom_connect" },
  lexroom_nudge: { account: "their Lexroom account", call: "ada_lexroom_connect" },
  lexroom_reconnect: {
    account: "their Lexroom account again (Lexroom refused the saved sign-in)",
    call: "ada_lexroom_connect with force true, because the saved sign-in is still on file and would otherwise be reported as connected",
  },
  google: { account: "their Gmail and Google Calendar", call: "ada_google_connect" },
};

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
          "  If their message answers it in any form, read it against this list. For a numbered item call ada_deadline_list for the current numbers, then ada_deadline_reply with research, brief or dismiss. For the research or the draft follow the morning digest skill. If several things are open and it is not clear which one they mean, ask which one in natural language and do not act on a guess.",
        ]
          .filter(Boolean)
          .join("\n")
      : kind === "lexroom_nudge"
        ? `- Your last answer may have ended with an offer to connect ${NAMES[kind].account}; ignore this if it did not. If their message says yes in any form, call ${NAMES[kind].call} and send the link. If it says no in any form, drop it and call ada_set_preference with key ${LEXROOM_OFFER_DECLINED_KEY} and one short sentence saying they declined connecting Lexroom, then do not bring it up again.`
        : `- You asked whether they want to connect ${NAMES[kind].account}. If their message says yes in any form, call ${NAMES[kind].call} and send the link. If it says no, drop it and do not ask again.`,
  );
  return [
    "# Question you just asked",
    "Ada's code sent this person a message that is not in the conversation above:",
    ...lines,
    "If their message is about something else, answer that and do not repeat the question.",
  ].join("\n");
}
