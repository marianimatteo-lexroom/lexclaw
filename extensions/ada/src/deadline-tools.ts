import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  deadlineDueLabel,
  readDeadlineIntakeConfig,
  reminderFireAtMs,
  seedReminders,
  type DeadlineIntakeConfig,
} from "./deadline-intake.js";
import { formatSources } from "./lexroom-citations.js";
import type { LexroomConfig } from "./lexroom-client.js";
import type { LexroomConnectConfig } from "./lexroom-connect.js";
import { runDeadlineResearch } from "./lexroom-tools.js";
import type { DeadlineItem, DeadlineStatus } from "./memory-contract.js";
import { openAdaMemoryFromApi, type MemoryStore } from "./memory.js";

type StoreApi = Pick<OpenClawPluginApi, "runtimeSource" | "runtime" | "logger">;

/** The plugin config slice these tools read: Lexroom access plus the intake flag. */
export type DeadlineToolConfig = LexroomConfig &
  LexroomConnectConfig & { deadlineIntake?: unknown };

export const DEADLINE_REPLY_ACTIONS = ["research", "track", "dismiss", "done", "brief"] as const;
export type DeadlineReplyAction = (typeof DEADLINE_REPLY_ACTIONS)[number];

type ToolFailure = {
  ok: false;
  error: string;
  reason?: "disabled" | "not_found" | "not_connected" | "superseded" | "passed";
};

const DISABLED: ToolFailure = {
  ok: false,
  reason: "disabled",
  error: "Deadline intake is off. Set plugins.entries.ada.config.deadlineIntake.enabled to true.",
};

/** Test seams: a ready memory store and the fetch Lexroom research uses. */
export type DeadlineToolDeps = { memory?: MemoryStore; fetchImpl?: typeof fetch };

