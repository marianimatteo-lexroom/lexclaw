import type { IncomingMessage, ServerResponse } from "node:http";
import type { GoogleConnectedNotice } from "./google-notify.js";
import type { LexroomAccountStore } from "./lexroom-account-contract.js";
import {
  isLexroomAccessLive,
  readConnectState,
  readLexroomConnectConfig,
  type LexroomConnectConfig,
} from "./lexroom-connect.js";
import { lexroomLogger } from "./lexroom-log.js";
import { loginLexroomAccount } from "./lexroom-login.js";

type ConnectHttpDeps = {
  config: LexroomConnectConfig;
  now: () => Date;
  store: LexroomAccountStore;
  log: {
    error: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
  notifyConnected?: (email: string) => Promise<GoogleConnectedNotice>;
  login?: typeof loginLexroomAccount;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const PAGE_STYLE = `
:root {
  color-scheme: light;
  --ink: #111112;
  --muted: #545458;
  --faint: #6a6a6f;
  --line: #e4eaf3;
  --paper: #ffffff;
  --field: #f3f6fb;
  --wash: #d5e3f6;
  --mark: #01102b;
  --blue: #155fc1;
  --chip: #f7fbff;
  --ready: #0c7a45;
  --ready-wash: #e7f6ee;
  --retry: #8a5a00;
  --retry-wash: #fbf3df;
  --blocked: #8d3030;
  --blocked-wash: #fbeeee;
  --shadow: 0 1px 1px rgba(1, 16, 43, 0.04), 0 24px 48px -28px rgba(1, 16, 43, 0.45);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --ink: #f4f7fb;
    --muted: #c5d0de;
    --faint: #8ea0b5;
    --line: #2a3544;
    --paper: #161c25;
    --field: #0d1218;
    --wash: #17304d;
    --mark: #e8eef8;
    --blue: #7aa7f5;
    --chip: #121922;
    --ready: #8ed4ae;
    --ready-wash: #163328;
    --retry: #e6c27a;
    --retry-wash: #2c2414;
    --blocked: #f0b4b4;
    --blocked-wash: #2c1818;
    --shadow: 0 24px 48px -28px rgba(0, 0, 0, 0.7);
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  min-height: 100dvh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  background:
    radial-gradient(720px 320px at 50% -40px, var(--wash), transparent 70%),
    var(--field);
  color: var(--ink);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.card {
  width: min(460px, 100%);
  background: var(--paper);
  border: 1px solid var(--line);
  border-radius: 24px;
  padding: 36px 32px 28px;
  box-shadow: var(--shadow);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  color: var(--mark);
  font-size: 15px;
  font-weight: 650;
  letter-spacing: -0.03em;
}
.brand i {
  width: 8px;
  height: 8px;
  border-radius: 99px;
  background: var(--blue);
}
h1 {
  margin: 22px 0 8px;
  font-size: 32px;
  line-height: 1.1;
  font-weight: 620;
  letter-spacing: -0.035em;
}
.lead {
  margin: 0 0 22px;
  color: var(--muted);
  font-size: 15.5px;
  line-height: 1.5;
  text-wrap: balance;
}
label {
  display: block;
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}
input {
  width: 100%;
  margin: 0 0 14px;
  padding: 12px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--field);
  color: var(--ink);
  font: inherit;
}
button {
  width: 100%;
  margin-top: 8px;
  padding: 13px 16px;
  border: 0;
  border-radius: 12px;
  background: var(--blue);
  color: #fff;
  font: inherit;
  font-weight: 650;
  cursor: pointer;
}
.note {
  margin: 16px 0 0;
  color: var(--faint);
  font-size: 13px;
  line-height: 1.45;
}
.error {
  margin: 0 0 16px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--blocked-wash);
  color: var(--blocked);
  font-size: 14px;
  line-height: 1.4;
}
.badge {
  width: 52px;
  height: 52px;
  margin-top: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--ready);
  background: var(--ready-wash);
}
.badge.error {
  color: var(--blocked);
  background: var(--blocked-wash);
}
.foot {
  margin: 18px 0 0;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  color: var(--faint);
  font-size: 13px;
  line-height: 1.45;
}
`;

function writeHtml(res: ServerResponse, status: number, html: string, formAction = false): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    formAction
      ? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'self'"
      : "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
  );
  res.end(html);
}

