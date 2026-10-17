import { accessTokenExpiresAtMs } from "./lexroom-connect.js";
import {
  CAPTCHA_ERROR,
  forbidden,
  MFA_ERROR,
  unavailable,
  type LexroomLoginResult,
} from "./lexroom-login-types.js";
import { exchange, readTextGuarded, type Trace } from "./lexroom-transport.js";

/**
 * A headless replica of what the Lexroom web app does when someone signs in: Auth.js on
 * app.lexroom.ai sends the browser to Auth0's Universal Login on auth.lexroom.ai, the person
 * types the email and then the password, Auth0 sends the browser back, Auth.js sets its session
 * cookie, and the session endpoint hands the SPA its bearer. Each step is one request, with a
 * cookie jar per host, the form fields the page itself defines, and redirects read one hop at a
 * time so nothing leaves the two Lexroom hosts.
 */
export const LEXROOM_APP_URL = "https://app.lexroom.ai";
const APP_HOST = "app.lexroom.ai";
const AUTH_HOST = "auth.lexroom.ai";
const MAX_HOPS = 12;
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Ada/1";

type Ctx = {
  fetchImpl?: typeof fetch;
  timeoutMs: number;
  signal?: AbortSignal;
  trace: Trace;
  /** Cookies by host, then name. A cookie is never sent to a host that did not set it. */
  jar: Map<string, Map<string, string>>;
};

/** The flow went somewhere it was not expected to, which says nothing about the credentials. */
class FlowError extends Error {}

type Page = { url: URL; status: number; text: string };
type Followed = { kind: "page"; page: Page } | { kind: "stopped"; url: URL };

function storeCookies(jar: Ctx["jar"], host: string, setCookies: readonly string[]): void {
  const cookies = jar.get(host) ?? new Map<string, string>();
  for (const header of setCookies) {
    const segments = header.split(";").map((part) => part.trim());
    const pair = segments[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1);
    const maxAge = segments.find((part) => part.toLowerCase().startsWith("max-age="));
    const expired =
      (maxAge !== undefined && Number.parseInt(maxAge.slice(8), 10) <= 0) ||
      segments.some((part) => part.toLowerCase().startsWith("expires=") && part.includes("1970"));
    if (!value || expired) {
      cookies.delete(name);
    } else {
      cookies.set(name, value);
    }
  }
  jar.set(host, cookies);
}

