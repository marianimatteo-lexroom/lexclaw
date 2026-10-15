import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { formatSource } from "./lexroom-citations.js";
import { runDraft, runResearch } from "./lexroom-client.js";

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

describe("runResearch", () => {
  it("posts the captured request shape and sends the bearer", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      streamResponse(askStream),
    );
    await runResearch({
      config,
      matterId: "verdi",
      query: "Termine per proporre opposizione a decreto ingiuntivo",
      fetchImpl,
    });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(requestUrl(url as RequestInfo)).toBe("https://api.lexroom.ai/v1/ask_me_anything");
    expect(init?.method).toBe("POST");
    const sent = new Headers(init?.headers);
    expect(sent.get("Authorization")).toBe("Bearer test-token");
    expect(sent.get("Content-Type")).toBe("application/json");
    expect(sent.get("X-Client-Type")).toBeNull();
    expect(sent.get("Accept-Encoding")).toBe("identity");
    expect(requestBody(init?.body)).toEqual({
      query: "Termine per proporre opposizione a decreto ingiuntivo\n",
      search_on_modules: ["Civile"],
      documents: [],
      is_temporary: false,
      search_on_user_data: false,
    });
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

  it("picks modules from the call, then config, then the Civile default", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen.push((requestBody(init?.body) as { search_on_modules: string[] }).search_on_modules);
      return streamResponse(line({ id: "r", status: "DONE", answer: { text: "ok" } }));
    };
    const base = { matterId: "m", query: "Q", fetchImpl };
    await runResearch({ ...base, config: { ...config, researchModules: ["Societario"] } });
    await runResearch({
      ...base,
      config: { ...config, researchModules: ["Societario"] },
      modules: [" Lavoro ", "Lavoro", ""],
    });
    await runResearch({ ...base, config: { ...config, researchModules: [] } });
    expect(seen).toEqual([["Societario"], ["Lavoro"], ["Civile"]]);
  });

  it("scopes the private library to the named documents", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      streamResponse(line({ id: "r", status: "DONE", answer: { text: "ok" } })),
    );
    await runResearch({
      config,
      matterId: "verdi",
      query: "Onere della prova",
      libraryDocumentIds: ["doc-verdi", " "],
      fetchImpl,
    });
    expect(requestBody(fetchImpl.mock.calls[0]?.[1]?.body)).toMatchObject({
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
        "Lexroom requires a verified sign-in. Complete MFA, then refresh the Vera access token.",
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
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({ detail }, 403),
      );
      return {
        fetchImpl,
        result: runResearch({ config, matterId: "m", query: "Q", modules, fetchImpl }),
      };
    };

    it("is a permission answer: one request, no reconnect reason", async () => {
      const { fetchImpl, result } = run(MODULES_DENIED);
      expect(await result).not.toHaveProperty("reason");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
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

  it("falls back to configured modules when selection picks none", async () => {
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
