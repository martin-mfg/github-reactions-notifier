import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest for stored GitHub access tokens (NFR-3), adapted from github-stats-extended
 * PR #536. Stricter than that PR: a key is mandatory, and there is no plaintext fallback or
 * legacy read path.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/** Marks a value as encrypted and versions the format. */
const PREFIX = "v1.";

/** A token as stored: `tokenEnc` is `v1.<auth tag>.<ciphertext>`, `tokenNonce` the IV (base64). */
interface EncryptedToken {
  tokenEnc: string;
  tokenNonce: string;
}

/** The stored token is unreadable: the user has to sign in again. */
class TokenDecryptionError extends Error {
  override name = "TokenDecryptionError";
}

/**
 * @param value Comma-separated keys, each 32 bytes as hex or base64.
 * @returns The keys, in order.
 */
const parseKeys = (value: string): Array<Buffer> =>
  value
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)
    .map((key) => {
      const bytes = Buffer.from(key, HEX_KEY.test(key) ? "hex" : "base64");
      if (bytes.length !== KEY_BYTES) {
        throw new Error(
          `Invalid TOKEN_ENCRYPTION_KEY: expected ${KEY_BYTES} bytes (base64 or hex), got ${bytes.length}`,
        );
      }
      return bytes;
    });

/**
 * AES-256-GCM cipher for stored GitHub access tokens. The user id is the AAD, so a ciphertext
 * cannot be moved to another user's row. The first key encrypts, every key decrypts (rotation).
 */
class AccessTokenCipher {
  readonly #keys: Array<Buffer>;

  /**
   * @param keys First key encrypts, all decrypt. At least one is required.
   */
  constructor(keys: Array<Buffer>) {
    if (keys.length === 0) {
      throw new Error("TOKEN_ENCRYPTION_KEY is not set");
    }
    this.#keys = keys;
  }

  /**
   * @param env Environment to read `TOKEN_ENCRYPTION_KEY` from.
   * @returns Cipher for `TOKEN_ENCRYPTION_KEY`. Throws if it is missing or invalid.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): AccessTokenCipher {
    return new AccessTokenCipher(parseKeys(env["TOKEN_ENCRYPTION_KEY"] ?? ""));
  }

  /**
   * @param token Plaintext GitHub access token.
   * @param userId Owner of the token, bound to the ciphertext as AAD.
   * @returns The values to store.
   */
  encrypt(token: string, userId: string): EncryptedToken {
    const [key] = this.#keys;
    if (!key) {
      throw new Error("TOKEN_ENCRYPTION_KEY is not set");
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv).setAAD(
      Buffer.from(userId),
    );
    const ciphertext = Buffer.concat([cipher.update(token), cipher.final()]);
    return {
      tokenEnc: `${PREFIX}${cipher.getAuthTag().toString("base64")}.${ciphertext.toString("base64")}`,
      tokenNonce: iv.toString("base64"),
    };
  }

  /**
   * @param stored The stored values.
   * @param userId Owner of the row.
   * @returns Plaintext GitHub access token.
   * @throws {TokenDecryptionError} The value is malformed, or no key authenticates it.
   */
  decrypt(stored: EncryptedToken, userId: string): string {
    const parts = stored.tokenEnc.startsWith(PREFIX)
      ? stored.tokenEnc.slice(PREFIX.length).split(".")
      : [];
    if (parts.length !== 2) {
      throw new TokenDecryptionError("Malformed encrypted access token");
    }
    const [authTag, ciphertext] = parts.map((part) =>
      Buffer.from(part, "base64"),
    );
    const iv = Buffer.from(stored.tokenNonce, "base64");
    if (!authTag || !ciphertext || iv.length !== IV_BYTES) {
      throw new TokenDecryptionError("Malformed encrypted access token");
    }

    for (const key of this.#keys) {
      try {
        const decipher = createDecipheriv(ALGORITHM, key, iv)
          .setAAD(Buffer.from(userId))
          .setAuthTag(authTag);
        return Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]).toString();
      } catch {
        // wrong key, try the next one
      }
    }
    throw new TokenDecryptionError(
      "Failed to decrypt the stored access token: no key in TOKEN_ENCRYPTION_KEY matches",
    );
  }
}

export { AccessTokenCipher, TokenDecryptionError };
export type { EncryptedToken };
