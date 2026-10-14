import { describe, expect, it } from "vitest";
import { runCollectExclusive } from "./collect-lock.js";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

describe("runCollectExclusive", () => {
  it("runs callers one at a time in arrival order", async () => {
    const events: string[] = [];
    const first = gate();
    const a = runCollectExclusive(async () => {
      events.push("a:start");
      await first.opened;
      events.push("a:end");
    });
    const b = runCollectExclusive(async () => {
      events.push("b:start");
    });
    await Promise.resolve();
    expect(events).toEqual(["a:start"]);
    first.open();
    await Promise.all([a, b]);
    expect(events).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("shares one waiting run between coalescing callers but not forced ones", async () => {
    const first = gate();
    let runs = 0;
    const work = async () => {
      runs += 1;
      return runs;
    };
    const running = runCollectExclusive(async () => {
      await first.opened;
    });
    const pollA = runCollectExclusive(work, { coalesce: true });
    const pollB = runCollectExclusive(work, { coalesce: true });
    const forced = runCollectExclusive(work);
    expect(pollB).toBe(pollA);
    first.open();
    await running;
    expect(await Promise.all([pollA, pollB, forced])).toEqual([1, 1, 2]);
    expect(runs).toBe(2);
  });

  it("queues a fresh run once the coalesced one has started", async () => {
    const started = gate();
    const release = gate();
    const a = runCollectExclusive(
      async () => {
        started.open();
        await release.opened;
        return "a";
      },
      { coalesce: true },
    );
    await started.opened;
    const b = runCollectExclusive(async () => "b", { coalesce: true });
    expect(b).not.toBe(a);
    release.open();
    expect(await Promise.all([a, b])).toEqual(["a", "b"]);
  });

  it("keeps serving callers after a run throws", async () => {
    await expect(
      runCollectExclusive(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(runCollectExclusive(async () => "next")).resolves.toBe("next");
  });
});
