// The mock-backed checks. Each one drives Ada's real code (login, client, session, jobs, push,
// link hook, SQLite account store) over real HTTP against the mock Lexroom and asserts what the
// lawyer would observe: a result, a structured failure, a message, a link.
import {
  type CheckContext,
  type CheckDefinition,
  type Sandbox,
  expiredToken,
  fakeWhatsApp,
  MOCK_CLIENT_SECRET,
  MOCK_EMAIL,
  MOCK_PASSWORD,
  PRODUCTION_BASE_URL,
  sandbox,
  seedAccount,
  sleep,
  staleToken,
  timed,
  watchdog,
} from "./lib.mts";

const RESEARCH_ID = "80878173f52500b2";
const RESEARCH_URL = `https://app.lexroom.ai/research/${RESEARCH_ID}`;
const QUERY = "Termine per proporre opposizione a decreto ingiuntivo";
const NUMBER_A = "390000000001";
const NUMBER_B = "390000000002";
const SENDER_A = { senderId: "+39 000 000 0001", channel: "kapso-whatsapp" };
const SENDER_B = { senderId: "+39 000 000 0002", channel: "kapso-whatsapp" };
/** Ceiling for any single call in a check; a call past it is reported as hung. */
const HUNG_MS = 20_000;

type Config = { baseUrl: string };
const config: Config = { baseUrl: PRODUCTION_BASE_URL };

const reset = (ctx: CheckContext, mode: Parameters<CheckContext["mock"]["configure"]>[0] = {}) => {
  ctx.mock.reset();
  ctx.mock.configure({ mode: "normal", routes: {}, ...mode });
};

const count = (ctx: CheckContext, path: string, method?: string) =>
  ctx.mock.requests().filter((r) => r.path === path && (!method || r.method === method)).length;

/** One logged request as `METHOD host path`; the API is `api`, the web app `app`, Auth0 `auth`. */
const flowStep = (r: { method: string; path: string; host?: string }) =>
  `${r.method} ${r.host?.split(".")[0] ?? "api"} ${r.path}`;

async function validToken(ctx: CheckContext): Promise<string> {
  const login = await ctx.ada.login.loginLexroomAccount({
    email: MOCK_EMAIL,
    password: MOCK_PASSWORD,
    baseUrl: PRODUCTION_BASE_URL,
    timeoutMs: 5000,
    fetchImpl: ctx.fetchImpl,
  });
  if (!login.ok) {
    throw new Error(`mock login failed: ${login.error}`);
  }
  return login.accessToken;
}

async function withBox<T>(
  ctx: CheckContext,
  run: (box: Sandbox) => Promise<T>,
  keep: Sandbox[],
): Promise<T> {
  const box = await sandbox(ctx.ada);
  keep.push(box);
  try {
    return await run(box);
  } finally {
    box.cleanup();
  }
}

/** Log lines from every sandbox, for the final no-secrets scan. */
export const capturedLogs: Sandbox[] = [];

const startResearch = (
  ctx: CheckContext,
  box: Sandbox,
  requester?: Record<string, string>,
  pushDepsFor?: (to: string) => never,
) =>
  ctx.ada.tools.startAdaResearch({
    args: { matterId: "verify-matter", query: QUERY },
    config,
    api: box.api,
    requester,
    fetchImpl: ctx.fetchImpl,
    ...(pushDepsFor ? { pushDepsFor } : {}),
  } as never);

type JobView = Record<string, unknown> & {
  ok?: boolean;
  state?: string;
  jobId?: string;
  reason?: string;
};

async function readUntilSettled(
  ctx: CheckContext,
  jobId: string,
  requester?: string,
): Promise<JobView> {
  return (await watchdog(
    ctx.ada.jobs.readResearchJob({ jobId, requester, waitSeconds: 30 }),
    HUNG_MS,
    "ada_research_status",
  )) as JobView;
}

function hookApi() {
  const handlers = new Map<string, (event: never) => Promise<unknown> | unknown>();
  const api = {
    on: (name: string, handler: (event: never) => Promise<unknown> | unknown) => {
      handlers.set(name, handler);
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    },
  };
  return {
    api: api as never,
    fire: (name: string, event: unknown) => handlers.get(name)?.(event as never),
  };
}

async function finalReply(fire: ReturnType<typeof hookApi>["fire"], text: string) {
  return (await fire("reply_payload_sending", { kind: "final", payload: { text } })) as
    | { payload: { text: string } }
    | undefined;
}

