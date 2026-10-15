import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  constantTimeEqual,
  createGoogleCertSource,
  GoogleCertsUnavailableError,
  verifyGooglePushJwt,
  type GoogleCertSource,
} from "./google-push-auth.js";

const NOW_MS = Date.parse("2026-10-14T12:00:00.000Z");
const NOW_S = NOW_MS / 1000;
const AUDIENCE = "https://gateway.example/ada/google/notify";
const CONFIG = { audience: AUDIENCE };

const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherPair = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

function sign(
  claims: Record<string, unknown>,
  options: { key?: crypto.KeyObject; kid?: string; alg?: string } = {},
): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: options.alg ?? "RS256", kid: options.kid ?? "kid-1", typ: "JWT" });
  const body = encode(claims);
  const signature = crypto
    .sign("RSA-SHA256", Buffer.from(`${head}.${body}`), options.key ?? pair.privateKey)
    .toString("base64url");
  return `${head}.${body}.${signature}`;
}

const validClaims = {
  iss: "https://accounts.google.com",
  aud: AUDIENCE,
  exp: NOW_S + 300,
  iat: NOW_S - 10,
  email: "push@project.iam.example",
  email_verified: true,
};

const certs: GoogleCertSource = {
  getKey: async (kid) => (kid === "kid-1" ? pair.publicKey : null),
};

const verify = (token: string, config: Parameters<typeof verifyGooglePushJwt>[1] = CONFIG) =>
  verifyGooglePushJwt(token, config, { certs, now: () => NOW_MS });

describe("verifyGooglePushJwt", () => {
  it("accepts a valid Google-signed token", async () => {
    expect(await verify(sign(validClaims))).toEqual({ ok: true });
    expect(
      await verify(sign({ ...validClaims, iss: "accounts.google.com", aud: ["x", AUDIENCE] })),
    ).toEqual({ ok: true });
  });

  it("rejects an expired token", async () => {
    expect(await verify(sign({ ...validClaims, exp: NOW_S - 120 }))).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await verify(sign({ ...validClaims, exp: undefined }))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects a bad signature, unknown key, and unsigned algorithm", async () => {
    expect(await verify(sign(validClaims, { key: otherPair.privateKey }))).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await verify(sign(validClaims, { kid: "unknown" }))).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(await verify(sign(validClaims, { alg: "none" }))).toEqual({
      ok: false,
      reason: "malformed",
    });
    expect(await verify("not-a-jwt")).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects the wrong issuer or audience", async () => {
    expect(await verify(sign({ ...validClaims, iss: "https://evil.example" }))).toEqual({
      ok: false,
      reason: "claims",
    });
    expect(await verify(sign({ ...validClaims, aud: "https://other.example" }))).toEqual({
      ok: false,
      reason: "claims",
    });
  });

  it("honors a configured issuer and service account", async () => {
    const token = sign({ ...validClaims, iss: "https://issuer.example" });
    expect(await verify(token)).toEqual({ ok: false, reason: "claims" });
    expect(await verify(token, { ...CONFIG, issuer: "https://issuer.example" })).toEqual({
      ok: true,
    });
    const strict = { ...CONFIG, serviceAccountEmail: "push@project.iam.example" };
    expect(await verify(sign(validClaims), strict)).toEqual({ ok: true });
    expect(await verify(sign({ ...validClaims, email: "other@example.com" }), strict)).toEqual({
      ok: false,
      reason: "claims",
    });
    expect(await verify(sign({ ...validClaims, email_verified: false }), strict)).toEqual({
      ok: false,
      reason: "claims",
    });
  });
});

describe("createGoogleCertSource", () => {
  const jwks = {
    keys: [{ ...pair.publicKey.export({ format: "jwk" }), kid: "kid-1", alg: "RS256" }],
  };
  const response = () =>
    new Response(JSON.stringify(jwks), { headers: { "cache-control": "public, max-age=100" } });

  it("caches keys, and limits refetches for unknown key ids", async () => {
    let nowMs = NOW_MS;
    const fetchImpl = vi.fn(async () => response());
    const source = createGoogleCertSource({ fetch: fetchImpl, now: () => nowMs });
    expect(await source.getKey("kid-1")).not.toBeNull();
    expect(await source.getKey("kid-1")).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await source.getKey("bogus")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    nowMs += 61_000;
    expect(await source.getKey("bogus")).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports an outage distinctly", async () => {
    const source = createGoogleCertSource({
      fetch: async () => new Response("nope", { status: 500 }),
    });
    await expect(source.getKey("kid-1")).rejects.toBeInstanceOf(GoogleCertsUnavailableError);
  });
});

describe("constantTimeEqual", () => {
  it("compares values of any length", () => {
    expect(constantTimeEqual("secret-token-value-1", "secret-token-value-1")).toBe(true);
    expect(constantTimeEqual("secret-token-value-1", "secret-token-value-2")).toBe(false);
    expect(constantTimeEqual("short", "secret-token-value-1")).toBe(false);
  });
});
