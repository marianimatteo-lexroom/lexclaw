/** One cumulative snapshot can be several MB; anything past this is a broken stream. */
export const MAX_NDJSON_LINE_BYTES = 32 * 1024 * 1024;

const NEWLINE = 0x0a;

function joinChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1 && chunks[0]) {
    return chunks[0];
  }
  return Buffer.concat(chunks);
}

/**
 * Yields complete lines from a byte stream. Lexroom labels its streams
 * `text/event-stream` but sends NDJSON, one full snapshot per line, and a line
 * can arrive in many chunks. Bytes are only decoded once a line is complete, so
 * multi-byte characters split across chunks stay intact and long lines cost one
 * join instead of a rescan per chunk. Breaking out of the loop cancels the body.
 */
export async function* ndjsonLines(
  body: ReadableStream<Uint8Array>,
  maxLineBytes = MAX_NDJSON_LINE_BYTES,
  onChunk?: (chunk: Uint8Array) => void,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;

  const take = (tail: Uint8Array): string => {
    pending.push(tail);
    const line = decoder.decode(joinChunks(pending));
    pending = [];
    pendingBytes = 0;
    return line;
  };
  const hold = (tail: Uint8Array) => {
    pendingBytes += tail.length;
    if (pendingBytes > maxLineBytes) {
      throw new Error("Lexroom stream line exceeded the size limit");
    }
    pending.push(tail);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      onChunk?.(value);
      let start = 0;
      for (;;) {
        const end = value.indexOf(NEWLINE, start);
        if (end === -1) {
          break;
        }
        if (pendingBytes + (end - start) > maxLineBytes) {
          throw new Error("Lexroom stream line exceeded the size limit");
        }
        const line = take(value.subarray(start, end));
        start = end + 1;
        if (line.trim()) {
          yield line;
        }
      }
      if (start < value.length) {
        hold(value.subarray(start));
      }
    }
    if (pendingBytes > 0) {
      const line = take(new Uint8Array(0));
      if (line.trim()) {
        yield line;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Parses one NDJSON line. Returns undefined for a line that is not JSON. */
export function parseNdjsonLine(line: string): unknown {
  const trimmed = line.trim().replace(/^data:\s*/u, "");
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}
