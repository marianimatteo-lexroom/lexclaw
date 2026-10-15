import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Ada answers on `/ada/...` and still on the pre-rename `/vera/...`. The old paths stay
 * because outside systems hold them: the Google OAuth redirect URI registered in Google
 * Cloud, the Pub/Sub push endpoint, status monitors, and Lexroom links already sent.
 */
export const ADA_HTTP_PREFIXES = ["/ada", "/vera"] as const;

type HttpRoute = Parameters<OpenClawPluginApi["registerHttpRoute"]>[0];

export function registerAdaHttpRoute(
  api: Pick<OpenClawPluginApi, "registerHttpRoute">,
  route: HttpRoute,
): void {
  for (const prefix of ADA_HTTP_PREFIXES) {
    api.registerHttpRoute({ ...route, path: `${prefix}${route.path}` });
  }
}

/** True when `pathname` is `suffix` under the current or the pre-rename prefix. */
export function isAdaPath(pathname: string, suffix: string): boolean {
  return ADA_HTTP_PREFIXES.some((prefix) => pathname === `${prefix}${suffix}`);
}
