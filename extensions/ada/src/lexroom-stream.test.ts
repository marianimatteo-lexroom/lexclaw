import { describe, expect, it } from "vitest";
import { ndjsonLines, parseNdjsonLine } from "./lexroom-stream.js";

function bodyOf(
  chunks: Uint8Array[],
  closes = true,
): ReadableStream<Uint8Array> & { cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      if (closes) {
        controller.close();
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return Object.assign(stream, { cancelled: () => cancelled });
}

function slices(bytes: Uint8Array, size: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    chunks.push(bytes.subarray(offset, offset + size));
  }
  return chunks;
}

async function collect(body: ReadableStream<Uint8Array>, max?: number): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of ndjsonLines(body, max)) {
    lines.push(line);
  }
  return lines;
}

describe("ndjsonLines", () => {
  it("rebuilds lines and multi-byte characters split across chunks", async () => {
    const bytes = new TextEncoder().encode('{"a":"è€😀"}\r\n\n{"b":2}\n{"c":3}');
    for (const size of [1, 2, 3, 7, 1000]) {
      const lines = await collect(bodyOf(slices(bytes, size)));
      expect(lines.map((line) => line.trim())).toEqual(['{"a":"è€😀"}', '{"b":2}', '{"c":3}']);
    }
  });

  it("reads a multi-megabyte line delivered in small chunks", async () => {
    const payload = "x".repeat(6 * 1024 * 1024);
    const bytes = new TextEncoder().encode(`${JSON.stringify({ payload })}\n{"done":true}\n`);
    const lines = await collect(bodyOf(slices(bytes, 16 * 1024)));
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0] ?? "") as { payload: string }).payload.length).toBe(payload.length);
  });

  it("rejects a line past the size limit", async () => {
    const bytes = new TextEncoder().encode(`${"x".repeat(100)}\n`);
    await expect(collect(bodyOf(slices(bytes, 10)), 50)).rejects.toThrow("size limit");
  });

  it("cancels the body when the consumer stops early", async () => {
    const body = bodyOf([new TextEncoder().encode('{"a":1}\n{"b":2}\n')], false);
    for await (const line of ndjsonLines(body)) {
      expect(line).toBe('{"a":1}');
      break;
    }
    expect(body.cancelled()).toBe(true);
  });
});

describe("parseNdjsonLine", () => {
  it("parses JSON, tolerates an SSE data prefix, and returns undefined for junk", () => {
    expect(parseNdjsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseNdjsonLine('data: {"a":1}')).toEqual({ a: 1 });
    expect(parseNdjsonLine('{"a":')).toBeUndefined();
  });
});
