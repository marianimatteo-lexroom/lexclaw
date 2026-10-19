/**
 * Ada never signs her messages: the person writing to her already knows who answers. The persona
 * says so, and this is the safety net for a model that signs anyway.
 *
 * Only a last line that is nothing but the signature is removed, and only when other text comes
 * before it. Matching is case-sensitive, so "ada" in running text, a sentence that mentions Ada
 * and a reply that is just "Ada" (the answer to "what is your name?") are left alone.
 */
const SIGNATURE_LINE =
  /^[ \t]*(?:[—–~-][ \t]*)?([*_]{0,2})Ada(?:[ \t]*(?:[·|,—–-]|di|of|at|from|@)[ \t]*Lexroom)?\1[ \t]*$/u;

/** `text` without a trailing standalone signature line such as "— Ada", "Ada" or "Ada · Lexroom". */
export function stripTrailingSignature(text: string): string {
  const body = text.trimEnd();
  const lastBreak = body.lastIndexOf("\n");
  if (lastBreak < 0 || !SIGNATURE_LINE.test(body.slice(lastBreak + 1))) {
    return text;
  }
  const rest = body.slice(0, lastBreak).trimEnd();
  return rest.length > 0 ? rest : text;
}
