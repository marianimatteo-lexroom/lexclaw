#!/usr/bin/env node

// Fails on private-looking identifiers (phone numbers, WhatsApp JIDs, real-looking
// emails, token-like strings, infra IDs) in tracked files on Ada's surface.
//
// The check is shape-based: it never embeds a real value, and it never prints one.
// Findings are reported as `path:line:column rule` plus a masked shape and the
// placeholder to use instead.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Tracked paths (git pathspecs) that make up Ada's surface. */
export const DEFAULT_SURFACE = [
  "extensions/ada",
  "deploy/railway",
  "PROGRESS.md",
  "test/scripts/ada-*",
  ".github/workflows/ada-ci.yml",
];

export const ALLOWLIST_PATH = "scripts/check-private-ids.allowlist.json";
export const INLINE_ALLOW_MARKER = "private-ids:allow";

const MAX_FILE_BYTES = 1_000_000;

/** Domains that are reserved or documentation-only, so they never name a real mailbox. */
const RESERVED_EMAIL_DOMAIN =
  /(^|\.)(example(\.(com|org|net|edu))?|test|invalid|localhost|local)$/i;

/** Messaging addresses that look like emails but are WhatsApp JID suffixes (covered by the JID rule). */
const JID_DOMAIN = /^(s\.whatsapp\.net|c\.us|g\.us|lid|broadcast)$/i;

/** Public vendor and tooling hosts Ada talks to; a URL on any other registrable domain is flagged. */
const PUBLIC_HOST_DOMAINS = [
  "googleapis.com",
  "google.com",
  "github.com",
  "githubusercontent.com",
  "railway.app",
  "railway.com",
  "kapso.ai",
  "lexroom.ai",
  "openclaw.ai",
  "openclaw.dev",
  "npmjs.org",
  "nodejs.org",
  "w3.org",
  "json-schema.org",
];

/** TLDs the host rule recognizes, so dotted identifiers that merely look like hosts stay quiet. */
const HOST_TLD =
  /^(com|net|org|io|ai|it|dev|app|co|eu|de|fr|uk|us|me|xyz|cloud|legal|law|tech|info|biz|so|sh)$/i;

const PLACEHOLDER_HINTS = {
  "whatsapp-jid": "use a placeholder such as 390000000001@s.whatsapp.net",
  "phone-e164": "use a placeholder such as +390000000001",
  email: "use a reserved domain such as someone@example.com",
  token: "use an obvious dummy such as <TOKEN> or test-token",
  host: "use a reserved host such as ada.example.com",
  uuid: "use 00000000-0000-0000-0000-000000000001 or <ID>",
  "infra-host": "use <SERVICE_HOST> or ada.example.com",
  "meta-id": "use 000000000000001 or <ID>",
};

/**
 * @typedef {{ rule: string; line: number; column: number; shape: string }} Finding
 * @typedef {{ domains: string[]; values: string[]; paths: string[] }} Allowlist
 */

/** @returns {Allowlist} */
export function emptyAllowlist() {
  return { domains: [], values: [], paths: [] };
}

/**
 * @param {unknown} raw
 * @returns {Allowlist}
 */
export function parseAllowlist(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("allowlist must be a JSON object");
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  const allowlist = emptyAllowlist();
  for (const key of /** @type {const} */ (["domains", "values", "paths"])) {
    const entries = record[key] ?? [];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== "string")) {
      throw new Error(`allowlist.${key} must be an array of strings`);
    }
    allowlist[key] = /** @type {string[]} */ (entries).map((entry) => entry.trim());
  }
  return allowlist;
}

/**
 * @param {string} cwd
 * @returns {Allowlist}
 */
export function loadAllowlist(cwd) {
  const file = path.join(cwd, ALLOWLIST_PATH);
  if (!fs.existsSync(file)) {
    return emptyAllowlist();
  }
  return parseAllowlist(JSON.parse(fs.readFileSync(file, "utf8")));
}

/**
 * A value is a placeholder when it is visibly synthetic: few distinct characters
 * (`0000000001`), or a long ascending run (`1234567890`).
 * @param {string} chars
 */
function isLowEntropy(chars) {
  const lower = chars.toLowerCase();
  if (new Set(lower).size <= 3) {
    return true;
  }
  let run = 1;
  for (let i = 1; i < lower.length; i += 1) {
    run = lower.charCodeAt(i) === lower.charCodeAt(i - 1) + 1 ? run + 1 : 1;
    if (run >= 7) {
      return true;
    }
  }
  return false;
}

/**
 * Phone digits: the first two are usually the country code and say nothing about
 * whether the rest is synthetic, so judge the remainder.
 * @param {string} digits
 */
function isPlaceholderPhone(digits) {
  if (/555-?01\d\d$/.test(digits)) {
    return true;
  }
  return isLowEntropy(digits.slice(2));
}

/** @param {string} uuid */
function isPlaceholderUuid(uuid) {
  const groups = uuid.split("-");
  if (groups.every((group) => new Set(group.toLowerCase()).size === 1)) {
    return true;
  }
  return isLowEntropy(groups.join(""));
}

