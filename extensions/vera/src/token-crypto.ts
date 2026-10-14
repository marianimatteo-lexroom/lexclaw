import crypto from "node:crypto";

export const VERA_TOKEN_KEY_ENV = "VERA_TOKEN_KEY";

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type TokenCipher = {
  /** Encrypts for storage. Without a key (non-production only) the value stays plaintext. */
  seal(plaintext: string, context: string): string;
  /** Decrypts a stored value. `legacy` is true when the row was plaintext and should be re-written. */
  open(stored: string, context: string): { value: string; legacy: boolean };
  /** True when seal() actually encrypts. */
  readonly encrypting: boolean;
};

function parseKey(raw: string): Buffer {
  const text = raw.trim();
  const decoded = /^[0-9a-fA-F]{64}$/u.test(text)
    ? Buffer.from(text, "hex")
    : Buffer.from(text, /^[A-Za-z0-9+/]+=*$/u.test(text) ? "base64" : "base64url");
  if (decoded.length !== KEY_BYTES) {
    throw new Error(
      `${VERA_TOKEN_KEY_ENV} must be 32 bytes encoded as 64 hex characters or base64 (generate one with: openssl rand -base64 32).`,
    );
  }
  return decoded;
}

export function isSealedToken(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/**
 * AES-256-GCM for OAuth tokens at rest. The row's table and column are bound as
 * additional authenticated data so a sealed value cannot be moved to another column.
 * Production (`NODE_ENV=production`) refuses to run without a key; other
 * environments keep plaintext so local development needs no setup.
 */
export function resolveTokenCipher(env: NodeJS.ProcessEnv = process.env): TokenCipher {
  const raw = env[VERA_TOKEN_KEY_ENV]?.trim();
  if (!raw && env.NODE_ENV === "production") {
    throw new Error(
      `${VERA_TOKEN_KEY_ENV} is required in production to encrypt Vera Google and Lexroom tokens at rest. Set it to 32 random bytes (openssl rand -base64 32).`,
    );
  }
  const key = raw ? parseKey(raw) : null;

  return {
    encrypting: key !== null,
    seal(plaintext, context) {
      if (!key) {
        return plaintext;
      }
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    },
    open(stored, context) {
      if (!isSealedToken(stored)) {
        return { value: stored, legacy: true };
      }
      if (!key) {
        throw new Error(
          `${VERA_TOKEN_KEY_ENV} is not set, but stored Vera tokens are encrypted. Restore the key used to encrypt them.`,
        );
      }
      const packed = Buffer.from(stored.slice(PREFIX.length), "base64");
      if (packed.length < IV_BYTES + TAG_BYTES) {
        throw new Error("Stored Vera token is malformed.");
      }
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, packed.subarray(0, IV_BYTES), {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      try {
        const value = Buffer.concat([
          decipher.update(packed.subarray(IV_BYTES + TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
        return { value, legacy: false };
      } catch {
        throw new Error(
          `Could not decrypt a stored Vera token. ${VERA_TOKEN_KEY_ENV} differs from the key that encrypted it.`,
        );
      }
    },
  };
}
