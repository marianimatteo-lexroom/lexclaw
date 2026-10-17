import { describe, expect, it, vi } from "vitest";
import { sendKapsoPdf } from "./kapso-document.js";

const config = {
  channels: {
    "kapso-whatsapp": {
      apiKey: "kapso_test_key",
      phoneNumberId: "100000000000000",
      baseUrl: "https://api.kapso.ai/meta/whatsapp/",
    },
  },
};
const isMediaUpload = (url: Parameters<typeof fetch>[0]) =>
  typeof url === "string" && url.endsWith("/media");
const jsonBody = (init: RequestInit | undefined) =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null");
const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const send = (
  fetchImpl: typeof fetch,
  overrides: Partial<Parameters<typeof sendKapsoPdf>[0]> = {},
) =>
  sendKapsoPdf({
    config,
    to: "+39 000 000 0001",
    filename: "lexroom-ricerca-x-2026-10-17.pdf",
    bytes,
    env: {},
    fetchImpl,
    ...overrides,
  });

const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

describe("sendKapsoPdf", () => {
  it("uploads the PDF to the media endpoint, then sends a document message with its id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      isMediaUpload(url)
        ? json(200, { id: "media-1" })
        : json(200, { messages: [{ id: "wamid.1" }] }),
    );
    expect(await send(fetchImpl)).toEqual({ ok: true, messageId: "wamid.1" });

    const [upload, message] = fetchImpl.mock.calls;
    expect(upload?.[0]).toBe("https://api.kapso.ai/meta/whatsapp/v23.0/100000000000000/media");
    const form = upload?.[1]?.body;
    expect(form).toBeInstanceOf(FormData);
    expect((form as FormData).get("messaging_product")).toBe("whatsapp");
    const file = (form as FormData).get("file") as File;
    expect(file.name).toBe("lexroom-ricerca-x-2026-10-17.pdf");
    expect(file.type).toBe("application/pdf");
    expect(upload?.[1]?.headers).toEqual({ "X-API-Key": "kapso_test_key" });

    expect(message?.[0]).toBe("https://api.kapso.ai/meta/whatsapp/v23.0/100000000000000/messages");
    expect(jsonBody(message?.[1])).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "390000000001",
      type: "document",
      document: { id: "media-1", filename: "lexroom-ricerca-x-2026-10-17.pdf" },
    });
  });

  it("stops after a failed upload and never sends a message", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(400, { error: "bad" }));
    expect(await send(fetchImpl)).toEqual({
      ok: false,
      error: "kapso document upload returned HTTP 400",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports an upload that returns no media id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json(200, {}));
    expect(await send(fetchImpl)).toEqual({
      ok: false,
      error: "kapso document upload returned no media id",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected message and a network failure without leaking the key", async () => {
    const rejected = vi.fn<typeof fetch>(async (url) =>
      isMediaUpload(url) ? json(200, { id: "media-1" }) : json(500),
    );
    expect(await send(rejected)).toEqual({
      ok: false,
      error: "kapso document send returned HTTP 500",
    });
    const down = vi.fn<typeof fetch>(async () => {
      throw new Error("connect failed kapso_test_key");
    });
    const failed = await send(down);
    expect(failed).toEqual({ ok: false, error: "kapso document upload request failed" });
  });

  it("refuses without credentials or with a bad recipient, before any request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await send(fetchImpl, { config: {} })).toEqual({
      ok: false,
      error: "kapso credentials are missing",
    });
    expect(await send(fetchImpl, { to: "not-a-number" })).toEqual({
      ok: false,
      error: "kapso document recipient is invalid",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
