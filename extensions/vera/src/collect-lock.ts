/**
 * Serializes collect passes: the poll, the Gmail push route, the 07:40 slot, the
 * catch-up, and the lawyer-inbound release all read the diff baseline and write the
 * held plan, so two of them interleaving would double-send or lose a hold.
 */
let tail: Promise<unknown> = Promise.resolve();
let queuedCoalescible: Promise<unknown> | null = null;

/**
 * Run `fn` after every earlier exclusive run settles. A `coalesce` caller that finds
 * another coalescible run still waiting shares that run instead of queuing a duplicate,
 * so a burst of polls or push notifications costs one trailing pass.
 */
export function runCollectExclusive<T>(
  fn: () => Promise<T>,
  options: { coalesce?: boolean } = {},
): Promise<T> {
  if (options.coalesce && queuedCoalescible) {
    return queuedCoalescible as Promise<T>;
  }
  const run = tail.then(() => {
    if (queuedCoalescible === run) {
      queuedCoalescible = null;
    }
    return fn();
  });
  if (options.coalesce) {
    queuedCoalescible = run;
  }
  tail = run.catch(() => undefined);
  return run;
}
