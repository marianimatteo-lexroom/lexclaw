import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatSource } from "./lexroom-citations.js";
import { runDraft, runResearch } from "./lexroom-client.js";
import { FALLBACK_MODULES } from "./lexroom-modules.js";

const config = { accessToken: "test-token", baseUrl: "https://api.lexroom.ai" };

function fixture(name: string): string {
  return readFileSync(new URL(`./test-fixtures/${name}`, import.meta.url), "utf8");
}

const askStream = fixture("lexroom-ask.ndjson");
const draftStream = fixture("lexroom-draft.ndjson");
const storedDraft = fixture("lexroom-draft-get.json");

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function requestBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== "string") {
    throw new Error("expected a JSON string body");
  }
  return JSON.parse(body) as unknown;
}

/** Splits mid-line and mid-character the way a real socket does. */
function streamResponse(text: string, chunkBytes = 977): Response {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
        controller.enqueue(bytes.subarray(offset, offset + chunkBytes));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function line(research: Record<string, unknown>): string {
  return `${JSON.stringify({ research })}\n`;
}

const USER_MODULES = ["Civile", "Lavoro", "Societario"];

/** Serves the user's modules, and hands every other request to the test. */
function lexroomFetch(
  ask: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
  modules: unknown = USER_MODULES,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    requestUrl(input).endsWith("/v1/user/modules") ? jsonResponse(modules) : ask(input, init),
  );
}

function askCall(fetchImpl: ReturnType<typeof lexroomFetch>) {
  const call = fetchImpl.mock.calls.find(([input]) =>
    requestUrl(input).endsWith("/v1/ask_me_anything"),
  );
  if (!call) {
    throw new Error("no research request was sent");
  }
  return call;
}

