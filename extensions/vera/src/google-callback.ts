import type { IncomingMessage, ServerResponse } from "node:http";
import type { GoogleAccountStore } from "./google-account-contract.js";
import { exchangeAuthorizationCode } from "./google-api.js";
import {
  readConnectState,
  readGoogleConnectConfig,
  type GoogleConnectConfig,
} from "./google-connect.js";
import type { GoogleConnectedNotice } from "./google-notify.js";

type CallbackDeps = {
  config: GoogleConnectConfig;
  now: () => Date;
  store: GoogleAccountStore;
  exchange: typeof exchangeAuthorizationCode;
  log: { error: (message: string) => void };
  notifyConnected?: (email: string) => Promise<GoogleConnectedNotice>;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

type ConnectPage = {
  kind: "ready" | "retry" | "blocked";
  heading: string;
  message: string;
  email?: string;
};

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
.badge {
  width: 52px;
  height: 52px;
  margin-top: 28px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  color: var(--tone);
  background: var(--tone-wash);
}
.ready { --tone: var(--ready); --tone-wash: var(--ready-wash); }
.retry { --tone: var(--retry); --tone-wash: var(--retry-wash); }
.blocked { --tone: var(--blocked); --tone-wash: var(--blocked-wash); }
h1 {
  margin: 18px 0 8px;
  font-size: 32px;
  line-height: 1.1;
  font-weight: 620;
  letter-spacing: -0.035em;
}
.lead {
  margin: 0;
  color: var(--muted);
  font-size: 15.5px;
  line-height: 1.5;
  text-wrap: balance;
}
.account {
  margin-top: 22px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--chip);
}
.avatar {
  width: 32px;
  height: 32px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 50%;
  background: #d2dcfe;
  color: #093877;
  font-size: 13px;
  font-weight: 700;
}
.account b {
  font-weight: 600;
  font-size: 14px;
  overflow-wrap: anywhere;
}
.products {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}
.products li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  border-top: 1px solid var(--line);
  font-size: 14px;
}
.products li span:last-child {
  color: var(--ready);
  font-size: 13px;
  font-weight: 650;
}
.foot {
  margin: 8px 0 0;
  padding-top: 16px;
  border-top: 1px solid var(--line);
  color: var(--faint);
  font-size: 13px;
  line-height: 1.45;
}
@media (max-width: 520px) {
  .card { padding: 28px 22px 22px; border-radius: 20px; }
  h1 { font-size: 28px; }
}
@media (prefers-reduced-motion: no-preference) {
  .card { animation: rise 0.45s cubic-bezier(.2, .8, .2, 1) both; }
  .draw {
    stroke-dasharray: 22;
    stroke-dashoffset: 22;
    animation: draw 0.45s ease 0.18s forwards;
  }
}
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@keyframes draw { to { stroke-dashoffset: 0; } }
`;

function mark(kind: ConnectPage["kind"]): string {
  if (kind === "ready") {
    return `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true"><path class="draw" d="M7 13.2 11.1 17.3 19 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }
  if (kind === "retry") {
    return `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true"><path d="M13 8v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M13 17.5h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>`;
  }
  return `<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true"><path d="M8 13h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

function renderConnectPage(content: ConnectPage): string {
  const email = content.email?.trim() ?? "";
  const initial = email ? escapeHtml(email.slice(0, 1).toUpperCase()) : "";
  const account = email
    ? `<div class="account"><span class="avatar" aria-hidden="true">${initial}</span><b>${escapeHtml(email)}</b></div>`
    : "";
  const access =
    content.kind === "ready"
      ? `<ul class="products"><li><span>Gmail</span><span>Read only</span></li><li><span>Google Calendar</span><span>Read only</span></li></ul><p class="foot">You can close this page and return to WhatsApp.</p>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Vera</title><style>${PAGE_STYLE}</style></head><body><main class="card"><p class="brand"><i></i>Vera</p><div class="badge ${content.kind}">${mark(content.kind)}</div><h1>${escapeHtml(content.heading)}</h1><p class="lead">${escapeHtml(content.message)}</p>${account}${access}</main></body></html>`;
}

export function writeVeraConnectPage(
  res: ServerResponse,
  status: number,
  content: ConnectPage,
): void {
  res.statusCode = status;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'",
  );
  res.end(renderConnectPage(content));
}

function query(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
}

export async function handleVeraGoogleCallback(
  req: IncomingMessage,
  res: ServerResponse,
  deps: CallbackDeps,
): Promise<boolean> {
  if (req.method !== "GET") {
    writeVeraConnectPage(res, 405, {
      kind: "blocked",
      heading: "Could not connect",
      message: "Vera could not finish connecting the Google account.",
    });
    return true;
  }
  const config = readGoogleConnectConfig(deps.config);
  if (!config.ok) {
    deps.log.error("vera google callback is not configured");
    writeVeraConnectPage(res, 503, {
      kind: "blocked",
      heading: "Not ready",
      message: "Vera Google connect is not configured.",
    });
    return true;
  }
  const params = query(req);
  if (params.get("error")) {
    writeVeraConnectPage(res, 200, {
      kind: "retry",
      heading: "Not connected",
      message:
        "Vera did not connect Gmail or Google Calendar. Return to WhatsApp and ask Vera for a new link.",
    });
    return true;
  }
  const code = params.get("code")?.trim() ?? "";
  const state = params.get("state")?.trim() ?? "";
  const now = deps.now();
  const parsed = state ? readConnectState(config.settings.stateSecret, state, now) : null;
  if (!code || !parsed) {
    writeVeraConnectPage(res, 400, {
      kind: "retry",
      heading: "Link expired",
      message:
        "This connect link is no longer valid. Return to WhatsApp and ask Vera for a new link.",
    });
    return true;
  }
  const pending = await deps.store.consumePending(parsed.nonce, now.getTime());
  if (!pending) {
    writeVeraConnectPage(res, 400, {
      kind: "retry",
      heading: "Link expired",
      message:
        "This connect link is no longer valid. Return to WhatsApp and ask Vera for a new link.",
    });
    return true;
  }
  const exchanged = await deps.exchange({
    clientId: config.settings.clientId,
    clientSecret: config.settings.clientSecret,
    redirectUri: config.settings.redirectUri,
    code,
    now,
  });
  if (!exchanged.ok) {
    deps.log.error(`vera google token exchange failed: ${exchanged.reason}`);
    const denied = exchanged.reason === "denied_scopes";
    writeVeraConnectPage(res, 400, {
      kind: denied ? "retry" : "blocked",
      heading: denied ? "Approval needed" : "Could not connect",
      message: denied
        ? "Approve both Gmail and Google Calendar, then ask Vera for a new link."
        : "Vera could not finish connecting the Google account. Return to WhatsApp and ask for a new link.",
    });
    return true;
  }
  await deps.store.upsertAccount({
    email: exchanged.token.email,
    refreshToken: exchanged.token.refreshToken,
    accessToken: exchanged.token.accessToken,
    accessExpiresAtMs: exchanged.token.accessExpiresAtMs,
    connectedAtMs: now.getTime(),
  });
  if (deps.notifyConnected) {
    const notice = await deps.notifyConnected(exchanged.token.email);
    if (!notice.ok) {
      deps.log.error(`vera google connect confirmation was not sent: ${notice.error}`);
    }
  }
  writeVeraConnectPage(res, 200, {
    kind: "ready",
    heading: "Connected",
    message: "Gmail and Google Calendar are connected to Vera.",
    email: exchanged.token.email,
  });
  return true;
}
