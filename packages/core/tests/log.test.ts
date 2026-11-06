import { format } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { logger } from "../src/common/log.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const prefix = { log: "", warn: "GRN-PROBLEM ", error: "GRN-PROBLEM " };

describe("logger", () => {
  it.each(["log", "warn", "error"] as const)(
    "redacts every OAuth token in %s output",
    (level) => {
      const output = vi
        .spyOn(console, level)
        .mockImplementation(() => undefined);

      logger[level](
        "first=gho_AbC123; second=gho_zYx987",
        "Bearer gho_Token456",
      );

      expect(output).toHaveBeenCalledExactlyOnceWith(
        `${prefix[level]}first=[REDACTED]; second=[REDACTED] Bearer [REDACTED]`,
      );
    },
  );

  it.each(["warn", "error"] as const)(
    "starts every %s line with the problem keyword, keeping placeholders working",
    (level) => {
      const output = vi
        .spyOn(console, level)
        .mockImplementation(() => undefined);

      logger[level]("status=%d", 503, { job: "j1" });

      expect(output).toHaveBeenCalledExactlyOnceWith(
        `GRN-PROBLEM ${format("status=%d", 503, { job: "j1" })}`,
      );
    },
  );

  it("redacts nested request configuration, error stacks and causes without mutating them", () => {
    const output = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const config = {
      data: "client_secret=gho_Secret123",
      headers: { Authorization: "Bearer gho_Header456" },
    };
    const cause = new Error("failed with gho_Cause789");
    const error = Object.assign(
      new Error("network failure gho_Error123", { cause }),
      {
        config,
      },
    );

    logger.error("OAuth callback failed", error);

    const original = format("OAuth callback failed", error);
    for (const token of [
      "gho_Secret123",
      "gho_Header456",
      "gho_Cause789",
      "gho_Error123",
    ]) {
      expect(original).toContain(token);
    }
    const expected = original
      .replaceAll("gho_Secret123", "[REDACTED]")
      .replaceAll("gho_Header456", "[REDACTED]")
      .replaceAll("gho_Cause789", "[REDACTED]")
      .replaceAll("gho_Error123", "[REDACTED]");
    expect(output).toHaveBeenCalledExactlyOnceWith(`GRN-PROBLEM ${expected}`);
    expect(expected).not.toContain("gho_");
    expect(error.message).toBe("network failure gho_Error123");
    expect(error.cause).toBe(cause);
    expect(error.config).toBe(config);
    expect(config.headers.Authorization).toBe("Bearer gho_Header456");
    expect(config.data).toBe("client_secret=gho_Secret123");
  });

  it("redacts after applying console formatting placeholders", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logger.log("token=%s details=%j", "gho_AbC123", { token: "gho_Def456" });

    expect(output).toHaveBeenCalledExactlyOnceWith(
      'token=[REDACTED] details={"token":"[REDACTED]"}',
    );
  });

  it("preserves ordinary output and handles circular objects", () => {
    const output = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const details: { status: number; self?: unknown } = { status: 503 };
    details.self = details;

    logger.warn("request failed: %d", 503, details);

    expect(output).toHaveBeenCalledExactlyOnceWith(
      `GRN-PROBLEM ${format("request failed: %d", 503, details)}`,
    );
  });
});
