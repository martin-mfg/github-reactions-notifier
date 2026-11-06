import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption at rest for stored GitHub access tokens (NFR-3), adapted from github-stats-extended
 * PR #536. Stricter than that PR: a key is mandatory, and there is no plaintext fallback or
 * legacy read path.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;

/**
 * Marks a value as encrypted and versions the format. A stored value is
 * `gse.v1.<iv>.<auth tag>.<ciphertext>`, each part base64, as in github-stats-extended.
 */
const PREFIX = "gse.v1.";

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
   * @returns The value to store: `gse.v1.<iv>.<auth tag>.<ciphertext>`.
   */
  encrypt(token: string, userId: string): string {
    const [key] = this.#keys;
    if (!key) {
      throw new Error("TOKEN_ENCRYPTION_KEY is not set");
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, {
      authTagLength: AUTH_TAG_BYTES,
    }).setAAD(Buffer.from(userId));
    const ciphertext = Buffer.concat([cipher.update(token), cipher.final()]);
    const parts = [iv, cipher.getAuthTag(), ciphertext].map((part) =>
      part.toString("base64"),
    );
    return PREFIX + parts.join(".");
  }

  /**
   * @param value The stored value.
   * @param userId Owner of the row.
   * @returns Plaintext GitHub access token.
   * @throws {TokenDecryptionError} The value is malformed (plaintext included), or no key
   *   authenticates it.
   */
  decrypt(value: string, userId: string): string {
    const parts = value.startsWith(PREFIX)
      ? value.slice(PREFIX.length).split(".")
      : [];
    if (parts.length !== 3) {
      throw new TokenDecryptionError("Malformed encrypted access token");
    }
    const [iv, authTag, ciphertext] = parts.map((part) =>
      Buffer.from(part, "base64"),
    );
    if (
      !iv ||
      !authTag ||
      !ciphertext ||
      iv.length !== IV_BYTES ||
      authTag.length !== AUTH_TAG_BYTES
    ) {
      throw new TokenDecryptionError("Malformed encrypted access token");
    }
    const aad = Buffer.from(userId);

    for (const key of this.#keys) {
      try {
        // A pinned tag length stops Node from accepting a truncated tag.
        const decipher = createDecipheriv(ALGORITHM, key, iv, {
          authTagLength: AUTH_TAG_BYTES,
        })
          .setAAD(aad)
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