const MODEL_REPLY =
  "Il termine per proporre opposizione a decreto ingiuntivo è di quaranta giorni dalla notifica del decreto, come previsto dalla legge.";

export const CHECKS: CheckDefinition[] = [
  {
    id: "login.ok",
    title:
      "Login tries the old endpoint, signs in through Lexroom's Auth0 flow, and returns a usable bearer",
    guards: "login contract (#43 typed client, #48 Auth0 sign-in)",
    async run(t, ctx) {
      reset(ctx);
      const { value: result } = await timed(
        ctx.ada.login.loginLexroomAccount({
          email: MOCK_EMAIL,
          password: MOCK_PASSWORD,
          baseUrl: PRODUCTION_BASE_URL,
          timeoutMs: 5000,
          fetchImpl: ctx.fetchImpl,
          env: {},
        }),
      );
      t.ok("web-flow login succeeds", result.ok, result.ok ? undefined : result.error);
      t.ok("a bearer comes back", result.ok && result.accessToken.length > 20);
      const requests = ctx.mock.requests();
      const [legacy] = requests;
      t.eq(
        "first one POST /v1/login, which answers 403 auth0_login_required",
        [legacy?.method, legacy?.path],
        ["POST", "/v1/login"],
      );
      t.eq("sends X-Client-Type app_lex", legacy?.clientType, "app_lex");
      t.eq("body is exactly email and password", legacy?.bodyKeys, ["email", "password"]);
      t.eq("no bearer is sent to login", legacy?.bearer, "none");
      t.eq("then the web flow, step by step", requests.slice(1).map(flowStep), [
        "GET app /api/auth/login",
        "GET auth /authorize",
        "GET auth /u/login/identifier",
        "POST auth /u/login/identifier",
        "GET auth /u/login/password",
        "POST auth /u/login/password",
        "GET auth /authorize/resume",
        "GET app /api/auth/callback/auth0",
        "GET app /",
        "GET app /api/auth/session",
      ]);
      const identifier = requests.find(
        (r) => r.method === "POST" && r.path === "/u/login/identifier",
      );
      t.ok(
        "the identifier form is posted with the fields the page defines",
        ["state", "username", "language", "persist", "action", "js-available"].every((key) =>
          identifier?.bodyKeys.includes(key),
        ),
        JSON.stringify(identifier?.bodyKeys),
      );
      const password = requests.find((r) => r.method === "POST" && r.path === "/u/login/password");
      t.ok(
        "the password form carries state, username and password",
        ["state", "username", "password"].every((key) => password?.bodyKeys.includes(key)),
      );
      t.ok(
        "the bearer is the one the session issued",
        result.ok && result.accessToken === ctx.mock.lastIssuedToken(),
      );

      reset(ctx);
      const realm = await ctx.ada.login.loginLexroomAccount({
        email: MOCK_EMAIL,
        password: MOCK_PASSWORD,
        baseUrl: PRODUCTION_BASE_URL,
        timeoutMs: 5000,
        fetchImpl: ctx.fetchImpl,
        env: { ADA_LEXROOM_AUTH0_CLIENT_SECRET: MOCK_CLIENT_SECRET },
      });
      t.ok("password-realm login succeeds", realm.ok, realm.ok ? undefined : realm.error);
      t.eq(
        "with the secret set, only the token endpoint and one bearer check",
        ctx.mock.requests().map(flowStep),
        ["POST auth /oauth/token", "GET api /v1/credits"],
      );
      const grant = ctx.mock.requests()[0];
      t.eq("the grant carries exactly the fields Auth0 defines", grant?.bodyKeys, [
        "audience",
        "client_id",
        "client_secret",
        "grant_type",
        "password",
        "realm",
        "scope",
        "username",
      ]);
      t.eq(
        "the new bearer is checked against Lexroom's API",
        ctx.mock.requests()[1]?.bearer,
        "valid",
      );
      t.ok(
        "the Auth0 token is what comes back",
        realm.ok && realm.accessToken === ctx.mock.lastIssuedToken(),
      );
    },
  },
  {
    id: "login.failures",
    title: "Login failures come back as structured ok:false results, never exceptions",
    guards: "401 / MFA / bad-body handling, and Auth0's wrong password, MFA, captcha and refusals",
    async run(t, ctx) {
      const realm = { ADA_LEXROOM_AUTH0_CLIENT_SECRET: MOCK_CLIENT_SECRET };
      const cases: Array<[string, Parameters<typeof reset>[1], string, NodeJS.ProcessEnv?]> = [
        ["old endpoint: 401 wrong password", { routes: { "/v1/login": "401" } }, "wrong_password"],
        ["old endpoint: MFA required", { routes: { "/v1/login": "mfa" } }, "mfa_required"],
        ["old endpoint: 403 refusal", { routes: { "/v1/login": "403" } }, "forbidden"],
        ["old endpoint: 500", { routes: { "/v1/login": "500" } }, "unavailable"],
        ["old endpoint: non-JSON 200", { routes: { "/v1/login": "malformed" } }, "unavailable"],
        ["old endpoint: empty 200", { routes: { "/v1/login": "empty" } }, "unavailable"],
        [
          "web: wrong password",
          { routes: { "/u/login/password": "wrong_password" } },
          "wrong_password",
        ],
        ["web: MFA step", { routes: { "/u/login/password": "mfa" } }, "mfa_required"],
        ["web: captcha", { routes: { "/u/login/password": "captcha" } }, "captcha_required"],
        ["web: blocked account", { routes: { "/u/login/password": "blocked" } }, "forbidden"],
        [
          "web: session without a token",
          { routes: { "/api/auth/session": "no_token" } },
          "unavailable",
        ],
        ["web: sign-in page down", { routes: { "/u/login/identifier": "500" } }, "unavailable"],
        [
          "web: sign-in page changed",
          { routes: { "/u/login/identifier": "malformed" } },
          "unavailable",
        ],
        [
          "Auth0: invalid_grant",
          { routes: { "/oauth/token": "wrong_password" } },
          "wrong_password",
          realm,
        ],
        ["Auth0: mfa_required", { routes: { "/oauth/token": "mfa" } }, "mfa_required", realm],
        ["Auth0: unauthorized_client", { routes: { "/oauth/token": "403" } }, "forbidden", realm],
        ["Auth0: invalid_client", { routes: { "/oauth/token": "401" } }, "forbidden", realm],
        ["Auth0: 500", { routes: { "/oauth/token": "500" } }, "unavailable", realm],
      ];
      for (const [label, mode, reason, env] of cases) {
        reset(ctx, mode);
        const result = await watchdog(
          ctx.ada.login.loginLexroomAccount({
            email: MOCK_EMAIL,
            password: MOCK_PASSWORD,
            baseUrl: PRODUCTION_BASE_URL,
            timeoutMs: 3000,
            fetchImpl: ctx.fetchImpl,
            env: env ?? {},
          }),
          HUNG_MS,
          label,
        );
        t.ok(
          `${label} -> ok:false reason ${reason}`,
          !result.ok && result.reason === reason && typeof result.error === "string",
          JSON.stringify(result).slice(0, 160),
        );
        t.ok(
          `${label}: no password or client secret in the error text`,
          !result.ok &&
            !result.error.includes(MOCK_PASSWORD) &&
            !result.error.includes(MOCK_CLIENT_SECRET),
        );
      }
    },
  },
  {
    id: "login.timeouts",
    title: "A stalled or silent login, at any step, ends at the request limit with reason timeout",
    guards: "unbounded Lexroom calls (login hung until the host gave up)",
    async run(t, ctx) {
      const steps: Array<[string, "stall" | "silent", NodeJS.ProcessEnv?]> = [
        ["/v1/login", "stall"],
        ["/v1/login", "silent"],
        ["/u/login/identifier", "stall"],
        ["/u/login/password", "silent"],
        ["/api/auth/session", "stall"],
        ["/oauth/token", "silent", { ADA_LEXROOM_AUTH0_CLIENT_SECRET: MOCK_CLIENT_SECRET }],
      ];
      for (const [route, mode, env] of steps) {
        reset(ctx, { routes: { [route]: mode } });
        const { value, ms } = await timed(
          watchdog(
            ctx.ada.login.loginLexroomAccount({
              email: MOCK_EMAIL,
              password: MOCK_PASSWORD,
              baseUrl: PRODUCTION_BASE_URL,
              timeoutMs: 1000,
              fetchImpl: ctx.fetchImpl,
              env: env ?? {},
            }),
            HUNG_MS,
            `login (${route} ${mode})`,
          ),
        );
        t.ok(
          `${route} ${mode}: ok:false reason timeout`,
          !value.ok && value.reason === "timeout",
          JSON.stringify(value).slice(0, 160),
        );
        t.ok(
          `${route} ${mode}: ended within the 2s limit of the whole sign-in (took ${ms}ms)`,
          ms >= 900 && ms < 4000,
        );
      }
    },
  },
  {
    id: "research.ok",
    title: "A normal research returns the answer, sources and the web-app link",
    guards: "client contract with the recorded ask_me_anything stream (#43)",
    async run(t, ctx) {
      reset(ctx);
      const accessToken = await validToken(ctx);
      const result = await watchdog(
        ctx.ada.client.runResearch({
          config: { accessToken, baseUrl: PRODUCTION_BASE_URL },
          matterId: "verify-matter",
          query: QUERY,
          fetchImpl: ctx.fetchImpl,
        }),
        HUNG_MS,
        "runResearch",
      );
      t.ok("research ok", result.ok, result.ok ? undefined : result.error);
      if (result.ok) {
        t.eq("research id from the stream", result.researchId, RESEARCH_ID);
        t.eq("web-app link", result.researchUrl, RESEARCH_URL);
        t.ok("answer text present", result.answer.trim().length > 0);
        t.ok("sources parsed", result.sources.length > 0);
      }
      const ask = ctx.mock.requests().find((r) => r.path === "/v1/ask_me_anything");
      t.eq("ask uses the bearer from login", ask?.bearer, "valid");
      t.ok("ask names the modules the user may search", (ask?.modules?.length ?? 0) > 0);
    },
  },
  {
    id: "research.timeouts",
    title: "A research that stalls or never answers ends as a timeout failure",
    guards: "unbounded research stream (silence after headers or after the first line)",
    async run(t, ctx) {
      const cases: Array<[string, Parameters<typeof reset>[1]]> = [
        ["ask stalls after the first stream line", { routes: { "/v1/ask_me_anything": "stall" } }],
        ["ask never answers", { routes: { "/v1/ask_me_anything": "silent" } }],
        ["user/modules never answers", { routes: { "/v1/user/modules": "silent" } }],
      ];
      for (const [label, mode] of cases) {
        reset(ctx, mode);
        const accessToken = await validToken(ctx);
        const { value, ms } = await timed(
          watchdog(
            ctx.ada.client.runResearch({
              config: { accessToken, baseUrl: PRODUCTION_BASE_URL },
              matterId: "verify-matter",
              query: QUERY,
              fetchImpl: ctx.fetchImpl,
            }),
            HUNG_MS,
            label,
          ),
        );
        t.ok(
          `${label} -> ok:false reason timeout`,
          !value.ok && "reason" in value && value.reason === "timeout",
          JSON.stringify(value).slice(0, 160),
        );
        t.ok(`${label}: gave up in ${ms}ms, well inside the 180s total cap`, ms < 8000);
      }
    },
  },
  {
    id: "research.failures",
    title: "401, 403, 500 and malformed replies become structured ok:false results",
    guards: "structured failures; a 403 must not read as a lost sign-in",
    async run(t, ctx) {
      const cases: Array<
        [string, Parameters<typeof reset>[1], (r: Record<string, unknown>) => boolean, string]
      > = [
        [
          "401 on ask",
          { routes: { "/v1/ask_me_anything": "401" } },
          (r) => r.reason === "not_connected",
          "reason not_connected",
        ],
        [
          "403 on ask",
          { routes: { "/v1/ask_me_anything": "403" } },
          (r) => r.reason === undefined && String(r.error).includes("403"),
          "no reconnect reason, message names the 403",
        ],
        [
          "500 on ask",
          { routes: { "/v1/ask_me_anything": "500" } },
          (r) => r.reason === undefined && String(r.error).includes("500"),
          "message names the 500",
        ],
        [
          "malformed ask stream",
          { routes: { "/v1/ask_me_anything": "malformed" } },
          (r) => typeof r.error === "string",
          "an error string",
        ],
        [
          "empty ask body",
          { routes: { "/v1/ask_me_anything": "empty" } },
          (r) => typeof r.error === "string",
          "an error string",
        ],
      ];
      for (const [label, mode, expectation, described] of cases) {
        reset(ctx, mode);
        const accessToken = await validToken(ctx);
        const result = (await watchdog(
          ctx.ada.client.runResearch({
            config: { accessToken, baseUrl: PRODUCTION_BASE_URL },
            matterId: "verify-matter",
            query: QUERY,
            fetchImpl: ctx.fetchImpl,
          }),
          HUNG_MS,
          label,
        )) as Record<string, unknown>;
        t.ok(
          `${label} -> ok:false, ${described}`,
          result.ok === false && expectation(result),
          JSON.stringify(result).slice(0, 200),
        );
        t.ok(
          `${label}: the bearer is not in the error text`,
          !String(result.error).includes(accessToken),
        );
      }
      reset(ctx, { routes: { "/v1/user/modules": "malformed" } });
      const accessToken = await validToken(ctx);
      const degraded = await watchdog(
        ctx.ada.client.runResearch({
          config: { accessToken, baseUrl: PRODUCTION_BASE_URL },
          matterId: "verify-matter",
          query: QUERY,
          fetchImpl: ctx.fetchImpl,
        }),
        HUNG_MS,
        "modules malformed",
      );
      t.ok(
        "a malformed modules list falls back to the catalog and the research still succeeds",
        degraded.ok,
      );
    },
  },
  {
    id: "relogin.auto",
    title:
      "A rejected bearer is renewed silently from the saved password and the call retried once",
    guards: "auto re-login (Lexroom 401 on a saved sign-in)",
    async run(t, ctx) {
      reset(ctx);
      await withBox(
        ctx,
        async (box) => {
          await seedAccount(box, { accessToken: staleToken("auto") });
          const result = (await watchdog(
            ctx.ada.tools.executeAdaResearch({
              args: { matterId: "verify-matter", query: QUERY },
              config,
              api: box.api,
              fetchImpl: ctx.fetchImpl,
            } as never),
            HUNG_MS,
            "executeAdaResearch",
          )) as Record<string, unknown>;
          t.ok(
            "the research succeeds without the lawyer reconnecting",
            result.ok === true,
            JSON.stringify(result).slice(0, 200),
          );
          t.eq("exactly one silent login", count(ctx, "/v1/login", "POST"), 1);
          t.eq("it went through the web flow once", count(ctx, "/api/auth/session", "GET"), 1);
          const asks = ctx.mock.requests().filter((r) => r.path === "/v1/ask_me_anything");
          t.eq(
            "ask went out twice: stale bearer, then the renewed one",
            asks.map((r) => r.bearer),
            ["unknown", "valid"],
          );
          const saved = await box.store.readAccount();
          t.ok(
            "the renewed bearer is what is saved",
            saved?.accessToken === ctx.mock.lastIssuedToken(),
          );
          t.ok(
            "the saved password is kept for the next renewal",
            saved?.password === MOCK_PASSWORD,
          );
        },
        capturedLogs,
      );

      reset(ctx);
      await withBox(
        ctx,
        async (box) => {
          await seedAccount(box, {
            accessToken: expiredToken("exp"),
            accessExpiresAtMs: 1_600_000_000_000,
          });
          const result = (await watchdog(
            ctx.ada.tools.executeAdaResearch({
              args: { matterId: "verify-matter", query: QUERY },
              config,
              api: box.api,
              fetchImpl: ctx.fetchImpl,
            } as never),
            HUNG_MS,
            "executeAdaResearch (expired)",
          )) as Record<string, unknown>;
          t.ok(
            "an expired bearer is renewed before the first call",
            result.ok === true,
            JSON.stringify(result).slice(0, 200),
          );
          t.eq("login ran once", count(ctx, "/v1/login", "POST"), 1);
          t.ok(
            "Lexroom never saw the expired bearer",
            !ctx.mock.requests().some((r) => r.bearer === "unknown"),
          );
        },
        capturedLogs,
      );
    },
  },
  {
    id: "relogin.edges",
    title:
      "Re-login edge cases: 403, wrong password, MFA, captcha, no saved password, stalled login",
    guards: "a 403 must keep the sign-in; a dead sign-in must ask to reconnect; nothing may hang",
    async run(t, ctx) {
      const run = (box: Sandbox) =>
        watchdog(
          ctx.ada.tools.executeAdaResearch({
            args: { matterId: "verify-matter", query: QUERY },
            config,
            api: box.api,
            fetchImpl: ctx.fetchImpl,
          } as never) as Promise<Record<string, unknown>>,
          HUNG_MS,
          "executeAdaResearch",
        );
      const seed = (box: Sandbox, label: string, password?: string) =>
        box.store.upsertAccount({
          email: `lawyer+${label}@example.test`,
          accessToken: staleToken(label),
          password: password ?? MOCK_PASSWORD,
          refreshToken: "",
          accessExpiresAtMs: null,
          connectedAtMs: Date.now(),
        });

      const token = await validToken(ctx);
      reset(ctx, { routes: { "/v1/ask_me_anything": "403" } });
      await withBox(
        ctx,
        async (box) => {
          await box.store.upsertAccount({
            email: "lawyer+403@example.test",
            accessToken: token,
            password: MOCK_PASSWORD,
            refreshToken: "",
            accessExpiresAtMs: null,
            connectedAtMs: Date.now(),
          });
          const result = await run(box);
          t.ok(
            "403 -> ok:false without a reconnect reason",
            result.ok === false && result.reason === undefined,
            JSON.stringify(result).slice(0, 160),
          );
          t.eq("403 triggers no re-login", count(ctx, "/v1/login", "POST"), 0);
          t.eq("403 keeps the saved sign-in", (await box.store.readAccount())?.accessToken, token);
        },
        capturedLogs,
      );

      reset(ctx, { routes: { "/v1/login": "401" } });
      await withBox(
        ctx,
        async (box) => {
          await seed(box, "wrongpw");
          const result = await run(box);
          t.ok(
            "wrong saved password -> ok:false not_connected",
            result.ok === false && result.reason === "not_connected",
            JSON.stringify(result).slice(0, 160),
          );
          t.eq("the dead account is cleared", await box.store.readAccount(), null);
        },
        capturedLogs,
      );

      reset(ctx, { routes: { "/v1/login": "mfa" } });
      await withBox(
        ctx,
        async (box) => {
          await seed(box, "mfa");
          const result = await run(box);
          t.ok(
            "MFA account -> ok:false not_connected, says why",
            result.ok === false &&
              result.reason === "not_connected" &&
              /MFA|one-time/u.test(String(result.error)),
          );
          t.eq("the MFA account is cleared", await box.store.readAccount(), null);
        },
        capturedLogs,
      );

      reset(ctx, { routes: { "/u/login/password": "wrong_password" } });
      await withBox(
        ctx,
        async (box) => {
          await seed(box, "webpw");
          const result = await run(box);
          t.ok(
            "Auth0 says the saved password is wrong -> ok:false not_connected",
            result.ok === false && result.reason === "not_connected",
            JSON.stringify(result).slice(0, 160),
          );
          t.eq("the dead account is cleared", await box.store.readAccount(), null);
        },
        capturedLogs,
      );

      reset(ctx, { routes: { "/u/login/password": "captcha" } });
      await withBox(
        ctx,
        async (box) => {
          await seed(box, "captcha");
          const result = await run(box);
          t.ok(
            "a captcha -> ok:false captcha_required, says why",
            result.ok === false &&
              result.reason === "captcha_required" &&
              /captcha/u.test(String(result.error)),
            JSON.stringify(result).slice(0, 160),
          );
          t.ok("a captcha keeps the saved account", (await box.store.readAccount()) !== null);
        },
        capturedLogs,
      );

      reset(ctx);
      await withBox(
        ctx,
        async (box) => {
          await seed(box, "nopw", "");
          const result = await run(box);
          t.ok(
            "no saved password -> ok:false not_connected",
            result.ok === false && result.reason === "not_connected",
          );
          t.eq("no login was attempted without a password", count(ctx, "/v1/login", "POST"), 0);
        },
        capturedLogs,
      );

      reset(ctx, { routes: { "/v1/login": "stall" } });
      await withBox(
        ctx,
        async (box) => {
          await seed(box, "stall");
          const { value, ms } = await timed(run(box));
          t.ok(
            "a stalled re-login -> ok:false reason timeout",
            value.ok === false && value.reason === "timeout",
            JSON.stringify(value).slice(0, 160),
          );
          t.ok(`it gave up in ${ms}ms`, ms < 12_000);
          t.ok(
            "a timeout does not delete the saved account",
            (await box.store.readAccount()) !== null,
          );
        },
        capturedLogs,
      );
    },
  },
  {
    id: "job.polling",
    title: "ada_research returns a job handle at once; ada_research_status reads the answer",
    guards: "research as a job (#38): a long research must not hold the chat turn",
    async run(t, ctx) {
      reset(ctx, { routes: { "/v1/ask_me_anything": "slow" } });
      await withBox(
        ctx,
        async (box) => {
          await seedAccount(box, { accessToken: await validToken(ctx) });
          const { value: started, ms } = await timed(startResearch(ctx, box));
          const view = started as JobView;
          t.ok(
            "a handle comes back",
            view.ok === true && view.state === "running" && /^rj_/u.test(String(view.jobId)),
          );
          t.ok(`it returned in ${ms}ms, not after the ~2s research`, ms < 1500);
          const jobId = String(view.jobId);
          const early = (await ctx.ada.jobs.readResearchJob({ jobId, waitSeconds: 0 })) as JobView;
          t.eq("an immediate read says running", early.state, "running");
          const done = await readUntilSettled(ctx, jobId);
          t.eq("waiting read ends in done", done.state, "done");
          t.eq("the done result carries the web-app link", done.researchUrl, RESEARCH_URL);
          t.ok("and the answer", typeof done.answer === "string" && done.answer.length > 0);
          const unknown = (await ctx.ada.jobs.readResearchJob({
            jobId: "rj_doesnotexist",
            waitSeconds: 0,
          })) as JobView;
          t.eq("an unknown handle is reported as unknown_job", unknown.reason, "unknown_job");
        },
        capturedLogs,
      );
    },
  },
  {
    id: "job.stall",
    title: "A job whose Lexroom stalls ends as failed with reason timeout, not running forever",
    guards: "unbounded research job",
    async run(t, ctx) {
      reset(ctx, { routes: { "/v1/ask_me_anything": "stall" } });
      await withBox(
        ctx,
        async (box) => {
          await seedAccount(box, { accessToken: await validToken(ctx) });
          const started = (await startResearch(ctx, box)) as JobView;
          t.eq("the job starts", started.state, "running");
          const { value, ms } = await timed(readUntilSettled(ctx, String(started.jobId)));
          t.ok(
            "the job ends failed with reason timeout",
            value.state === "failed" && value.reason === "timeout",
            JSON.stringify(value).slice(0, 200),
          );
          t.ok(`in ${ms}ms`, ms < 10_000);
        },
        capturedLogs,
      );
    },
  },
  {
    id: "link.appended",
    title:
      "The research link is appended to the final reply by code, once, when the model forgot it",
    guards: "#36 -> #37: the link depended on the model remembering and went missing",
    async run(t, ctx) {
      ctx.ada.links.takeResearchLinks("");
      reset(ctx);
      await withBox(
        ctx,
        async (box) => {
          await seedAccount(box, { accessToken: await validToken(ctx) });
          const readJob = async () => {
            const started = (await startResearch(ctx, box)) as JobView;
            return await readUntilSettled(ctx, String(started.jobId));
          };

          const { api, fire } = hookApi();
          ctx.ada.links.registerResearchLinkHooks(api);

          const done = await readJob();
          t.eq("the model read a finished research", done.state, "done");
          const first = await finalReply(fire, MODEL_REPLY);
          t.ok(
            "a final reply without the link gets it appended",
            first?.payload.text.includes(RESEARCH_URL) === true,
            first ? undefined : "hook returned no change",
          );
          t.ok(
            "the original reply text is kept in front",
            first?.payload.text.startsWith(MODEL_REPLY) === true,
          );
          t.eq("the link appears exactly once", first?.payload.text.split(RESEARCH_URL).length, 2);
          const second = await finalReply(fire, "Va bene, a presto.");
          t.eq(
            "the next, unrelated reply is left alone (the link was consumed)",
            second,
            undefined,
          );

          await readJob();
          const already = await finalReply(fire, `${MODEL_REPLY}\n${RESEARCH_URL}`);
          t.eq("a reply that already carries the link is not changed", already, undefined);
          t.eq(
            "and does not leave the link waiting for the next reply",
            await finalReply(fire, MODEL_REPLY),
            undefined,
          );

          await readJob();
          const block = (await fire("reply_payload_sending", {
            kind: "block",
            payload: { text: MODEL_REPLY },
          })) as unknown;
          t.eq("a streamed block is not touched", block, undefined);
          const afterBlock = await finalReply(fire, MODEL_REPLY);
          t.ok(
            "the link is still added to the final reply that follows",
            afterBlock?.payload.text.includes(RESEARCH_URL) === true,
          );

          const fallback = hookApi();
          ctx.ada.links.registerResearchLinkHooks(fallback.api);
          await readJob();
          const viaMessage = (await fallback.fire("message_sending", { content: MODEL_REPLY })) as
            | { content: string }
            | undefined;
          t.ok(
            "when the payload hook never runs, message_sending appends it",
            viaMessage?.content.includes(RESEARCH_URL) === true,
          );

          const none = await finalReply(fire, "NO_REPLY");
          t.eq("NO_REPLY is never given a link", none, undefined);
        },
        capturedLogs,
      );
    },
  },
  {
    id: "push.per-sender",
    title:
      "Ack and result go to the number that asked, each with the link; nobody reads another's job",
    guards: "#38 -> #39: result pushed to the configured lawyer instead of the sender who asked",
    async run(t, ctx) {
      ctx.ada.push.clearHeldResearch();
      ctx.ada.links.takeResearchLinks("");
      reset(ctx, { routes: { "/v1/ask_me_anything": "slow" } });
      await withBox(
        ctx,
        async (box) => {
          await seedAccount(box, { accessToken: await validToken(ctx) });
          const wa = fakeWhatsApp(ctx.ada);
          const depsFor = wa.depsFor as never;
          const [a, b] = (await Promise.all([
            startResearch(ctx, box, SENDER_A, depsFor),
            startResearch(ctx, box, SENDER_B, depsFor),
          ])) as JobView[];
          t.ok(
            "both starts return a handle and say the requester was told",
            a?.ok === true &&
              b?.ok === true &&
              a.requesterNotified === true &&
              b.requesterNotified === true,
          );
          t.eq(
            "A got exactly one message so far (the ack), while the research still runs",
            wa.to(NUMBER_A).length,
            1,
          );
          t.eq("B got exactly one message so far (the ack)", wa.to(NUMBER_B).length, 1);

          await readUntilSettled(ctx, String(a?.jobId), NUMBER_A);
          await readUntilSettled(ctx, String(b?.jobId), NUMBER_B);
          for (
            let i = 0;
            i < 60 && (wa.to(NUMBER_A).length < 2 || wa.to(NUMBER_B).length < 2);
            i += 1
          ) {
            await sleep(50);
          }
          const countA = wa.to(NUMBER_A).length;
          const countB = wa.to(NUMBER_B).length;
          t.ok(
            "each number received the ack plus its own result (more than just the ack)",
            countA >= 2 && countB >= 2,
            `A=${countA} B=${countB}`,
          );
          t.ok(
            "both identical researches produced the same number of messages for each asker, none went to the other",
            countA === countB,
            `A=${countA} B=${countB}`,
          );
          for (const [name, number] of [
            ["A", NUMBER_A],
            ["B", NUMBER_B],
          ] as const) {
            t.ok(
              `${name}'s last message carries the research link`,
              wa.to(number).at(-1)?.includes(RESEARCH_URL) === true,
            );
          }
          const foreign = (await ctx.ada.jobs.readResearchJob({
            jobId: String(a?.jobId),
            requester: NUMBER_B,
            waitSeconds: 0,
          })) as JobView;
          t.eq("B cannot read A's job", foreign.reason, "unknown_job");
          const own = (await ctx.ada.jobs.readResearchJob({
            jobId: String(a?.jobId),
            requester: NUMBER_A,
            waitSeconds: 0,
          })) as JobView;
          t.eq("A reads their job as delivered", own.state, "delivered");
          t.ok("and the status does not hand the model the answer to repeat", !("answer" in own));

          const before = [...wa.sent.values()].flat().length;
          const group = (await startResearch(
            ctx,
            box,
            { ...SENDER_A, conversationId: "120363000000000000@g.us" },
            depsFor,
          )) as JobView;
          t.ok(
            "in a group chat nothing is pushed and the requester is not marked notified",
            group.ok === true && group.requesterNotified === undefined,
          );
          t.eq(
            "no WhatsApp message left Ada for the group request",
            [...wa.sent.values()].flat().length,
            before,
          );
          await readUntilSettled(ctx, String(group.jobId));
        },
        capturedLogs,
      );
    },
  },
];
