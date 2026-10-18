import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isOwner } from "./owner.js";

const STATE_TTL_MS = 30 * 60 * 1000;

/**
 * The signed, single-use, 30-minute state a connect link carries. It names the WhatsApp number
 * that asked for the link, so finishing the link saves the account for that number and for no
 * one else, whoever opens it.
 */
export function createConnectState(
  stateSecret: string,
  now: Date,
  owner: string,
): { state: string; nonce: string; expiresAtMs: number } {
  const nonce = randomBytes(32).toString("base64url");
  const expiresAtMs = now.getTime() + STATE_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ nonce, exp: expiresAtMs, owner })).toString(
    "base64url",
  );
  const signature = createHmac("sha256", stateSecret).update(payload).digest("base64url");
  return { state: `${payload}.${signature}`, nonce, expiresAtMs };
}

export function readConnectState(
  stateSecret: string,
  state: string,
  now: Date,
): { nonce: string; owner: string } | null {
  const parts = state.split(".");
  if (parts.length !== 2) {
    return null;
  }
  const [payload, signature] = parts;
  if (!payload || !signature) {
    return null;
  }
  const expected = createHmac("sha256", stateSecret).update(payload).digest("base64url");
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);
  if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
    return null;
  }
  let parsed: { nonce?: unknown; exp?: unknown; owner?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      nonce?: unknown;
      exp?: unknown;
      owner?: unknown;
    };
  } catch {
    return null;
  }
  if (typeof parsed.nonce !== "string" || typeof parsed.exp !== "number") {
    return null;
  }
  if (!isOwner(parsed.owner)) {
    return null;
  }
  if (parsed.exp <= now.getTime()) {
    return null;
  }
  return { nonce: parsed.nonce, owner: parsed.owner };
}
