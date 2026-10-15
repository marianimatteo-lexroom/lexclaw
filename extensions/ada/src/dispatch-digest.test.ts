import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { DigestPlan } from "./digest.js";
import { dispatchDigest } from "./dispatch-digest.js";

const plan: DigestPlan = { deliver: false, reason: "nothing_cleared_the_bar" };

function apiWith(dispatchHookAgentTurn: ReturnType<typeof vi.fn> | undefined) {
  return {
    runtime: { hooks: dispatchHookAgentTurn ? { dispatchHookAgentTurn } : undefined },
  } as unknown as Pick<OpenClawPluginApi, "runtime">;
}

describe("dispatchDigest", () => {
  it("reports hooks_unavailable when the host has no hook dispatcher", async () => {
    expect(
      await dispatchDigest(apiWith(undefined), {
        plan,
        sessionKey: "hook:vera:digest:d",
        idempotencyKey: "k",
      }),
    ).toEqual({ ok: false, reason: "hooks_unavailable" });
  });

  it("starts one isolated digest turn with the plan and the caller's idempotency key", async () => {
    const dispatch = vi.fn(async () => ({ ok: true, runId: "run" }));
    const result = await dispatchDigest(apiWith(dispatch), {
      plan,
      sessionKey: "hook:vera:digest:d",
      idempotencyKey: "vera-digest:d:verdi",
    });
    expect(result).toEqual({ ok: true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Ada digest",
        sessionKey: "hook:vera:digest:d",
        idempotencyKey: "vera-digest:d:verdi",
        externalContentSource: "email",
        deliver: true,
        timeoutSeconds: 45,
        message: expect.stringContaining(JSON.stringify(plan)),
      }),
    );
  });

  it("marks a release after a lawyer reply and keeps its idempotency keys apart", async () => {
    const dispatch = vi.fn(async () => ({ ok: true, runId: "run" }));
    await dispatchDigest(apiWith(dispatch), {
      plan,
      sessionKey: "hook:vera:digest:d",
      idempotencyKey: "vera-digest:d:verdi",
      afterLawyerReply: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Ada held digest",
        idempotencyKey: "vera-held:vera-digest:d:verdi",
        message: expect.stringContaining("The lawyer just texted"),
      }),
    );
  });

  it("asks for the Google connect skill instead of a digest", async () => {
    const dispatch = vi.fn(async () => ({ ok: true, runId: "run" }));
    await dispatchDigest(apiWith(dispatch), {
      plan,
      sessionKey: "hook:vera:connect:d",
      idempotencyKey: "vera-connect:d",
      connectOnly: true,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Ada Google connect",
        message: "Follow the ada-google-connect skill now. Do not invent a digest.",
      }),
    );
  });

  it("passes through the host's rejection reason", async () => {
    const dispatch = vi.fn(async () => ({ ok: false, reason: "timeout" }));
    expect(
      await dispatchDigest(apiWith(dispatch), {
        plan,
        sessionKey: "hook:vera:digest:d",
        idempotencyKey: "k",
      }),
    ).toEqual({ ok: false, reason: "timeout" });
  });
});
