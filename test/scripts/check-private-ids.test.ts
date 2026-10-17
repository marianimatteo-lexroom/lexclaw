import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  emptyAllowlist,
  findPrivateIdsInTrackedFiles,
  maskShape,
  parseAllowlist,
  scanText,
} from "../../scripts/check-private-ids.mjs";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/check-private-ids.mjs",
);

// Synthetic, built from parts so no real-looking literal sits in this file. The phone numbers use
// the UK drama-reserved range; none of these belong to a person or a service.
const join = (...parts: string[]) => parts.join("");
const SYNTHETIC = {
  phone: join("+44", "7700", "900123"),
  phoneSpaced: "+44 7700 900 123",
  jid: join("44", "7700", "900123", "@s.whatsapp.net"),
  groupJid: join("1203", "6302", "4681357924", "@g.us"),
  email: join("maria.rossi", "@", "studio-fictional", ".it"),
  githubToken: join("ghp_", "aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1eF3hJ5"),
  jwt: [
    join("eyJ", "hbGciOiJIUzI1NiJ9"),
    join("eyJ", "zdWIiOiJzeW50aGV0aWMifQ"),
    "c2lnbmF0dXJlLXN5bnRoZXRpYw",
  ].join("."),
  uuid: "9f1c2a7e-4b3d-4e8a-a6c5-3d2b1f0e9a87",
  apiKeyAssignment: join('apiKey: "', "Xq7Zp2Lk9Vw4Rt8Mn3Yb6Hc1Sd5Fg0Ja", '"'),
  host: join("https://", "ada.fictional-firm", ".legal/callback"),
  railwayHost: join("https://", "ada-production-ab12", ".up.railway.app"),
  metaId: join('phone_number_id: "', "618273940516273", '"'),
};

function values(text: string) {
  return scanText(text, emptyAllowlist());
}

