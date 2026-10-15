import os from "node:os";
import type { LexroomLog } from "./lexroom-client.js";

type LogSink = { info: (message: string) => void; warn: (message: string) => void };

/** Writes Lexroom diagnostics to the gateway log as `ada lexroom <event> key=value ...`. */
export function lexroomLogger(logger: LogSink): LexroomLog {
  return (event, fields) => {
    const pairs = Object.entries(fields)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    const line = `ada lexroom ${event}${pairs ? ` ${pairs}` : ""}`;
    if (/\.(failed|timeout)$/u.test(event) || event.endsWith("_failed")) {
      logger.warn(line);
    } else {
      logger.info(line);
    }
  };
}

/** Which process and replica a log line came from, to spot a write and read that never met. */
export function runtimeIdentity(env: NodeJS.ProcessEnv = process.env): {
  pid: number;
  host: string;
  replica: string;
} {
  return {
    pid: process.pid,
    host: os.hostname(),
    replica: env.RAILWAY_REPLICA_ID ?? env.RAILWAY_DEPLOYMENT_ID ?? "none",
  };
}
