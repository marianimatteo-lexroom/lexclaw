import { describe, expect, it, vi } from "vitest";
import { runDraft, runResearch } from "./lexroom-client.js";

const config = { accessToken: "test-token", baseUrl: "https://api.lexroom.ai" };

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function requestBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("expected a JSON string body");
  }
  return body;
}

function streamResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("runResearch", () => {
  it("scopes the private library to the named documents and reads the stream", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/ask_me_anything")) {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("X-Client-Type")).toBe("app_lex");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
        expect(JSON.parse(requestBody(init?.body))).toEqual({
          query: "Onere della prova",
          search_on_user_data: true,
          library_documents: [{ document_ids: ["doc-verdi"] }],
          search_on_modules: ["Lavoro"],
        });
        return streamResponse([
          `${JSON.stringify({
            research: { id: "res-1", status: "RUNNING", answer: { text: "partial" } },
          })}\n`,
          JSON.stringify({
            research: {
              id: "res-1",
              status: "DONE",
              answer: { text: "La prova grava sul datore." },
            },
          }),
        ]);
      }
      expect(url).toBe("https://api.lexroom.ai/v1/cited_public_sources/res-1");
      return jsonResponse({ cited_sources: [{ title: "Cass. civ. 12345/2024" }, { title: " " }] });
    });

    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Onere della prova",
      libraryDocumentIds: ["doc-verdi"],
      modules: ["Lavoro"],
      fetchImpl,
    });

    expect(result).toEqual({
      ok: true,
      matterId: "verdi",
      researchId: "res-1",
      status: "DONE",
      answer: "La prova grava sul datore.",
      sources: [{ title: "Cass. civ. 12345/2024" }],
    });
  });

  it("does not search the private library when no document ids are passed", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/cited_public_sources/res-2")) {
        return jsonResponse({ cited_sources: [] });
      }
      expect(JSON.parse(requestBody(init?.body))).toEqual({
        query: "Termini",
        search_on_user_data: false,
      });
      return streamResponse([
        `${JSON.stringify({
          research: { id: "res-2", status: "DONE", answer: { text: "Answer" } },
        })}\n`,
      ]);
    });

    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Termini",
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: true, sources: [] });
  });

  it("names an MFA challenge without calling the stream reader", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "mfa_step_up_required" }, 403));
    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Termini",
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      error:
        "Lexroom requires a verified sign-in. Complete MFA, then refresh the Vera access token.",
    });
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

  it("selects modules and then drafts after confirmation", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      calls.push(url);
      if (url.endsWith("/v2/ai/drafting/selectors")) {
        expect(JSON.parse(requestBody(init?.body))).toEqual({ prompt: "Atto di citazione" });
        return jsonResponse({ modules: [{ name: "Civile" }] });
      }
      expect(JSON.parse(requestBody(init?.body))).toEqual({
        prompt: "Atto di citazione",
        modules: ["Civile"],
      });
      return streamResponse([
        `${JSON.stringify({
          research: {
            id: "draft-1",
            status: "DONE",
            draft: { title: "Atto di citazione", content: "Premesso che" },
          },
        })}\n`,
      ]);
    });

    const result = await runDraft({
      config,
      matterId: "bianchi",
      prompt: "Atto di citazione",
      confirmed: true,
      fetchImpl,
    });
    expect(calls.map((url) => url.replace("https://api.lexroom.ai", ""))).toEqual([
      "/v2/ai/drafting/selectors",
      "/v2/ai/drafting",
    ]);
    expect(result).toEqual({
      ok: true,
      drafted: true,
      matterId: "bianchi",
      researchId: "draft-1",
      status: "DONE",
      title: "Atto di citazione",
      content: "Premesso che",
    });
  });
});
