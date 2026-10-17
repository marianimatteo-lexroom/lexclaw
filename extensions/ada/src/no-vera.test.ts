import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import plugin from "../index.js";
import { extractPdfText } from "./pdf-text.js";
import { ADA_PERSONA } from "./persona.js";
import type { Language } from "./research-link-outbound.js";
import { buildResearchPdf } from "./research-pdf.js";
import { researchAckText, researchMessage } from "./research-push.js";

/**
 * The assistant is called Ada. "Vera" is the old name: it stays in internal identifiers (state
 * directory, /vera/ routes, VERA_* variables, the vera.verus.legal domain), which this word
 * match skips, and in the one persona sentence that forbids it.
 */
const OLD_NAME = /(?<![\w/.-])vera(?![\w/-]|\.\w)/iu;
const ROOT = join(import.meta.dirname, "..");
const LANGUAGES: Language[] = ["it", "en", "es", "fr", "de"];

function readTree(dir: string, keep: (file: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && keep(join(entry.parentPath, entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("the assistant's name", () => {
  it("is stated to the model on every turn, with the old name forbidden", async () => {
    expect(ADA_PERSONA).toContain("Your name is Ada");
    expect(ADA_PERSONA).toMatch(/Never call yourself Vera/u);

    const on = vi.fn<OpenClawPluginApi["on"]>();
    plugin.register?.(createTestPluginApi({ id: "ada", on }));
    const persona = on.mock.calls.find(
      ([hook, , options]) => hook === "before_prompt_build" && options === undefined,
    );
    const handler = persona?.[1] as (() => unknown) | undefined;
    expect(await handler?.()).toEqual({ prependSystemContext: ADA_PERSONA });
  });

  it("does not match the old name inside internal identifiers, so the check can stay strict", () => {
    for (const internal of [
      "/vera/google/callback",
      "vera.verus.legal",
      "VERA_TOKEN_KEY",
      "vera-held:x",
      "$OPENCLAW_STATE_DIR/vera/memory.sqlite",
    ]) {
      expect(OLD_NAME.test(internal), internal).toBe(false);
    }
    for (const spoken of ["Vera", "I am Vera.", "Ciao, sono Vera!", "VERA digest", "(vera)"]) {
      expect(OLD_NAME.test(spoken), spoken).toBe(true);
    }
  });

  it("never reaches the model or users in a tool, skill, manifest, message or PDF", async () => {
    const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
    plugin.register?.(createTestPluginApi({ id: "ada", registerTool }));
    const tools = registerTool.mock.calls.map(([tool]) =>
      JSON.stringify(typeof tool === "function" ? {} : tool),
    );
    expect(tools.length).toBeGreaterThan(10);

    const skills = readTree(join(ROOT, "skills"), (file) => file.endsWith(".md")).map((file) =>
      readFileSync(file, "utf8"),
    );
    expect(skills.length).toBeGreaterThan(0);
    const manifest = [
      readFileSync(join(ROOT, "openclaw.plugin.json"), "utf8"),
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ];

    const messages: string[] = [];
    for (const language of LANGUAGES) {
      messages.push(researchAckText(language));
      for (const failure of [
        { ok: false as const, reason: "timeout" as const, message: "m", error: "m" },
        { ok: false as const, reason: "not_connected" as const, error: "e" },
        { ok: false as const, reason: "forbidden" as const, error: "e" },
        { ok: false as const, reason: "captcha_required" as const, error: "e" },
      ]) {
        messages.push(
          await researchMessage(failure, { readProfileLanguage: async () => language }),
        );
      }
      const pdf = await buildResearchPdf({
        query: "q",
        answer: "Risposta.",
        sources: [{ id: 1, title: "Fonte" }],
        researchUrl: "https://app.lexroom.ai/research/1",
        language,
      });
      messages.push(extractPdfText(pdf.bytes));
    }

    const texts = [...tools, ...skills, ...manifest, ...messages].map((text) =>
      text.replace(ADA_PERSONA, ""),
    );
    expect(texts.filter((text) => OLD_NAME.test(text))).toEqual([]);
  });

  it("is not written as the capitalized word in any non-comment source line", () => {
    const files = [
      join(ROOT, "index.ts"),
      ...readTree(join(ROOT, "src"), (file) => file.endsWith(".ts") && !file.endsWith(".test.ts")),
    ].filter((file) => !file.endsWith("persona.ts"));
    const offenders = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, index) => ({ file, line: index + 1, text: line }))
        .filter(({ text }) => !/^\s*(\/\/|\*|\/\*)/u.test(text) && /\bVera\b/u.test(text))
        .map(({ file: path, line }) => `${path}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
