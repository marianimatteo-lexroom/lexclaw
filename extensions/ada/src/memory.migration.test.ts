import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adaMemoryExists,
  listAdaMemoryOwners,
  openAdaMemory,
  openAdaRegistry,
  wrapMemoryWorker,
  type MemoryStore,
} from "./memory.js";
import { createSqliteWorkerBackend } from "./memory.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const LAWYER = "390000000000";
const ANNA = "393331111111";
const BRUNO = "393332222222";
const PROFILE = {
  name: "Avv. Test",
  timezone: "Europe/Rome",
  email: null,
  language: "it",
  jurisdiction: "IT",
  autonomy: "ask-first",
  channelStyle: "short",
  generatedAtMs: 1,
};
const TODO = {
  id: "todo-rossi",
  matterId: "rossi",
  owner: "lawyer" as const,
  title: "Rossi: transazione riservata",
  status: "pending" as const,
  detail: "",
  updatedAtMs: 1,
};

/** The real SQLite memory backend behind the store interface, one connection per file. */
function realOpen(databasePath: string): Promise<MemoryStore> {
  const backend = createSqliteWorkerBackend(undefined, { databasePath });
  return Promise.resolve(
    wrapMemoryWorker({
      execute: async (command: { type: string; input: unknown }) =>
        (backend.execute as (command: unknown) => unknown)(command),
      close: async () => backend.close(),
    } as never),
  );
}

function location(stateDir: string) {
  return { runtimeSource: "/fake/index.ts", stateDir, open: realOpen };
}

const legacyFile = (stateDir: string) => path.join(stateDir, "vera", "memory.sqlite");
const ownerFile = (stateDir: string, owner: string) =>
  path.join(stateDir, "vera", "memory", `${owner}.sqlite`);

/** A volume from before per-number memory: one memory.sqlite with the lawyer's data in it. */
async function legacyVolume() {
  const stateDir = tempDirs.make("ada-memory-migration-");
  const registry = await openAdaRegistry(location(stateDir));
  await registry.upsertProfile(PROFILE);
  await registry.upsertTodo(TODO);
  await registry.upsertRecord(
    {
      id: "rossi-one-pager",
      matterId: "rossi",
      folder: "knowledge/facts",
      type: "fact",
      title: "Rossi",
      aliases: ["Rossi SRL"],
      body: "- Transazione riservata",
      validFromMs: 1,
      validToMs: null,
      supersededBy: null,
    },
    "create",
    1,
  );
  await registry.writeWake({ lastCollectAtMs: 77, heldPlanJson: '{"deliver":true}' });
  await registry.claimWelcome(ANNA, 5);
  return { stateDir, registry };
}

