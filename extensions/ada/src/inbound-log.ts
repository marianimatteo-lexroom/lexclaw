import { normalizeWhatsAppNumber } from "./google-notify.js";

/** `+39…4567`: enough to tell two senders apart in a log, never the whole number. */
export function maskNumber(...senders: unknown[]): string {
  for (const sender of senders) {
    const digits = normalizeWhatsAppNumber(sender);
    if (digits) {
      return `+${digits.slice(0, 2)}…${digits.slice(-4)}`;
    }
  }
  return "unknown";
}

type InfoLogger = { info?: (message: string) => void };

/**
 * One info line for every inbound path that ends without doing its job, so a message that
 * produced no reply is never silent in the log. Carries the stage, the reason and a masked
 * sender, never message text.
 */
export function logInboundSkip(
  logger: InfoLogger,
  params: { stage: string; reason: string; sender?: unknown; messageId?: unknown },
): void {
  const id = typeof params.messageId === "string" ? params.messageId.slice(-6) : undefined;
  logger.info?.(
    `ada inbound skipped stage=${params.stage} reason=${params.reason} sender=${maskNumber(...(Array.isArray(params.sender) ? params.sender : [params.sender]))}${id ? ` msg=…${id}` : ""}`,
  );
}

/** The sender a session key names (`agent:main:kapso-whatsapp:direct:<number>`), masked. */
export function maskSessionNumber(sessionKey: unknown): string {
  return typeof sessionKey === "string" ? maskNumber(...sessionKey.split(":")) : "unknown";
}
