import { describe, expect, it } from "vitest";
import type { MemoryRecord } from "./memory-contract.js";
import { matchMatterId, matchesMemoryQuery, rankMemoryHits, renderMemoryPage } from "./memory-render.js";

const dining: MemoryRecord = {
  id: "dining",
  matterId: "rossi",
  folder: "knowledge/preferences",
  type: "preference",
  title: "Dining",
  aliases: ["food", "lunch", "restaurants", "takeout", "delivery", "dining", "pasta"],
  body: "- **Pasta:** Loves pasta; stated on 2026-09-15.",
  validFromMs: 1,
  validToMs: null,
  supersededBy: null,
};

const other: MemoryRecord = {
  id: "hearing",
  matterId: "bianchi",
  folder: "workstreams/active",
  type: "workstream",
  title: "Hearing",
  aliases: ["udienza", "tribunale"],
  body: "- Hearing next week.",
  validFromMs: 1,
  validToMs: null,
  supersededBy: null,
};

describe("memory render and search", () => {
  it("renders Instinct-style frontmatter and body", () => {
    expect(renderMemoryPage(dining)).toContain("id: dining");
    expect(renderMemoryPage(dining)).toContain('aliases: ["food"');
    expect(renderMemoryPage(dining)).toContain("Loves pasta");
  });

  it("matches aliases with grep-style keywords and rejects misspellings", () => {
    expect(matchesMemoryQuery(dining, "pasta")).toBe(true);
    expect(matchesMemoryQuery(dining, "takeout")).toBe(true);
    expect(matchesMemoryQuery(dining, "Italian noodles I enjoy")).toBe(false);
    expect(matchesMemoryQuery(dining, "pazta")).toBe(false);
  });

  it("ranks exact alias hits first", () => {
    const ranked = rankMemoryHits([other, dining], "pasta");
    expect(ranked.map((record) => record.id)).toEqual(["dining"]);
  });

  it("picks the longest matching matter alias", () => {
    expect(
      matchMatterId("Re: Rossi spa contract", [
        { matterId: "rossi", alias: "Rossi" },
        { matterId: "rossi-spa", alias: "Rossi spa" },
      ]),
    ).toBe("rossi-spa");
    expect(matchMatterId("newsletter", [{ matterId: "rossi", alias: "Rossi" }])).toBeNull();
  });
});
