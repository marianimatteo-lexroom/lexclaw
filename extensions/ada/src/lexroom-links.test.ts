import { describe, expect, it } from "vitest";
import { lexroomResearchUrl } from "./lexroom-links.js";

const API = "https://api.lexroom.ai";

describe("lexroomResearchUrl", () => {
  it("links a new research to its page in the Lexroom web app", () => {
    expect(lexroomResearchUrl({ researchId: "80878173f52500b2", apiBaseUrl: API })).toBe(
      "https://app.lexroom.ai/research/80878173f52500b2",
    );
  });

  it("links a follow-up to the page of the research that started the thread", () => {
    lexroomResearchUrl({ researchId: "root-1", apiBaseUrl: API });
    expect(
      lexroomResearchUrl({ researchId: "reply-1", parentResearchId: "root-1", apiBaseUrl: API }),
    ).toBe("https://app.lexroom.ai/research/root-1");
    expect(
      lexroomResearchUrl({ researchId: "reply-2", parentResearchId: "reply-1", apiBaseUrl: API }),
    ).toBe("https://app.lexroom.ai/research/root-1");
  });

  it("falls back to the parent when this process never saw the thread", () => {
    expect(
      lexroomResearchUrl({
        researchId: "x-2",
        parentResearchId: " unseen-parent ",
        apiBaseUrl: API,
      }),
    ).toBe("https://app.lexroom.ai/research/unseen-parent");
  });

  it("gives no link without an id or for an API that is not production", () => {
    expect(lexroomResearchUrl({ researchId: undefined, apiBaseUrl: API })).toBeUndefined();
    expect(lexroomResearchUrl({ researchId: "  ", apiBaseUrl: API })).toBeUndefined();
    expect(
      lexroomResearchUrl({ researchId: "r1", apiBaseUrl: "https://staging.lexroom.test" }),
    ).toBeUndefined();
  });

  it.each([
    "https://api.lexroom.ai/",
    "https://api.lexroom.ai/v1",
    "https://API.Lexroom.ai:443",
    "https://api-eu.lexroom.ai",
    "https://eu.api.lexroom.ai/",
    "https://lexroom.ai",
  ])("treats %s as production", (apiBaseUrl) => {
    expect(lexroomResearchUrl({ researchId: "r9", apiBaseUrl })).toBe(
      "https://app.lexroom.ai/research/r9",
    );
  });

  it.each([
    "https://api.lexroom.ai.evil.example",
    "https://notlexroom.ai",
    "https://lexroom.example",
    "http://localhost:8080",
  ])("does not treat %s as production", (apiBaseUrl) => {
    expect(lexroomResearchUrl({ researchId: "r9", apiBaseUrl })).toBeUndefined();
  });

  it("keeps an id that could change the path out of it", () => {
    expect(lexroomResearchUrl({ researchId: "a/b?c", apiBaseUrl: API })).toBe(
      "https://app.lexroom.ai/research/a%2Fb%3Fc",
    );
  });
});