async function openMemory(
  api: StoreApi,
  deps: DeadlineToolDeps,
): Promise<MemoryStore | ToolFailure> {
  if (deps.memory) {
    return deps.memory;
  }
  try {
    return await openAdaMemoryFromApi(api);
  } catch (error) {
    api.logger.error(
      `ada memory store failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
    return { ok: false, error: "Ada could not open the memory store." };
  }
}

function isFailure(value: MemoryStore | ToolFailure): value is ToolFailure {
  return "ok" in value;
}

function view(item: DeadlineItem, label: string, config: DeadlineIntakeConfig, nowMs: number) {
  return {
    id: item.id,
    offerNo: item.offerNo,
    matterId: item.matterId,
    matterLabel: label,
    type: item.type,
    title: item.title,
    due: deadlineDueLabel(item),
    timeZone: item.timeZone,
    status: item.status,
    confidence: item.confidence,
    sources: item.sources.map((source) => ({ kind: source.kind, label: source.label })),
    movedFromDue: item.movedFromMs === null ? null : new Date(item.movedFromMs).toISOString(),
    briefReady: item.researchStatus === "done",
    reminders:
      item.status === "tracked"
        ? config.reminders.map((step) => ({
            step: step.id,
            at: new Date(reminderFireAtMs(item, step)).toISOString(),
            state: item.remindersSent.includes(step.id)
              ? "settled"
              : reminderFireAtMs(item, step) <= nowMs
                ? "due"
                : "scheduled",
          }))
        : [],
  };
}

async function labelFor(memory: MemoryStore, matterId: string): Promise<string> {
  const aliases = await memory.listMatterAliases();
  return aliases.find((entry) => entry.matterId === matterId)?.title ?? matterId;
}

/** Read-only list of the deadlines and hearings Ada knows about, newest digest numbers included. */
export async function executeAdaDeadlineList(
  config: DeadlineToolConfig,
  api: StoreApi,
  now = new Date(),
  deps: DeadlineToolDeps = {},
) {
  const settings = readDeadlineIntakeConfig(config);
  if (!settings.enabled) {
    return DISABLED;
  }
  const memory = await openMemory(api, deps);
  if (isFailure(memory)) {
    return memory;
  }
  const items = (await memory.listDeadlines()).filter(
    (item) =>
      (item.status === "candidate" || item.status === "tracked") && item.dueAtMs >= now.getTime(),
  );
  const aliases = await memory.listMatterAliases();
  const labelOf = (matterId: string) =>
    aliases.find((entry) => entry.matterId === matterId)?.title ?? matterId;
  return {
    ok: true as const,
    items: items.map((item) => view(item, labelOf(item.matterId), settings, now.getTime())),
  };
}

function resolveRef(items: readonly DeadlineItem[], ref: string): DeadlineItem | null {
  const text = ref.trim().replace(/^#/u, "");
  if (/^\d{1,3}$/u.test(text)) {
    return items.find((item) => item.offerNo === Number(text)) ?? null;
  }
  return items.find((item) => item.id === text) ?? null;
}

/**
 * The lawyer's reply to a digest line. "research" confirms tracking and runs Lexroom
 * research; "track" confirms tracking only; "dismiss" and "done" close the item.
 * Nothing here sends email or touches the calendar.
 */
export async function executeAdaDeadlineReply(
  params: { ref: string; action: DeadlineReplyAction },
  config: DeadlineToolConfig,
  api: StoreApi,
  signal?: AbortSignal,
  now = new Date(),
  deps: DeadlineToolDeps = {},
) {
  const settings = readDeadlineIntakeConfig(config);
  if (!settings.enabled) {
    return DISABLED;
  }
  const memory = await openMemory(api, deps);
  if (isFailure(memory)) {
    return memory;
  }
  const nowMs = now.getTime();
  const found = resolveRef(await memory.listDeadlines(), params.ref);
  if (!found) {
    return {
      ok: false as const,
      reason: "not_found" as const,
      error: `No deadline matches "${params.ref}". Call ada_deadline_list for the current numbers.`,
    };
  }
  if (found.status === "superseded") {
    return {
      ok: false as const,
      reason: "superseded" as const,
      error: "That date was replaced by a newer one. Call ada_deadline_list.",
    };
  }
  const label = await labelFor(memory, found.matterId);

  if (params.action === "dismiss" || params.action === "done") {
    const status: DeadlineStatus = params.action === "dismiss" ? "dismissed" : "done";
    const closed = await memory.updateDeadline(found.id, { status }, nowMs);
    return { ok: true as const, item: view(closed ?? found, label, settings, nowMs) };
  }

  if (params.action === "brief") {
    if (!found.brief) {
      return {
        ok: false as const,
        error: "No brief yet. Use research to run Lexroom for this item.",
      };
    }
    return {
      ok: true as const,
      item: view(found, label, settings, nowMs),
      brief: { answer: found.brief, stored: true as const },
    };
  }
  if (found.status === "done") {
    return { ok: false as const, error: "That item is already marked done." };
  }
  if (found.dueAtMs < nowMs) {
    return {
      ok: false as const,
      reason: "passed" as const,
      error: "That date has already passed.",
    };
  }
  const tracked =
    (await memory.updateDeadline(
      found.id,
      {
        status: "tracked",
        ...(found.status === "tracked"
          ? {}
          : { remindersSent: seedReminders(found, settings.reminders, nowMs) }),
      },
      nowMs,
    )) ?? found;

  if (params.action === "track") {
    return { ok: true as const, item: view(tracked, label, settings, nowMs) };
  }

  const profile = await memory.readProfile();
  const research = await runDeadlineResearch({
    item: tracked,
    matterLabel: label,
    language: profile?.language ?? null,
    config,
    api,
    now,
    signal,
    fetchImpl: deps.fetchImpl,
  });
  if (!research.ok) {
    const failed = await memory.updateDeadline(tracked.id, { researchStatus: "failed" }, nowMs);
    return {
      ok: false as const,
      ...(research.reason ? { reason: research.reason } : {}),
      error: research.error,
      tracking: true,
      item: view(failed ?? tracked, label, settings, nowMs),
    };
  }
  const done = await memory.updateDeadline(
    tracked.id,
    {
      researchStatus: "done",
      brief: research.sources.length
        ? `${research.answer}\n\nSources:\n${formatSources(research.sources)}`
        : research.answer,
      briefAtMs: nowMs,
    },
    nowMs,
  );
  return {
    ok: true as const,
    item: view(done ?? tracked, label, settings, nowMs),
    brief: {
      answer: research.answer,
      sources: research.sources,
      ...(research.researchId ? { researchId: research.researchId } : {}),
      ...(research.researchUrl ? { researchUrl: research.researchUrl } : {}),
    },
  };
}
