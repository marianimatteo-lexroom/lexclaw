import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWorkerBackend } from "./google-account.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const ACCOUNT = {
  email: "lawyer@example.com",
  refreshToken: "test-refresh-token",
  accessToken: "test-access-token",
  accessExpiresAtMs: 1_000,
  connectedAtMs: 500,
  scopes: "https://www.googleapis.com/auth/gmail.send",
};

describe("vera google account store", () => {
  it("keeps one pending connect and one lawyer account", () => {
    const backend = createSqliteWorkerBackend(undefined, {
      databasePath: path.join(tempDirs.make("vera-google-"), "google-account.sqlite"),
    });
    try {
      backend.execute({
        type: "replacePending",
        input: { nonce: "pending-nonce-aaaaaa", expiresAtMs: 200 },
      });
      backend.execute({
        type: "replacePending",
        input: { nonce: "pending-nonce-bbbbbb", expiresAtMs: 300 },
      });
      expect(
        backend.execute({
          type: "consumePending",
          input: { nonce: "pending-nonce-aaaaaa", nowMs: 50 },
        }),
      ).toBe(false);
      expect(
        backend.execute({
          type: "consumePending",
          input: { nonce: "pending-nonce-bbbbbb", nowMs: 250 },
        }),
      ).toBe(true);
      expect(
        backend.execute({
          type: "consumePending",
          input: { nonce: "pending-nonce-bbbbbb", nowMs: 250 },
        }),
      ).toBe(false);
      expect(
        backend.execute({
          type: "consumePending",
          input: { nonce: "pending-nonce-cccccc", nowMs: 10 },
        }),
      ).toBe(false);

      backend.execute({ type: "upsertAccount", input: ACCOUNT });
      backend.execute({
        type: "upsertAccount",
        input: { ...ACCOUNT, email: "other@example.com", refreshToken: "test-refresh-token-2" },
      });
      expect(backend.execute({ type: "readAccount", input: undefined })).toMatchObject({
        email: "other@example.com",
        refreshToken: "test-refresh-token-2",
      });
      backend.execute({ type: "clearAccount", input: undefined });
      expect(backend.execute({ type: "readAccount", input: undefined })).toBeNull();
    } finally {
      void backend.close();
    }
  });

  it("rejects an expired pending connect", () => {
    const backend = createSqliteWorkerBackend(undefined, {
      databasePath: path.join(tempDirs.make("vera-google-expired-"), "google-account.sqlite"),
    });
    try {
      backend.execute({
        type: "replacePending",
        input: { nonce: "pending-nonce-expired", expiresAtMs: 100 },
      });
      expect(
        backend.execute({
          type: "consumePending",
          input: { nonce: "pending-nonce-expired", nowMs: 100 },
        }),
      ).toBe(false);
    } finally {
      void backend.close();
    }
  });
});
