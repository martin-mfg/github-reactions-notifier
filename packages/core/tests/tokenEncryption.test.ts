import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AccessTokenCipher, TokenDecryptionError } from "../src/index.js";

const KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const cipher = new AccessTokenCipher([KEY]);
const USER = "U_kgDOAAAAAQ";

describe("AccessTokenCipher", () => {
  /**
   * @param value A stored value.
   * @returns Its base64 parts after the prefix: IV, auth tag, ciphertext.
   */
  const partsOf = (value: string): Array<Buffer> =>
    value
      .slice("gse.v1.".length)
      .split(".")
      .map((part) => Buffer.from(part, "base64"));

  /**
   * @param parts IV, auth tag and ciphertext.
   * @returns The stored value made of them.
   */
  const join = (parts: Array<Buffer>): string =>
    `gse.v1.${parts.map((part) => part.toString("base64")).join(".")}`;

  it("round-trips a token as gse.v1.<iv>.<tag>.<ciphertext>, with no plaintext", () => {
    const stored = cipher.encrypt("gho_secret", USER);

    expect(stored).toMatch(/^gse\.v1\.[^.]+\.[^.]+\.[^.]+$/);
    const [iv, tag] = partsOf(stored);
    expect(iv).toHaveLength(12);
    expect(tag).toHaveLength(16);
    expect(stored).not.toContain("gho_secret");
    expect(cipher.decrypt(stored, USER)).toBe("gho_secret");
  });

  it("uses a fresh IV for every call", () => {
    const a = cipher.encrypt("gho_secret", USER);
    const b = cipher.encrypt("gho_secret", USER);

    expect(partsOf(a)[0]).not.toEqual(partsOf(b)[0]);
    expect(a).not.toBe(b);
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
    const [iv, tag, ciphertext] = partsOf(cipher.encrypt("gho_secret", USER));
    const bytes = Buffer.from(ciphertext ?? Buffer.alloc(0));
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    const tampered = join([
      iv ?? Buffer.alloc(0),
      tag ?? Buffer.alloc(0),
      bytes,
    ]);

    expect(() => cipher.decrypt(tampered, USER)).toThrow(
      /no key in TOKEN_ENCRYPTION_KEY matches/,
    );
  });

  it("rejects a truncated auth tag as malformed", () => {
    const [iv, tag, ciphertext] = partsOf(cipher.encrypt("gho_secret", USER));
    const truncated = join([
      iv ?? Buffer.alloc(0),
      (tag ?? Buffer.alloc(0)).subarray(0, 4),
      ciphertext ?? Buffer.alloc(0),
    ]);

    expect(() => cipher.decrypt(truncated, USER)).toThrow(/Malformed/);
  });

  it.each([
    ["plaintext", "gho_plain"],
    ["the old v1 format", "v1.AAAAAAAAAAAAAAAAAAAAAA==.AAAA"],
    ["too few parts", "gse.v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA=="],
    ["too many parts", "gse.v1.a.b.c.d"],
    ["a bad IV", "gse.v1.AAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAA"],
  ])("rejects %s as malformed", (_, stored) => {
    expect(() => cipher.decrypt(stored, USER)).toThrow(/Malformed/);
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
