export const ADA_WHATSAPP_CHANNEL = "kapso-whatsapp";

export function readAdaWhatsAppTarget(config: unknown): string | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  const channels = (config as { channels?: unknown }).channels;
  if (!channels || typeof channels !== "object") {
    return null;
  }
  const channel = (channels as Record<string, unknown>)[ADA_WHATSAPP_CHANNEL];
  if (!channel || typeof channel !== "object") {
    return null;
  }
  const defaultTo = (channel as { defaultTo?: unknown }).defaultTo;
  if (typeof defaultTo !== "string") {
    return null;
  }
  const target = defaultTo.trim();
  return target || null;
}

/**
 * Reduces a WhatsApp sender or `defaultTo` to its digits so `+39 333 0000000`,
 * `390000000000`, `whatsapp:+390000000000`, and `390000000000@s.whatsapp.net` compare
 * equal. Returns null for anything that is not a phone number (group ids, names).
 */
export function normalizeWhatsAppNumber(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const bare = value
    .trim()
    .replace(/^[A-Za-z][\w-]*:/u, "")
    .replace(/@(?:s\.whatsapp\.net|c\.us)$/iu, "")
    .trim();
  if (!/^\+?[\d\s().-]+$/u.test(bare)) {
    return null;
  }
  const digits = bare.replace(/\D/gu, "");
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}