/**
 * Dummies read as words ("test-token-for-unit-tests-1234"); real secrets do not.
 * @param {string} value
 */
function looksLikeRandomSecret(value) {
  const words = value.split(/[^A-Za-z0-9]+/).filter((part) => /^[a-z]{3,}$/.test(part));
  return (
    words.length < 2 && shannonEntropy(value) >= 3.8 && /\d/.test(value) && /[A-Za-z]/.test(value)
  );
}

/** @param {string} value */
function shannonEntropy(value) {
  const counts = new Map();
  for (const char of value) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * Masks a value so a finding is locatable without reproducing it.
 * @param {string} value
 */
export function maskShape(value) {
  return value.replace(/[0-9]/g, "9").replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a");
}

/**
 * @typedef {{
 *   rule: string;
 *   pattern: RegExp;
 *   group?: number;
 *   isAllowed: (match: RegExpExecArray, allowlist: Allowlist) => boolean;
 * }} Detector
 */

/** @param {string} value @param {Allowlist} allowlist */
function isAllowlistedValue(value, allowlist) {
  const lower = value.toLowerCase();
  return allowlist.values.some((entry) => entry.toLowerCase() === lower);
}

/** @type {Detector[]} */
const DETECTORS = [
  {
    rule: "whatsapp-jid",
    pattern: /\b(\d{6,}(?:-\d+)?)@(?:s\.whatsapp\.net|c\.us|g\.us|lid|broadcast)\b/gi,
    group: 1,
    isAllowed: (match, allowlist) =>
      isAllowlistedValue(match[0], allowlist) ||
      isPlaceholderPhone(match[1].replace(/\D/g, "").slice(0, 15)),
  },
  {
    rule: "phone-e164",
    // `+` then 9-15 digits, optionally grouped by spaces, dots or dashes. wa.me links carry the number without `+`.
    pattern: /(?<![\w+)\]])\+([1-9](?:[ .-]?\(?\d\)?){8,14})(?!\d)|\bwa\.me\/(\d{8,15})\b/g,
    group: 0,
    isAllowed: (match, allowlist) => {
      const digits = (match[1] ?? match[2]).replace(/\D/g, "");
      return (
        digits.length < 9 ||
        digits.length > 15 ||
        isAllowlistedValue(match[0], allowlist) ||
        isPlaceholderPhone(digits)
      );
    },
  },
  {
    rule: "email",
    pattern: /\b[A-Za-z0-9._%+-]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})\b/g,
    group: 0,
    isAllowed: (match, allowlist) => {
      const domain = match[1].toLowerCase();
      const labels = domain.split(".");
      return (
        JID_DOMAIN.test(domain) ||
        RESERVED_EMAIL_DOMAIN.test(domain) ||
        // `a@b.it`: a one-letter registrable label is only ever used as a stand-in.
        (labels.length === 2 && labels[0].length === 1) ||
        allowlist.domains.some((entry) => {
          const allowed = entry.toLowerCase();
          return domain === allowed || domain.endsWith(`.${allowed}`);
        }) ||
        isAllowlistedValue(match[0], allowlist)
      );
    },
  },
  {
    rule: "token",
    pattern: new RegExp(
      [
        String.raw`\bsk-[A-Za-z0-9_-]{20,}`,
        String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
        String.raw`\bgithub_pat_[A-Za-z0-9_]{30,}`,
        String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
        String.raw`\bAIza[0-9A-Za-z_-]{35}`,
        String.raw`\bya29\.[0-9A-Za-z_-]{20,}`,
        String.raw`\bGOCSPX-[0-9A-Za-z_-]{20,}`,
        String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`,
        String.raw`\b\d{8,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com`,
        String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
        String.raw`\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
        String.raw`\bBearer\s+([A-Za-z0-9._~+/-]{24,}=*)`,
        // name = "<high-entropy blob>" for secret-named keys
        String.raw`(?:secret|token|password|passwd|api[_-]?key|credential|private[_-]?key)\w*["']?\s*[:=]\s*["'\x60]([A-Za-z0-9+/_=-]{24,})["'\x60]`,
      ].join("|"),
      "gi",
    ),
    group: 0,
    isAllowed: (match, allowlist) => {
      const loose = match[1] ?? match[2];
      if (loose !== undefined) {
        return !looksLikeRandomSecret(loose) || isAllowlistedValue(loose, allowlist);
      }
      return isAllowlistedValue(match[0], allowlist);
    },
  },
  {
    rule: "host",
    pattern: /\bhttps?:\/\/((?:[A-Za-z0-9-]+\.)+([A-Za-z]{2,}))\b/gi,
    group: 1,
    isAllowed: (match, allowlist) => {
      const host = match[1].toLowerCase();
      const covers = (/** @type {string} */ domain) =>
        host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`);
      return (
        !HOST_TLD.test(match[2]) ||
        RESERVED_EMAIL_DOMAIN.test(host) ||
        PUBLIC_HOST_DOMAINS.some(covers) ||
        allowlist.domains.some(covers) ||
        isAllowlistedValue(host, allowlist)
      );
    },
  },
  {
    rule: "uuid",
    pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    group: 0,
    isAllowed: (match, allowlist) =>
      isPlaceholderUuid(match[0]) || isAllowlistedValue(match[0], allowlist),
  },
  {
    rule: "infra-host",
    pattern: /\b[a-z0-9][a-z0-9-]*\.up\.railway\.app(?![\w-]|\.[a-z])/gi,
    group: 0,
    isAllowed: (match, allowlist) =>
      /(?:example|placeholder|your|<)/i.test(match[0]) || isAllowlistedValue(match[0], allowlist),
  },
  {
    rule: "meta-id",
    pattern:
      /\b(?:phone[_-]?number[_-]?id|waba[_-]?id|business[_-]?account[_-]?id)\w*["']?\s*[:=]\s*["'\x60]?(\d{10,})\b/gi,
    group: 1,
    isAllowed: (match, allowlist) =>
      isLowEntropy(match[1]) || isAllowlistedValue(match[1], allowlist),
  },
];

/**
 * Scans text and returns findings. Findings carry a masked shape, never the value.
 * @param {string} text
 * @param {Allowlist} [allowlist]
 * @returns {Finding[]}
 */
export function scanText(text, allowlist = emptyAllowlist()) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes(INLINE_ALLOW_MARKER)) {
      continue;
    }
    for (const detector of DETECTORS) {
      detector.pattern.lastIndex = 0;
      for (const match of line.matchAll(detector.pattern)) {
        if (detector.isAllowed(match, allowlist)) {
          continue;
        }
        const value = match[detector.group ?? 0] ?? match[0];
        findings.push({
          rule: detector.rule,
          line: index + 1,
          column: (match.index ?? 0) + 1,
          shape: maskShape(value),
        });
      }
    }
  }
  return findings;
}

/**
 * @param {string} relativePath
 * @param {Allowlist} allowlist
 */
function isAllowlistedPath(relativePath, allowlist) {
  return allowlist.paths.some((entry) =>
    entry.endsWith("/") ? relativePath.startsWith(entry) : relativePath === entry,
  );
}

/**
 * Lists tracked files for the given pathspecs.
 * @param {string} cwd
 * @param {string[]} pathspecs
 * @returns {string[]}
 */
export function listTrackedFiles(cwd, pathspecs) {
  const result = spawnSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr?.toString("utf8").trim() || "git ls-files failed");
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter((entry) => entry.length > 0);
}

/**
 * @param {{ cwd?: string; pathspecs?: string[]; allowlist?: Allowlist }} [options]
 * @returns {{ filesScanned: number; findings: Array<Finding & { filePath: string }> }}
 */
export function findPrivateIdsInTrackedFiles(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const allowlist = options.allowlist ?? loadAllowlist(cwd);
  const files = listTrackedFiles(cwd, options.pathspecs ?? DEFAULT_SURFACE);
  /** @type {Array<Finding & { filePath: string }>} */
  const findings = [];
  let filesScanned = 0;
  for (const filePath of files) {
    if (isAllowlistedPath(filePath, allowlist)) {
      continue;
    }
    const absolute = path.join(cwd, filePath);
    let buffer;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
        continue;
      }
      buffer = fs.readFileSync(absolute);
    } catch {
      continue;
    }
    if (buffer.includes(0)) {
      continue;
    }
    filesScanned += 1;
    for (const finding of scanText(buffer.toString("utf8"), allowlist)) {
      findings.push({ filePath, ...finding });
    }
  }
  return { filesScanned, findings };
}

/**
 * @param {string[]} argv
 */
export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const pathspecs = argv.filter((arg) => !arg.startsWith("--"));
  const { filesScanned, findings } = findPrivateIdsInTrackedFiles({
    pathspecs: pathspecs.length > 0 ? pathspecs : undefined,
  });

  /** @type {Record<string, number>} */
  const byRule = {};
  /** @type {Record<string, number>} */
  const byFile = {};
  for (const finding of findings) {
    byRule[finding.rule] = (byRule[finding.rule] ?? 0) + 1;
    byFile[finding.filePath] = (byFile[finding.filePath] ?? 0) + 1;
  }

  if (json) {
    console.log(JSON.stringify({ filesScanned, total: findings.length, byRule, byFile }, null, 2));
    return findings.length === 0 ? 0 : 1;
  }
  if (findings.length === 0) {
    console.log(`check-private-ids: ok (${filesScanned} files scanned)`);
    return 0;
  }

  console.error(
    `check-private-ids: ${findings.length} private-looking identifier(s) in ${Object.keys(byFile).length} file(s). Values are masked on purpose.`,
  );
  for (const finding of findings) {
    console.error(
      `- ${finding.filePath}:${finding.line}:${finding.column} ${finding.rule} ${finding.shape} -> ${PLACEHOLDER_HINTS[finding.rule]}`,
    );
  }
  console.error(
    `Replace each with a placeholder. For a deliberate exception add ${INLINE_ALLOW_MARKER} to the line, or list a placeholder domain, placeholder value or fixture directory in ${ALLOWLIST_PATH}.`,
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
