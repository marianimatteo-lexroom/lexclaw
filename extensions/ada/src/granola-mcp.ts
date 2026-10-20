import { GRANOLA_MCP_URL } from "./granola-oauth.js";

/**
 * A small Streamable HTTP MCP client for Granola's hosted server. It carries one person's bearer
 * token, runs the handshake, lists or calls tools, and classifies what went wrong. Tool names and
 * argument schemas are never assumed: they come from `tools/list` at the time of the call.
 */
const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 45_000;
/** Bytes of one MCP response Ada will read; a long transcript beyond this is "too large". */
const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_LIST_PAGES = 5;

export type GranolaToolInfo = {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
};

export type GranolaMcpFailure = {
  ok: false;
  /**
   * `unauthorized`: the token was refused. `plan`: Granola says the plan does not include it.
   * `too_large`: the answer is too big to return. `bad_request`: the arguments or tool were
   * rejected. `missing_tool`: this person's plan does not offer the tool, and `tools` is what it
   * does offer. `unavailable`: Granola could not be reached or failed.
   */
  kind: "unauthorized" | "plan" | "too_large" | "bad_request" | "missing_tool" | "unavailable";
  message: string;
  tools?: GranolaToolInfo[];
};

export type GranolaMcpResult<T> = { ok: true; value: T } | GranolaMcpFailure;

const PLAN_PATTERN =
  /\b(free plan|free tier|basic plan|upgrade|paid plan|paid feature|subscription|premium|business plan|enterprise|plan limit|not included in your plan|last 30 days|30[- ]day)\b/iu;
const SIZE_PATTERN =
  /\b(too (?:large|long|big)|exceeds?|exceeded|size limit|token limit|length limit|context (?:window|length)|payload)\b/iu;

/** What an error message says is wrong, from the words Granola uses. */
export function classifyGranolaError(message: string): GranolaMcpFailure["kind"] {
  if (SIZE_PATTERN.test(message)) {
    return "too_large";
  }
  if (PLAN_PATTERN.test(message)) {
    return "plan";
  }
  return "bad_request";
}

