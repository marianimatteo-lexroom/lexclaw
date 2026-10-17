/**
 * Where a research can be read in the Lexroom web app. The route is the web app's own,
 * `ROUTES.LEXROOM.RESEARCH.CHAT.ID(id) = /research/${id}`, taken from its public bundle: after a
 * new research it navigates there, and a follow-up stays on the page of the research that started
 * the thread. A thread's page is therefore its root's.
 */
export const LEXROOM_WEB_APP_URL = "https://app.lexroom.ai";

const MAX_TRACKED = 500;

/** Research id to the root of its thread. The stream names a parent but never the root. */
const roots = new Map<string, string>();

/** `lexroom.ai` and its subdomains (`api.`, a regional `api-eu.`, ...); never a staging host. */
export function isProductionHost(hostname: string): boolean {
  return hostname === "lexroom.ai" || hostname.endsWith(".lexroom.ai");
}

/**
 * The web app page for one research, or undefined when it has no id or the API is not a
 * production one (a staging API has a web app Ada does not know). A follow-up links to the root
 * of its thread, found through the research ids this process has seen; when the parent is not
 * one of them the parent itself is the best root available.
 */
export function lexroomResearchUrl(params: {
  researchId: string | undefined;
  parentResearchId?: string;
  apiBaseUrl: string;
}): string | undefined {
  const id = params.researchId?.trim();
  if (!id || !isProductionHost(new URL(params.apiBaseUrl).hostname)) {
    return undefined;
  }
  const parent = params.parentResearchId?.trim();
  const root = parent ? (roots.get(parent) ?? parent) : id;
  roots.delete(id);
  roots.set(id, root);
  if (roots.size > MAX_TRACKED) {
    roots.delete(roots.keys().next().value ?? id);
  }
  return `${LEXROOM_WEB_APP_URL}/research/${encodeURIComponent(root)}`;
}
