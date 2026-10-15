function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/giu, "\n")
    .replace(/<[^>]+>/gu, "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&quot;/giu, '"')
    .trim();
}

/**
 * The answer text of a snapshot, falling back to its HTML and then to the previous snapshot.
 * A terminal event often repeats the id without the answer body, and must not blank the answer.
 */
export function mergeAnswer(
  previous: string,
  incoming: string | { text?: string; html?: string } | undefined,
): string {
  const record = incoming && typeof incoming === "object" ? incoming : undefined;
  const raw = typeof incoming === "string" ? incoming : record?.text;
  const text = (typeof raw === "string" ? raw : "").replaceAll("</END>", "").trim();
  const html = (typeof record?.html === "string" ? record.html : "")
    .replaceAll("</END>", "")
    .trim();
  return text || (html ? stripHtml(html) : "") || previous;
}