describe("memory belongs to one number each", () => {
  it("moves the existing memory to the lawyer's number, once, and leaves a backup", async () => {
    const { stateDir } = await legacyVolume();
    const log = vi.fn();
    const lawyer = await openAdaMemory({
      ...location(stateDir),
      log,
      owner: LAWYER,
      lawyer: LAWYER,
    });

    expect(log.mock.calls).toEqual([["ada legacy memory adopted owner=+39…0000"]]);
    expect(await lawyer.readProfile()).toMatchObject({ name: "Avv. Test" });
    expect(await lawyer.listTodos()).toMatchObject([{ id: "todo-rossi" }]);
    expect(await lawyer.getRecord("rossi-one-pager", "rossi")).toMatchObject({ title: "Rossi" });
    expect(await lawyer.readWake()).toMatchObject({
      lastCollectAtMs: 77,
      heldPlanJson: '{"deliver":true}',
    });
    expect(fs.existsSync(ownerFile(stateDir, LAWYER))).toBe(true);
    expect(fs.readFileSync(path.join(stateDir, "vera", "memory", "legacy-adopted"), "utf8")).toBe(
      LAWYER,
    );
    // The old file stays where it was, as a backup, and keeps no working memory of its own.
    expect(fs.existsSync(legacyFile(stateDir))).toBe(true);
  });

  it("leaves the welcome markers of other numbers out of the lawyer's copy", async () => {
    const { stateDir } = await legacyVolume();
    const lawyer = await openAdaMemory({ ...location(stateDir), owner: LAWYER, lawyer: LAWYER });
    expect(await lawyer.claimWelcome(ANNA, 9)).toBe(true);
    const registry = await openAdaRegistry(location(stateDir));
    expect(await registry.claimWelcome(ANNA, 9)).toBe(false);
  });

  it("gives every other number an empty memory of its own", async () => {
    const { stateDir } = await legacyVolume();
    await openAdaMemory({ ...location(stateDir), owner: LAWYER, lawyer: LAWYER });
    const bruno = await openAdaMemory({ ...location(stateDir), owner: BRUNO, lawyer: LAWYER });
    const anna = await openAdaMemory({ ...location(stateDir), owner: ANNA, lawyer: LAWYER });
    for (const store of [bruno, anna]) {
      expect(await store.readProfile()).toBeNull();
      expect(await store.listTodos()).toEqual([]);
      expect(await store.getRecord("rossi-one-pager", "rossi")).toBeNull();
      expect(await store.searchRecords("Rossi", "rossi")).toEqual([]);
      expect(await store.readWake()).toMatchObject({ lastCollectAtMs: null, heldPlanJson: null });
    }
    expect(ownerFile(stateDir, BRUNO)).not.toBe(ownerFile(stateDir, ANNA));
  });

  it("keeps what one number writes out of every other number's memory", async () => {
    const { stateDir } = await legacyVolume();
    const lawyer = await openAdaMemory({ ...location(stateDir), owner: LAWYER, lawyer: LAWYER });
    const anna = await openAdaMemory({ ...location(stateDir), owner: ANNA, lawyer: LAWYER });
    const bruno = await openAdaMemory({ ...location(stateDir), owner: BRUNO, lawyer: LAWYER });
    await anna.upsertTodo({ ...TODO, id: "todo-anna", title: "Anna: pratica privata" });
    await anna.writeWake({ lastCollectAtMs: 123 });

    expect((await anna.listTodos()).map((todo) => todo.id)).toEqual(["todo-anna"]);
    expect((await lawyer.listTodos()).map((todo) => todo.id)).toEqual(["todo-rossi"]);
    expect(await bruno.listTodos()).toEqual([]);
    expect((await lawyer.readWake()).lastCollectAtMs).toBe(77);
    expect((await bruno.readWake()).lastCollectAtMs).toBeNull();
  });

  it("keeps the reminders and watched threads of one number out of every other number's memory", async () => {
    const { stateDir } = await legacyVolume();
    const anna = await openAdaMemory({ ...location(stateDir), owner: ANNA, lawyer: LAWYER });
    const bruno = await openAdaMemory({ ...location(stateDir), owner: BRUNO, lawyer: LAWYER });
    await anna.putProactive({
      kind: "reminder",
      id: "r1",
      dueAtMs: 5,
      status: "pending",
      data: '{"text":"Anna only","createdAtMs":1}',
      updatedAtMs: 1,
    });
    expect(await anna.listProactive("reminder")).toHaveLength(1);
    expect(await bruno.listProactive("reminder")).toEqual([]);
    expect(await bruno.removeProactive("reminder", "r1")).toBe(false);
    expect(await anna.listProactive("reminder")).toHaveLength(1);
  });

  it("lists every number that has a memory file of its own, and only those", async () => {
    const { stateDir } = await legacyVolume();
    await openAdaMemory({ ...location(stateDir), owner: BRUNO, lawyer: LAWYER });
    await openAdaMemory({ ...location(stateDir), owner: ANNA, lawyer: LAWYER });
    fs.writeFileSync(path.join(path.dirname(ownerFile(stateDir, ANNA)), "notes.txt"), "x");
    const api = {
      runtimeSource: "/fake/index.ts",
      runtime: { state: { resolveStateDir: () => stateDir } },
      config: {},
    } as never;
    expect(listAdaMemoryOwners(api)).toEqual([ANNA, BRUNO]);
    expect(
      listAdaMemoryOwners({
        ...(api as object),
        runtime: { state: { resolveStateDir: () => path.join(stateDir, "nowhere") } },
      } as never),
    ).toEqual([]);
  });

  it("does not hand the old memory to a different lawyer number later", async () => {
    const { stateDir } = await legacyVolume();
    await openAdaMemory({ ...location(stateDir), owner: LAWYER, lawyer: LAWYER });
    const newLawyer = "390000000099";
    const log = vi.fn();
    const store = await openAdaMemory({
      ...location(stateDir),
      log,
      owner: newLawyer,
      lawyer: newLawyer,
    });
    expect(log).not.toHaveBeenCalled();
    expect(await store.readProfile()).toBeNull();
    expect(await store.listTodos()).toEqual([]);
  });

  it("takes nothing from the old file for a number that is not the lawyer", async () => {
    const { stateDir } = await legacyVolume();
    const anna = await openAdaMemory({ ...location(stateDir), owner: ANNA, lawyer: LAWYER });
    expect(await anna.readProfile()).toBeNull();
    expect(fs.existsSync(path.join(stateDir, "vera", "memory", "legacy-adopted"))).toBe(false);
  });

  it("says a number has memory only once it has a file, and the lawyer while the old data waits", async () => {
    const { stateDir } = await legacyVolume();
    expect(adaMemoryExists({ stateDir }, ANNA, LAWYER)).toBe(false);
    expect(adaMemoryExists({ stateDir }, LAWYER, LAWYER)).toBe(true);
    await openAdaMemory({ ...location(stateDir), owner: LAWYER, lawyer: LAWYER });
    expect(adaMemoryExists({ stateDir }, LAWYER, LAWYER)).toBe(true);
    expect(adaMemoryExists({ stateDir }, ANNA, LAWYER)).toBe(false);
    await openAdaMemory({ ...location(stateDir), owner: ANNA, lawyer: LAWYER });
    expect(adaMemoryExists({ stateDir }, ANNA, LAWYER)).toBe(true);
  });

  it("refuses anything that is not a phone number as an owner, so no path can be named", () => {
    const stateDir = tempDirs.make("ada-memory-owner-");
    for (const owner of ["../etc/passwd", "lawyer", "", "393331111111/../x"]) {
      expect(() => openAdaMemory({ ...location(stateDir), owner })).toThrow(
        /owner's WhatsApp number/u,
      );
    }
  });
});
