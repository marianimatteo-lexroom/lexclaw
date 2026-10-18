import { randomUUID } from "node:crypto";

/**
 * When code (not the model) asks a person whether to connect an account, that question is not in
 * their session history, so the model would not know what a bare "sì" answers. The question is
 * remembered here for the next turn of that number only, and handed to the model as a note; the
 * model decides whether the reply is a yes, a no, or about something else. One run reads it, so a
 * question is never carried into later turns; the same run asking again (a retry or fallback
 * attempt) still gets it. It is kept in this process only.
 */
export type ConnectOfferKind = "lexroom" | "lexroom_reconnect" | "google";

type Offer = { at: number; consumedByRunId?: string };

const OFFER_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_OWNERS = 1000;

const offers = new Map<string, Map<ConnectOfferKind, Offer>>();

export function noteConnectOffer(owner: string, kind: ConnectOfferKind, nowMs = Date.now()): void {
  const kinds = offers.get(owner) ?? new Map<ConnectOfferKind, Offer>();
  kinds.set(kind, { at: nowMs });
  offers.delete(owner);
  offers.set(owner, kinds);
  if (offers.size > MAX_OWNERS) {
    offers.delete(offers.keys().next().value ?? owner);
  }
}

/**
 * What was asked of `owner` and not yet shown to the model. The first run to read an offer owns
 * it: only that run reads it again, and no later run does.
 */
export function takeConnectOffers(
  owner: string,
  runId: string | undefined,
  nowMs = Date.now(),
): ConnectOfferKind[] {
  const kinds = offers.get(owner);
  if (!kinds) {
    return [];
  }
  const claim = runId ?? randomUUID();
  const taken: ConnectOfferKind[] = [];
  for (const [kind, offer] of kinds) {
    if (nowMs - offer.at > OFFER_TTL_MS) {
      kinds.delete(kind);
    } else if (offer.consumedByRunId === undefined || offer.consumedByRunId === claim) {
      offer.consumedByRunId = claim;
      taken.push(kind);
    }
  }
  if (kinds.size === 0) {
    offers.delete(owner);
  }
  return taken;
}

const NAMES: Record<ConnectOfferKind, { account: string; call: string }> = {
  lexroom: { account: "their Lexroom account", call: "ada_lexroom_connect" },
  lexroom_reconnect: {
    account: "their Lexroom account again (Lexroom refused the saved sign-in)",
    call: "ada_lexroom_connect with force true, because the saved sign-in is still on file and would otherwise be reported as connected",
  },
  google: { account: "their Gmail and Google Calendar", call: "ada_google_connect" },
};

/** The note for the model; it is only a reminder of a question already asked. */
export function connectOfferNote(kinds: readonly ConnectOfferKind[]): string | undefined {
  if (kinds.length === 0) {
    return undefined;
  }
  const lines = kinds.map(
    (kind) =>
      `- You asked whether they want to connect ${NAMES[kind].account}. If their message says yes in any form, call ${NAMES[kind].call} and send the link. If it says no, drop it and do not ask again.`,
  );
  return [
    "# Question you just asked",
    "Ada's code sent this person a question that is not in the conversation above:",
    ...lines,
    "If their message is about something else, answer that and do not repeat the question.",
  ].join("\n");
}
