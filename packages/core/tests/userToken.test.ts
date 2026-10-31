import nock from "nock";
import { describe, expect, it } from "vitest";

import {
  ViewerDocument,
  createGraphQLFetcher,
  mutationRequest,
  userTokenRetryer,
} from "../src/index.js";

const viewerData = {
  viewer: {
    id: "U_kgDOABCDEF",
    login: "octocat",
    createdAt: "2015-01-01T00:00:00Z",
  },
  rateLimit: { cost: 1 },
};

const reset = 1767225600; // 2026-01-01T00:00:00Z
const rateLimitHeaders = (remaining: number) => ({
  "x-ratelimit-limit": "5000",
  "x-ratelimit-used": String(5000 - remaining),
  "x-ratelimit-remaining": String(remaining),
  "x-ratelimit-reset": String(reset),
  "x-ratelimit-resource": "graphql",
});

const fetcher = createGraphQLFetcher(ViewerDocument, "bearer");
const send = () =>
  userTokenRetryer(fetcher, {}, "user-token", { timeoutMs: 5000 });

describe("userTokenRetryer", () => {
  it("sends once with the user's token and the C13 header, and returns the headers", async () => {
    const scope = nock("https://api.github.com", {
      reqheaders: {
        "x-github-next-global-id": "1",
        authorization: "bearer user-token",
      },
    })
      .post("/graphql", { query: ViewerDocument.text, variables: {} })
      .reply(200, { data: viewerData }, rateLimitHeaders(4999));

    const outcome = await send();

    expect(outcome).toEqual({
      kind: "ok",
      data: viewerData,
      errors: [],
      details: {
        status: 200,
        errorTypes: [],
        message: "",
        rateLimit: {
          resource: "graphql",
          limit: 5000,
          used: 1,
          remaining: 4999,
          resetAt: new Date(reset * 1000),
        },
      },
    });
    scope.done();
  });

  it.each([
    [401, { message: "Bad credentials" }, {}, { kind: "unauthorized" }],
    [
      403,
      { message: "You have exceeded a secondary rate limit." },
      { "retry-after": "60" },
      { kind: "rate-limited", retryAfterSeconds: 60, resetAt: null },
    ],
    [
      403,
      { message: "API rate limit exceeded" },
      rateLimitHeaders(0),
      {
        kind: "rate-limited",
        retryAfterSeconds: null,
        resetAt: new Date(reset * 1000),
      },
    ],
    [
      403,
      { message: "You have exceeded a secondary rate limit." },
      {},
      { kind: "rate-limited", retryAfterSeconds: null, resetAt: null },
    ],
    [
      200,
      {
        data: null,
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      },
      rateLimitHeaders(0),
      { kind: "rate-limited", resetAt: new Date(reset * 1000) },
    ],
    [
      403,
      { message: "Resource not accessible by integration" },
      {},
      { kind: "failed", timedOut: false },
    ],
    [502, { message: "Bad Gateway" }, {}, { kind: "failed", timedOut: false }],
  ])(
    "classifies a %i without retrying, rotating or throwing",
    async (status, body, headers, expected) => {
      const scope = nock("https://api.github.com")
        .post("/graphql")
        .reply(status, body, headers);

      const outcome = await send();

      expect(outcome).toMatchObject(expected);
      expect(outcome.details.status).toBe(status);
      scope.done();
    },
  );

  it("fails a network error without retrying", async () => {
    const scope = nock("https://api.github.com")
      .post("/graphql")
      .replyWithError("socket hang up");

    expect(await send()).toMatchObject({
      kind: "failed",
      timedOut: false,
      details: { status: null, message: "socket hang up" },
    });
    scope.done();
  });

  it("aborts the request after the timeout", async () => {
    nock("https://api.github.com")
      .post("/graphql")
      .delay(1000)
      .reply(200, { data: viewerData });

    const outcome = await userTokenRetryer(fetcher, {}, "user-token", {
      timeoutMs: 50,
    });

    expect(outcome).toMatchObject({
      kind: "failed",
      timedOut: true,
      details: { status: null, message: "request timed out" },
    });
  });
});

describe("mutationRequest", () => {
  const comment = {
    method: "POST" as const,
    path: "/repos/grn/inbox/issues/1/comments",
    token: "machine-token",
    body: { body: "hello" },
    timeoutMs: 5000,
  };

  it("posts once with the REST headers", async () => {
    const scope = nock("https://api.github.com", {
      reqheaders: {
        accept: "application/vnd.github+json",
        authorization: "Bearer machine-token",
        "x-github-api-version": "2022-11-28",
      },
    })
      .post("/repos/grn/inbox/issues/1/comments", { body: "hello" })
      .reply(201, { id: 7 });

    expect(await mutationRequest(comment)).toMatchObject({
      kind: "ok",
      data: { id: 7 },
      details: { status: 201 },
    });
    scope.done();
  });

  it("never retries a failed write", async () => {
    const scope = nock("https://api.github.com")
      .post("/repos/grn/inbox/issues/1/comments")
      .once()
      .reply(502, { message: "Bad Gateway" });

    expect(await mutationRequest(comment)).toMatchObject({
      kind: "failed",
      details: { status: 502, message: "Bad Gateway" },
    });
    scope.done();
    expect(nock.pendingMocks()).toEqual([]);
  });

  it("classifies a secondary limit", async () => {
    nock("https://api.github.com")
      .post("/repos/grn/inbox/issues/1/comments")
      .reply(
        403,
        { message: "You have exceeded a secondary rate limit." },
        { "retry-after": "60" },
      );

    expect(await mutationRequest(comment)).toMatchObject({
      kind: "rate-limited",
      retryAfterSeconds: 60,
    });
  });

  it("aborts the request after the timeout", async () => {
    nock("https://api.github.com")
      .post("/repos/grn/inbox/issues/1/comments")
      .delay(1000)
      .reply(201, { id: 7 });

    expect(await mutationRequest({ ...comment, timeoutMs: 50 })).toMatchObject({
      kind: "failed",
      timedOut: true,
    });
  });
});
