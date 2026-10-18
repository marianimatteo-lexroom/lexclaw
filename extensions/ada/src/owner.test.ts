import { describe, expect, it } from "vitest";
import {
  lawyerOwner,
  ownerRefusalMessage,
  resolveTurnOwner,
  sessionKeyOwner,
  toOwner,
} from "./owner.js";

const ANNA = "393331111111";
const BRUNO = "393332222222";

describe("owner numbers", () => {
  it("reduces every spelling of a number to its digits, and refuses what is not a number", () => {
    for (const value of [
      "+393331111111",
      "393331111111",
      " +39 333 111 1111 ",
      "whatsapp:+393331111111",
      "393331111111@s.whatsapp.net",
    ]) {
      expect(toOwner(value)).toBe(ANNA);
    }
    for (const value of ["", "lawyer", "123", "120363025246125486@g.us", undefined, 393331111111]) {
      expect(toOwner(value)).toBeNull();
    }
  });

  it("takes the lawyer from the configured default recipient", () => {
    expect(lawyerOwner({ channels: { "kapso-whatsapp": { defaultTo: "+393331111111" } } })).toBe(
      ANNA,
    );
    expect(lawyerOwner({})).toBeNull();
  });

  it("reads the number out of a direct session key only", () => {
    expect(sessionKeyOwner(`agent:main:kapso-whatsapp:direct:${ANNA}`)).toBe(ANNA);
    expect(sessionKeyOwner(`agent:main:kapso-whatsapp:direct:+${ANNA}`)).toBe(ANNA);
    expect(sessionKeyOwner("agent:main:main")).toBeNull();
    expect(sessionKeyOwner("agent:main:kapso-whatsapp:group:120363025246125486")).toBeNull();
    expect(sessionKeyOwner("hook:ada:digest:2026-10-14")).toBeNull();
    expect(sessionKeyOwner(undefined)).toBeNull();
  });
});

describe("resolveTurnOwner", () => {
  const session = (number: string) => `agent:main:kapso-whatsapp:direct:${number}`;

  it("is the sender of the private WhatsApp chat", () => {
    expect(
      resolveTurnOwner({
        requesterSenderId: "+39 333 111 1111",
        messageChannel: "kapso-whatsapp",
        sessionKey: session(ANNA),
      }),
    ).toEqual({ ok: true, owner: ANNA });
  });

  it("can come from the trusted sender alone, or from the session alone", () => {
    expect(resolveTurnOwner({ requesterSenderId: ANNA })).toEqual({ ok: true, owner: ANNA });
    expect(resolveTurnOwner({ sessionKey: session(BRUNO) })).toEqual({ ok: true, owner: BRUNO });
  });

  it("never falls back to another account when it cannot tell who is asking", () => {
    for (const turn of [
      {},
      { requesterSenderId: "webchat-user-7" },
      { sessionKey: "agent:main:main" },
      { messageChannel: "kapso-whatsapp" },
    ]) {
      expect(resolveTurnOwner(turn)).toEqual({ ok: false, reason: "no_sender" });
    }
  });

  it("refuses another channel, a group and a sender that contradicts its session", () => {
    expect(resolveTurnOwner({ requesterSenderId: ANNA, messageChannel: "telegram" })).toEqual({
      ok: false,
      reason: "other_channel",
    });
    expect(
      resolveTurnOwner({ requesterSenderId: ANNA, nativeChannelId: "120363025246125486@g.us" }),
    ).toEqual({ ok: false, reason: "group_chat" });
    expect(
      resolveTurnOwner({
        requesterSenderId: ANNA,
        sessionKey: "agent:main:kapso-whatsapp:group:120363025246125486",
      }),
    ).toEqual({ ok: false, reason: "group_chat" });
    expect(resolveTurnOwner({ requesterSenderId: BRUNO, sessionKey: session(ANNA) })).toEqual({
      ok: false,
      reason: "session_mismatch",
    });
  });

  it("explains a refusal to the person without technical detail", () => {
    expect(ownerRefusalMessage("group_chat")).toContain("private WhatsApp chat");
    expect(ownerRefusalMessage("no_sender")).toContain("private WhatsApp chat");
  });
});
