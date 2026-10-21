import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  firstString,
  kapsoMessagesEndpoint,
  postKapsoMessage,
  readRecord,
  resolveKapsoAccount,
} from "./kapso-api.js";
import { languageFromProfile } from "./research-link-outbound.js";

const TEMPLATE_TIMEOUT_MS = 10_000;

/** Meta template names are lowercase letters, digits, and underscores. */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
/** Meta language codes: `en`, `it`, `en_US`, `pt_BR`. */
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/;
const RECIPIENT_DIGITS = /^\d{6,20}$/;

export type KapsoTemplate = { name: string; language: string };

export type KapsoTemplateResult = { ok: true; messageId?: string } | { ok: false; error: string };

/** Read `digestReadyTemplate` from the plugin config; null means it is unset or incomplete. */
export function readDigestReadyTemplate(pluginConfig: unknown): KapsoTemplate | null {
  const value = readRecord(readRecord(pluginConfig)?.digestReadyTemplate);
  const name = firstString(value?.name);
  const language = firstString(value?.language);
  return name && language ? { name, language } : null;
}

/**
 * The template that nudges a number whose morning brief is held: `briefReadyTemplate` in the
 * number's profile language when the template is approved in it (`languages`), else in its default
 * `language`. Without `briefReadyTemplate`, `digestReadyTemplate` as configured. Null: neither is set.
 */
export function readBriefReadyTemplate(
  pluginConfig: unknown,
  profileLanguage: string | undefined,
): KapsoTemplate | null {
  const value = readRecord(readRecord(pluginConfig)?.briefReadyTemplate);
  const name = firstString(value?.name);
  const language = firstString(value?.language);
  if (!name || !language) {
    return readDigestReadyTemplate(pluginConfig);
  }
  const wanted = languageFromProfile(profileLanguage);
  const offered = Array.isArray(value?.languages) ? value.languages : [];
  const own = offered.find(
    (code): code is string =>
      typeof code === "string" && code.split("_")[0]?.toLowerCase() === wanted,
  );
  return { name, language: own ?? language };
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

const warnedUnset = { digest: new WeakSet<object>(), brief: new WeakSet<object>() };

/** Log once per plugin instance: a missing template is a setup gap, not a per-poll event. */
export function warnDigestReadyTemplateUnset(
  api: Pick<OpenClawPluginApi, "logger">,
  kind: "digest" | "brief" = "digest",
): void {
  if (warnedUnset[kind].has(api)) {
    return;
  }
  warnedUnset[kind].add(api);
  api.logger.warn(
    kind === "digest"
      ? "ada: digest held for a closed WhatsApp window but digestReadyTemplate is not set; the user will not be nudged to reply"
      : "ada: morning brief held for a closed WhatsApp window but neither briefReadyTemplate nor digestReadyTemplate is set; the user will not be nudged to reply",
  );
}

/** Tell one number a digest is waiting so a reply can reopen its 24-hour window. */
export async function sendDigestReadyNotice(params: {
  api: Pick<OpenClawPluginApi, "config" | "logger">;
  template: KapsoTemplate;
  /** Whom to nudge. There is no default: a send always names the number it is for. */
  to: string;
  fetchImpl?: typeof fetch;
}): Promise<KapsoTemplateResult> {
  const result: KapsoTemplateResult = await sendKapsoTemplate({
    config: params.api.config,
    to: params.to,
    template: params.template,
    fetchImpl: params.fetchImpl,
  });
  if (result.ok) {
    params.api.logger.info("ada sent the digest-ready template to reopen the WhatsApp window");
  } else {
    params.api.logger.warn(`ada digest-ready template not sent: ${result.error}`);
  }
  return result;
}
