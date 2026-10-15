import type { IncomingMessage } from "node:http";
import { constantTimeEqual } from "./google-push-auth.js";

const MIN_TOKEN_LENGTH = 16;

/** Returns the configured token only when it is long enough to be a real secret. */
export function readBearerSecret(config: unknown, key: string): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const token = (config as Record<string, unknown>)[key];
  return typeof token === "string" && token.trim().length >= MIN_TOKEN_LENGTH ? token.trim() : null;
}

export function bearerMatches(req: IncomingMessage, expected: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string") {
    return false;
  }
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  const presented = match?.[1];
  if (!presented) {
    return false;
  }
  return constantTimeEqual(presented, expected);
}
