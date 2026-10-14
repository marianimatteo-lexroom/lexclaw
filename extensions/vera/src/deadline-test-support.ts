import path from "node:path";
import { deflateSync } from "node:zlib";
import type { SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import type { SqliteWorkerCommand } from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { VeraMemoryOperations } from "./memory-contract.js";
import { wrapMemoryWorker, type MemoryStore } from "./memory.js";
import { createSqliteWorkerBackend } from "./memory.worker.js";

/** Real memory worker over a temp database, without the worker thread. */
export function openTestMemory(directory: string): { memory: MemoryStore; close: () => void } {
  const backend = createSqliteWorkerBackend(undefined, {
    databasePath: path.join(directory, "memory.sqlite"),
  });
  const store: SqliteWorkerStore<VeraMemoryOperations> = {
    async execute(command) {
      // The backend types execute over the union of commands, so the command-to-output
      // correlation that SqliteWorkerStore expresses has to be restated here.
      const output = backend.execute(command as SqliteWorkerCommand<VeraMemoryOperations>);
      return output as VeraMemoryOperations[typeof command.type]["output"];
    },
    async close() {
      await backend.close();
    },
  };
  return {
    memory: wrapMemoryWorker(store),
    close: () => {
      void backend.close();
    },
  };
}

function escapePdf(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");
}

/** A one-page PDF with standard text operators. Fake content only. */
export function buildPdf(lines: readonly string[], options: { compress?: boolean } = {}): Buffer {
  const operators = lines
    .map((line, index) => `${index === 0 ? "" : "0 -14 Td "}(${escapePdf(line)}) Tj`)
    .join("\n");
  const content = Buffer.from(`BT /F1 12 Tf 72 720 Td\n${operators}\nET`, "latin1");
  const stream = options.compress ? deflateSync(content) : content;
  return Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Length ${stream.length}${options.compress ? " /Filter /FlateDecode" : ""} >>\nstream\n`,
      "latin1",
    ),
    stream,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
}
