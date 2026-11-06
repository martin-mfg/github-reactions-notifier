import { logger } from "@grn/core";
import type {
  GitHubOutcome,
  MutationRequest,
  ResponseDetails,
} from "@grn/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { defaultConfig } from "../src/config.ts";
import { classifyWrite, sendWrite } from "../src/github/writes.ts";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

const context = {
  job: "job-1",
  user: "U_alice",
  kind: "deliver",
  target: "grn/inbox#1",
};

const details = (status: number | null, message = ""): ResponseDetails => ({
  status,
  errorTypes: [],
  message,
  rateLimit: null,
  date: null,
});

const failed = (
  status: number | null,
  message = "",
  timedOut = false,
): GitHubOutcome<unknown> => ({
  kind: "failed",
  timedOut,
  details: details(status, message),
});

describe("classifyWrite", () => {
  it("passes a success through", () => {
    expect(
      classifyWrite(
        { kind: "ok", data: { id: 1 }, errors: [], details: details(201) },
        context,
      ),
    ).toEqual({ kind: "ok", data: { id: 1 } });
  });

  it("alerts on every rate-limit hit", () => {
    const resetAt = new Date("2026-01-01T12:00:00Z");
    expect(
      classifyWrite(
        {
          kind: "rate-limited",
          retryAfterSeconds: null,
          resetAt,
          details: details(403, "API rate limit exceeded"),
        },
        context,
      ),
    ).toEqual({ kind: "rate-limited", retryAfterSeconds: null, resetAt });
    expect(logger.error).toHaveBeenCalledWith(
      "ALERT: machine account hit a rate limit",
      expect.objectContaining({ job: "job-1", status: 403 }),
    );
  });

  it.each([
    ["a 5xx", failed(502), "write failed"],
    ["a network error", failed(null, "socket hang up"), "write failed"],
    ["a timeout", failed(null, "request timed out", true), "write timed out"],
  ])("retries %s and logs it as a warning", (_, outcome, logged) => {
    expect(classifyWrite(outcome, context)).toEqual({ kind: "transient" });
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      logged,
      expect.objectContaining({ job: "job-1" }),
    );
  });

  it.each([404, 410, 403])(
    "fails a %i permanently and logs an error",
    (status) => {
      expect(classifyWrite(failed(status, "Not Found"), context)).toEqual({
        kind: "permanent",
      });
      expect(logger.error).toHaveBeenCalledWith("write failed permanently", {
        ...context,
        status,
        errorTypes: [],
        message: "Not Found",
      });
    },
  );

  it.each<[string, GitHubOutcome<unknown>]>([
    ["a 422", failed(422, "Validation Failed")],
    [
      "a 401",
      { kind: "unauthorized", details: details(401, "Bad credentials") },
    ],
    ["a 3xx", failed(304)],
  ])("logs %s as unexpected and retries it", (_, outcome) => {
    expect(classifyWrite(outcome, context)).toEqual({ kind: "transient" });
    expect(logger.warn).toHaveBeenCalledWith(
      "unexpected response to a write",
      expect.objectContaining({
        ...context,
        status: outcome.details.status,
        message: outcome.details.message,
      }),
    );
  });
});

describe("sendWrite", () => {
  it("sends once with the request timeout and classifies the outcome", async () => {
    const send = vi.fn((_request: MutationRequest) =>
      Promise.resolve(failed(502)),
    );

    const result = await sendWrite(
      {
        method: "POST",
        path: "/repos/grn/inbox/issues/1/comments",
        token: "machine",
        body: { body: "hi" },
      },
      context,
      { ...defaultConfig, requestTimeoutSeconds: 5 },
      send,
    );

    expect(result).toEqual({ kind: "transient" });
    expect(logger.warn).toHaveBeenCalledWith(
      "write failed",
      expect.objectContaining({
        ...context,
        method: "POST",
        durationMs: expect.any(Number) as number,
        status: 502,
      }),
    );
    expect(send).toHaveBeenCalledExactlyOnceWith({
      method: "POST",
      path: "/repos/grn/inbox/issues/1/comments",
      token: "machine",
      body: { body: "hi" },
      timeoutMs: 5000,
    });
  });

  it("logs a successful request with its duration", async () => {
    const send = vi.fn(
      (_request: MutationRequest): Promise<GitHubOutcome<unknown>> =>
        Promise.resolve({
          kind: "ok",
          data: { id: 7 },
          errors: [],
          details: details(201),
        }),
    );

    const result = await sendWrite(
      { method: "GET", path: "/user", token: "machine" },
      context,
      defaultConfig,
      send,
    );

    expect(result).toEqual({ kind: "ok", data: { id: 7 } });
    expect(logger.log).toHaveBeenCalledExactlyOnceWith(
      "machine account request",
      {
        ...context,
        method: "GET",
        path: "/user",
        status: 201,
        durationMs: expect.any(Number) as number,
      },
    );
  });
});
