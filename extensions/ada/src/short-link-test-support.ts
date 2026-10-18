import { resolveShortLink, type ShortLinkKind } from "./short-links.js";

/** The full connect URL behind a short link, read at an instant before any link expires. */
export function expandShortLink(shortUrl: string): URL {
  const [kind, code] = new URL(shortUrl).pathname.split("/").slice(-2);
  const target = resolveShortLink(kind as ShortLinkKind, code ?? "", new Date(0));
  if (!target) {
    throw new Error("short link is not registered");
  }
  return new URL(target);
}
