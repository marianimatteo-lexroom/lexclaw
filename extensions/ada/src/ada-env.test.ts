import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAdaEnv } from "./ada-env.js";
import { adaStatePath } from "./state-paths.js";
import { readStatusReactionSettings } from "./status-reactions.js";
import { resolveTokenCipher } from "./token-crypto.js";

const KEY = Buffer.alloc(32, 9).toString("base64");

describe("readAdaEnv", () => {
  it("prefers ADA_, falls back to the old VERA_ name, and treats blanks as unset", () => {
    expect(readAdaEnv({ ADA_X: "new", VERA_X: "old" }, "X")).toBe("new");
    expect(readAdaEnv({ VERA_X: "old" }, "X")).toBe("old");
    expect(readAdaEnv({ ADA_X: "  ", VERA_X: "old" }, "X")).toBe("old");
    expect(readAdaEnv({}, "X")).toBeUndefined();
  });
});

describe("pre-rename deployments", () => {
  it("still decrypt with a VERA_TOKEN_KEY, and ADA_TOKEN_KEY takes over when both are set", () => {
    const legacy = resolveTokenCipher({ NODE_ENV: "production", VERA_TOKEN_KEY: KEY });
    const sealed = legacy.seal("secret-value", "ctx");
    expect(legacy.encrypting).toBe(true);
    const renamed = resolveTokenCipher({ NODE_ENV: "production", ADA_TOKEN_KEY: KEY });
    expect(renamed.open(sealed, "ctx").value).toBe("secret-value");
    const other = Buffer.alloc(32, 3).toString("base64");
    const both = resolveTokenCipher({ ADA_TOKEN_KEY: other, VERA_TOKEN_KEY: KEY });
    expect(() => both.open(sealed, "ctx")).toThrow("ADA_TOKEN_KEY differs");
  });

  it("refuses production without either key and names the new variable", () => {
    expect(() => resolveTokenCipher({ NODE_ENV: "production" })).toThrow("ADA_TOKEN_KEY");
  });

  it("reads the old status-reaction variables", () => {
    expect(readStatusReactionSettings({ VERA_STATUS_REACTIONS: "false" })).toBeNull();
    expect(readStatusReactionSettings({ VERA_REACTION_ACK: "📨" })).toMatchObject({ ack: "📨" });
    expect(
      readStatusReactionSettings({ ADA_REACTION_ACK: "🤝", VERA_REACTION_ACK: "📨" }),
    ).toMatchObject({ ack: "🤝" });
  });

  it("keeps the stores under the existing state folder so saved sign-ins stay readable", () => {
    expect(adaStatePath("/data/.openclaw", "lexroom-account.sqlite")).toBe(
      path.join("/data/.openclaw", "vera", "lexroom-account.sqlite"),
    );
  });
});
