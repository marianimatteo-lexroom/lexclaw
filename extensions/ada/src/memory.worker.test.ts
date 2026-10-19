import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWorkerBackend } from "./memory.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function openBackend() {
  return createSqliteWorkerBackend(undefined, {
    databasePath: path.join(tempDirs.make("ada-memory-"), "memory.sqlite"),
  });
}

describe("ada memory store", () => {
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

  it("persists the held plan retry state", () => {
    const backend = openBackend();
    try {
      expect(backend.execute({ type: "readWake", input: undefined })).toMatchObject({
        heldPlanAttempts: 0,
        heldPlanNextAttemptAtMs: null,
        heldPlanTemplateAttemptedAtMs: null,
      });
      backend.execute({
        type: "writeWake",
        input: {
          heldPlanAttempts: 2,
          heldPlanNextAttemptAtMs: 5000,
          heldPlanTemplateAttemptedAtMs: 4000,
        },
      });
      backend.execute({ type: "writeWake", input: { lastCollectAtMs: 9 } });
      expect(backend.execute({ type: "readWake", input: undefined })).toMatchObject({
        heldPlanAttempts: 2,
        heldPlanNextAttemptAtMs: 5000,
        heldPlanTemplateAttemptedAtMs: 4000,
        lastCollectAtMs: 9,
      });
    } finally {
      void backend.close();
    }
  });

  it("keeps digest and held-plan timestamps and clears the hold age with the plan", () => {
    const backend = openBackend();
    try {
      backend.execute({
        type: "writeWake",
        input: { lastDigestAtMs: 10, heldPlanJson: "{}", heldPlanAtMs: 20 },
      });
      expect(backend.execute({ type: "readWake", input: undefined })).toMatchObject({
        lastDigestAtMs: 10,
        heldPlanAtMs: 20,
      });
      backend.execute({ type: "writeWake", input: { heldPlanJson: null, heldPlanAtMs: null } });
      expect(backend.execute({ type: "readWake", input: undefined })).toMatchObject({
        lastDigestAtMs: 10,
        heldPlanAtMs: null,
      });
    } finally {
      void backend.close();
    }
  });

  it("adds the retry and status columns to a wake table from before they existed", () => {
    const databasePath = path.join(tempDirs.make("ada-memory-"), "memory.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`CREATE TABLE vera_wake_state (
      id TEXT PRIMARY KEY,
      last_lawyer_inbound_at_ms INTEGER,
      last_reconcile_at_ms INTEGER,
      last_collect_at_ms INTEGER,
      held_plan_json TEXT,
      watch_expiration_ms INTEGER,
      open_todo_ids_json TEXT
    ) STRICT;
    INSERT INTO vera_wake_state (id, last_collect_at_ms, held_plan_json) VALUES ('lawyer', 5, '{}');`);
    legacy.close();
    const backend = createSqliteWorkerBackend(undefined, { databasePath });
    try {
      expect(backend.execute({ type: "readWake", input: undefined })).toMatchObject({
        lastCollectAtMs: 5,
        heldPlanJson: "{}",
        heldPlanAttempts: 0,
        heldPlanNextAttemptAtMs: null,
        heldPlanTemplateAttemptedAtMs: null,
        lastDigestAtMs: null,
        lastMorningBriefAtMs: null,
        heldPlanAtMs: null,
      });
    } finally {
      void backend.close();
    }
  });

  it("keeps the morning brief marker apart from the digest marker", () => {
    const backend = openBackend();
    try {
      backend.execute({ type: "writeWake", input: { lastDigestAtMs: 10 } });
      expect(backend.execute({ type: "readWake", input: undefined })).toMatchObject({
        lastDigestAtMs: 10,
        lastMorningBriefAtMs: null,
      });
      backend.execute({ type: "writeWake", input: { lastMorningBriefAtMs: 30 } });
      expect(backend.execute({ type: "readWake", input: undefined })).toMatchObject({
        lastDigestAtMs: 10,
        lastMorningBriefAtMs: 30,
      });
    } finally {
      void backend.close();
    }
  });
});

describe("ada profile time zone", () => {
  it("creates a blank profile for a number that has none, then changes only the zone", () => {
    const backend = openBackend();
    try {
      expect(backend.execute({ type: "readProfile", input: undefined })).toBeNull();
      backend.execute({
        type: "setProfileTimezone",
        input: { timezone: "Asia/Shanghai", atMs: 1000 },
      });
      expect(backend.execute({ type: "readProfile", input: undefined })).toMatchObject({
        name: "",
        timezone: "Asia/Shanghai",
        language: "",
        generatedAtMs: 1000,
      });

      backend.execute({
        type: "upsertProfile",
        input: {
          name: "Avv. Test",
          timezone: "Europe/Rome",
          email: "avv@example.com",
          language: "it",
          jurisdiction: "IT",
          autonomy: "text only",
          channelStyle: "short",
          generatedAtMs: 2000,
        },
      });
      backend.execute({
        type: "setProfileTimezone",
        input: { timezone: "America/New_York", atMs: 3000 },
      });
      expect(backend.execute({ type: "readProfile", input: undefined })).toEqual({
        name: "Avv. Test",
        timezone: "America/New_York",
        email: "avv@example.com",
        language: "it",
        jurisdiction: "IT",
        autonomy: "text only",
        channelStyle: "short",
        generatedAtMs: 3000,
      });
    } finally {
      void backend.close();
    }
  });
});

describe("ada profile language on creation", () => {
  it("is set only when the profile is created, never over an existing one", () => {
    const backend = openBackend();
    try {
      backend.execute({
        type: "setProfileTimezone",
        input: { timezone: "Asia/Shanghai", atMs: 1000, language: "en" },
      });
      expect(backend.execute({ type: "readProfile", input: undefined })).toMatchObject({
        language: "en",
      });
      backend.execute({
        type: "setProfileTimezone",
        input: { timezone: "Europe/Rome", atMs: 2000, language: "de" },
      });
      expect(backend.execute({ type: "readProfile", input: undefined })).toMatchObject({
        timezone: "Europe/Rome",
        language: "en",
      });
    } finally {
      void backend.close();
    }
  });
});

describe("ada welcome markers", () => {
  it("claims a number once, survives a reopen, and can be released", () => {
    const databasePath = path.join(tempDirs.make("ada-welcome-"), "memory.sqlite");
    const claim = (backend: ReturnType<typeof createSqliteWorkerBackend>, number: string) =>
      backend.execute({ type: "claimWelcome", input: { number, atMs: 1000 } });

    const first = createSqliteWorkerBackend(undefined, { databasePath });
    expect(claim(first, "393331111111")).toBe(true);
    expect(claim(first, "393331111111")).toBe(false);
    expect(claim(first, "393332222222")).toBe(true);
    void first.close();

    const second = createSqliteWorkerBackend(undefined, { databasePath });
    expect(claim(second, "393331111111")).toBe(false);
    second.execute({ type: "releaseWelcome", input: { number: "393331111111" } });
    expect(claim(second, "393331111111")).toBe(true);
    void second.close();
  });
});