function clip(value: string, max = 400): string {
  const line = value.replace(/\s+/gu, " ").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function failure(kind: GranolaMcpFailure["kind"], message: string): GranolaMcpFailure {
  return { ok: false, kind, message: clip(message) };
}

async function readLimited(response: Response): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    return await response.text();
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type JsonRpcMessage = {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
};

/** The JSON-RPC message answering `id`, from a JSON body or a `text/event-stream` body. */
function messageFor(body: string, contentType: string, id: number): JsonRpcMessage | null {
  const candidates: unknown[] = [];
  if (contentType.includes("text/event-stream")) {
    for (const event of body.split(/\r?\n\r?\n/u)) {
      const data = event
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (data) {
        try {
          candidates.push(JSON.parse(data));
        } catch {
          // A keep-alive or partial event carries nothing to read.
        }
      }
    }
  } else {
    try {
      const parsed: unknown = JSON.parse(body);
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return null;
    }
  }
  return (
    (candidates.find(
      (item) => item && typeof item === "object" && (item as JsonRpcMessage).id === id,
    ) as JsonRpcMessage | undefined) ?? null
  );
}

type Rpc = <Result>(
  method: string,
  params: Record<string, unknown>,
) => Promise<GranolaMcpResult<Result>>;

/** Runs `work` inside one initialized MCP session carrying `accessToken`. */
export async function withGranolaSession<T>(params: {
  accessToken: string;
  work: (rpc: Rpc) => Promise<GranolaMcpResult<T>>;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  mcpUrl?: string;
}): Promise<GranolaMcpResult<T>> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const url = params.mcpUrl ?? GRANOLA_MCP_URL;
  let sessionId: string | undefined;
  let nextId = 1;

  const post = async (payload: unknown) => {
    const limit = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${params.accessToken}`,
        "mcp-protocol-version": PROTOCOL_VERSION,
        ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      },
      body: JSON.stringify(payload),
      signal: params.signal ? AbortSignal.any([params.signal, limit]) : limit,
    });
  };

  const rpc: Rpc = async <Result>(method: string, rpcParams: Record<string, unknown>) => {
    const id = nextId++;
    let response: Response;
    try {
      response = await post({ jsonrpc: "2.0", id, method, params: rpcParams });
    } catch {
      return failure("unavailable", "Granola did not respond.");
    }
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) {
      const detail = clip((await response.text().catch(() => "")).slice(0, 600), 300);
      if (response.status === 401) {
        return failure("unauthorized", "Granola refused the saved sign-in.");
      }
      if (response.status === 413) {
        return failure("too_large", detail || "The answer is too large.");
      }
      if (response.status === 402 || response.status === 403) {
        return failure("plan", detail || "Granola says this is not available on the plan.");
      }
      if (response.status === 429 || response.status >= 500) {
        return failure("unavailable", `Granola answered ${response.status}.`);
      }
      return failure(
        classifyGranolaError(detail),
        detail || `Granola answered ${response.status}.`,
      );
    }
    const body = await readLimited(response).catch(() => undefined);
    if (body === null) {
      return failure("too_large", "The answer is larger than Ada can read.");
    }
    if (body === undefined) {
      return failure("unavailable", "Granola did not finish its answer.");
    }
    const message = messageFor(body, response.headers.get("content-type") ?? "", id);
    if (!message) {
      return failure("unavailable", "Granola sent an answer Ada could not read.");
    }
    if (message.error) {
      const text = typeof message.error.message === "string" ? message.error.message : "error";
      return failure(classifyGranolaError(text), text);
    }
    return { ok: true, value: message.result as Result };
  };

  const initialized = await rpc<unknown>("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "ada", version: "1" },
  });
  if (!initialized.ok) {
    return initialized;
  }
  try {
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }).then((response) =>
      response.body?.cancel(),
    );
  } catch {
    // The notification has no answer to wait for; the next request shows whether the session works.
  }
  return await params.work(rpc);
}

function toolInfo(value: unknown): GranolaToolInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const tool = value as {
    name?: unknown;
    description?: unknown;
    inputSchema?: unknown;
    annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
  };
  if (typeof tool.name !== "string" || !/^[\w.-]{1,128}$/u.test(tool.name)) {
    return null;
  }
  const writes =
    tool.annotations?.readOnlyHint === false ||
    tool.annotations?.destructiveHint === true ||
    /^(create|update|delete|remove|write|edit|set|add|share|send|move|rename|upload)[_-]/iu.test(
      tool.name,
    );
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: tool.inputSchema ?? { type: "object" },
    readOnly: !writes,
  };
}

/** The tools this person's Granola plan offers right now. */
export function listGranolaTools(
  params: Omit<Parameters<typeof withGranolaSession>[0], "work">,
): Promise<GranolaMcpResult<GranolaToolInfo[]>> {
  return withGranolaSession({
    ...params,
    work: async (rpc) => {
      const tools: GranolaToolInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const listed = await rpc<{ tools?: unknown[]; nextCursor?: unknown }>(
          "tools/list",
          cursor ? { cursor } : {},
        );
        if (!listed.ok) {
          return listed;
        }
        for (const item of listed.value?.tools ?? []) {
          const info = toolInfo(item);
          if (info) {
            tools.push(info);
          }
        }
        cursor =
          typeof listed.value?.nextCursor === "string" && listed.value.nextCursor
            ? listed.value.nextCursor
            : undefined;
        if (!cursor) {
          break;
        }
      }
      return { ok: true, value: tools };
    },
  });
}

/** Lists the tools and calls `tool` when this person's plan offers it, in one session. */
export function callGranolaTool(
  params: Omit<Parameters<typeof withGranolaSession>[0], "work"> & {
    tool: string;
    arguments: Record<string, unknown>;
  },
): Promise<GranolaMcpResult<{ text: string; tools: GranolaToolInfo[] }>> {
  return withGranolaSession({
    accessToken: params.accessToken,
    fetchImpl: params.fetchImpl,
    signal: params.signal,
    mcpUrl: params.mcpUrl,
    work: async (rpc) => {
      const listed = await rpc<{ tools?: unknown[] }>("tools/list", {});
      if (!listed.ok) {
        return listed;
      }
      const tools = (listed.value?.tools ?? [])
        .map(toolInfo)
        .filter((info): info is GranolaToolInfo => info !== null);
      const wanted = tools.find((info) => info.name === params.tool);
      if (!wanted) {
        return { ...failure("missing_tool", `${params.tool} is not available.`), tools };
      }
      if (!wanted.readOnly) {
        return failure("bad_request", `${wanted.name} would change Granola, which Ada never does.`);
      }
      const called = await rpc<{
        content?: Array<{ type?: unknown; text?: unknown }>;
        structuredContent?: unknown;
        isError?: unknown;
      }>("tools/call", { name: wanted.name, arguments: params.arguments });
      if (!called.ok) {
        return { ...called, tools };
      }
      const parts = (called.value?.content ?? [])
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string);
      let text = parts.join("\n\n");
      if (!text && called.value?.structuredContent !== undefined) {
        text = JSON.stringify(called.value.structuredContent);
      }
      if (called.value?.isError === true) {
        return {
          ...failure(classifyGranolaError(text), text || "Granola reported an error."),
          tools,
        };
      }
      return { ok: true, value: { text, tools } };
    },
  });
}
