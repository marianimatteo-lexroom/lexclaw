/**
 * Ada never signs her messages: the person writing to her already knows who answers. The persona
 * says so, and this is the safety net for a model that signs anyway.
 *
 * Replies carry legal content (names of parties, heirs, drafts for a client who may be called
 * Ada), so the net is deliberately narrow. Text is cut only when the whole reply ends with a blank
 * line and then one line that is an em or en dash followed by "Ada", optionally with
 * " · Lexroom" or ", Lexroom", and some text comes before it. A bare "Ada", "*Ada*", a hyphen
 * signature, or a name on the last line of a list or a draft is never touched.
 */
const SIGNATURE_TAIL = /\n[ \t]*\n[ \t]*[—–][ \t]?Ada(?:(?: · |, )Lexroom)?[ \t]*$/u;

/** `text` without a trailing "— Ada" style signature line, or unchanged. */
export function stripTrailingSignature(text: string): string {
  const body = text.trimEnd();
  const match = SIGNATURE_TAIL.exec(body);
  if (!match) {
    return text;
  }
  const rest = body.slice(0, match.index).trimEnd();
  return rest.length > 0 ? rest : text;
}
