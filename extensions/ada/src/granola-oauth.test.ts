import { afterEach, describe, expect, it } from "vitest";
import { clearGranolaDiscoveryCache, discoverGranolaEndpoints } from "./granola-oauth.js";

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function metadataFetch(
  authServer: Record<string, unknown>,
  issuer = "https://mcp-auth.granola.ai",
) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.includes("oauth-protected-resource")) {
      return json({ authorization_servers: [issuer] });
    }
    if (url.startsWith("https://mcp-auth.granola.ai/.well-known/")) {
      return json(authServer);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

afterEach(() => clearGranolaDiscoveryCache());

describe("discoverGranolaEndpoints host pinning", () => {
  it("accepts endpoints on Granola's hosts", async () => {
    const { fetchImpl } = metadataFetch({
      authorization_endpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
      token_endpoint: "https://mcp-auth.granola.ai/oauth2/token",
      registration_endpoint: "https://mcp-auth.granola.ai/oauth2/register",
    });
    const endpoints = await discoverGranolaEndpoints({ fetchImpl });
    expect(endpoints?.authorizationEndpoint).toBe("https://mcp-auth.granola.ai/oauth2/authorize");
    expect(endpoints?.revocationEndpoint).toBeUndefined();
  });

  it("refuses endpoints that point anywhere else", async () => {
    const { fetchImpl } = metadataFetch({
      authorization_endpoint: "https://evil.example/authorize",
      token_endpoint: "https://granola.ai.evil.example/token",
    });
    expect(await discoverGranolaEndpoints({ fetchImpl })).toBeNull();
  });

  it("ignores a foreign authorization server and keeps Granola's own", async () => {
    const { fetchImpl, urls } = metadataFetch(
      {
        authorization_endpoint: "https://mcp-auth.granola.ai/oauth2/authorize",
        token_endpoint: "https://mcp-auth.granola.ai/oauth2/token",
        registration_endpoint: "http://127.0.0.1/register",
        revocation_endpoint: "https://evil.example/revoke",
      },
      "https://evil.example",
    );
    const endpoints = await discoverGranolaEndpoints({ fetchImpl });
    expect(urls.some((url) => url.startsWith("https://evil.example"))).toBe(false);
    expect(endpoints?.registrationEndpoint).toBe("https://mcp-auth.granola.ai/oauth2/register");
    expect(endpoints?.revocationEndpoint).toBeUndefined();
  });
});