describe("runResearch", () => {
  it("sends the same requests as lexroom-bot: user modules, then the ask with its exact body and headers", async () => {
    const fetchImpl = lexroomFetch(() => streamResponse(askStream));
    await runResearch({
      config: { ...config, accessToken: "shape-token" },
      matterId: "verdi",
      query: "Termine per proporre opposizione a decreto ingiuntivo, è già scaduto?",
      parentResearchId: "parent-1",
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [modulesUrl, modulesInit] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl(modulesUrl as RequestInfo)).toBe("https://api.lexroom.ai/v1/user/modules");
    expect(modulesInit?.method).toBe("GET");
    expect(Object.fromEntries(new Headers(modulesInit?.headers))).toEqual({
      authorization: "Bearer shape-token",
      "x-client-type": "app_lex",
    });
    const [url, init] = askCall(fetchImpl);
    expect(requestUrl(url as RequestInfo)).toBe("https://api.lexroom.ai/v1/ask_me_anything");
    expect(init?.method).toBe("POST");
    expect(Object.fromEntries(new Headers(init?.headers))).toEqual({
      authorization: "Bearer shape-token",
      "content-type": "application/json",
      "x-client-type": "app_lex",
    });
    expect([...String(init?.body)].every((char) => char.charCodeAt(0) < 128)).toBe(true);
    expect(requestBody(init?.body)).toEqual({
      query: "Termine per proporre opposizione a decreto ingiuntivo, è già scaduto?",
      search_on_user_data: false,
      search_on_modules: USER_MODULES,
      parent_research_id: "parent-1",
    });
  });

  it("escapes non-ASCII characters in the body so the backend never sees UTF-8", async () => {
    const fetchImpl = lexroomFetch(() =>
      streamResponse(line({ id: "r", status: "DONE", answer: "ok" })),
    );
    await runResearch({
      config: { ...config, accessToken: "ascii-token" },
      matterId: "m",
      query: "Può l'erede rinunciare? €100",
      fetchImpl,
    });
    expect(askCall(fetchImpl)[1]?.body).toContain("Pu\\u00f2 l'erede rinunciare? \\u20ac100");
  });

  it("reads the last cumulative snapshot and keeps citation numbers", async () => {
    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Termine opposizione",
      fetchImpl: async () => streamResponse(askStream),
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result).toMatchObject({ researchId: "80878173f52500b2", status: "DONE" });
    expect(result.answer).toMatch(/^\*In sintesi\*\nIl termine ordinario .* \*\*?40 giorni/u);
    expect(result.answer).toContain("*1. La norma*");
    expect(result.answer).not.toMatch(/\*\*|^#|\|---/mu);
    expect(result.answer).toContain("Italia | 40 giorni | *24/11/2026* (martedì)");
    expect(result.answer).toContain("[1]");
    expect(result.answer).not.toContain("</END>");
    expect(result.sources.map((source) => source.id)).toEqual(
      Array.from({ length: 28 }, (_, index) => index + 1),
    );
  });

  it("maps statutes and decisions to compact numbered sources without judge names", async () => {
    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Termine opposizione",
      fetchImpl: async () => streamResponse(askStream),
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    const lines = new Map(result.sources.map((source) => [source.id, formatSource(source)]));
    expect(lines.get(1)).toBe("[1] Codice di procedura civile, art. 641");
    expect(lines.get(21)).toBe("[21] Codice di procedura civile, art. 650");
    expect(lines.get(5)).toBe(
      "[5] Sentenza n. 610/2026 - Tribunale di Perugia - Sezione Seconda, 09/04/2026",
    );
    expect(lines.get(11)).toBe(
      "[11] Tribunale di Teramo, Sentenza n.668 del 19 dicembre 2023, 19/12/2023",
    );
    expect(lines.get(2)).toMatch(/Suprema Corte di Cassazione, \d{2}\/\d{2}\/\d{4}$/u);
    expect(JSON.stringify(result.sources)).not.toContain("MATALUCCI");
  });

  describe("researchUrl", () => {
    const run = (extra: { baseUrl?: string; parentResearchId?: string }) =>
      runResearch({
        config: { accessToken: "link-token", baseUrl: extra.baseUrl ?? "https://api.lexroom.ai" },
        matterId: "m",
        query: "Q",
        parentResearchId: extra.parentResearchId,
        fetchImpl: lexroomFetch(() =>
          streamResponse(line({ id: "res-77", status: "DONE", answer: "ok" })),
        ),
      });

    it("points at the research in the Lexroom web app", async () => {
      expect(await run({})).toMatchObject({
        researchId: "res-77",
        researchUrl: "https://app.lexroom.ai/research/res-77",
      });
    });

    it("points a follow-up at the page of the thread's first research", async () => {
      expect(await run({ parentResearchId: "thread-root" })).toMatchObject({
        researchId: "res-77",
        researchUrl: "https://app.lexroom.ai/research/thread-root",
      });
    });

    it("is logged on research.done as present or absent, never as the id", async () => {
      for (const [baseUrl, expected] of [
        ["https://api.lexroom.ai/", "present"],
        ["https://lexroom.example", "absent"],
      ] as const) {
        const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> =
          [];
        await runResearch({
          config: { accessToken: `log-url-${expected}`, baseUrl },
          matterId: "m",
          query: "Q",
          fetchImpl: lexroomFetch(() =>
            streamResponse(line({ id: "res-secret-id", status: "DONE", answer: "ok" })),
          ),
          log: (event, fields) => events.push({ event, fields }),
        });
        const done = events.find((entry) => entry.event === "research.done");
        expect(done?.fields.researchUrl).toBe(expected);
        expect(JSON.stringify(events)).not.toContain("res-secret-id");
      }
    });

    it("is left out for a non-production API", async () => {
      expect(await run({ baseUrl: "https://lexroom.example" })).not.toHaveProperty("researchUrl");
    });
  });

  it("lists only the sources the answer cites", async () => {
    const documents = [
      {
        type_id: 3,
        files: [
          {
            citation_id: 1,
            title: "Cass. 1/2024",
            author: "Suprema Corte di Cassazione",
            time: "01/02/2024",
          },
          {
            citation_id: 2,
            title: "Cass. 2/2024",
            author: "Suprema Corte di Cassazione",
            time: "02/02/2024",
          },
        ],
      },
    ];
    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Q",
      fetchImpl: async () =>
        streamResponse(
          line({ id: "r", status: "DONE", answer: { text: "Vale [2] e [9]." }, documents }),
        ),
    });
    expect(result).toMatchObject({
      ok: true,
      answer: "Vale [2] e [9].",
      sources: [
        { id: 2, title: "Cass. 2/2024", court: "Suprema Corte di Cassazione", date: "02/02/2024" },
      ],
    });
  });

  describe("modules", () => {
    const searched = async (
      options: { modules?: string[]; researchModules?: string[]; token: string },
      available: unknown = USER_MODULES,
    ) => {
      const fetchImpl = lexroomFetch(
        () => streamResponse(line({ id: "r", status: "DONE", answer: { text: "ok" } })),
        available,
      );
      await runResearch({
        config: {
          ...config,
          accessToken: options.token,
          researchModules: options.researchModules,
        },
        matterId: "m",
        query: "Q",
        modules: options.modules,
        fetchImpl,
      });
      return (requestBody(askCall(fetchImpl)[1]?.body) as { search_on_modules: string[] })
        .search_on_modules;
    };

    it("searches every module the user may search when none is named", async () => {
      expect(await searched({ token: "m1" })).toEqual(USER_MODULES);
    });

    it("narrows to the call's modules, then the configured ones, within the user's modules", async () => {
      expect(await searched({ token: "m2", researchModules: ["Societario"] })).toEqual([
        "Societario",
      ]);
      expect(
        await searched({
          token: "m3",
          researchModules: ["Societario"],
          modules: [" Lavoro ", "Lavoro", ""],
        }),
      ).toEqual(["Lavoro"]);
    });

    it("ignores requested modules the user may not search, and falls back to all of theirs", async () => {
      expect(await searched({ token: "m4", modules: ["Penale", "Lavoro"] })).toEqual(["Lavoro"]);
      expect(await searched({ token: "m5", modules: ["Penale"] })).toEqual(USER_MODULES);
    });

    it("reads the module names from the response shapes lexroom-bot accepts", async () => {
      expect(
        await searched(
          { token: "m6" },
          { modules: [{ name: "Tributario" }, { slug: "IP" }, " Banking "] },
        ),
      ).toEqual(["Tributario", "IP", "Banking"]);
    });

    it("falls back to the full catalog when the modules call fails or is empty", async () => {
      const failing = vi.fn(async (input: RequestInfo | URL) =>
        requestUrl(input).endsWith("/v1/user/modules")
          ? jsonResponse({ detail: "boom" }, 500)
          : streamResponse(line({ id: "r", status: "DONE", answer: "ok" })),
      );
      await runResearch({
        config: { ...config, accessToken: "m7" },
        matterId: "m",
        query: "Q",
        fetchImpl: failing,
      });
      expect(requestBody(askCall(failing)[1]?.body)).toMatchObject({
        search_on_modules: [...FALLBACK_MODULES],
      });
      expect(await searched({ token: "m8" }, [])).toEqual([...FALLBACK_MODULES]);
    });

    it("looks the modules up once per token, and again after a 401", async () => {
      let rejected = false;
      const fetchImpl = lexroomFetch(() =>
        rejected
          ? jsonResponse({ detail: "expired" }, 401)
          : streamResponse(line({ id: "r", status: "DONE", answer: "ok" })),
      );
      const run = () =>
        runResearch({
          config: { ...config, accessToken: "m9" },
          matterId: "m",
          query: "Q",
          fetchImpl,
        });
      const lookups = () =>
        fetchImpl.mock.calls.filter(([input]) => requestUrl(input).endsWith("/v1/user/modules"))
          .length;
      await run();
      await run();
      expect(lookups()).toBe(1);
      rejected = true;
      expect(await run()).toMatchObject({ ok: false, reason: "not_connected" });
      rejected = false;
      await run();
      expect(lookups()).toBe(2);
    });
  });

  it("scopes the private library to the named documents", async () => {
    const fetchImpl = lexroomFetch(() =>
      streamResponse(line({ id: "r", status: "DONE", answer: { text: "ok" } })),
    );
    await runResearch({
      config,
      matterId: "verdi",
      query: "Onere della prova",
      libraryDocumentIds: ["doc-verdi", " "],
      fetchImpl,
    });
    expect(requestBody(askCall(fetchImpl)[1]?.body)).toMatchObject({
      search_on_user_data: true,
      library_documents: [{ document_ids: ["doc-verdi"] }],
    });
  });

  it("stops at DONE and ignores trailing noise", async () => {
    const result = await runResearch({
      config,
      matterId: "m",
      query: "Q",
      fetchImpl: async () =>
        streamResponse(
          `${line({ id: "r", status: "RUNNING" })}\n${line({ id: "r", status: "DONE", answer: "Fatto" })}{"research":`,
        ),
    });
    expect(result).toMatchObject({ ok: true, answer: "Fatto" });
  });

  describe("response parsing, as in lexroom-bot", () => {
    const research = (body: string) =>
      runResearch({
        config: { ...config, accessToken: "parse-token" },
        matterId: "m",
        query: "Q",
        fetchImpl: lexroomFetch(() => streamResponse(body)),
      });

    it("reads snapshots with no `research` envelope", async () => {
      const flat = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;
      const result = await research(
        flat({ id: "r1", status: "LOADING", answer: { text: "Parziale" } }) +
          flat({ id: "r1", status: "DONE", answer: { text: "Completa [1]" } }),
      );
      expect(result).toMatchObject({ ok: true, researchId: "r1", answer: "Completa [1]" });
    });

    it("skips lines without an id", async () => {
      const result = await research(
        `${JSON.stringify({ research: { status: "DONE", answer: "senza id" } })}\n` +
          line({ id: "r", status: "DONE", answer: "con id" }),
      );
      expect(result).toMatchObject({ ok: true, researchId: "r", answer: "con id" });
    });

    it("keeps the last answer when the terminal event repeats the id without a body", async () => {
      const documents = [{ type_id: 3, files: [{ citation_id: 1, title: "Cass. 1/2024" }] }];
      const result = await research(
        line({ id: "r", status: "LOADING", answer: { text: "Risposta [1]" }, documents }) +
          line({ id: "r", status: "DONE" }),
      );
      expect(result).toMatchObject({
        ok: true,
        answer: "Risposta [1]",
        sources: [{ id: 1, title: "Cass. 1/2024" }],
      });
    });

    it("falls back to the html when the text is empty, and strips </END>", async () => {
      const result = await research(
        line({
          id: "r",
          status: "DONE",
          answer: { text: "", html: "<p>Primo&nbsp;punto</p><p>Secondo &amp; ultimo</p></END>" },
        }),
      );
      expect(result).toMatchObject({ ok: true, answer: "Primo punto\nSecondo & ultimo" });
      const ended = await research(
        line({ id: "r", status: "DONE", answer: { text: "Fine</END>\n" } }),
      );
      expect(ended).toMatchObject({ ok: true, answer: "Fine" });
    });

    it("returns the last snapshot when the stream ends before DONE but an answer arrived", async () => {
      const result = await research(
        line({ id: "r", status: "LOADING", answer: { text: "Risposta parziale" } }),
      );
      expect(result).toMatchObject({
        ok: true,
        researchId: "r",
        status: "LOADING",
        answer: "Risposta parziale",
      });
    });
  });

  it.each([
    ["a FAILED snapshot", line({ id: "r", status: "FAILED" }), "Lexroom could not complete"],
    ["a stream cut before DONE", line({ id: "r", status: "RUNNING" }), "ended before DONE"],
    ["an empty stream", "", "empty research stream"],
    ["a stream error", `${JSON.stringify({ error: "quota exceeded" })}\n`, "quota exceeded"],
    ["an error inside the snapshot", line({ id: "r", status: "RUNNING", error: "boom" }), "boom"],
  ])("fails on %s", async (_label, body, error) => {
    const result = await runResearch({
      config,
      matterId: "m",
      query: "Q",
      fetchImpl: async () => streamResponse(body),
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? "" : result.error).toContain(error);
  });

  it("names an MFA challenge", async () => {
    const result = await runResearch({
      config,
      matterId: "m",
      query: "Q",
      fetchImpl: async () => jsonResponse({ detail: "mfa_step_up_required" }, 403),
    });
    expect(result).toEqual({
      ok: false,
      error:
        "Lexroom requires a verified sign-in. Complete MFA, then refresh the Ada access token.",
    });
  });

  it("asks for a new sign-in when Lexroom answers 401", async () => {
    const result = await runResearch({
      config,
      matterId: "m",
      query: "Q",
      fetchImpl: async () => jsonResponse({ detail: "expired" }, 401),
    });
    expect(result).toMatchObject({ ok: false, reason: "not_connected" });
  });

  describe("a 403 from Lexroom", () => {
    const MODULES_DENIED = "User not authorized to search on the specified modules";
    const run = (detail: string, modules?: string[]) => {
      const fetchImpl = lexroomFetch(() => jsonResponse({ detail }, 403));
      return {
        fetchImpl,
        result: runResearch({ config, matterId: "m", query: "Q", modules, fetchImpl }),
      };
    };

    it("is a permission answer: one request, no reconnect reason", async () => {
      const { fetchImpl, result } = run(MODULES_DENIED);
      expect(await result).not.toHaveProperty("reason");
      expect(
        fetchImpl.mock.calls.filter(([input]) => requestUrl(input).endsWith("/v1/ask_me_anything")),
      ).toHaveLength(1);
    });

    it("names the unauthorized modules and Lexroom's detail, and keeps the sign-in", async () => {
      const result = await run(MODULES_DENIED, ["Civile"]).result;
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("moduli richiesti (Civile)"),
      });
      expect(result).toMatchObject({ error: expect.stringContaining(`"${MODULES_DENIED}"`) });
      expect(result).toMatchObject({ error: expect.stringContaining("non serve ricollegare") });
    });

    it.each([
      ["Not enough credits", "crediti o piano non sufficienti"],
      ["You do not have permission to perform this action.", "non ha i permessi"],
      ["", "non ha i permessi"],
    ])("explains %j in Italian without asking to reconnect", async (detail, expected) => {
      const result = await run(detail).result;
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(expected) });
      expect(result).toMatchObject({ error: expect.stringContaining("non serve ricollegare") });
      expect(result).not.toHaveProperty("reason");
    });
  });

  it("reports cancellation plainly", async () => {
    const controller = new AbortController();
    controller.abort();
    const cancelled = await runResearch({
      config,
      matterId: "m",
      query: "Q",
      signal: controller.signal,
      fetchImpl: async (_input, init) => {
        init?.signal?.throwIfAborted();
        return streamResponse("");
      },
    });
    expect(cancelled).toEqual({ ok: false, error: "The Lexroom request was cancelled." });
  });

  it("never echoes the token in a failure and refuses cleartext base URLs", async () => {
    const leaked = await runResearch({
      config,
      matterId: "m",
      query: "Q",
      fetchImpl: async () => {
        throw new Error("socket closed for Bearer test-token");
      },
    });
    expect(JSON.stringify(leaked)).not.toContain("test-token");

    const fetchImpl = vi.fn();
    const insecure = await runResearch({
      config: { ...config, baseUrl: "http://api.lexroom.ai" },
      matterId: "m",
      query: "Q",
      fetchImpl,
    });
    expect(insecure).toMatchObject({ ok: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("runDraft", () => {
  it("does not call Lexroom until the lawyer has confirmed", async () => {
    const fetchImpl = vi.fn();
    const result = await runDraft({
      config,
      matterId: "bianchi",
      prompt: "Reply to opposing counsel",
      confirmed: false,
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      drafted: false,
      reason: "confirmation_required",
      matterId: "bianchi",
    });
  });

  it("selects active modules, drafts from the stream, and maps its citations", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      calls.push(url.replace("https://api.lexroom.ai", ""));
      if (url.endsWith("/v2/ai/drafting/selectors")) {
        expect(requestBody(init?.body)).toEqual({ prompt: "Diffida ad adempiere", template: null });
        return jsonResponse({
          modules: [
            { name: "Civile", is_active: true },
            { name: "Penale", is_active: false },
            { name: "Societario", is_active: true },
          ],
        });
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
      expect(requestBody(init?.body)).toEqual({
        prompt: "Diffida ad adempiere",
        template: null,
        modules: ["Civile", "Societario"],
        documents: [],
      });
      return streamResponse(draftStream);
    });

    const result = await runDraft({
      config,
      matterId: "bianchi",
      prompt: "Diffida ad adempiere",
      confirmed: true,
      fetchImpl,
    });
    expect(calls).toEqual(["/v2/ai/drafting/selectors", "/v2/ai/drafting"]);
    if (!result.ok || !result.drafted) {
      throw new Error("expected a draft");
    }
    expect(result).toMatchObject({
      researchId: "21b2c101e6f9f98a",
      status: "DONE",
      title: "Diffida ad adempiere ex art. 1454 c.c.",
    });
    expect(result.content).toContain("PEC: [●]");
    expect(result.content).toContain("**PREMESSO CHE**");
    expect(result.analysis).toMatch(/^Documento breve di diffida .* \[1\]\[2\]\./u);
    expect(result.sources.map(formatSource)).toEqual([
      "[1] Codice civile, art. 1454",
      "[2] Sez. Seconda Civile, Ordinanza n. 32821 del 27/11/2023 - Suprema Corte di Cassazione, 27/11/2023",
    ]);
  });

  it("falls back to configured modules, then the user's modules, when selection picks none", async () => {
    const bodies: unknown[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (requestUrl(input).endsWith("/selectors")) {
        return jsonResponse({ modules: [{ name: "Penale", is_active: false }] });
      }
      bodies.push(requestBody(init?.body));
      return streamResponse(draftStream);
    };
    await runDraft({
      config: { ...config, researchModules: ["Lavoro"] },
      matterId: "m",
      prompt: "P",
      confirmed: true,
      fetchImpl,
    });
    expect(bodies[0]).toMatchObject({ modules: ["Lavoro"] });
    const own = lexroomFetch(
      (input, init) => {
        if (requestUrl(input).endsWith("/selectors")) {
          return jsonResponse({ modules: [] });
        }
        bodies.push(requestBody(init?.body));
        return streamResponse(draftStream);
      },
      ["Tributario"],
    );
    await runDraft({
      config: { ...config, accessToken: "draft-own" },
      matterId: "m",
      prompt: "P",
      confirmed: true,
      fetchImpl: own,
    });
    expect(bodies[1]).toMatchObject({ modules: ["Tributario"] });
  });

  it("loads the stored draft when the stream ends without one", async () => {
    const withoutDraft = draftStream
      .split("\n")
      .filter((text) => text.trim())
      .map((text) => JSON.parse(text) as { research: Record<string, unknown> })
      .map(({ research }) => Object.assign(research, { draft: null }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/v2/ai/drafting")) {
        return streamResponse(withoutDraft.map((research) => line(research)).join(""));
      }
      expect(url).toBe("https://api.lexroom.ai/v2/craft/drafting/21b2c101e6f9f98a");
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
      return new Response(storedDraft, { status: 200 });
    });
    const result = await runDraft({
      config,
      matterId: "m",
      prompt: "P",
      confirmed: true,
      modules: ["Civile"],
      fetchImpl,
    });
    expect(result).toMatchObject({
      ok: true,
      drafted: true,
      title: "Diffida ad adempiere ex art. 1454 c.c.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails rather than returning an empty draft", async () => {
    const result = await runDraft({
      config,
      matterId: "m",
      prompt: "P",
      confirmed: true,
      modules: ["Civile"],
      fetchImpl: async (input) =>
        requestUrl(input).includes("/v2/craft/")
          ? jsonResponse({ id: "d", status: "DONE", draft: null })
          : streamResponse(line({ id: "d", status: "DONE", draft: null })),
    });
    expect(result).toEqual({ ok: false, error: "Lexroom finished without producing a draft." });
  });
});

describe("timeouts, retries and logging", () => {
  const LIMIT = 1000;
  const timedOut = (limit: string) => {
    const message = `Lexroom did not respond within ${limit}; the request was abandoned.`;
    return { ok: false, reason: "timeout", message, error: message };
  };
  const never = () =>
    new Promise<Response>(() => {
      // Never settles.
    });
  const withToken = (accessToken: string) => ({
    accessToken,
    baseUrl: "https://api.lexroom.ai",
    idleTimeoutMs: LIMIT,
    timeoutMs: 5000,
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("times out a research endpoint that never responds, aborts it and leaves no timer", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = lexroomFetch((_input, init) => {
      signals.push(init?.signal as AbortSignal);
      return never();
    });
    const pending = runResearch({
      config: withToken("t-hang"),
      matterId: "m",
      query: "Q",
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(LIMIT);
    await expect(pending).resolves.toEqual(timedOut("1s"));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a research stream that goes silent after headers", async () => {
    const fetchImpl = lexroomFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull: () =>
              new Promise<void>(() => {
                // Never settles.
              }),
          }),
          {
            status: 200,
          },
        ),
    );
    const pending = runResearch({
      config: withToken("t-silent"),
      matterId: "m",
      query: "Q",
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(LIMIT);
    await expect(pending).resolves.toEqual(timedOut("1s"));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("answers with a timeout, not the fallback catalog, when the modules call never responds", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => never());
    const pending = runResearch({
      config: withToken("t-modules-hang"),
      matterId: "m",
      query: "Q",
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(LIMIT);
    await expect(pending).resolves.toEqual(timedOut("1s"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes its default limit from ADA_LEXROOM_TIMEOUT_MS, and VERA_LEXROOM_TIMEOUT_MS for compat", async () => {
    for (const name of ["ADA_LEXROOM_TIMEOUT_MS", "VERA_LEXROOM_TIMEOUT_MS"]) {
      vi.stubEnv("ADA_LEXROOM_TIMEOUT_MS", "");
      vi.stubEnv("VERA_LEXROOM_TIMEOUT_MS", "");
      vi.stubEnv(name, "2000");
      const pending = runResearch({
        config: { accessToken: `t-env-${name}`, baseUrl: "https://api.lexroom.ai" },
        matterId: "m",
        query: "Q",
        fetchImpl: lexroomFetch(() => never()),
      });
      await vi.advanceTimersByTimeAsync(1999);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toEqual(timedOut("2s"));
    }
  });

  it("surfaces a 403 at once: one request, no retry, Lexroom's own words in the message", async () => {
    const detail = "You do not have permission to perform this action.";
    const fetchImpl = lexroomFetch(() => jsonResponse({ detail }, 403));
    const result = await runResearch({
      config: withToken("t-403"),
      matterId: "m",
      query: "Q",
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(`"${detail}"`) });
    expect(result).not.toHaveProperty("reason");
    expect(
      fetchImpl.mock.calls.filter(([input]) => requestUrl(input).endsWith("/v1/ask_me_anything")),
    ).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([400, 404, 500, 503])("never retries a %i", async (status) => {
    const fetchImpl = lexroomFetch(() => jsonResponse({ detail: "no" }, status));
    await runResearch({ config: withToken(`t-${status}`), matterId: "m", query: "Q", fetchImpl });
    expect(
      fetchImpl.mock.calls.filter(([input]) => requestUrl(input).endsWith("/v1/ask_me_anything")),
    ).toHaveLength(1);
  });

  it("retries a research POST once when the connection was never made, and not after a drop", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    let calls = 0;
    const flaky = lexroomFetch(() => {
      calls += 1;
      if (calls === 1) {
        throw refused;
      }
      return streamResponse(line({ id: "r", status: "DONE", answer: "ok" }));
    });
    const pending = runResearch({
      config: withToken("t-refused"),
      matterId: "m",
      query: "Q",
      fetchImpl: flaky,
    });
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ ok: true, answer: "ok" });
    expect(calls).toBe(2);

    const dropped = lexroomFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    });
    const second = await runResearch({
      config: withToken("t-reset"),
      matterId: "m",
      query: "Q",
      fetchImpl: dropped,
    });
    expect(second).toMatchObject({ ok: false });
    expect(
      dropped.mock.calls.filter(([input]) => requestUrl(input).endsWith("/v1/ask_me_anything")),
    ).toHaveLength(1);
  });

  it("logs every request with one correlation id, the endpoint and its outcome, and no secret", async () => {
    const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
    const fetchImpl = lexroomFetch(() =>
      streamResponse(line({ id: "r", status: "DONE", answer: "Segreto del cliente Rossi" })),
    );
    await runResearch({
      config: withToken("t-secret-token-0123456789"),
      matterId: "m",
      query: "una domanda riservata sul cliente Rossi",
      fetchImpl,
      log: (event, fields) => events.push({ event, fields }),
    });
    const names = events.map((entry) => entry.event);
    expect(names).toEqual(
      expect.arrayContaining([
        "modules.response",
        "modules.done",
        "research.start",
        "research.response",
        "research.done",
      ]),
    );
    expect(new Set(events.map((entry) => entry.fields.cid)).size).toBe(1);
    expect(events.find((entry) => entry.event === "research.response")?.fields).toMatchObject({
      endpoint: "POST /v1/ask_me_anything",
      status: 200,
      attempt: 1,
      ms: expect.any(Number),
    });
    expect(events.find((entry) => entry.event === "modules.done")?.fields).toMatchObject({
      endpoint: "GET /v1/user/modules",
    });
    const logged = JSON.stringify(events);
    expect(logged).not.toContain("t-secret-token");
    expect(logged).not.toContain("Rossi");
  });

  it("logs a timed-out request as a timeout with its limit", async () => {
    const events: Array<{ event: string; fields: Record<string, string | number | boolean> }> = [];
    const pending = runResearch({
      config: withToken("t-log-timeout"),
      matterId: "m",
      query: "Q",
      fetchImpl: lexroomFetch(() => never()),
      log: (event, fields) => events.push({ event, fields }),
    });
    await vi.advanceTimersByTimeAsync(LIMIT);
    await pending;
    expect(events.at(-1)).toMatchObject({
      event: "research.timeout",
      fields: { kind: "idle", limitMs: LIMIT },
    });
  });
});
