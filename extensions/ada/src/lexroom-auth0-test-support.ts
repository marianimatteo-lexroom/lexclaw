import { readFileSync } from "node:fs";
import { vi } from "vitest";

/**
 * A scripted Lexroom: the web app's Auth.js on app.lexroom.ai and Auth0's Universal Login on
 * auth.lexroom.ai, built on the markup captured from the live identifier and password pages
 * (tokens and addresses removed). Each test overrides the one step it is about.
 */
const fixture = (name: string) =>
  readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8");

export const IDENTIFIER_PAGE = fixture("auth0-identifier.html");
export const PASSWORD_PAGE = fixture("auth0-password.html");

export const EMAIL = "lawyer@example.com";
export const PASSWORD = "correct horse battery staple 9";
export const STATE = "STATE-TOKEN";

const AUTH = "https://auth.lexroom.ai";
const APP = "https://app.lexroom.ai";

export function jwt(exp: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part({ exp })}.signature`;
}

export const html = (body: string, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(body, { status, headers });
};

export const redirect = (location: string, cookies: string[] = [], status = 302) => {
  const headers = new Headers({ location });
  for (const cookie of cookies) {
    headers.append("set-cookie", cookie);
  }
  return new Response(null, { status, headers });
};

export const jsonBody = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export type Call = {
  method: string;
  host: string;
  path: string;
  search: string;
  headers: Headers;
  body: string;
};

export type Handlers = Partial<Record<string, (call: Call) => Response | Promise<Response>>>;

/** The page Auth0 shows after a wrong password: the same form with a server-rendered error. */
export function withError(page: string, code: string): string {
  return page.replace(
    "</form>",
    `<span id="error-element-password" class="ulp-input-error-message" data-error-code="${code}">Errore</span></form>`,
  );
}

export function withCaptcha(page: string): string {
  return page.replace(
    "</form>",
    '<div data-captcha-sitekey="SITEKEY" data-captcha-provider="auth0_v2"><input type="hidden" name="captcha"></div></form>',
  );
}

/**
 * The whole sign-in as a `fetch`. Handlers are keyed `METHOD host/path`; anything not overridden
 * answers as Lexroom does when the credentials are right. `calls` records every request.
 */
export function lexroomSite(overrides: Handlers = {}) {
  const calls: Call[] = [];
  const accessToken = jwt(Math.floor(Date.now() / 1000) + 3600);
  const defaults: Handlers = {
    "GET app.lexroom.ai/api/auth/login": () =>
      redirect(`${AUTH}/authorize?client_id=x&state=APP-STATE&code_challenge=CHALLENGE`, [
        "authjs.pkce.code_verifier=PKCE-VERIFIER; Path=/; HttpOnly; Secure",
      ]),
    "GET auth.lexroom.ai/authorize": () =>
      redirect(`/u/login/identifier?state=${STATE}&ui_locales=it`, [
        "auth0=AUTH0-SESSION; Path=/; Secure",
      ]),
    "GET auth.lexroom.ai/u/login/identifier": () => html(IDENTIFIER_PAGE),
    "POST auth.lexroom.ai/u/login/identifier": () =>
      redirect(`/u/login/password?state=${STATE}&ui_locales=it`),
    "GET auth.lexroom.ai/u/login/password": () => html(PASSWORD_PAGE),
    "POST auth.lexroom.ai/u/login/password": () => redirect(`/authorize/resume?state=${STATE}`),
    "GET auth.lexroom.ai/authorize/resume": () =>
      redirect(`${APP}/api/auth/callback/auth0?code=AUTH-CODE&state=APP-STATE`),
    "GET app.lexroom.ai/api/auth/callback/auth0": () =>
      redirect("/", ["authjs.session-token=SESSION-COOKIE; Path=/; HttpOnly; Secure"]),
    "GET app.lexroom.ai/": () => html("<html>app</html>"),
    "GET app.lexroom.ai/api/auth/session": () =>
      jsonBody({
        user: { email: EMAIL, accessToken },
        expires: "2026-11-16T00:00:00.000Z",
      }),
  };
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const call: Call = {
      method: init?.method ?? "GET",
      host: url.host,
      path: url.pathname,
      search: url.search,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    const handler =
      overrides[`${call.method} ${call.host}${call.path}`] ??
      defaults[`${call.method} ${call.host}${call.path}`];
    if (!handler) {
      throw new Error(`unexpected request ${call.method} ${call.host}${call.path}`);
    }
    return await handler(call);
  }) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
  return { fetchImpl, calls, accessToken };
}

export const requests = (calls: readonly Call[]) =>
  calls.map((call) => `${call.method} ${call.host}${call.path}`);
