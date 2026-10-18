import type { IncomingMessage, ServerResponse } from "node:http";
import { writeAdaConnectPage } from "./google-callback.js";
import { resolveShortLink, type ShortLinkKind } from "./short-links.js";

/** Serves `/<kind>/<code>`: 302 to the full connect URL, or a small Italian "expired" page. */
export function handleAdaShortLink(
  req: IncomingMessage,
  res: ServerResponse,
  kind: ShortLinkKind,
  now: Date,
): boolean {
  const code = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/").pop() ?? "";
  const target =
    req.method === "GET" || req.method === "HEAD" ? resolveShortLink(kind, code, now) : null;
  if (!target) {
    writeAdaConnectPage(res, 404, {
      kind: "retry",
      lang: "it",
      heading: "Link scaduto",
      message:
        "Questo link non è più valido o è scaduto. Torna su WhatsApp e chiedi ad Ada un nuovo link.",
    });
    return true;
  }
  res.statusCode = 302;
  res.setHeader("location", target);
  res.setHeader("cache-control", "no-store");
  res.setHeader("referrer-policy", "no-referrer");
  res.end();
  return true;
}
