/**
 * When code (not the model) asks a person whether to connect an account, that question is not in
 * their session history, so the model would not know what a bare "sì" answers. The question is
 * remembered here for the next turn of that number only, and handed to the model as a note; the
 * model decides whether the reply is a yes, a no, or about something else. It is read once, so a
 * question is never carried into later turns, and it is kept in this process only.
 */
export type ConnectOfferKind = "lexroom" | "google";

const OFFER_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_OWNERS = 1000;

const offers = new Map<string, Map<ConnectOfferKind, number>>();

export function noteConnectOffer(owner: string, kind: ConnectOfferKind, nowMs = Date.now()): void {
  const kinds = offers.get(owner) ?? new Map<ConnectOfferKind, number>();
  kinds.set(kind, nowMs);
  offers.delete(owner);
  offers.set(owner, kinds);
  if (offers.size > MAX_OWNERS) {
    offers.delete(offers.keys().next().value ?? owner);
  }
}

/** What was asked of `owner` and not yet shown to the model; the offers are then forgotten. */
export function takeConnectOffers(owner: string, nowMs = Date.now()): ConnectOfferKind[] {
  const kinds = offers.get(owner);
  offers.delete(owner);
  return [...(kinds ?? [])].filter(([, at]) => nowMs - at <= OFFER_TTL_MS).map(([kind]) => kind);
}

const NAMES: Record<ConnectOfferKind, { account: string; tool: string }> = {
  lexroom: { account: "their Lexroom account", tool: "ada_lexroom_connect" },
  google: { account: "their Gmail and Google Calendar", tool: "ada_google_connect" },
};

/** The note for the model; it is only a reminder of a question already asked. */
export function connectOfferNote(kinds: readonly ConnectOfferKind[]): string | undefined {
  if (kinds.length === 0) {
    return undefined;
  }
  const lines = kinds.map(
    (kind) =>
      `- You asked whether they want to connect ${NAMES[kind].account}. If their message says yes in any form, call ${NAMES[kind].tool} and send the link. If it says no, drop it and do not ask again.`,
  );
  return [
    "# Question you just asked",
    "Ada's code sent this person a question that is not in the conversation above:",
    ...lines,
    "If their message is about something else, answer that and do not repeat the question.",
  ].join("\n");
}