const CHECK_ICON =
  '<path d="M7 13.2 11.1 17.3 19 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
const CROSS_ICON =
  '<path d="M8 8 18 18M18 8 8 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';

/** Only the Connected page may show the green check; every failure state gets the red cross. */
function renderStatusPage(params: {
  heading: string;
  message: string;
  email?: string;
  failed?: boolean;
}): string {
  const email = params.email?.trim() ?? "";
  const account = email
    ? `<p class="foot">Signed in as <b>${escapeHtml(email)}</b>. You can close this page and return to WhatsApp.</p>`
    : `<p class="foot">You can close this page and return to WhatsApp.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Ada</title><style>${PAGE_STYLE}</style></head><body><main class="card"><p class="brand"><i></i>Ada</p><div class="badge${params.failed ? " error" : ""}" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 26 26" fill="none">${params.failed ? CROSS_ICON : CHECK_ICON}</svg></div><h1>${escapeHtml(params.heading)}</h1><p class="lead">${escapeHtml(params.message)}</p>${account}</main></body></html>`;
}

function renderLoginForm(params: { state: string; email?: string; error?: string }): string {
  const error = params.error ? `<p class="error" role="alert">${escapeHtml(params.error)}</p>` : "";
  const lead =
    "Sign in with the Lexroom account Ada should use for research and drafts. Ada keeps the email and password encrypted so she can sign in again when the session expires. They are never shown or sent anywhere except Lexroom.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Ada · Lexroom</title><style>${PAGE_STYLE}</style></head><body><main class="card"><p class="brand"><i></i>Ada</p><h1>Connect Lexroom</h1><p class="lead">${escapeHtml(lead)}</p>${error}<form method="post" action="/ada/lexroom/connect"><input type="hidden" name="state" value="${escapeHtml(params.state)}"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(params.email ?? "")}"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required value=""><button type="submit">Connect Lexroom</button></form><p class="note">This page expires with the WhatsApp link. Ask Ada for a new one if it stops working.</p></main></body></html>`;
}

function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (Buffer.concat(chunks).length > 32_768) {
      throw new Error("form too large");
    }
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Saves the credential and reads it back before the page may claim success. A credential
 * that cannot be read back, or that Ada would already treat as expired, is not a connection.
 */
async function persistAndConfirm(
  deps: ConnectHttpDeps,
  record: Parameters<LexroomAccountStore["upsertAccount"]>[0],
): Promise<{ reason: string; message: string } | undefined> {
  const saveFailed = {
    reason: "not_saved",
    message:
      "Ada could not save the Lexroom sign-in. Return to WhatsApp and ask Ada for a new link.",
  };
  try {
    await deps.store.upsertAccount(record);
    const saved = await deps.store.readAccount();
    if (!saved || saved.accessToken !== record.accessToken || saved.email !== record.email) {
      return { ...saveFailed, reason: "not_readable_after_write" };
    }
    if (
      !saved.password &&
      !isLexroomAccessLive({
        accessToken: saved.accessToken,
        accessExpiresAtMs: saved.accessExpiresAtMs,
        now: deps.now(),
      })
    ) {
      return {
        reason: "already_expired",
        message:
          "Lexroom signed you in, but the sign-in it issued expires almost immediately, so Ada cannot use it. Return to WhatsApp and ask Ada for a new link; if it happens again, contact support.",
      };
    }
    return undefined;
  } catch (error) {
    deps.log.error(
      `ada lexroom connect could not save the credential: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return saveFailed;
  }
}

