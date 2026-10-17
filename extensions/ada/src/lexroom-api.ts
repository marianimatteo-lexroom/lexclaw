import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { exchange, readJsonGuarded, type RetryPolicy, type Trace } from "./lexroom-transport.js";

export const DEFAULT_LEXROOM_BASE_URL = "https://api.lexroom.ai";
export const LEXROOM_CLIENT_TYPE = "app_lex";

export function lexroomBaseUrl(value: string | undefined): string {
  return (value?.trim() || DEFAULT_LEXROOM_BASE_URL).replace(/\/+$/u, "");
}

/** Exactly what the lexroom-bot client sends: the bearer, the client type, and JSON for POSTs. */
export function lexroomHeaders(accessToken: string | undefined, method: "GET" | "POST"): Headers {
  const result = new Headers();
  if (accessToken !== undefined) {
    result.set("Authorization", `Bearer ${accessToken}`);
  }
  result.set("X-Client-Type", LEXROOM_CLIENT_TYPE);
  if (method === "POST") {
    result.set("Content-Type", "application/json");
  }
  return result;
}

/**
 * Escapes non-ASCII to \uXXXX so a request body is pure ASCII bytes, which keeps the
 * Python backend from choking on a UTF-8 decode whatever the runtime encoding is.
 */
export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /[\u0080-\uFFFF]/gu,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

const OptionalString = Type.Optional(Type.String());

/** `POST /v1/login`. Field spellings follow lexroom-bot: `access_token ?? token ?? accessToken`. */
export const LoginBody = Type.Object({
  access_token: OptionalString,
  token: OptionalString,
  accessToken: OptionalString,
  access: OptionalString,
  refresh_token: OptionalString,
  refresh: OptionalString,
  refreshToken: OptionalString,
  email: OptionalString,
  user_email: OptionalString,
  username: OptionalString,
});

/**
 * `GET /v1/user/modules`. The shape is deliberately loose, a JSON array or object: lexroom-bot
 * reads a list of names, and no capture pins the object form, so `normalizeModules` stays the
 * tolerant reader until one does.
 */
export const UserModulesBody = Type.Union([
  Type.Array(Type.Unknown()),
  Type.Record(Type.String(), Type.Unknown()),
]);

/** The error body of any endpoint. A `detail` that is not a string (a 422 list) reads as absent. */
const ErrorBody = Type.Object({ detail: OptionalString, code: OptionalString });

/**
 * The only way to reach Lexroom. `timeoutMs` has no default: it is the hard limit of one
 * attempt, connect to last body byte, and a call that leaves it out does not compile.
 */
export type LexroomCall = {
  baseUrl: string;
  timeoutMs: number;
  trace: Trace;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
};

/** What came back, already checked against the endpoint's schema. */
export type LexroomReply<T> =
  | { kind: "ok"; status: number; body: T }
  | { kind: "http_error"; status: number; detail: string; code: string }
  | { kind: "unexpected_shape"; status: number };

/**
 * One request under `call.timeoutMs`. A timeout throws `LexroomTimeoutError`. A 2xx body that
 * does not match `schema` is `unexpected_shape` and is logged, never read as if it matched.
 */
async function send<S extends TSchema>(
  call: LexroomCall,
  step: string,
  request: {
    method: "GET" | "POST";
    path: string;
    headers: Headers;
    body?: string;
    retry: RetryPolicy;
    retryTimeout?: boolean;
  },
  schema: S,
): Promise<LexroomReply<Static<S>>> {
  const sent = await exchange({
    fetchImpl: call.fetchImpl ?? fetch,
    url: `${call.baseUrl}${request.path}`,
    init: {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    },
    timeoutMs: call.timeoutMs,
    signal: call.signal,
    trace: call.trace,
    step,
    retry: request.retry,
    ...(request.retryTimeout ? { retryTimeout: true } : {}),
    read: (response, guard) => readJsonGuarded(response, guard),
  });
  if (!sent.ok) {
    const error = Check(ErrorBody, sent.value) ? sent.value : {};
    return {
      kind: "http_error",
      status: sent.status,
      detail: error.detail ?? "",
      code: error.code ?? "",
    };
  }
  if (!Check(schema, sent.value)) {
    call.trace(`${step}.unexpected_shape`, { status: sent.status });
    return { kind: "unexpected_shape", status: sent.status };
  }
  return { kind: "ok", status: sent.status, body: sent.value };
}

/** One `POST /v1/login`, the call lexroom-bot makes. Safe to repeat, so a silent server gets one more try. */
export function lexroomLogin(
  call: LexroomCall,
  credentials: { email: string; password: string },
): Promise<LexroomReply<Static<typeof LoginBody>>> {
  return send(
    call,
    "login",
    {
      method: "POST",
      path: "/v1/login",
      headers: lexroomHeaders(undefined, "POST"),
      body: asciiJson(credentials),
      retry: "any",
      retryTimeout: true,
    },
    LoginBody,
  );
}

/** `GET /v1/user/modules`. */
export function lexroomUserModules(
  call: LexroomCall,
  accessToken: string,
): Promise<LexroomReply<Static<typeof UserModulesBody>>> {
  return send(
    call,
    "modules",
    {
      method: "GET",
      path: "/v1/user/modules",
      headers: lexroomHeaders(accessToken, "GET"),
      retry: "any",
    },
    UserModulesBody,
  );
}

/** `GET /v1/credits`: the cheap authenticated call the web app makes. Only the status matters. */
export function lexroomCreditsProbe(
  call: LexroomCall,
  accessToken: string,
): Promise<LexroomReply<unknown>> {
  return send(
    call,
    "auth_probe",
    {
      method: "GET",
      path: "/v1/credits",
      headers: lexroomHeaders(accessToken, "GET"),
      retry: "any",
    },
    Type.Unknown(),
  );
}
