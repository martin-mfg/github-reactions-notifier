import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AccessTokenCipher, TokenDecryptionError } from "../src/index.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const cipher = new AccessTokenCipher([KEY]);
const USER = "U_kgDOAAAAAQ";

describe("AccessTokenCipher", () => {
  it("round-trips a token, with a v1 prefix and no plaintext", () => {
    const stored = cipher.encrypt("gho_secret", USER);

    expect(stored.tokenEnc).toMatch(/^v1\./);
    expect(JSON.stringify(stored)).not.toContain("gho_secret");
    expect(cipher.decrypt(stored, USER)).toBe("gho_secret");
  });

  it("uses a fresh nonce for every call", () => {
    const a = cipher.encrypt("gho_secret", USER);
    const b = cipher.encrypt("gho_secret", USER);

    expect(a.tokenNonce).not.toBe(b.tokenNonce);
    expect(a.tokenEnc).not.toBe(b.tokenEnc);
  });

  it("decrypts with a rotated-out key", () => {
    const stored = new AccessTokenCipher([OTHER_KEY]).encrypt("gho_x", USER);

    expect(new AccessTokenCipher([KEY, OTHER_KEY]).decrypt(stored, USER)).toBe(
      "gho_x",
    );
    expect(() => cipher.decrypt(stored, USER)).toThrow(TokenDecryptionError);
  });

  it("rejects a ciphertext moved to another user", () => {
    const stored = cipher.encrypt("gho_secret", USER);

    expect(() => cipher.decrypt(stored, "U_other")).toThrow(
      TokenDecryptionError,
    );
  });

  it("rejects a tampered ciphertext", () => {
    const stored = cipher.encrypt("gho_secret", USER);
    const [prefix, tag, ciphertext] = stored.tokenEnc.split(".");
    const bytes = Buffer.from(ciphertext ?? "", "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = `${prefix ?? ""}.${tag ?? ""}.${bytes.toString("base64")}`;

    expect(() =>
      cipher.decrypt({ ...stored, tokenEnc: tampered }, USER),
    ).toThrow(/no key in TOKEN_ENCRYPTION_KEY matches/);
  });

  it.each([
    ["plaintext", { tokenEnc: "gho_plain", tokenNonce: "" }],
    ["too few parts", { tokenEnc: "v1.abc", tokenNonce: "AAAAAAAAAAAAAAAA" }],
    [
      "too many parts",
      { tokenEnc: "v1.a.b.c", tokenNonce: "AAAAAAAAAAAAAAAA" },
    ],
    ["a bad nonce", { tokenEnc: "v1.a.b", tokenNonce: "" }],
  ])("rejects %s as malformed", (_, stored) => {
    expect(() => cipher.decrypt(stored, USER)).toThrow(TokenDecryptionError);
  });

  describe("fromEnv", () => {
    it("accepts base64 and hex keys", () => {
      const fromBase64 = AccessTokenCipher.fromEnv({
        TOKEN_ENCRYPTION_KEY: KEY.toString("base64"),
      });
      const fromHex = AccessTokenCipher.fromEnv({
        TOKEN_ENCRYPTION_KEY: KEY.toString("hex"),
      });

      expect(
        fromHex.decrypt(fromBase64.encrypt("gho_secret", USER), USER),
      ).toBe("gho_secret");
    });

    it("reads a comma-separated key list: the first encrypts, all decrypt", () => {
      const rotated = AccessTokenCipher.fromEnv({
        TOKEN_ENCRYPTION_KEY: ` ${OTHER_KEY.toString("base64")} ,${KEY.toString("hex")}\n`,
      });
      const old = cipher.encrypt("gho_old", USER);

      expect(rotated.decrypt(old, USER)).toBe("gho_old");
      expect(() =>
        cipher.decrypt(rotated.encrypt("gho_new", USER), USER),
      ).toThrow(TokenDecryptionError);
    });

    it("requires a key", () => {
      expect(() => AccessTokenCipher.fromEnv({})).toThrow(
        "TOKEN_ENCRYPTION_KEY is not set",
      );
      expect(() =>
        AccessTokenCipher.fromEnv({ TOKEN_ENCRYPTION_KEY: " , " }),
      ).toThrow("TOKEN_ENCRYPTION_KEY is not set");
    });

    it("rejects a key of the wrong size", () => {
      expect(() =>
        AccessTokenCipher.fromEnv({
          TOKEN_ENCRYPTION_KEY: randomBytes(16).toString("base64"),
        }),
      ).toThrow(/Invalid TOKEN_ENCRYPTION_KEY/);
    });
  });
});