export async function handleAdaLexroomConnect(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectHttpDeps,
): Promise<boolean> {
  const config = readLexroomConnectConfig(deps.config);
  if (!config.ok) {
    deps.log.error("ada lexroom connect is not configured");
    writeHtml(
      res,
      503,
      renderStatusPage({
        heading: "Not ready",
        failed: true,
        message: "Ada Lexroom connect is not configured.",
      }),
    );
    return true;
  }

  if (req.method === "GET") {
    const state = query(req).get("state")?.trim() ?? "";
    const now = deps.now();
    const parsed = state ? readConnectState(config.settings.stateSecret, state, now) : null;
    if (!parsed || !(await deps.store.hasPending(parsed.nonce, now.getTime()))) {
      writeHtml(
        res,
        400,
        renderStatusPage({
          heading: "Link expired",
          failed: true,
          message:
            "This connect link is no longer valid. Return to WhatsApp and ask Ada for a new link.",
        }),
      );
      return true;
    }
    writeHtml(res, 200, renderLoginForm({ state }), true);
    return true;
  }

  if (req.method !== "POST") {
    writeHtml(
      res,
      405,
      renderStatusPage({
        heading: "Could not connect",
        failed: true,
        message: "Ada could not finish connecting the Lexroom account.",
      }),
    );
    return true;
  }

  let form: URLSearchParams;
  try {
    form = await readFormBody(req);
  } catch {
    writeHtml(
      res,
      413,
      renderStatusPage({
        heading: "Could not connect",
        failed: true,
        message: "Ada could not read the sign-in form.",
      }),
    );
    return true;
  }

  const state = form.get("state")?.trim() ?? "";
  const email = form.get("email")?.trim() ?? "";
  const password = form.get("password") ?? "";
  const now = deps.now();
  const parsed = state ? readConnectState(config.settings.stateSecret, state, now) : null;
  if (!parsed || !(await deps.store.hasPending(parsed.nonce, now.getTime()))) {
    writeHtml(
      res,
      400,
      renderStatusPage({
        heading: "Link expired",
        failed: true,
        message:
          "This connect link is no longer valid. Return to WhatsApp and ask Ada for a new link.",
      }),
    );
    return true;
  }

  const login = deps.login ?? loginLexroomAccount;
  const log = lexroomLogger({
    info: (message) => (deps.log.info ?? (() => undefined))(message),
    warn: (message) => (deps.log.warn ?? deps.log.error)(message),
  });
  const result = await login({
    email,
    password,
    baseUrl: config.settings.baseUrl,
  });
  if (!result.ok) {
    if (result.reason === "invalid_credentials") {
      writeHtml(
        res,
        401,
        renderLoginForm({
          state,
          email,
          error: result.error,
        }),
        true,
      );
      return true;
    }
    deps.log.error(`ada lexroom login failed: ${result.error}`);
    writeHtml(
      res,
      200,
      renderLoginForm({
        state,
        email,
        error: result.error || "Ada could not finish Lexroom sign-in. Try again shortly.",
      }),
      true,
    );
    return true;
  }

  const pending = await deps.store.consumePending(parsed.nonce, now.getTime());
  if (!pending) {
    writeHtml(
      res,
      400,
      renderStatusPage({
        heading: "Link expired",
        failed: true,
        message:
          "This connect link is no longer valid. Return to WhatsApp and ask Ada for a new link.",
      }),
    );
    return true;
  }

  const record = {
    email: result.email,
    accessToken: result.accessToken,
    password,
    refreshToken: result.refreshToken,
    accessExpiresAtMs: result.accessExpiresAtMs,
    connectedAtMs: now.getTime(),
  };
  log("connect.callback.write", {
    emailInput: email,
    emailStored: record.email,
    normalization: email === record.email ? "unchanged" : "lowercased-or-from-session",
  });
  const failure = await persistAndConfirm(deps, record);
  if (failure) {
    log("connect.callback.rejected", { reason: failure.reason });
    writeHtml(
      res,
      500,
      renderStatusPage({ heading: "Could not connect", message: failure.message, failed: true }),
    );
    return true;
  }
  log("connect.callback.confirmed", { email: record.email });
  if (deps.notifyConnected) {
    const notice = await deps.notifyConnected(result.email);
    if (!notice.ok) {
      deps.log.error(`ada lexroom connect confirmation was not sent: ${notice.error}`);
    }
  }
  writeHtml(
    res,
    200,
    renderStatusPage({
      heading: "Connected",
      message: "Lexroom is connected to Ada for research and drafts.",
      email: result.email,
    }),
  );
  return true;
}
