import { randomBytes } from "node:crypto";

/**
 * Short aliases for connect links. The signed state in the full URL stays the only authority
 * (owner, single use, 30-minute expiry); a code just stands in for the URL in the chat. Codes
 * live in this process only, so a restart makes the links already sent say "expired" and the
 * person asks Ada for a new one.
 */
export type ShortLinkKind = "g" | "l" | "gr";

type ShortLink = {
  kind: ShortLinkKind;
  owner: string;
  nonce: string;
  target: string;
  expiresAtMs: number;
};

const MAX_SHORT_LINKS = 2000;
const CODE_BYTES = 7;
const CODE_PATTERN = /^[A-Za-z0-9_-]{10}$/u;

// One table per process, shared by every module instance of the plugin.
const links = ((globalThis as Record<symbol, unknown>)[Symbol.for("ada.shortLinks")] ??= new Map<
  string,
  ShortLink
>()) as Map<string, ShortLink>;

function key(kind: ShortLinkKind, code: string): string {
  return `${kind}:${code}`;
}

function purge(nowMs: number): void {
  for (const [entryKey, entry] of links) {
    if (entry.expiresAtMs <= nowMs) {
      links.delete(entryKey);
    }
  }
}

/**
 * Registers `target` under a fresh random code and returns the code. A number has at most one
 * live code per kind, matching its single pending connect; the table is capped, oldest first.
 */
export function mintShortLink(params: {
  kind: ShortLinkKind;
  owner: string;
  nonce: string;
  target: string;
  expiresAtMs: number;
  now: Date;
}): string {
  const nowMs = params.now.getTime();
  purge(nowMs);
  for (const [entryKey, entry] of links) {
    if (entry.kind === params.kind && entry.owner === params.owner) {
      links.delete(entryKey);
    }
  }
  while (links.size >= MAX_SHORT_LINKS) {
    const oldest = links.keys().next();
    if (oldest.done) {
      break;
    }
    links.delete(oldest.value);
  }
  let code = randomBytes(CODE_BYTES).toString("base64url");
  while (links.has(key(params.kind, code))) {
    code = randomBytes(CODE_BYTES).toString("base64url");
  }
  links.set(key(params.kind, code), {
    kind: params.kind,
    owner: params.owner,
    nonce: params.nonce,
    target: params.target,
    expiresAtMs: params.expiresAtMs,
  });
  return code;
}

export function resolveShortLink(kind: ShortLinkKind, code: string, now: Date): string | null {
  if (!CODE_PATTERN.test(code)) {
    return null;
  }
  const entry = links.get(key(kind, code));
  if (!entry) {
    return null;
  }
  if (entry.expiresAtMs <= now.getTime()) {
    links.delete(key(kind, code));
    return null;
  }
  return entry.target;
}

/** True while `owner` holds a code of `kind` that has not expired: a link sent and still usable. */
export function hasLiveShortLink(kind: ShortLinkKind, owner: string, now: Date): boolean {
  for (const entry of links.values()) {
    if (entry.kind === kind && entry.owner === owner && entry.expiresAtMs > now.getTime()) {
      return true;
    }
  }
  return false;
}

/** Drops every code whose state nonce was just spent, so a code never outlives its state. */
export function revokeShortLinksForNonce(nonce: string): void {
  for (const [entryKey, entry] of links) {
    if (entry.nonce === nonce) {
      links.delete(entryKey);
    }
  }
}

export function shortLinkUrl(origin: string, kind: ShortLinkKind, code: string): string {
  return `${origin}/${kind}/${code}`;
}
