import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DigestPlan } from "./digest.js";

const openAdaMemoryIfExistsFromApi = vi.hoisted(() => vi.fn());
const executeAdaGoogleConnect = vi.hoisted(() => vi.fn());

vi.mock("./memory.js", () => ({ openAdaMemoryIfExistsFromApi }));
vi.mock("./google-tools.js", () => ({ executeAdaGoogleConnect }));

import { takeConnectOffers } from "./connect-offers.js";
import { clearSentDigests, dispatchDigest } from "./dispatch-digest.js";

const ANNA = "393331111111";
const BRUNO = "393332222222";
const LAWYER = "390000000000";
const DINO = "393334444444";
const ELSA = "393339999999";

const NO_PLAN: DigestPlan = { deliver: false, reason: "nothing_cleared_the_bar" };
const PLAN: DigestPlan = {
  deliver: true,
  items: [
    {
      matterId: "rossi",
      matterLabel: "Rossi SRL",
      kind: "deadline",
      summary: "memoria entro domani",
      cost: 100,
      dueAt: "2026-10-12T15:00:00.000Z",
    },
  ],
  nextSteps: [
    {
      action: "research",
      matterId: "rossi",
      matterLabel: "Rossi SRL",
      instruction: "Research only the Rossi SRL matter: memoria entro domani",
    },
    {
      action: "draft_if_confirmed",
      matterId: "rossi",
      matterLabel: "Rossi SRL",
      instruction: "After the lawyer confirms, draft only for the Rossi SRL matter",
    },
  ],
};

function setup(profiles: Record<string, { language: string; timezone: string } | null> = {}) {
  const sent: Array<{ to: string; text: string }> = [];
  const sendText = vi.fn(async (params: { to: string; text: string }) => {
    sent.push({ to: params.to, text: params.text });
  });
  openAdaMemoryIfExistsFromApi.mockImplementation(async (_api: unknown, owner: string) => {
    const profile = profiles[owner];
    return profile ? { readProfile: async () => profile } : null;
  });
  const api = {
    config: { channels: { "kapso-whatsapp": { defaultTo: `+${LAWYER}` } } },
    pluginConfig: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: { channel: { outbound: { loadAdapter: async () => ({ sendText }) } } },
  } as unknown as Pick<
    OpenClawPluginApi,
    "runtime" | "runtimeSource" | "config" | "logger" | "pluginConfig"
  >;
  return { api, sent, sendText };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSentDigests();
});

