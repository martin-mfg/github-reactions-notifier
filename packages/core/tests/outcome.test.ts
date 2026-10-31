import { AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";

import {
  classifyError,
  classifyResponse,
  parseRateLimitHeaders,
} from "../src/index.js";

const reset = 1767225600; // 2026-01-01T00:00:00Z
const rateLimitHeaders = (remaining: number) => ({
  "x-ratelimit-limit": "5000",
  "x-ratelimit-used": String(5000 - remaining),
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(reset),
  "x-ratelimit-resource": "graphql",
});

describe("parseRateLimitHeaders", () => {
  it("reads the headers, case-insensitively, from Axios headers too", () => {
    const expected = {
      resource: "graphql",
      limit: 5000,
      used: 10,
      remaining: 4990,
      resetAt: new Date(reset * 1000),
    };
    expect(parseRateLimitHeaders(rateLimitHeaders(4990))).toEqual(expected);
    expect(
      parseRateLimitHeaders(
        new AxiosHeaders({
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Used": "10",
          "X-RateLimit-Remaining": "4990",
          "X-RateLimit-Reset": String(reset),
          "X-RateLimit-Resource": "graphql",
        }),
      ),
    ).toEqual(expected);
  });

  it("needs the complete set", () => {
    const partial: Record<string, string> = rateLimitHeaders(4990);
    delete partial["x-ratelimit-used"];
    expect(parseRateLimitHeaders(partial)).toBeNull();
    expect(parseRateLimitHeaders(undefined)).toBeNull();
  });

  it("allows a missing resource", () => {
    const headers: Record<string, string> = rateLimitHeaders(4990);
    delete headers["x-ratelimit-resource"];
    expect(parseRateLimitHeaders(headers)?.resource).toBeNull();
  });
});

describe("classifyResponse", () => {
  it("unwraps a GraphQL response's data and keeps partial errors", () => {
    const errors = [
      { type: "NOT_FOUND", message: "Could not resolve", path: ["a0"] },
    ];
    const outcome = classifyResponse(
      {
        status: 200,
        headers: rateLimitHeaders(4990),
        data: { data: { a0: null }, errors },
      },
      "graphql",
    );
    expect(outcome).toMatchObject({
      kind: "ok",
      data: { a0: null },
      errors,
      details: {
        status: 200,
        errorTypes: ["NOT_FOUND"],
        message: "Could not resolve",
        rateLimit: { remaining: 4990 },
      },
    });
  });

  it("keeps a REST response's body", () => {
    expect(
      classifyResponse({ status: 201, headers: {}, data: { id: 1 } }, "rest"),
    ).toMatchObject({ kind: "ok", data: { id: 1 }, errors: [] });
  });

  it("fails a GraphQL response without data", () => {
    expect(
      classifyResponse(
        {
          status: 200,
          headers: {},
          data: { errors: [{ message: "Parse error" }] },
        },
        "graphql",
      ),
    ).toMatchObject({
      kind: "failed",
      timedOut: false,
      details: { status: 200, message: "Parse error" },
    });
  });

  it("reports a 401 as unauthorized", () => {
    expect(
      classifyResponse(
        { status: 401, headers: {}, data: { message: "Bad credentials" } },
        "graphql",
      ),
    ).toMatchObject({
      kind: "unauthorized",
      details: { status: 401, message: "Bad credentials" },
    });
  });

  it.each([403, 429])("waits for a %i's retry-after", (status) => {
    expect(
      classifyResponse(
        {
          status,
          headers: { "retry-after": "42" },
          data: { message: "You have exceeded a secondary rate limit." },
        },
        "rest",
      ),
    ).toMatchObject({
      kind: "rate-limited",
      retryAfterSeconds: 42,
      resetAt: null,
    });
  });

  it("waits for the reset when no points remain", () => {
    expect(
      classifyResponse(
        {
          status: 403,
          headers: rateLimitHeaders(0),
          data: { message: "API rate limit exceeded" },
        },
        "rest",
      ),
    ).toMatchObject({
      kind: "rate-limited",
      retryAfterSeconds: null,
      resetAt: new Date(reset * 1000),
    });
  });

  it("recognises a RATE_LIMITED error in a 200", () => {
    expect(
      classifyResponse(
        {
          status: 200,
          headers: rateLimitHeaders(0),
          data: {
            data: null,
            errors: [
              { type: "RATE_LIMITED", message: "API rate limit exceeded" },
            ],
          },
        },
        "graphql",
      ),
    ).toMatchObject({ kind: "rate-limited", resetAt: new Date(reset * 1000) });
  });

  it.each([
    [403, "You have exceeded a secondary rate limit."],
    [429, "Too many requests"],
  ])("reports a %i naming no wait as rate-limited", (status, message) => {
    expect(
      classifyResponse({ status, headers: {}, data: { message } }, "rest"),
    ).toMatchObject({
      kind: "rate-limited",
      retryAfterSeconds: null,
      resetAt: null,
    });
  });

  it.each([
    [403, "Resource not accessible by integration"],
    [404, "Not Found"],
    [410, "Issues are disabled for this repo"],
    [422, "Validation Failed"],
    [502, "Bad Gateway"],
  ])("fails a %i", (status, message) => {
    expect(
      classifyResponse(
        { status, headers: rateLimitHeaders(4990), data: { message } },
        "rest",
      ),
    ).toMatchObject({
      kind: "failed",
      timedOut: false,
      details: { status, message, errorTypes: [] },
    });
  });
});

describe("classifyError", () => {
  it("classifies an Axios error's response", () => {
    const error = Object.assign(new Error("Request failed"), {
      isAxiosError: true,
      response: { status: 401, headers: {}, data: {} },
    });
    expect(classifyError(error, "graphql", false)).toMatchObject({
      kind: "unauthorized",
    });
  });

  it("fails a network error or a timeout", () => {
    expect(classifyError(new Error("socket hang up"), "rest", false)).toEqual({
      kind: "failed",
      timedOut: false,
      details: {
        status: null,
        errorTypes: [],
        message: "socket hang up",
        rateLimit: null,
      },
    });
    expect(classifyError(new Error("canceled"), "rest", true)).toMatchObject({
      kind: "failed",
      timedOut: true,
      details: { message: "request timed out" },
    });
  });
});
