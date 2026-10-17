// The live step: ONE real login and ONE real research query against live Lexroom, with the
// +verus account. Credentials come from the environment only and are never printed, logged
// or written; every string that leaves this file goes through maskSecrets.
import { type Ada, maskEmail, maskSecrets, PRODUCTION_BASE_URL } from "./lib.mts";

export const LIVE_ENV = {
  email: "ADA_VERIFY_LEXROOM_EMAIL",
  password: "ADA_VERIFY_LEXROOM_PASSWORD",
  baseUrl: "ADA_VERIFY_LEXROOM_BASE_URL",
} as const;

const LIVE_QUERY = "Qual è il termine per proporre opposizione a decreto ingiuntivo?";

export type LiveResult = {
  status: "pass" | "fail" | "skip";
  /** Lines safe to print and store: no credential, token, phone number or answer text. */
  lines: string[];
};

function present(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

export async function runLive(ada: Ada): Promise<LiveResult> {
  const email = present(LIVE_ENV.email);
  const password = present(LIVE_ENV.password);
  if (!email || !password) {
    return {
      status: "skip",
      lines: [
        `ADVISORY: live step skipped. ${LIVE_ENV.email} and ${LIVE_ENV.password} are not both set in this environment, so no real Lexroom request was made and nothing below is a live result.`,
        `Set them to the +verus account's sign-in to run one real research query per run.`,
      ],
    };
  }
  const baseUrl = present(LIVE_ENV.baseUrl) ?? PRODUCTION_BASE_URL;
  const secrets = [email, password];
  const safe = (text: string) => maskSecrets(text, secrets);
  const lines = [`account: ${maskEmail(email)}   target: ${new URL(baseUrl).host}`];
  const previousLimit = process.env.ADA_LEXROOM_TIMEOUT_MS;
  delete process.env.ADA_LEXROOM_TIMEOUT_MS;
  try {
    const startedAt = Date.now();
    const login = await ada.login.loginLexroomAccount({
      email,
      password,
      baseUrl,
      timeoutMs: 30_000,
    });
    if (!login.ok) {
      lines.push(`FAIL login: ${login.reason}: ${safe(login.error)}`);
      return { status: "fail", lines };
    }
    secrets.push(login.accessToken);
    lines.push(`login ok in ${Date.now() - startedAt}ms (bearer received, not shown)`);

    const researchStartedAt = Date.now();
    const result = await ada.client.runResearch({
      config: {
        accessToken: login.accessToken,
        baseUrl,
        timeoutMs: 240_000,
        idleTimeoutMs: 60_000,
        answerTimeoutMs: 90_000,
      },
      matterId: "verify-ada-live",
      query: LIVE_QUERY,
    });
    const ms = Date.now() - researchStartedAt;
    if (!result.ok) {
      const reason = "reason" in result && result.reason ? ` (${result.reason})` : "";
      lines.push(`FAIL research${reason} after ${ms}ms: ${safe(result.error)}`);
      return { status: "fail", lines };
    }
    const link = result.researchUrl ? safe(result.researchUrl) : undefined;
    const maskedLink = link?.replace(/(\/research\/)([A-Za-z0-9]{4})[A-Za-z0-9]*/u, "$1$2***");
    lines.push(
      `research ok in ${ms}ms: status=${result.status} answerChars=${result.answer.length} sources=${result.sources.length}`,
      `research link built: ${maskedLink ?? "none"}`,
    );
    const problems = [
      result.answer.trim() ? undefined : "empty answer",
      result.researchId ? undefined : "no research id in the stream",
      result.researchUrl || !new URL(baseUrl).hostname.endsWith("lexroom.ai")
        ? undefined
        : "no research link built",
    ].filter((p): p is string => p !== undefined);
    if (problems.length > 0) {
      lines.push(`FAIL live research returned an unexpected shape: ${problems.join(", ")}`);
      return { status: "fail", lines };
    }
    return { status: "pass", lines };
  } catch (error) {
    lines.push(
      `FAIL live step crashed: ${safe(error instanceof Error ? error.message : String(error))}`,
    );
    return { status: "fail", lines };
  } finally {
    if (previousLimit !== undefined) {
      process.env.ADA_LEXROOM_TIMEOUT_MS = previousLimit;
    }
  }
}
