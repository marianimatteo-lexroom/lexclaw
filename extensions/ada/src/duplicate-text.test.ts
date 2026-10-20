import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import {
  createInboundTextGuard,
  normalizeInboundText,
  registerInboundDuplicateHooks,
} from "./duplicate-text.js";

const NUMBER = "393338262862";
const QUESTION =
  "Quali sono i termini per impugnare una sentenza di primo grado in materia civile?";

function guardAt(start = 1_000_000) {
  let now = start;
  const guard = createInboundTextGuard(() => now);
  return {
    guard,
    advance: (ms: number) => {
      now += ms;
    },
    seen: (messageId: string, text = QUESTION, sender = NUMBER) =>
      guard.verdict({ channelId: "kapso-whatsapp", senders: [sender], messageId, text }),
  };
}

describe("repeated inbound text", () => {
  it("answers the first copy and skips an identical one sent seconds later", () => {
    const { seen, advance } = guardAt();
    expect(seen("wamid.A")).toBe("first");
    advance(20_000);
    expect(seen("wamid.B")).toBe("duplicate");
  });

  it("ignores case and spacing when it compares texts", () => {
    const { seen } = guardAt();
    expect(seen("wamid.A", QUESTION)).toBe("first");
    expect(seen("wamid.B", `  ${QUESTION.toUpperCase().replace(/ /gu, "  ")}\n`)).toBe("duplicate");
    expect(normalizeInboundText("A \t b\n")).toBe("a b");
  });

  it("still answers a different message, even one that shares most of its words", () => {
    const { seen, advance } = guardAt();
    expect(seen("wamid.A")).toBe("first");
    advance(5_000);
    expect(seen("wamid.B", `${QUESTION} E per il giudizio d'appello?`)).toBe("first");
    expect(seen("wamid.C", "Grazie, e per le sentenze del giudice di pace?")).toBe("first");
  });

  it("answers the same text again once two minutes have passed", () => {
    const { seen, advance } = guardAt();
    expect(seen("wamid.A")).toBe("first");
    advance(2 * 60 * 1000 + 1_000);
    expect(seen("wamid.B")).toBe("first");
  });

  it("never treats one message as a repeat of itself, whichever hook sees it first", () => {
    const { seen } = guardAt();
    expect(seen("wamid.A")).toBe("first");
    expect(seen("wamid.A")).toBe("first");
    expect(seen("wamid.B")).toBe("duplicate");
    expect(seen("wamid.B")).toBe("duplicate");
    expect(seen("wamid.A")).toBe("first");
  });

  it("keeps numbers apart", () => {
    const { seen } = guardAt();
    expect(seen("wamid.A", QUESTION, NUMBER)).toBe("first");
    expect(seen("wamid.B", QUESTION, "393331112233")).toBe("first");
  });

  it("lets short answers repeat, since they answer different questions", () => {
    const { seen } = guardAt();
    expect(seen("wamid.A", "Sì")).toBe("first");
    expect(seen("wamid.B", "Sì")).toBe("first");
  });

  it("leaves other channels, groups and messages without an id alone", () => {
    const { guard } = guardAt();
    const base = { senders: [NUMBER], text: QUESTION };
    expect(guard.verdict({ ...base, channelId: "telegram", messageId: "1" })).toBe("ignored");
    expect(guard.verdict({ ...base, channelId: "kapso-whatsapp" })).toBe("ignored");
    expect(
      guard.verdict({
        channelId: "kapso-whatsapp",
        senders: ["120363@g.us"],
        messageId: "1",
        text: QUESTION,
      }),
    ).toBe("ignored");
  });

  it("uses when the messages were sent, not when this process got to them", () => {
    const { guard, advance } = guardAt();
    const sent = (messageId: string, timestampMs: number) =>
      guard.verdict({
        channelId: "kapso-whatsapp",
        senders: [NUMBER],
        messageId,
        text: QUESTION,
        timestampMs,
      });
    expect(sent("wamid.A", 1_000_000)).toBe("first");
    // The second copy waited behind a long answer to the first before it was looked at.
    advance(5 * 60 * 1000);
    expect(sent("wamid.B", 1_020_000)).toBe("duplicate");
  });

  it("answers a repeat after a run that failed without an answer", () => {
    const { guard, seen } = guardAt();
    expect(seen("wamid.A")).toBe("first");
    guard.release(NUMBER);
    expect(seen("wamid.B")).toBe("first");
  });
});

describe("the duplicate hooks", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;

  function register() {
    const hooks = new Map<string, Handler>();
    const info = vi.fn();
    const api = createTestPluginApi({
      id: "ada",
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      on: ((name: string, handler: Handler) => {
        hooks.set(name, handler);
      }) as OpenClawPluginApi["on"],
    });
    const guard = guardAt();
    registerInboundDuplicateHooks(api, guard.guard);
    const dispatch = (messageId: string, content = QUESTION) =>
      hooks.get("before_dispatch")?.(
        { content, messageId, channel: "kapso-whatsapp", senderId: NUMBER },
        { channelId: "kapso-whatsapp", messageId, senderId: NUMBER },
      );
    return { hooks, info, dispatch, ...guard };
  }

  it("claims the second copy without a reply and logs it without the text", () => {
    const { dispatch, info } = register();
    expect(dispatch("wamid.A")).toBeUndefined();
    expect(dispatch("wamid.B")).toEqual({ handled: true });
    const logged = info.mock.calls.map(([line]) => String(line)).join("\n");
    expect(logged).toContain("reason=duplicate_text");
    expect(logged).not.toContain("impugnare");
    expect(logged).not.toContain(NUMBER);
  });

  it("dispatches a different message and a redelivery of the first one", () => {
    const { dispatch } = register();
    expect(dispatch("wamid.A")).toBeUndefined();
    expect(dispatch("wamid.C", "E per l'appello quanto tempo c'è, esattamente?")).toBeUndefined();
    expect(dispatch("wamid.A")).toBeUndefined();
  });

  it("answers a repeat when the run for the first copy failed", () => {
    const { hooks, dispatch } = register();
    expect(dispatch("wamid.A")).toBeUndefined();
    hooks.get("agent_end")?.({ success: false }, { senderId: NUMBER, trigger: "user" });
    expect(dispatch("wamid.B")).toBeUndefined();
  });
});
