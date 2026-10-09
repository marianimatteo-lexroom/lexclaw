import { describe, expect, it, vi } from "vitest";
import type { GoogleAccountRecord, GoogleAccountStore } from "./google-account-contract.js";
import { sendConnectedEmail } from "./google-tools.js";

const CONFIG = {
  googleClientId: "test-client.apps.googleusercontent.com",
  googleClientSecret: "test-client-secret-value",
  googleRedirectUri: "https://gateway.example/vera/google/callback",
  googleStateSecret: "state-secret-test-value",
};

function storeWith(account: GoogleAccountRecord | null): GoogleAccountStore {
  return {
    replacePending: async () => {},
    consumePending: async () => false,
    upsertAccount: async () => {},
    readAccount: async () => account,
    clearAccount: async () => {},
  };
}

const SEND = {
  config: CONFIG,
  to: "paolo@example.com",
  subject: "Oggi",
  text: "Ciao Paolo.",
};

describe("sendConnectedEmail", () => {
  it("does not call Google before the lawyer confirms", async () => {
    const fetchImpl = vi.fn();
    const result = await sendConnectedEmail({
      ...SEND,
      confirmed: false,
      store: storeWith(null),
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: "confirmation_required" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("asks for a new link when the saved connection cannot send", async () => {
    const fetchImpl = vi.fn();
    const result = await sendConnectedEmail({
      ...SEND,
      confirmed: true,
      store: storeWith({
        email: "lawyer@example.com",
        refreshToken: "test-refresh-token",
        accessToken: "test-access-token",
        accessExpiresAtMs: Date.now() + 3_600_000,
        connectedAtMs: 1,
        scopes: null,
      }),
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: "needs_send_scope" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
