import {
  firstString,
  kapsoMediaEndpoint,
  kapsoMessagesEndpoint,
  postKapsoMessage,
  readRecord,
  resolveKapsoAccount,
} from "./kapso-api.js";

const UPLOAD_TIMEOUT_MS = 20_000;
const SEND_TIMEOUT_MS = 10_000;
const RECIPIENT_DIGITS = /^\d{6,20}$/;

export type KapsoDocumentResult = { ok: true; messageId?: string } | { ok: false; error: string };

/**
 * Sends one PDF to a WhatsApp number through Kapso: the file is uploaded to the Cloud API media
 * endpoint, then a `document` message references the returned media id. Never throws, and no
 * error carries the API key or the file's contents.
 */
export async function sendKapsoPdf(params: {
  config: unknown;
  /** Digits with country code; a leading `+` is accepted. */
  to: string;
  filename: string;
  bytes: Uint8Array<ArrayBuffer>;
  accountId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<KapsoDocumentResult> {
  const to = params.to.replace(/[\s()-]/gu, "").replace(/^\+/u, "");
  if (!RECIPIENT_DIGITS.test(to)) {
    return { ok: false, error: "kapso document recipient is invalid" };
  }
  const account = resolveKapsoAccount(params.config, params.accountId, params.env ?? process.env);
  if (account.enabled === false) {
    return { ok: false, error: "kapso account is disabled" };
  }
  const media = kapsoMediaEndpoint(account);
  const messages = kapsoMessagesEndpoint(account);
  if (!media.ok || !messages.ok) {
    const failure = !media.ok ? media : messages;
    return {
      ok: false,
      error:
        !failure.ok && failure.reason === "invalid"
          ? failure.error
          : "kapso credentials are missing",
    };
  }

  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set("type", "application/pdf");
  form.set("file", new Blob([params.bytes], { type: "application/pdf" }), params.filename);
  const uploaded = await postKapsoMessage({
    endpoint: media,
    body: form,
    timeoutMs: UPLOAD_TIMEOUT_MS,
    readJson: true,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });
  if (!uploaded.ok) {
    return { ok: false, error: describeFailure("upload", uploaded) };
  }
  const mediaId = firstString(readRecord(uploaded.json)?.id);
  if (!mediaId) {
    return { ok: false, error: "kapso document upload returned no media id" };
  }

  const posted = await postKapsoMessage({
    endpoint: messages,
    body: {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: { id: mediaId, filename: params.filename },
    },
    timeoutMs: SEND_TIMEOUT_MS,
    readJson: true,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
  });
  if (!posted.ok) {
    return { ok: false, error: describeFailure("send", posted) };
  }
  const sent = readRecord(posted.json)?.messages;
  const messageId = Array.isArray(sent) ? firstString(readRecord(sent[0])?.id) : undefined;
  return messageId ? { ok: true, messageId } : { ok: true };
}

function describeFailure(
  step: "upload" | "send",
  failure: { ok: false; kind: "http"; status: number } | { ok: false; kind: "timeout" | "network" },
): string {
  if (failure.kind === "http") {
    return `kapso document ${step} returned HTTP ${failure.status}`;
  }
  return failure.kind === "timeout"
    ? `kapso document ${step} timed out`
    : `kapso document ${step} request failed`;
}
