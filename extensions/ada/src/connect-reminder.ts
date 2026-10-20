import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { CONNECT_FEATURE_NAMES } from "./connect-offers.js";
import { openAdaGoogleAccountFromApi } from "./google-account.js";
import { openAdaGranolaAccountFromApi } from "./granola-account.js";
import { openAdaLexroomAccountFromApi } from "./lexroom-account.js";
import {
  CONNECT_FEATURES,
  connectDeclinedKey,
  connectRemindedKey,
  type ConnectFeature,
  type Preference,
} from "./memory-contract.js";

export type UnfinishedConnectFacts = {
  nowMs: number;
  connected: boolean;
  /** When the last connect link sent for this feature stops working; null when none was sent. */
  linkExpiresAtMs: number | null;
  reminded: boolean;
  declined: boolean;
  /** This turn already carries the Lexroom offer, which covers the same feature. */
  offeredThisTurn: boolean;
};

/**
 * The deterministic part of the reminder: a link was sent, it ran out without the account being
 * connected, the person was not reminded of it before and did not decline it.
 */
export function unfinishedConnectDue(facts: UnfinishedConnectFacts): boolean {
  return (
    !facts.connected &&
    facts.linkExpiresAtMs !== null &&
    facts.linkExpiresAtMs <= facts.nowMs &&
    !facts.reminded &&
    !facts.declined &&
    !facts.offeredThisTurn
  );
}

export function unfinishedConnectNote(feature: ConnectFeature): string {
  const { account, call } = CONNECT_FEATURE_NAMES[feature];
  return [
    "# Unfinished connection (this turn only)",
    `Earlier this person was sent a link to connect ${account} and never finished it, so it is still not connected. After you have fully answered their message, end your reply with ONE short, gentle line in the language of their latest message: the connection was not finished, and you can send a new link if they want one (for example "By the way, the Google connection wasn't finished: want a new link?"). Do not call ${call} and do not write a link until they say yes. Never tell them to type a word or phrase, and do not sign the message.`,
    "Skip the line when their message is itself about connecting it, when it is about something else you cannot answer in the same reply, or when you end the turn with NO_REPLY.",
  ].join("\n");
}

const TOOLS: Record<ConnectFeature, string> = {
  google: "ada_google_connect",
  lexroom: "ada_lexroom_connect",
  granola: "ada_granola_connect",
};

type Probe = {
  linkExpiresAtMs: () => Promise<number | null>;
  connected: () => Promise<boolean>;
};

function probes(
  api: Pick<OpenClawPluginApi, "config" | "logger" | "runtime" | "runtimeSource" | "pluginConfig">,
  owner: string,
  lexroomConnected: () => Promise<boolean>,
): Record<ConnectFeature, Probe> {
  return {
    google: {
      linkExpiresAtMs: async () =>
        await (await openAdaGoogleAccountFromApi(api, owner)).pendingExpiresAt(),
      connected: async () =>
        (await (await openAdaGoogleAccountFromApi(api, owner)).readAccount()) !== null,
    },
    lexroom: {
      linkExpiresAtMs: async () =>
        await (await openAdaLexroomAccountFromApi(api, owner)).pendingExpiresAt(),
      connected: lexroomConnected,
    },
    granola: {
      linkExpiresAtMs: async () =>
        await (await openAdaGranolaAccountFromApi(api, owner)).pendingExpiresAt(),
      connected: async () =>
        (await (await openAdaGranolaAccountFromApi(api, owner)).readAccount()) !== null,
    },
  };
}

/**
 * The first account, in a fixed order, whose connect link ran out unused and is owed one gentle
 * reminder. Reads the link stores first, so a number that never asked to connect anything costs
 * only those reads, and the preferences only when something is owed. At most one per turn.
 */
export async function findUnfinishedConnect(params: {
  api: Pick<OpenClawPluginApi, "config" | "logger" | "runtime" | "runtimeSource" | "pluginConfig">;
  owner: string;
  nowMs: number;
  allows: (tool: string) => boolean;
  lexroomConnected: () => Promise<boolean>;
  offeredLexroomThisTurn: boolean;
  preferences: () => Promise<readonly Preference[]>;
}): Promise<ConnectFeature | null> {
  const probe = probes(params.api, params.owner, params.lexroomConnected);
  let preferences: readonly Preference[] | undefined;
  for (const feature of CONNECT_FEATURES) {
    if (!params.allows(TOOLS[feature])) {
      continue;
    }
    const linkExpiresAtMs = await probe[feature].linkExpiresAtMs();
    if (linkExpiresAtMs === null || linkExpiresAtMs > params.nowMs) {
      continue;
    }
    const connected = await probe[feature].connected();
    preferences ??= await params.preferences();
    const has = (key: string) => preferences?.some((entry) => entry.key === key) ?? false;
    if (
      unfinishedConnectDue({
        nowMs: params.nowMs,
        connected,
        linkExpiresAtMs,
        reminded: has(connectRemindedKey(feature)),
        declined: has(connectDeclinedKey(feature)),
        offeredThisTurn: feature === "lexroom" && params.offeredLexroomThisTurn,
      })
    ) {
      return feature;
    }
  }
  return null;
}
