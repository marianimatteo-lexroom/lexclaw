import { describe, expect, it, vi } from "vitest";
import {
  invalidateLexroomAccessCache,
  probeLexroomAccess,
  runDraft,
  runResearch,
} from "./lexroom-client.js";

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
        expect(new Headers(init?.headers).get("X-Request-ID")).toMatch(/^[0-9a-f-]{36}$/u);
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
        expect(JSON.parse(requestBody(init?.body))).toEqual({
          query: "Onere della prova",
          documents: [],
          is_temporary: false,
          search_on_user_data: true,
          library_documents: [{ document_ids: ["doc-verdi"] }],
          search_on_modules: ["Lavoro"],
        });
        return streamResponse([
          `${JSON.stringify({
            research: { id: "res-1", status: "RUNNING", answer: { text: "partial" } },
          })}\n`,
          JSON.stringify({
            id: "res-1",
            status: "DONE",
            answer: "La prova grava sul datore.</END> [1]",
          }),
        ]);
      }
      expect(url).toBe("https://api.lexroom.ai/v1/ask_me_anything/res-1");
      expect(init?.method).toBe("GET");
      return jsonResponse({
        research: {
          id: "res-1",
          status: "DONE",
          answer: { text: "La prova grava sul datore. [1]" },
          documents: [
            {
              files: [
                { citation_id: 1, title: "Cass. civ. 12345/2024", section_title: " " },
                { title: " " },
              ],
            },
          ],
        },
      });
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
      answer: "La prova grava sul datore. [Cass. civ. 12345/2024]",
      sources: [{ title: "Cass. civ. 12345/2024" }],
    });
  });

  it("does not search the private library when no document ids are passed", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/ask_me_anything/res-2")) {
        return new Response(null, { status: 204 });
      }
      expect(JSON.parse(requestBody(init?.body))).toEqual({
        query: "Termini",
        documents: [],
        is_temporary: false,
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
      reason: "not_connected",
      error:
        "Lexroom requires a verified sign-in. Complete MFA, then refresh the Vera access token.",
    });
  });

  it("maps a rejected access token to not_connected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "invalid token" }, 401));
    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Termini",
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      reason: "not_connected",
      error: "Lexroom rejected the access token. Sign in again and update Vera's access token.",
    });
  });

  it("keeps the stream answer when the stored AMA research only has sources", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.endsWith("/v1/ask_me_anything/res-2")) {
        return jsonResponse({
          research: {
            id: "res-2",
            status: "DONE",
            answer: "",
            documents: [{ title: "Codice civile", section_title: "art. 1218" }],
          },
        });
      }
      return streamResponse([
        `${JSON.stringify({
          research: { id: "res-2", status: "DONE", answer: { text: "Risposta</END>" } },
        })}\n`,
      ]);
    });

    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Termini",
      fetchImpl,
    });
    expect(result).toMatchObject({
      ok: true,
      answer: "Risposta",
      sources: [{ title: "Codice civile / art. 1218" }],
    });
  });

  it("surfaces a stream error from LEXROOM_AMA", async () => {
    const fetchImpl = vi.fn(async () =>
      streamResponse([`${JSON.stringify({ error: "quota exceeded" })}\n`]),
    );
    const result = await runResearch({
      config,
      matterId: "verdi",
      query: "Termini",
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: "quota exceeded" });
  });
});

describe("probeLexroomAccess", () => {
  it("caches a rejected probe and skips the cache for an unknown status", async () => {
    const token = "rejected-probe-token";
    invalidateLexroomAccessCache(token);
    const now = Date.parse("2026-10-10T12:00:00.000Z");
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "no" }, 401));
    await expect(
      probeLexroomAccess({
        accessToken: token,
        baseUrl: "https://api.lexroom.ai",
        nowMs: now,
        fetchImpl,
      }),
    ).resolves.toBe("rejected");
    await expect(
      probeLexroomAccess({
        accessToken: token,
        baseUrl: "https://api.lexroom.ai",
        nowMs: now + 30_000,
        fetchImpl,
      }),
    ).resolves.toBe("rejected");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const unknown = "unknown-probe-token";
    invalidateLexroomAccessCache(unknown);
    const unknownFetch = vi.fn(async () => jsonResponse({}, 500));
    await probeLexroomAccess({
      accessToken: unknown,
      baseUrl: "https://api.lexroom.ai",
      nowMs: now,
      fetchImpl: unknownFetch,
    });
    await probeLexroomAccess({
      accessToken: unknown,
      baseUrl: "https://api.lexroom.ai",
      nowMs: now + 1_000,
      fetchImpl: unknownFetch,
    });
    expect(unknownFetch).toHaveBeenCalledTimes(2);
    invalidateLexroomAccessCache(token);
    invalidateLexroomAccessCache(unknown);
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
        expect(JSON.parse(requestBody(init?.body))).toEqual({
          prompt: "Atto di citazione",
          template: null,
        });
        return jsonResponse({ modules: [{ name: "Civile" }] });
      }
      expect(JSON.parse(requestBody(init?.body))).toEqual({
        prompt: "Atto di citazione",
        documents: [],
        template: null,
        modules: ["Civile"],
      });
      return streamResponse([
        `${JSON.stringify({
          research: {
            id: "draft-1",
            status: "DONE",
            draft: {
              title: "Atto di citazione",
              content: "Bozza",
              edited_content: "Premesso che",
            },
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

  it("maps a rejected access token to not_connected", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: "forbidden" }, 403));
    const result = await runDraft({
      config,
      matterId: "bianchi",
      prompt: "Atto di citazione",
      confirmed: true,
      modules: ["Civile"],
      fetchImpl,
    });
    expect(result).toEqual({
      ok: false,
      reason: "not_connected",
      error: "Lexroom returned 403: forbidden",
    });
  });
});
