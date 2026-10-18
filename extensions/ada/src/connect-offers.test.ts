import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import plugin from "../index.js";
import { connectOfferNote, noteConnectOffer, takeConnectOffers } from "./connect-offers.js";
import { ADA_PERSONA } from "./persona.js";

const ANNA = "393331111111";
const BRUNO = "393332222222";
const CARLA = "393333333333";
const HOUR_MS = 3_600_000;

describe("pending connect questions", () => {
  it("are kept for the number that was asked, and the first run to read them owns them", () => {
    noteConnectOffer(ANNA, "lexroom", 1_000);
    noteConnectOffer(ANNA, "google", 2_000);
    expect(takeConnectOffers(BRUNO, "run-1", 3_000)).toEqual([]);
    expect(takeConnectOffers(ANNA, "run-1", 3_000)).toEqual(["lexroom", "google"]);
    expect(takeConnectOffers(ANNA, "run-1", 3_000)).toEqual(["lexroom", "google"]);
    expect(takeConnectOffers(ANNA, "run-2", 3_000)).toEqual([]);
  });

  it("are not taken by a run without an id, and a new question is read afresh", () => {
    noteConnectOffer(ANNA, "lexroom", 1_000);
    expect(takeConnectOffers(ANNA, undefined, 2_000)).toEqual(["lexroom"]);
    expect(takeConnectOffers(ANNA, undefined, 2_000)).toEqual([]);
    noteConnectOffer(ANNA, "lexroom", 3_000);
    expect(takeConnectOffers(ANNA, "run-3", 4_000)).toEqual(["lexroom"]);
  });

  it("expire, so an old question never reaches a later conversation", () => {
    noteConnectOffer(CARLA, "lexroom", 0);
    expect(takeConnectOffers(CARLA, "run-1", 72 * HOUR_MS + 1)).toEqual([]);
  });

  it("are handed to the model as a note to read the reply by, not as a keyword matcher", () => {
    expect(connectOfferNote([])).toBeUndefined();
    const note = connectOfferNote(["lexroom", "google"]) ?? "";
    expect(note).toContain("Question you just asked");
    expect(note).toContain("ada_lexroom_connect");
    expect(note).toContain("ada_google_connect");
    expect(note).toContain("yes in any form");
    expect(note).toContain("do not ask again");
  });

  it("tells the model to force a new link when Lexroom refused a sign-in that is still saved", () => {
    const note = connectOfferNote(["lexroom_reconnect"]) ?? "";
    expect(note).toContain("ada_lexroom_connect with force true");
    expect(connectOfferNote(["lexroom"])).not.toContain("force true");
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

  it("adds the question note to the number that was asked, again for the same run only", () => {
    const hook = personaHook();
    noteConnectOffer(ANNA, "google");
    expect(hook({}, { ...turn(BRUNO), runId: "r1", trigger: "user" })).toEqual({
      prependSystemContext: ADA_PERSONA,
    });
    const withNote = {
      prependSystemContext: ADA_PERSONA,
      prependContext: expect.stringContaining("ada_google_connect"),
    };
    expect(hook({}, { ...turn(ANNA), runId: "r1", trigger: "user" })).toEqual(withNote);
    expect(hook({}, { ...turn(ANNA), runId: "r1", trigger: "user" })).toEqual(withNote);
    expect(hook({}, { ...turn(ANNA), runId: "r2", trigger: "user" })).toEqual({
      prependSystemContext: ADA_PERSONA,
    });
  });

  it("keeps the question for the person's own turn when a cron or system run builds a prompt first", () => {
    const hook = personaHook();
    noteConnectOffer(ANNA, "google");
    for (const trigger of ["cron", "heartbeat", "memory"]) {
      expect(hook({}, { ...turn(ANNA), runId: `r-${trigger}`, trigger })).toEqual({
        prependSystemContext: ADA_PERSONA,
      });
    }
    expect(hook({}, { ...turn(ANNA), runId: "r-user" })).toEqual({
      prependSystemContext: ADA_PERSONA,
      prependContext: expect.stringContaining("ada_google_connect"),
    });
  });

  it("still returns the persona for a turn that names no sender", () => {
    noteConnectOffer(ANNA, "lexroom");
    expect(personaHook()({}, {})).toEqual({ prependSystemContext: ADA_PERSONA });
    expect(takeConnectOffers(ANNA, "r1")).toEqual(["lexroom"]);
  });
});