/** One request, one hop. The redirect is handed back, not followed. */
async function hop(
  ctx: Ctx,
  phase: string,
  method: "GET" | "POST",
  url: URL,
  form: URLSearchParams | undefined,
  referer: string | undefined,
): Promise<{ status: number; location: string | null; text: string }> {
  if (url.protocol !== "https:" || (url.host !== APP_HOST && url.host !== AUTH_HOST)) {
    throw new FlowError("the sign-in was sent to a host that is not Lexroom's");
  }
  const headers = new Headers({
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    "Accept-Language": "it-IT,it;q=0.9,en;q=0.8",
  });
  const cookies = ctx.jar.get(url.host);
  if (cookies && cookies.size > 0) {
    headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  if (form) {
    headers.set("Content-Type", "application/x-www-form-urlencoded");
    headers.set("Origin", url.origin);
  }
  if (referer) {
    headers.set("Referer", referer);
  }
  const sent = await exchange({
    fetchImpl: ctx.fetchImpl ?? fetch,
    url: url.href,
    init: {
      method,
      headers,
      ...(form ? { body: form.toString() } : {}),
      redirect: "manual",
    },
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    trace: ctx.trace,
    step: phase,
    retry: "none",
    read: async (response, guard) => ({
      location: response.headers.get("location"),
      cookies: response.headers.getSetCookie(),
      text: (await readTextGuarded(response, guard)) ?? "",
    }),
  });
  storeCookies(ctx.jar, url.host, sent.value.cookies);
  return { status: sent.status, location: sent.value.location, text: sent.value.text };
}

/** Where a redirect must not be followed: a one-time-code step, or Auth.js reporting an error. */
function isStop(url: URL): boolean {
  return (
    (url.host === AUTH_HOST && url.pathname.startsWith("/u/mfa-")) ||
    (url.host === APP_HOST && (url.pathname === "/api/auth/error" || url.searchParams.has("error")))
  );
}

async function follow(
  ctx: Ctx,
  phase: string,
  method: "GET" | "POST",
  start: URL,
  form?: URLSearchParams,
  referer?: string,
): Promise<Followed> {
  let current = start;
  let verb = method;
  let body = form;
  let from = referer;
  for (let hops = 0; hops < MAX_HOPS; hops += 1) {
    const reply = await hop(ctx, phase, verb, current, body, from);
    if (reply.status >= 300 && reply.status < 400 && reply.location) {
      const next = new URL(reply.location, current);
      if (isStop(next)) {
        return { kind: "stopped", url: next };
      }
      verb = "GET";
      body = undefined;
      from = current.href;
      current = next;
      continue;
    }
    return { kind: "page", page: { url: current, status: reply.status, text: reply.text } };
  }
  throw new FlowError("the sign-in redirected too many times");
}

// --- Universal Login pages ---------------------------------------------------------------

const withoutScripts = (html: string) => html.replace(/<script\b[\s\S]*?<\/script>/giu, "");

function decodeEntities(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attributes(tag: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
    found.set((match[1] ?? "").toLowerCase(), decodeEntities(match[2] ?? match[3] ?? ""));
  }
  return found;
}

type Form = { action: string | undefined; fields: Array<[string, string]> };

/**
 * The page's primary sign-in form exactly as a browser would submit it: every named input with
 * its value, in page order, plus the primary button's own name and value. A form without an
 * `action` posts back to the page's own address.
 */
export function primaryForm(html: string): Form | undefined {
  const body = withoutScripts(html);
  const open = /<form\b[^>]*data-form-primary="true"[^>]*>/iu.exec(body);
  if (!open) {
    return undefined;
  }
  const end = body.indexOf("</form>", open.index);
  const inner = body.slice(open.index + open[0].length, end === -1 ? undefined : end);
  const fields: Array<[string, string]> = [];
  for (const [tag] of inner.matchAll(/<input\b[^>]*>/giu)) {
    const attrs = attributes(tag);
    const name = attrs.get("name");
    const type = (attrs.get("type") ?? "text").toLowerCase();
    if (
      name &&
      !["submit", "button", "image", "reset", "file", "checkbox", "radio"].includes(type)
    ) {
      fields.push([name, attrs.get("value") ?? ""]);
    }
  }
  for (const [tag] of inner.matchAll(/<button\b[^>]*>/giu)) {
    const attrs = attributes(tag);
    if (attrs.get("data-action-button-primary") === "true" && attrs.get("name")) {
      fields.push([attrs.get("name") ?? "", attrs.get("value") ?? ""]);
    }
  }
  return { action: attributes(open[0]).get("action"), fields };
}

function formBody(form: Form, overrides: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  const set = new Set<string>();
  for (const [name, value] of form.fields) {
    if (name in overrides) {
      if (!set.has(name)) {
        body.append(name, overrides[name] ?? "");
        set.add(name);
      }
    } else {
      body.append(name, value);
    }
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (!set.has(name)) {
      body.append(name, value);
    }
  }
  return body;
}

type PageVerdict =
  | { kind: "ok" }
  | { kind: "captcha" }
  | { kind: "wrong_password"; code: string }
  | { kind: "refused"; code: string };

/** Auth0 error codes that are a refusal of the account, not of the password. */
const BLOCKED = new Set(["blocked-user", "user-blocked", "too-many-attempts", "ip-blocked"]);

/**
 * What a Universal Login page says about the attempt. Only server-rendered signals count: the
 * client-side validation messages every page carries (`ulp-error-info`) and the captcha code in
 * its script are present on a healthy page too.
 */
export function judgePage(html: string): PageVerdict {
  const body = withoutScripts(html);
  if (/<div\b[^>]*data-captcha-sitekey/iu.test(body) || /name="captcha"/iu.test(body)) {
    return { kind: "captcha" };
  }
  const codes = [...body.matchAll(/data-error-code="([^"]*)"/giu)].map((match) => match[1] ?? "");
  const blocked = codes.find((code) => BLOCKED.has(code));
  if (blocked) {
    return { kind: "refused", code: blocked };
  }
  const wrong = codes.find((code) => /credentials/u.test(code));
  if (wrong || /id="error-element-|ulp-input-error-message/iu.test(body)) {
    return { kind: "wrong_password", code: wrong ?? "" };
  }
  return { kind: "ok" };
}

function verdictFailure(
  verdict: PageVerdict,
  trace: Trace,
  phase: string,
): LexroomLoginResult | undefined {
  if (verdict.kind === "ok") {
    return undefined;
  }
  trace("web.rejected", {
    phase,
    kind: verdict.kind,
    ...("code" in verdict ? { code: verdict.code } : {}),
  });
  if (verdict.kind === "captcha") {
    return { ok: false, reason: "captcha_required", error: CAPTCHA_ERROR };
  }
  if (verdict.kind === "refused") {
    return forbidden({
      error: `Lexroom's sign-in refused this account (${verdict.code}).`,
      code: verdict.code,
    });
  }
  return {
    ok: false,
    reason: "wrong_password",
    error: "Those Lexroom credentials were not accepted.",
  };
}

function stoppedFailure(url: URL, trace: Trace, phase: string): LexroomLoginResult {
  if (url.host === AUTH_HOST) {
    trace("web.rejected", { phase, kind: "mfa" });
    return { ok: false, reason: "mfa_required", error: MFA_ERROR };
  }
  const code = (url.searchParams.get("error") ?? "").slice(0, 60);
  trace("web.rejected", { phase, kind: "app_error", code });
  return forbidden({ error: `Lexroom's web app refused the sign-in (${code || "error"}).`, code });
}

// --- the session ------------------------------------------------------------------------------

type Dict = Record<string, unknown>;
const isRecord = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const firstText = (...values: unknown[]): string =>
  values.map((value) => (typeof value === "string" ? value.trim() : "")).find((v) => v !== "") ??
  "";

/** The token's own expiry, else the session's field for it (seconds or milliseconds), else unknown. */
function expiryOf(accessToken: string, user: Dict, session: Dict): number | null {
  const fromToken = accessTokenExpiresAtMs(accessToken);
  if (fromToken !== null) {
    return fromToken;
  }
  for (const source of [user, session]) {
    for (const key of ["accessTokenExpires", "accessTokenExpiresAt", "expiresAt", "expires_at"]) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value < 1e12 ? value * 1000 : value;
      }
    }
  }
  return null;
}