describe("dispatchDigest", () => {
  it("sends the digest to its owner's number only, in their language, without any model turn", async () => {
    const { api, sent } = setup({ [ANNA]: { language: "English", timezone: "Europe/Rome" } });
    expect(await dispatchDigest(api, { owner: ANNA, plan: PLAN, idempotencyKey: "k1" })).toEqual({
      ok: true,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(`+${ANNA}`);
    expect(sent[0]?.text).toContain("Good morning. This one should not wait:");
    expect(sent[0]?.text).toContain("Rossi SRL: memoria entro domani");
    expect(sent.some((entry) => entry.to === `+${LAWYER}`)).toBe(false);
  });

  it("writes it in Italian by default and for a number with no profile", async () => {
    const { api, sent } = setup();
    await dispatchDigest(api, { owner: BRUNO, plan: PLAN, idempotencyKey: "k2" });
    expect(sent[0]).toMatchObject({ to: `+${BRUNO}` });
    expect(sent[0]?.text).toContain("Buongiorno. Questo non può aspettare:");
    expect(sent[0]?.text).toContain("Rossi SRL");
    expect(sent[0]?.text).toContain("Posso fare subito:");
  });

  it("sends a different owner's digest to that owner, never to the previous one", async () => {
    const { api, sent } = setup();
    await dispatchDigest(api, { owner: ANNA, plan: PLAN, idempotencyKey: "same-key-a" });
    await dispatchDigest(api, { owner: BRUNO, plan: PLAN, idempotencyKey: "same-key-b" });
    expect(sent.map((entry) => entry.to)).toEqual([`+${ANNA}`, `+${BRUNO}`]);
  });

  it("does not send the same digest twice, and keeps a release after a reply apart", async () => {
    const { api, sent } = setup();
    await dispatchDigest(api, { owner: ANNA, plan: PLAN, idempotencyKey: "k3" });
    await dispatchDigest(api, { owner: ANNA, plan: PLAN, idempotencyKey: "k3" });
    expect(sent).toHaveLength(1);
    await dispatchDigest(api, {
      owner: ANNA,
      plan: PLAN,
      idempotencyKey: "k3",
      afterLawyerReply: true,
    });
    expect(sent).toHaveLength(2);
  });

  it("notes what the digest offered, for that number only, and only once it was delivered", async () => {
    const { api, sendText } = setup();
    sendText.mockRejectedValueOnce(new Error("window closed"));
    expect(
      await dispatchDigest(api, { owner: DINO, plan: PLAN, idempotencyKey: "d1" }),
    ).toMatchObject({ ok: false });
    expect(takeConnectOffers(DINO, { runId: "r0" })).toEqual([]);

    await dispatchDigest(api, {
      owner: DINO,
      plan: PLAN,
      idempotencyKey: "d1",
      afterLawyerReply: true,
    });
    const [offer] = takeConnectOffers(DINO, { runId: "r1" });
    expect(offer?.kind).toBe("digest");
    expect(offer?.detail).toContain("a Lexroom research for Rossi SRL");
    expect(takeConnectOffers(ELSA, { runId: "r1" })).toEqual([]);
  });

  it("sends nothing for a plan with nothing to say", async () => {
    const { api, sent } = setup();
    expect(await dispatchDigest(api, { owner: ANNA, plan: NO_PLAN, idempotencyKey: "k4" })).toEqual(
      {
        ok: false,
        reason: "nothing_to_send",
      },
    );
    expect(sent).toEqual([]);
  });

  it("asks the owner to connect Google with that owner's own link", async () => {
    const { api, sent } = setup();
    executeAdaGoogleConnect.mockResolvedValue({
      ok: true,
      connected: false,
      ask: { url: "https://accounts.google.com/o/oauth2/v2/auth?state=anna", message: "x" },
    });
    expect(
      await dispatchDigest(api, {
        owner: ANNA,
        plan: NO_PLAN,
        idempotencyKey: "c1",
        connectOnly: true,
      }),
    ).toEqual({ ok: true });
    expect(executeAdaGoogleConnect).toHaveBeenCalledExactlyOnceWith(ANNA, {}, api);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(`+${ANNA}`);
    expect(sent[0]?.text).toContain("https://accounts.google.com/o/oauth2/v2/auth?state=anna");
    expect(sent[0]?.text).toContain("Collega Gmail e Google Calendar");
  });

  it("tells an owner whose Google sign-in expired, in plain words, with a fresh link and no command", async () => {
    const { api, sent } = setup();
    executeAdaGoogleConnect.mockResolvedValue({
      ok: true,
      connected: false,
      ask: { url: "https://accounts.google.com/o/oauth2/v2/auth?state=anna", message: "x" },
    });
    expect(
      await dispatchDigest(api, {
        owner: ANNA,
        plan: NO_PLAN,
        idempotencyKey: "r1",
        connectOnly: true,
        reconnect: true,
      }),
    ).toEqual({ ok: true });
    expect(sent[0]?.to).toBe(`+${ANNA}`);
    expect(sent[0]?.text).toBe(
      "Il collegamento al tuo Gmail è scaduto: ecco il link per ricollegarlo (vale 30 minuti)\nhttps://accounts.google.com/o/oauth2/v2/auth?state=anna",
    );
    expect(sent[0]?.text).not.toMatch(/«|scrivimi/u);
  });

  it("does not ask an already connected owner again", async () => {
    const { api, sent } = setup();
    executeAdaGoogleConnect.mockResolvedValue({ ok: true, connected: true, email: "a@b.c" });
    expect(
      await dispatchDigest(api, {
        owner: ANNA,
        plan: NO_PLAN,
        idempotencyKey: "c2",
        connectOnly: true,
      }),
    ).toEqual({ ok: false, reason: "already_connected" });
    expect(sent).toEqual([]);
  });

  it("reports a failed send and lets the next pass try again", async () => {
    const { api, sendText } = setup();
    sendText.mockRejectedValueOnce(new Error("kapso down"));
    expect(await dispatchDigest(api, { owner: ANNA, plan: PLAN, idempotencyKey: "k5" })).toEqual({
      ok: false,
      reason: "kapso down",
    });
    expect(await dispatchDigest(api, { owner: ANNA, plan: PLAN, idempotencyKey: "k5" })).toEqual({
      ok: true,
    });
  });
});
