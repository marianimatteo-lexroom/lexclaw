import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  firstString,
  kapsoMessagesEndpoint,
  postKapsoMessage,
  readRecord,
  resolveKapsoAccount,
} from "./kapso-api.js";

const TEMPLATE_TIMEOUT_MS = 10_000;

/** Meta template names are lowercase letters, digits, and underscores. */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
/** Meta language codes: `en`, `it`, `en_US`, `pt_BR`. */
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/;
const RECIPIENT_DIGITS = /^\d{6,20}$/;

export type KapsoTemplate = { name: string; language: string };

export type KapsoTemplateResult = { ok: true; messageId?: string } | { ok: false; error: string };

function readTemplate(
  pluginConfig: unknown,
  key: "digestReadyTemplate" | "requestReadyTemplate",
): KapsoTemplate | null {
  const value = readRecord(readRecord(pluginConfig)?.[key]);
  const name = firstString(value?.name);
  const language = firstString(value?.language);
  return name && language ? { name, language } : null;
}

/**
 * Read `digestReadyTemplate` from the plugin config; null means it is unset or incomplete. It is
 * the MARKETING template, for the morning digest and brief that Ada starts on her own.
 */
export function readDigestReadyTemplate(pluginConfig: unknown): KapsoTemplate | null {
  return readTemplate(pluginConfig, "digestReadyTemplate");
}

/**
 * Read `requestReadyTemplate`; null means it is unset or incomplete. It is the UTILITY template,
 * for a result the person asked for, such as a finished Lexroom research.
 */
export function readRequestReadyTemplate(pluginConfig: unknown): KapsoTemplate | null {
  return readTemplate(pluginConfig, "requestReadyTemplate");
}

/** Cloud API recipients are digits with country code, no plus or spaces. */
function normalizeRecipient(value: string): string | null {
  const digits = value.replace(/[\s()-]/gu, "").replace(/^\+/u, "");
  return RECIPIENT_DIGITS.test(digits) ? digits : null;
}

/**
 * Send one pre-approved, variable-less WhatsApp template through Kapso. Templates are the
 * only message the Cloud API accepts outside the 24-hour customer-service window.
 */
export async function sendKapsoTemplate(params: {
  config: unknown;
  to: string;
  template: KapsoTemplate;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<KapsoTemplateResult> {
  if (!TEMPLATE_NAME.test(params.template.name)) {
    return { ok: false, error: "kapso template name is invalid" };
  }
  if (!TEMPLATE_LANGUAGE.test(params.template.language)) {
    return { ok: false, error: "kapso template language is invalid" };
  }
  const to = normalizeRecipient(params.to);
  if (!to) {
    return { ok: false, error: "kapso template recipient is invalid" };
  }
  const account = resolveKapsoAccount(params.config, params.accountId, params.env ?? process.env);
  if (account.enabled === false) {
    return { ok: false, error: "kapso account is disabled" };
  }
  const endpoint = kapsoMessagesEndpoint(account);
  if (!endpoint.ok) {
    return {
      ok: false,
      error:
        endpoint.reason === "missing-credentials"
          ? "kapso credentials are missing"
          : endpoint.error,
    };
  }

  const posted = await postKapsoMessage({
    endpoint,
    body: {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: params.template.name, language: { code: params.template.language } },
    },
    timeoutMs: TEMPLATE_TIMEOUT_MS,
    readJson: true,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });
  if (!posted.ok) {
    if (posted.kind === "http") {
      return { ok: false, error: `kapso template returned HTTP ${posted.status}` };
    }
    return {
      ok: false,
      error:
        posted.kind === "timeout" ? "kapso template timed out" : "kapso template request failed",
    };
  }
  const body = posted.json;
  const messages = readRecord(body)?.messages;
  const messageId = Array.isArray(messages) ? firstString(readRecord(messages[0])?.id) : undefined;
  return messageId ? { ok: true, messageId } : { ok: true };
}

const warnedUnset = new WeakSet<object>();

/** Log once per plugin instance: a missing template is a setup gap, not a per-poll event. */
export function warnDigestReadyTemplateUnset(api: Pick<OpenClawPluginApi, "logger">): void {
  if (warnedUnset.has(api)) {
    return;
  }
  warnedUnset.add(api);
  api.logger.warn(
    "ada: digest held for a closed WhatsApp window but digestReadyTemplate is not set; the user will not be nudged to reply",
  );
}

async function sendReadyNotice(
  params: {
    api: Pick<OpenClawPluginApi, "config" | "logger">;
    template: KapsoTemplate;
    to: string;
    fetchImpl?: typeof fetch;
  },
  label: string,
): Promise<KapsoTemplateResult> {
  const result: KapsoTemplateResult = await sendKapsoTemplate({
    config: params.api.config,
    to: params.to,
    template: params.template,
    fetchImpl: params.fetchImpl,
  });
  if (result.ok) {
    params.api.logger.info(`ada sent the ${label} template to reopen the WhatsApp window`);
  } else {
    params.api.logger.warn(`ada ${label} template not sent: ${result.error}`);
  }
  return result;
}

/** Tell one number a digest is waiting so a reply can reopen its 24-hour window. */
export async function sendDigestReadyNotice(params: {
  api: Pick<OpenClawPluginApi, "config" | "logger">;
  template: KapsoTemplate;
  /** Whom to nudge. There is no default: a send always names the number it is for. */
  to: string;
  fetchImpl?: typeof fetch;
}): Promise<KapsoTemplateResult> {
  return await sendReadyNotice(params, "digest-ready");
}

/**
 * Tell one number that a result they asked for is waiting, so a reply can reopen their window.
 * It uses the UTILITY `requestReadyTemplate`, and falls back to the digest template, the earlier
 * behavior, when that one is not configured or Kapso refuses it. Null: neither is configured.
 */
export async function sendRequestReadyNotice(params: {
  api: Pick<OpenClawPluginApi, "config" | "logger" | "pluginConfig">;
  to: string;
  fetchImpl?: typeof fetch;
}): Promise<KapsoTemplateResult | null> {
  const request = readRequestReadyTemplate(params.api.pluginConfig);
  if (request) {
    const sent = await sendReadyNotice({ ...params, template: request }, "request-ready");
    if (sent.ok) {
      return sent;
    }
  }
  const digest = readDigestReadyTemplate(params.api.pluginConfig);
  if (!digest) {
    return null;
  }
  return await sendReadyNotice({ ...params, template: digest }, "digest-ready");
}
