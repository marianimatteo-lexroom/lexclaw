import type { OpenClawPluginApi, PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import { openAdaMemoryIfExistsFromApi } from "./memory.js";
import { DEFAULT_TIME_ZONE, effectiveTimeZone, nextSlotMs, previousSlotMs } from "./schedule.js";

const CATCH_UP_DELAY_MS = 30 * 1000;

type ServiceScheduler = Pick<PluginServiceSchedulerV1, "schedule">;
type Logger = Pick<OpenClawPluginApi["logger"], "info" | "error">;

/**
 * One-off and repeating timers. The host scheduler is used when it exists; hosts that omit the
 * V2 scheduler field (e.g. OpenClaw 2026.9.8) get plain timers, announced once at info level.
 */
export function createServiceTimers(deps: { logger: Logger; now: () => Date }) {
  const fallbackTimers = new Set<ReturnType<typeof setTimeout>>();
  const fallbackOnceById = new Map<string, ReturnType<typeof setTimeout>>();
  const fallbackNoted = new Set<string>();

  const noteFallback = (kind: "setInterval" | "setTimeout", id: string) => {
    if (!fallbackNoted.has(kind)) {
      fallbackNoted.add(kind);
      deps.logger.info(`ada: Gateway service scheduler missing; using ${kind} (first for ${id})`);
    }
  };

  const scheduleRepeating = (params: {
    scheduler: ServiceScheduler | undefined;
    id: string;
    delayMs: number;
    everyMs: number;
    run: () => void | Promise<void>;
  }) => {
    if (params.scheduler) {
      params.scheduler.schedule({
        id: params.id,
        delayMs: params.delayMs,
        everyMs: params.everyMs,
        run: params.run,
      });
      return;
    }
    noteFallback("setInterval", params.id);
    const first = setTimeout(() => {
      fallbackTimers.delete(first);
      void params.run();
      const interval = setInterval(() => {
        void params.run();
      }, params.everyMs);
      fallbackTimers.add(interval);
    }, params.delayMs);
    fallbackTimers.add(first);
  };

  /** Like the host scheduler, scheduling an id again replaces the job still pending under it. */
  const scheduleOnce = (params: {
    scheduler: ServiceScheduler | undefined;
    id: string;
    atMs: number;
    run: () => void | Promise<void>;
  }) => {
    if (params.scheduler) {
      params.scheduler.schedule({ id: params.id, atMs: params.atMs, run: params.run });
      return;
    }
    noteFallback("setTimeout", params.id);
    const pending = fallbackOnceById.get(params.id);
    if (pending) {
      clearTimeout(pending);
      fallbackTimers.delete(pending);
    }
    const timer = setTimeout(
      () => {
        fallbackTimers.delete(timer);
        fallbackOnceById.delete(params.id);
        void params.run();
      },
      Math.max(0, params.atMs - deps.now().getTime()),
    );
    timer.unref?.();
    fallbackTimers.add(timer);
    fallbackOnceById.set(params.id, timer);
  };

  const stop = () => {
    for (const timer of fallbackTimers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    fallbackTimers.clear();
    fallbackOnceById.clear();
  };

  return { scheduleRepeating, scheduleOnce, stop };
}

export type ServiceTimers = ReturnType<typeof createServiceTimers>;

/**
 * Each number's 07:40 on its own clock, and the catch-up for one a restart straddled. Slots come
 * from the calendar of that number's zone rather than a 24h step, so DST days stay at 07:40 and a
 * slow run never drifts them.
 */
export function createMorningSchedule(deps: {
  api: Pick<OpenClawPluginApi, "logger" | "runtimeSource" | "runtime" | "config">;
  now: () => Date;
  scheduler: ServiceScheduler | undefined;
  timers: ServiceTimers;
  /** Every number the service visits. */
  listOwners: () => Promise<string[]>;
  /** One number's collect pass. */
  runOwner: (owner: string, forceMorning: boolean, catchUp?: boolean) => Promise<void>;
  isStopped: () => boolean;
}) {
  const { api, now, timers } = deps;
  const morningSlots = new Map<string, { timeZone: string; atMs: number }>();
  let armedAtMs: number | null = null;

  /** A number's profile zone, Europe/Rome when it has none yet or the read fails. */
  const ownerTimeZone = async (owner: string): Promise<string> => {
    try {
      const memory = await openAdaMemoryIfExistsFromApi(api, owner);
      return effectiveTimeZone((await memory?.readProfile())?.timezone);
    } catch {
      return DEFAULT_TIME_ZONE;
    }
  };

  /**
   * Brings the slots in line with the numbers and zones as they are now: a number that was
   * added gets its next slot, one that was removed loses it, and one whose zone changed gets
   * the next 07:40 of its new zone. A slot already in the past waits for its run.
   */
  const refreshMorningSlots = async (): Promise<void> => {
    let owners: string[];
    try {
      owners = await deps.listOwners();
    } catch (error) {
      api.logger.error(
        `ada service could not list accounts: ${error instanceof Error ? error.message : "unknown"}`,
      );
      return;
    }
    const clock = now().getTime();
    for (const owner of morningSlots.keys()) {
      if (!owners.includes(owner)) {
        morningSlots.delete(owner);
      }
    }
    for (const owner of owners) {
      const timeZone = await ownerTimeZone(owner);
      if (morningSlots.get(owner)?.timeZone !== timeZone) {
        morningSlots.set(owner, { timeZone, atMs: nextSlotMs(clock, timeZone) });
      }
    }
  };

  /** One timer, set to the earliest slot of any number; the run visits the numbers that are due. */
  const armMorning = async (): Promise<void> => {
    if (deps.isStopped()) {
      return;
    }
    await refreshMorningSlots();
    const atMs = Math.min(...[...morningSlots.values()].map((slot) => slot.atMs));
    if (!Number.isFinite(atMs) || atMs === armedAtMs) {
      return;
    }
    armedAtMs = atMs;
    timers.scheduleOnce({
      scheduler: deps.scheduler,
      id: "ada-morning",
      atMs,
      run: async () => {
        // A timer that wakes slightly early still runs the slot it was set for, once.
        const firedFor = Math.max(now().getTime(), atMs);
        try {
          await refreshMorningSlots();
          const due = [...morningSlots].filter(([, slot]) => slot.atMs <= firedFor);
          for (const [owner, slot] of due) {
            await deps.runOwner(owner, true);
            morningSlots.set(owner, {
              timeZone: slot.timeZone,
              atMs: nextSlotMs(firedFor, slot.timeZone),
            });
          }
        } finally {
          armedAtMs = null;
          try {
            await armMorning();
          } catch (error) {
            api.logger.error(
              `ada could not schedule the next morning slot: ${error instanceof Error ? error.message : "unknown"}`,
            );
          }
        }
      },
    });
  };

  // A restart can straddle a number's 07:40. When nothing was collected for a number since
  // the latest slot of its own zone, run its morning pass once shortly after boot.
  const armCatchUp = async (): Promise<void> => {
    const clock = now().getTime();
    const stale: string[] = [];
    for (const owner of await deps.listOwners()) {
      const memory = await openAdaMemoryIfExistsFromApi(api, owner);
      if (!memory) {
        continue;
      }
      const lastCollectAtMs = (await memory.readWake()).lastCollectAtMs;
      const slotMs = previousSlotMs(
        clock,
        effectiveTimeZone((await memory.readProfile())?.timezone),
      );
      if (lastCollectAtMs !== null && lastCollectAtMs < slotMs) {
        stale.push(owner);
      }
    }
    if (stale.length === 0) {
      return;
    }
    timers.scheduleOnce({
      scheduler: deps.scheduler,
      id: "ada-catch-up",
      atMs: clock + CATCH_UP_DELAY_MS,
      run: async () => {
        for (const owner of stale) {
          await deps.runOwner(owner, true, true);
        }
      },
    });
  };

  return { armMorning, armCatchUp };
}
