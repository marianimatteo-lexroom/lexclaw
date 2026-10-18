/**
 * Serializes collect passes: the poll, the Gmail push route, the 07:40 slot, the
 * catch-up, and the lawyer-inbound release all read the diff baseline and write the
 * held plan, so two of them interleaving would double-send or lose a hold.
 */
let tail: Promise<unknown> = Promise.resolve();
/** The waiting coalescible run of each key; a key is the number whose pass it is. */
const queuedCoalescible = new Map<string, Promise<unknown>>();

/**
 * Run `fn` after every earlier exclusive run settles. A `coalesce` caller that finds
 * another coalescible run of the same `key` still waiting shares that run instead of queuing a
 * duplicate, so a burst of polls or push notifications for one number costs one trailing pass,
 * and one number's pass is never dropped because another's is waiting.
 */
export function runCollectExclusive<T>(
  fn: () => Promise<T>,
  options: { coalesce?: boolean; key?: string } = {},
): Promise<T> {
  const key = options.key ?? "";
  const waiting = options.coalesce ? queuedCoalescible.get(key) : undefined;
  if (waiting) {
    return waiting as Promise<T>;
  }
  const run = tail.then(() => {
    if (queuedCoalescible.get(key) === run) {
      queuedCoalescible.delete(key);
    }
    return fn();
  });
  if (options.coalesce) {
    queuedCoalescible.set(key, run);
  }
  tail = run.catch(() => undefined);
  return run;
}
