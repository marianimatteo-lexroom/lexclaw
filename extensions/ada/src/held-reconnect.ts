/**
 * Numbers whose saved Google sign-in expired and who could not be told yet, because the WhatsApp
 * window was closed or the send failed. The dead account is already dropped, so nothing would
 * ever notice them again: the note waits here until that number next writes. Only the fact is
 * kept; the link is made fresh when the note goes out, so it is never stale. In memory, bounded.
 */
const HELD_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_HELD = 1000;

const held = new Map<string, number>();

export function holdReconnectNote(owner: string, nowMs: number): void {
  held.delete(owner);
  held.set(owner, nowMs);
  if (held.size > MAX_HELD) {
    held.delete(held.keys().next().value ?? owner);
  }
}

/** True when `owner` has a note waiting; it is then no longer held. */
export function takeHeldReconnectNote(owner: string, nowMs: number): boolean {
  const heldAtMs = held.get(owner);
  held.delete(owner);
  return heldAtMs !== undefined && nowMs - heldAtMs <= HELD_TTL_MS;
}

export function clearHeldReconnectNotes(): void {
  held.clear();
}
