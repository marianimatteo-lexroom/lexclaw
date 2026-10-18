import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { connectOfferNote, noteConnectOffer, takeConnectOffers } from "./connect-offers.js";
import { digestOfferDetail } from "./digest-text.js";
import type { DigestPlan } from "./digest.js";
import { ADA_PERSONA } from "./persona.js";
import { recordSenderInbound } from "./research-push.js";

const HOUR_MS = 3_600_000;

let counter = 0;
/** Offers live for the whole process, so each test names numbers of its own. */
const freshNumber = () => `39333${String(++counter).padStart(7, "0")}`;
const kinds = (owner: string, options: Parameters<typeof takeConnectOffers>[1]) =>
  takeConnectOffers(owner, { inboundAtMs: Number.MAX_SAFE_INTEGER, ...options }).map(
    (offer) => offer.kind,
  );

describe("pending connect questions", () => {
  it("are kept for the number that was asked, and the first run to read them owns them", () => {
    const [anna, bruno] = [freshNumber(), freshNumber()];
    noteConnectOffer(anna, "lexroom", 1_000);
    noteConnectOffer(anna, "google", 2_000);
    expect(kinds(bruno, { runId: "run-1", nowMs: 3_000 })).toEqual([]);
    expect(kinds(anna, { runId: "run-1", nowMs: 3_000 })).toEqual(["lexroom", "google"]);
    expect(kinds(anna, { runId: "run-1", nowMs: 3_000 })).toEqual(["lexroom", "google"]);
    expect(kinds(anna, { runId: "run-2", nowMs: 3_000 })).toEqual([]);
  });

  it("are not shared by runs without an id, and a new question is read afresh", () => {
    const anna = freshNumber();
    noteConnectOffer(anna, "lexroom", 1_000);
    expect(kinds(anna, { nowMs: 2_000 })).toEqual(["lexroom"]);
    expect(kinds(anna, { nowMs: 2_000 })).toEqual([]);
    noteConnectOffer(anna, "lexroom", 3_000);
    expect(kinds(anna, { runId: "run-3", nowMs: 4_000 })).toEqual(["lexroom"]);
  });

  it("are not read by a run whose message arrived before the question was delivered", () => {
    const anna = freshNumber();
    noteConnectOffer(anna, "lexroom", 5_000);
    expect(kinds(anna, { runId: "run-hello", inboundAtMs: 4_000, nowMs: 6_000 })).toEqual([]);
    expect(kinds(anna, { runId: "run-hello", inboundAtMs: 4_000, nowMs: 6_000 })).toEqual([]);
    expect(kinds(anna, { runId: "run-yes", inboundAtMs: 7_000, nowMs: 8_000 })).toEqual([
      "lexroom",
    ]);
  });

  it("are left for a later run when the run's message has no known arrival time", () => {
    const anna = freshNumber();
    noteConnectOffer(anna, "lexroom", 1_000);
    expect(takeConnectOffers(anna, { runId: "run-1", nowMs: 2_000 })).toEqual([]);
    expect(kinds(anna, { runId: "run-2", nowMs: 2_000 })).toEqual(["lexroom"]);
  });

  it("expire, so an old question never reaches a later conversation", () => {
    const carla = freshNumber();
    noteConnectOffer(carla, "lexroom", 0);
    expect(kinds(carla, { runId: "run-1", nowMs: 72 * HOUR_MS + 1 })).toEqual([]);
  });

  it("are handed to the model as a note to read the reply by, not as a keyword matcher", () => {
    expect(connectOfferNote([])).toBeUndefined();
    const note = connectOfferNote([{ kind: "lexroom" }, { kind: "google" }]) ?? "";
    expect(note).toContain("Question you just asked");
    expect(note).toContain("ada_lexroom_connect");
    expect(note).toContain("ada_google_connect");
    expect(note).toContain("yes in any form");
    expect(note).toContain("do not ask again");
  });

  it("tells the model to force a new link when Lexroom refused a sign-in that is still saved", () => {
    const note = connectOfferNote([{ kind: "lexroom_reconnect" }]) ?? "";
    expect(note).toContain("ada_lexroom_connect with force true");
    expect(connectOfferNote([{ kind: "lexroom" }])).not.toContain("force true");
  });
});

const PLAN: Extract<DigestPlan, { deliver: true }> = {
  deliver: true,
  items: [],
  nextSteps: [
    { action: "research", matterId: "rossi", matterLabel: "Rossi SRL", instruction: "x" },
    { action: "draft_if_confirmed", matterId: "rossi", matterLabel: "Rossi SRL", instruction: "y" },
  ],
  deadlines: [1, 2].map((no) => ({
    id: `dl-${no}`,
    matterId: "m",
    matterLabel: no === 1 ? "Bianchi" : "Verdi",
    type: "hearing" as const,
    title: "Udienza",
    dueAt: "2026-11-12T08:30:00.000Z",
    due: "2026-11-12 09:30",
    daysLeft: 30,
    status: no === 1 ? ("candidate" as const) : ("tracked" as const),
    confidence: 0.9,
    source: "PEC",
    briefReady: no === 2,
    no,
  })),
};

