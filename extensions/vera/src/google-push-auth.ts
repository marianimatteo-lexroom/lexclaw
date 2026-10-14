import crypto from "node:crypto";

export const GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
export const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;

const CLOCK_SKEW_MS = 60_000;
const DEFAULT_CERT_TTL_MS = 3_600_000;
const MAX_CERT_TTL_MS = 86_400_000;
const UNKNOWN_KID_REFETCH_MS = 60_000;
const MAX_JWT_CHARS = 8192;

export type GoogleCertSource = {
  /** Resolves the signing key for `kid`, or null when Google does not publish it. */
  getKey(kid: string): Promise<crypto.KeyObject | null>;
};

export type GooglePushJwtConfig = {
  /** Audience the Pub/Sub push subscription was configured with. */
  audience: string;
  /** Overrides the default Google issuers. */
  issuer?: string;
  /** Required `email` claim when set (the subscription's service account). */
  serviceAccountEmail?: string;
};

export type GooglePushJwtResult =
  | { ok: true }
  | { ok: false; reason: "malformed" | "signature" | "claims" | "expired" };

export class GoogleCertsUnavailableError extends Error {}

type Jwk = { kid?: string; kty?: string; n?: string; e?: string };

export function createGoogleCertSource(
  deps: { fetch?: typeof fetch; now?: () => number; url?: string } = {},
): GoogleCertSource {
  const fetchImpl = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  const url = deps.url ?? GOOGLE_CERTS_URL;
  let keys = new Map<string, crypto.KeyObject>();
  let expiresAtMs = 0;
  let fetchedAtMs = Number.NEGATIVE_INFINITY;
  let inflight: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    const startedAt = now();
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    } catch (error) {
      throw new GoogleCertsUnavailableError(
        `Google certs fetch failed: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    if (!response.ok) {
      throw new GoogleCertsUnavailableError(`Google certs fetch returned ${response.status}`);
    }
    const body = (await response.json()) as { keys?: Jwk[] };
    const next = new Map<string, crypto.KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kid && jwk.kty === "RSA") {
        next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
      }
    }
    const maxAge = /max-age=(\d+)/u.exec(response.headers.get("cache-control") ?? "");
    const ttlMs = maxAge ? Number(maxAge[1]) * 1000 : DEFAULT_CERT_TTL_MS;
    keys = next;
    fetchedAtMs = startedAt;
    expiresAtMs = startedAt + Math.min(ttlMs, MAX_CERT_TTL_MS);
  }

  function refreshOnce(): Promise<void> {
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  return {
    async getKey(kid) {
      if (now() >= expiresAtMs) {
        await refreshOnce();
      }
      const known = keys.get(kid);
      if (known) {
        return known;
      }
      // Google rotates keys; an unknown kid may be a fresh one, but a bogus kid must not
      // turn every request into an outbound fetch.
      if (now() - fetchedAtMs >= UNKNOWN_KID_REFETCH_MS) {
        await refreshOnce();
        return keys.get(kid) ?? null;
      }
      return null;
    },
  };
}

function decodeJson(segment: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function looksLikeJwt(token: string): boolean {
  return token.length <= MAX_JWT_CHARS && /^[\w-]+\.[\w-]+\.[\w-]+$/u.test(token);
}

/**
 * Verifies the OIDC token Pub/Sub attaches to push requests: RS256 signature from
 * Google's published keys, issuer, audience, expiry, and (optionally) the
 * subscription's service account. Throws GoogleCertsUnavailableError when the
 * signing keys cannot be fetched, so callers can tell an outage from a bad token.
 */
export async function verifyGooglePushJwt(
  token: string,
  config: GooglePushJwtConfig,
  deps: { certs: GoogleCertSource; now?: () => number },
): Promise<GooglePushJwtResult> {
  if (!looksLikeJwt(token)) {
    return { ok: false, reason: "malformed" };
  }
  const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = token.split(".");
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const key = await deps.certs.getKey(header.kid);
  if (!key) {
    return { ok: false, reason: "signature" };
  }
  const signatureValid = crypto.verify(
    "RSA-SHA256",
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    key,
    Buffer.from(encodedSignature, "base64url"),
  );
  if (!signatureValid) {
    return { ok: false, reason: "signature" };
  }

  const nowMs = (deps.now ?? Date.now)();
  if (typeof payload.exp !== "number" || payload.exp * 1000 + CLOCK_SKEW_MS <= nowMs) {
    return { ok: false, reason: "expired" };
  }
  if (typeof payload.nbf === "number" && payload.nbf * 1000 - CLOCK_SKEW_MS > nowMs) {
    return { ok: false, reason: "claims" };
  }
  const issuers: readonly string[] = config.issuer ? [config.issuer] : GOOGLE_ISSUERS;
  if (typeof payload.iss !== "string" || !issuers.includes(payload.iss)) {
    return { ok: false, reason: "claims" };
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(config.audience)) {
    return { ok: false, reason: "claims" };
  }
  if (
    config.serviceAccountEmail &&
    (payload.email !== config.serviceAccountEmail || payload.email_verified !== true)
  ) {
    return { ok: false, reason: "claims" };
  }
  return { ok: true };
}

/** Compares secrets without leaking length or content through timing. */
export function constantTimeEqual(actual: string, expected: string): boolean {
  const digest = (value: string) => crypto.createHash("sha256").update(value, "utf8").digest();
  return crypto.timingSafeEqual(digest(actual), digest(expected));
}
