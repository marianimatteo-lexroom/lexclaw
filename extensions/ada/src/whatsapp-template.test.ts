import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readBriefReadyTemplate,
  readDigestReadyTemplate,
  sendDigestReadyNotice,
  sendKapsoTemplate,
  warnDigestReadyTemplateUnset,
} from "./whatsapp-template.js";

const config = {
  channels: {
    "kapso-whatsapp": {
      apiKey: "kapso_test_key",
      phoneNumberId: "100000000000000",
      baseUrl: "https://api.kapso.ai/meta/whatsapp/",
      defaultTo: "+390000000000",
    },
  },
};
const template = { name: "ada_digest_ready", language: "en" };

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sendKapsoTemplate", () => {
  it("posts the utility template to the Cloud API through Kapso on 2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { messages: [{ id: "wamid.HBgMMzkwMDAwMDAwMDAwFQIAEhgU" }] }),
    );
    const result = await sendKapsoTemplate({
      config,
      to: "+39 000 000 0000",
      template,
      env: {},
      fetchImpl,
    });

    expect(result).toEqual({ ok: true, messageId: "wamid.HBgMMzkwMDAwMDAwMDAwFQIAEhgU" });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://api.kapso.ai/meta/whatsapp/v23.0/100000000000000/messages");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "kapso_test_key" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      messaging_product: "whatsapp",
      to: "390000000000",
      type: "template",
      template: { name: "ada_digest_ready", language: { code: "en" } },
    });
  });

  it("accepts a 2xx without a parsable body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    expect(
      await sendKapsoTemplate({ config, to: "390000000000", template, env: {}, fetchImpl }),
    ).toEqual({ ok: true });
  });

  it("reports a 4xx rejection by status without leaking the key or the recipient", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(400, { error: { message: "Template name does not exist in en" } }),
    );
    const result = await sendKapsoTemplate({
      config,
      to: "390000000000",
      template,
      env: {},
      fetchImpl,
    });
    expect(result).toEqual({ ok: false, error: "kapso template returned HTTP 400" });
    expect(JSON.stringify(result)).not.toContain("kapso_test_key");
    expect(JSON.stringify(result)).not.toContain("390000000000");
  });

  it("reports a 5xx as an HTTP failure too", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503));
    expect(
      await sendKapsoTemplate({ config, to: "390000000000", template, env: {}, fetchImpl }),
    ).toEqual({ ok: false, error: "kapso template returned HTTP 503" });
  });

  it("times out after ten seconds instead of hanging the pass", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const pending = sendKapsoTemplate({
      config,
      to: "390000000000",
      template,
      env: {},
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ ok: false, error: "kapso template timed out" });
  });

  it("reports a network failure that is not a timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    expect(
      await sendKapsoTemplate({ config, to: "390000000000", template, env: {}, fetchImpl }),
    ).toEqual({ ok: false, error: "kapso template request failed" });
  });

  it("refuses bad input and missing setup without calling Kapso", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200));
    const send = (overrides: Partial<Parameters<typeof sendKapsoTemplate>[0]>) =>
      sendKapsoTemplate({ config, to: "390000000000", template, env: {}, fetchImpl, ...overrides });

    expect(await send({ template: { name: "Not Valid!", language: "en" } })).toEqual({
      ok: false,
      error: "kapso template name is invalid",
    });
    expect(await send({ template: { name: "ada_digest_ready", language: "english" } })).toEqual({
      ok: false,
      error: "kapso template language is invalid",
    });
    expect(await send({ to: "not-a-number" })).toEqual({
      ok: false,
      error: "kapso template recipient is invalid",
    });
    expect(await send({ config: {} })).toEqual({
      ok: false,
      error: "kapso credentials are missing",
    });
    expect(
      await send({
        config: {
          channels: { "kapso-whatsapp": { ...config.channels["kapso-whatsapp"], enabled: false } },
        },
      }),
    ).toEqual({ ok: false, error: "kapso account is disabled" });
    expect(
      await send({
        config: {
          channels: {
            "kapso-whatsapp": { ...config.channels["kapso-whatsapp"], baseUrl: "http://insecure" },
          },
        },
      }),
    ).toEqual({ ok: false, error: "kapso base URL is invalid" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("readDigestReadyTemplate", () => {
  it("needs both a name and a language", () => {
    expect(
      readDigestReadyTemplate({
        digestReadyTemplate: { name: " ada_digest_ready ", language: "it" },
      }),
    ).toEqual({ name: "ada_digest_ready", language: "it" });
    expect(readDigestReadyTemplate({})).toBeNull();
    expect(readDigestReadyTemplate(undefined)).toBeNull();
    expect(
      readDigestReadyTemplate({ digestReadyTemplate: { name: "ada_digest_ready" } }),
    ).toBeNull();
    expect(readDigestReadyTemplate({ digestReadyTemplate: "ada_digest_ready" })).toBeNull();
  });
});

describe("readBriefReadyTemplate", () => {
  const brief = { name: "ada_brief_ready", language: "it", languages: ["it", "en_US"] };

  it("uses the number's language when the template is approved in it, else the default", () => {
    const pluginConfig = { briefReadyTemplate: brief };
    expect(readBriefReadyTemplate(pluginConfig, "English")).toEqual({
      name: "ada_brief_ready",
      language: "en_US",
    });
    expect(readBriefReadyTemplate(pluginConfig, "it")).toEqual({
      name: "ada_brief_ready",
      language: "it",
    });
    expect(readBriefReadyTemplate(pluginConfig, "de")).toEqual({
      name: "ada_brief_ready",
      language: "it",
    });
    expect(readBriefReadyTemplate(pluginConfig, undefined)).toEqual({
      name: "ada_brief_ready",
      language: "it",
    });
  });

  it("keeps one language when none are listed", () => {
    expect(
      readBriefReadyTemplate(
        { briefReadyTemplate: { name: "ada_brief_ready", language: "en" } },
        "it",
      ),
    ).toEqual({ name: "ada_brief_ready", language: "en" });
  });

  it("falls back to digestReadyTemplate as configured when briefReadyTemplate is unset or incomplete", () => {
    const digest = { name: "ada_digest_ready", language: "it" };
    expect(readBriefReadyTemplate({ digestReadyTemplate: digest }, "en")).toEqual(digest);
    expect(
      readBriefReadyTemplate(
        { digestReadyTemplate: digest, briefReadyTemplate: { name: "ada_brief_ready" } },
        "en",
      ),
    ).toEqual(digest);
    expect(readBriefReadyTemplate({}, "en")).toBeNull();
  });
});

describe("sendDigestReadyNotice", () => {
  function logger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  }

  it("sends to the number it is given, never the configured one, and logs the outcome", async () => {
    const log = logger();
    const fetchImpl = vi.fn(async () => jsonResponse(200, { messages: [{ id: "wamid.x" }] }));
    const result = await sendDigestReadyNotice({
      api: { config: config as never, logger: log },
      template,
      to: "+393331111111",
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({
      to: "393331111111",
    });
    expect(log.info).toHaveBeenCalledOnce();
  });

  it("warns instead of sending when Kapso rejects", async () => {
    const log = logger();
    const fetchImpl = vi.fn(async () => jsonResponse(401));
    expect(
      await sendDigestReadyNotice({
        api: { config: config as never, logger: log },
        template,
        to: "+393331111111",
        fetchImpl,
      }),
    ).toEqual({ ok: false, error: "kapso template returned HTTP 401" });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("kapso_test_key");
  });
});

describe("warnDigestReadyTemplateUnset", () => {
  it("warns once per plugin instance", () => {
    const api = { logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
    warnDigestReadyTemplateUnset(api);
    warnDigestReadyTemplateUnset(api);
    expect(api.logger.warn).toHaveBeenCalledOnce();
    expect(api.logger.warn.mock.calls[0]?.[0]).toContain("digestReadyTemplate");
  });
});

describe("kapso response body timeout", () => {
  it("gives up on a response whose body never arrives, instead of waiting forever", async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200 },
        ),
    );
    const pending = sendKapsoTemplate({
      config,
      to: "390000000000",
      template,
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(cancelled || fetchImpl.mock.calls.length === 1).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