describe("check-private-ids", () => {
  it.each([
    ["phone-e164", `call ${SYNTHETIC.phone} now`],
    ["phone-e164", `call ${SYNTHETIC.phoneSpaced} now`],
    ["phone-e164", `https://wa.me/${SYNTHETIC.phone.slice(1)}`],
    ["whatsapp-jid", `to: "${SYNTHETIC.jid}"`],
    ["whatsapp-jid", `to: "${SYNTHETIC.groupJid}"`],
    ["email", `from ${SYNTHETIC.email}`],
    ["token", `token ${SYNTHETIC.githubToken}`],
    ["token", `jwt ${SYNTHETIC.jwt}`],
    ["token", SYNTHETIC.apiKeyAssignment],
    ["uuid", `project ${SYNTHETIC.uuid}`],
    ["host", `origin ${SYNTHETIC.host}`],
    ["infra-host", `origin ${SYNTHETIC.railwayHost}`],
    ["meta-id", SYNTHETIC.metaId],
  ])("flags %s shapes", (rule, line) => {
    const findings = values(line);
    expect(findings.map((finding) => finding.rule)).toContain(rule);
  });

  it("accepts placeholders, reserved domains, dummies and version strings", () => {
    const placeholders = [
      "+390000000001",
      "+39 000 000 0001",
      "+12125550123",
      "+1234567890123",
      "390000000001@s.whatsapp.net",
      "120363000000000000@g.us",
      "someone@example.com",
      "someone@pec.example.test",
      "a@b.it",
      "project@sandbox.invalid",
      "00000000-0000-0000-0000-000000000001",
      "11111111-2222-3333-4444-555555555555",
      "Authorization: Bearer test-token-for-unit-tests-1234",
      'token: "test-token-for-unit-tests-1234"',
      "const STATIC_TOKEN = 'static-secret-token-0123456789';",
      "https://example.com/path https://api.example.test http://127.0.0.1:8080 http://localhost:3000",
      "https://www.googleapis.com/gmail/v1 https://app.lexroom.ai/home https://ada.up.railway.app.example",
      "pkg@1.2.3 name@2026.10.3 +1.5 1e+10 a+b+1234567890123456789",
      "phone_number_id: <KAPSO_PHONE_NUMBER_ID> waba_id: 000000000000001",
    ];
    for (const line of placeholders) {
      expect(values(line), line).toStrictEqual([]);
    }
  });

  it("honors the inline marker and the allowlist", () => {
    const line = `from ${SYNTHETIC.email} to ${SYNTHETIC.phone}`;
    expect(values(`${line} // private-ids:allow`)).toStrictEqual([]);

    const allowlist = parseAllowlist({
      domains: ["studio-fictional.it", "fictional-firm.legal"],
      values: [SYNTHETIC.phone],
    });
    expect(scanText(line, allowlist)).toStrictEqual([]);
    expect(scanText(`origin ${SYNTHETIC.host}`, allowlist)).toStrictEqual([]);
    expect(scanText(`origin ${SYNTHETIC.phoneSpaced}`, allowlist)).toHaveLength(1);
  });

  it("rejects a malformed allowlist", () => {
    expect(() => parseAllowlist({ domains: "example.com" })).toThrow(/domains/);
    expect(() => parseAllowlist([])).toThrow(/object/);
  });

  it("reports a masked shape, never the value", () => {
    const text = `a ${SYNTHETIC.email} b ${SYNTHETIC.phone} c ${SYNTHETIC.githubToken}`;
    const serialized = JSON.stringify(values(text));
    for (const secret of [SYNTHETIC.email, SYNTHETIC.phone, SYNTHETIC.githubToken]) {
      expect(serialized).not.toContain(secret);
    }
    expect(maskShape(SYNTHETIC.phone)).toBe("+999999999999");
  });

  describe("on a tracked tree", () => {
    function createRepository(files: Record<string, string | Buffer>): string {
      const rootDir = createTempDir("openclaw-private-ids-");
      execFileSync("git", ["init", "-q"], { cwd: rootDir });
      for (const [file, content] of Object.entries(files)) {
        const filePath = path.join(rootDir, file);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      }
      execFileSync("git", ["add", "--", ...Object.keys(files)], { cwd: rootDir });
      return rootDir;
    }

    it("scans only Ada's surface and skips binary files and allowlisted paths", () => {
      const rootDir = createRepository({
        "extensions/ada/src/leak.test.ts": `const to = "${SYNTHETIC.jid}";\n`,
        "extensions/ada/src/ok.test.ts": 'const to = "390000000001@s.whatsapp.net";\n',
        "extensions/ada/src/test-fixtures/capture.json": `{"email":"${SYNTHETIC.email}"}\n`,
        "extensions/ada/src/image.bin": Buffer.from(`${SYNTHETIC.phone}\0`),
        "extensions/other/leak.ts": `const to = "${SYNTHETIC.jid}";\n`,
        "PROGRESS.md": `Sender ${SYNTHETIC.phoneSpaced}\n`,
      });

      const result = findPrivateIdsInTrackedFiles({
        cwd: rootDir,
        allowlist: parseAllowlist({ paths: ["extensions/ada/src/test-fixtures/"] }),
      });
      expect(
        result.findings.map(({ filePath, rule, line }) => ({ filePath, rule, line })),
      ).toStrictEqual([
        { filePath: "PROGRESS.md", rule: "phone-e164", line: 1 },
        { filePath: "extensions/ada/src/leak.test.ts", rule: "whatsapp-jid", line: 1 },
      ]);
    });

    it("exits 1 without printing the value, and 0 on a clean tree", () => {
      const dirty = createRepository({
        "extensions/ada/src/leak.test.ts": `const to = "${SYNTHETIC.jid}";\n`,
      });
      const failed = spawnSync(process.execPath, [scriptPath], { cwd: dirty, encoding: "utf8" });
      expect(failed.status).toBe(1);
      expect(failed.stderr).toContain("extensions/ada/src/leak.test.ts:1:");
      expect(failed.stderr).toContain("whatsapp-jid");
      expect(failed.stderr).not.toContain(SYNTHETIC.jid);
      expect(failed.stderr).not.toContain(SYNTHETIC.jid.split("@")[0]);

      const clean = createRepository({
        "extensions/ada/src/ok.test.ts": 'const to = "390000000001@s.whatsapp.net";\n',
      });
      const passed = spawnSync(process.execPath, [scriptPath], { cwd: clean, encoding: "utf8" });
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain("ok (1 files scanned)");
    });
  });
});