describe("the digest as a pending question", () => {
  it("lists the next steps and every numbered item with what its line offered", () => {
    expect(digestOfferDetail(PLAN)).toBe(
      [
        "  - a Lexroom research for Rossi SRL; a yes starts it",
        "  - a draft for Rossi SRL, only after the research and with their ok",
        "  - item 1: Bianchi, hearing 2026-11-12 09:30; offered: start the Lexroom research, or skip it",
        "  - item 2: Verdi, hearing 2026-11-12 09:30; offered: send the stored brief again, or skip it",
      ].join("\n"),
    );
  });

  it("is handed to the model with the actions and the instruction to ask which one when unclear", () => {
    const note = connectOfferNote([{ kind: "digest", detail: digestOfferDetail(PLAN) }]) ?? "";
    expect(note).toContain("Question you just asked");
    expect(note).toContain("item 2: Verdi");
    expect(note).toContain("ada_deadline_list");
    expect(note).toContain("ada_deadline_reply");
    expect(note).toContain("ask which one in natural language");
  });
});

describe("the persona hook", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;

  function personaHook(): Handler {
    const registered: Array<{ handler: Handler; options: unknown }> = [];
    plugin.register?.(
      createTestPluginApi({
        id: "ada",
        on: ((_name: string, handler: Handler, options?: unknown) => {
          if (_name === "before_prompt_build") {
            registered.push({ handler, options });
          }
        }) as OpenClawPluginApi["on"],
      }),
    );
    const hook = registered.find((entry) => entry.options === undefined);
    if (!hook) {
      throw new Error("persona hook missing");
    }
    return hook.handler;
  }

  const turn = (number: string) => ({
    senderId: number,
    channelId: "kapso-whatsapp",
    sessionKey: `agent:main:kapso-whatsapp:direct:${number}`,
  });
  const plain = { prependSystemContext: ADA_PERSONA };
  /** The message the person's run answers has arrived, after any question already sent. */
  const arrived = (number: string) => recordSenderInbound(number, Date.now() + 60_000);
  const noted = (text: string) => ({
    prependSystemContext: ADA_PERSONA,
    prependContext: expect.stringContaining(text),
  });

  it("adds the question note to the number that was asked, again for the same run only", () => {
    const [anna, bruno] = [freshNumber(), freshNumber()];
    const hook = personaHook();
    noteConnectOffer(anna, "google");
    arrived(anna);
    arrived(bruno);
    expect(hook({}, { ...turn(bruno), runId: "r1", trigger: "user" })).toEqual(plain);
    expect(hook({}, { ...turn(anna), runId: "r1", trigger: "user" })).toEqual(
      noted("ada_google_connect"),
    );
    expect(hook({}, { ...turn(anna), runId: "r1", trigger: "user" })).toEqual(
      noted("ada_google_connect"),
    );
    expect(hook({}, { ...turn(anna), runId: "r2", trigger: "user" })).toEqual(plain);
  });

  it("keeps the question for the person's own turn when a cron or system run builds a prompt first", () => {
    const anna = freshNumber();
    const hook = personaHook();
    noteConnectOffer(anna, "google");
    arrived(anna);
    for (const trigger of ["cron", "heartbeat", "memory"]) {
      expect(hook({}, { ...turn(anna), runId: `r-${trigger}`, trigger })).toEqual(plain);
    }
    expect(hook({}, { ...turn(anna), runId: "r-user" })).toEqual(noted("ada_google_connect"));
  });

  it("gives a bare 'sì' after a question sent while another message was being answered the question's context", () => {
    const anna = freshNumber();
    const t = Date.now();
    const hook = personaHook();
    recordSenderInbound(anna, t + 1_000);
    // The release of a held message, triggered by "buongiorno", delivers the question later.
    noteConnectOffer(anna, "lexroom", t + 2_000);
    expect(hook({}, { ...turn(anna), runId: "run-buongiorno" })).toEqual(plain);
    // The person reads it and answers "sì": a message that arrived after the question.
    recordSenderInbound(anna, t + 3_000);
    expect(hook({}, { ...turn(anna), runId: "run-si" })).toEqual(noted("ada_lexroom_connect"));
    expect(hook({}, { ...turn(anna), runId: "run-after" })).toEqual(plain);
  });

  it("gives a bare 'ok' after the morning digest the digest's items and actions", () => {
    const anna = freshNumber();
    const t = Date.now();
    const hook = personaHook();
    recordSenderInbound(anna, t + 1_000);
    noteConnectOffer(anna, "digest", t + 2_000, digestOfferDetail(PLAN));
    recordSenderInbound(anna, t + 3_000);
    const result = hook({}, { ...turn(anna), runId: "run-ok" }) as { prependContext?: string };
    expect(result.prependContext).toContain("item 1: Bianchi");
    expect(result.prependContext).toContain("item 2: Verdi");
    expect(result.prependContext).toContain("ada_deadline_reply");
  });

  it("leaves the question alone when this process never saw the message arrive", () => {
    const anna = freshNumber();
    noteConnectOffer(anna, "lexroom");
    expect(personaHook()({}, { ...turn(anna), runId: "r1" })).toEqual(plain);
    arrived(anna);
    expect(personaHook()({}, { ...turn(anna), runId: "r2" })).toEqual(noted("ada_lexroom_connect"));
  });

  it("still returns the persona for a turn that names no sender", () => {
    const anna = freshNumber();
    noteConnectOffer(anna, "lexroom");
    expect(personaHook()({}, {})).toEqual(plain);
    expect(kinds(anna, { runId: "r1" })).toEqual(["lexroom"]);
  });
});