async function readSession(ctx: Ctx, email: string): Promise<LexroomLoginResult> {
  const reply = await hop(
    ctx,
    "web.session",
    "GET",
    new URL(`${LEXROOM_APP_URL}/api/auth/session`),
    undefined,
    undefined,
  );
  if (reply.status >= 500) {
    return unavailable(`Lexroom's web app returned ${reply.status} for the session.`);
  }
  let json: unknown;
  try {
    json = JSON.parse(reply.text);
  } catch {
    json = undefined;
  }
  const session = isRecord(json) ? json : {};
  const user = isRecord(session.user) ? session.user : {};
  const accessToken = firstText(
    user.accessToken,
    user.access_token,
    session.accessToken,
    session.access_token,
  );
  if (!accessToken) {
    ctx.trace("web.rejected", {
      phase: "web.session",
      kind: "no_access_token",
      status: reply.status,
    });
    return unavailable("Lexroom signed in, but its session has no access token.");
  }
  return {
    ok: true,
    email: firstText(user.email) || email,
    accessToken,
    refreshToken: "",
    accessExpiresAtMs: expiryOf(accessToken, user, session),
  };
}

// --- the flow -------------------------------------------------------------------------------

const onPath = (page: Page, prefix: string) =>
  page.url.host === AUTH_HOST && page.url.pathname.startsWith(prefix);

/** Signs in through the web app's own Auth0 flow. Throws `LexroomTimeoutError` when a limit ends it. */
export async function webLogin(params: {
  email: string;
  password: string;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  trace: Trace;
}): Promise<LexroomLoginResult> {
  const ctx: Ctx = {
    fetchImpl: params.fetchImpl,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    trace: params.trace,
    jar: new Map(),
  };
  try {
    const entry = await follow(
      ctx,
      "web.authorize",
      "GET",
      new URL(`${LEXROOM_APP_URL}/api/auth/login`),
    );
    if (entry.kind === "stopped") {
      return stoppedFailure(entry.url, ctx.trace, "web.authorize");
    }
    if (!onPath(entry.page, "/u/login/identifier")) {
      return unavailable("Lexroom's sign-in did not open the identifier page.");
    }
    const identifier = await submit(ctx, "web.identifier", entry.page, {
      username: params.email,
    });
    if ("ok" in identifier) {
      return identifier;
    }
    if (!onPath(identifier, "/u/login/password")) {
      return unavailable("Lexroom's sign-in did not open the password page.");
    }
    const password = await submit(ctx, "web.password", identifier, {
      username: params.email,
      password: params.password,
    });
    if ("ok" in password) {
      return password;
    }
    if (password.url.host === AUTH_HOST) {
      return (
        verdictFailure(judgePage(password.text), ctx.trace, "web.password") ??
        unavailable("Lexroom's sign-in stopped on a page that was not expected.")
      );
    }
    return await readSession(ctx, params.email);
  } catch (error) {
    if (error instanceof FlowError) {
      ctx.trace("web.failed", { error: error.message.slice(0, 100) });
      return unavailable(`Lexroom's web sign-in failed: ${error.message}.`);
    }
    throw error;
  }
}

/**
 * Posts the page's own form with the credentials filled in and follows the redirects. Returns the
 * page it ends on, or the failure when the page or a redirect says why it was refused.
 */
async function submit(
  ctx: Ctx,
  phase: string,
  page: Page,
  overrides: Record<string, string>,
): Promise<Page | LexroomLoginResult> {
  const early = verdictFailure(judgePage(page.text), ctx.trace, phase);
  if (early) {
    return early;
  }
  const form = primaryForm(page.text);
  if (!form) {
    return unavailable("Lexroom's sign-in page has no sign-in form; it may have changed.");
  }
  const target = new URL(form.action ?? "", page.url);
  const result = await follow(ctx, phase, "POST", target, formBody(form, overrides), page.url.href);
  if (result.kind === "stopped") {
    return stoppedFailure(result.url, ctx.trace, phase);
  }
  if (result.page.url.host === AUTH_HOST && phase === "web.identifier") {
    const verdict = verdictFailure(judgePage(result.page.text), ctx.trace, phase);
    if (verdict) {
      return verdict;
    }
  }
  return result.page;
}
