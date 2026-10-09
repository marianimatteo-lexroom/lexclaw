import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWorkerBackend } from "./memory.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function openBackend() {
  return createSqliteWorkerBackend(undefined, {
    databasePath: path.join(tempDirs.make("vera-memory-"), "memory.sqlite"),
  });
}

describe("vera memory store", () => {
  it("keeps matter walls, alias search, and correction history", () => {
    const backend = openBackend();
    try {
      backend.execute({
        type: "upsertRecord",
        input: {
          atMs: 1000,
          reason: "create",
          record: {
            id: "rossi-dining",
            matterId: "rossi",
            folder: "knowledge/preferences",
            type: "preference",
            title: "Dining",
            aliases: ["pasta", "takeout"],
            body: "- Pasta: yes",
            validFromMs: 1000,
            validToMs: null,
            supersededBy: null,
          },
        },
      });
      backend.execute({
        type: "upsertRecord",
        input: {
          atMs: 1000,
          reason: "create",
          record: {
            id: "bianchi-dining",
            matterId: "bianchi",
            folder: "knowledge/preferences",
            type: "preference",
            title: "Dining",
            aliases: ["pasta"],
            body: "- Pasta: no",
            validFromMs: 1000,
            validToMs: null,
            supersededBy: null,
          },
        },
      });

      const rossiHits = backend.execute({
        type: "searchRecords",
        input: { query: "pasta", matterId: "rossi" },
      });
      expect(rossiHits.map((hit) => hit.id)).toEqual(["rossi-dining"]);
      expect(
        backend.execute({
          type: "searchRecords",
          input: { query: "pazta", matterId: "rossi" },
        }),
      ).toEqual([]);

      backend.execute({
        type: "upsertRecord",
        input: {
          atMs: 2000,
          reason: "correction",
          record: {
            id: "rossi-dining",
            matterId: "rossi",
            folder: "knowledge/preferences",
            type: "preference",
            title: "Dining",
            aliases: ["pasta", "takeout"],
            body: "- Pasta: corrected on 2026-10-06",
            validFromMs: 2000,
            validToMs: null,
            supersededBy: null,
          },
        },
      });
      const history = backend.execute({
        type: "history",
        input: { id: "rossi-dining", matterId: "rossi" },
      });
      expect(history[0]).toMatchObject({
        reason: "correction",
        previousBody: "- Pasta: yes",
      });
      expect(
        backend.execute({
          type: "getRecord",
          input: { id: "rossi-dining", matterId: "bianchi" },
        }),
      ).toBeNull();
    } finally {
      void backend.close();
    }
  });

  it("holds a plan when the WhatsApp window is closed", () => {
    const backend = openBackend();
    try {
      backend.execute({
        type: "writeWake",
        input: {
          heldPlanJson: JSON.stringify({ deliver: true, items: [], nextSteps: [] }),
          lastLawyerInboundAtMs: 1,
        },
      });
      expect(backend.execute({ type: "readWake", input: undefined }).heldPlanJson).toContain(
        "deliver",
      );
      backend.execute({ type: "writeWake", input: { heldPlanJson: null } });
      expect(backend.execute({ type: "readWake", input: undefined }).heldPlanJson).toBeNull();
    } finally {
      void backend.close();
    }
  });
});
