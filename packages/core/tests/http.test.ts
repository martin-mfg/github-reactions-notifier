import nock from "nock";
import { describe, expect, it } from "vitest";

import { ViewerDocument, createGraphQLFetcher, request } from "../src/index.js";

const viewerResult = {
  data: {
    viewer: { id: "U_kgDOABCDEF", login: "octocat" },
    rateLimit: {
      cost: 1,
      used: 1,
      remaining: 4999,
      resetAt: "2026-01-01T00:00:00Z",
    },
  },
};

// C13: every GraphQL request must ask for the new global node ID format.
describe("X-Github-Next-Global-ID header", () => {
  it("is sent by typed GraphQL fetchers", async () => {
    const scope = nock("https://api.github.com", {
      reqheaders: {
        "x-github-next-global-id": "1",
        authorization: "bearer user-token",
      },
    })
      .post("/graphql", { query: ViewerDocument.text, variables: {} })
      .reply(200, viewerResult);

    const fetcher = createGraphQLFetcher(ViewerDocument, "bearer");
    const response = await fetcher({}, "user-token");

    expect(response.data).toStrictEqual(viewerResult);
    scope.done();
  });

  it("is sent by untyped requests and cannot be overridden", async () => {
    const scope = nock("https://api.github.com", {
      reqheaders: { "x-github-next-global-id": "1" },
    })
      .post("/graphql")
      .reply(200, viewerResult);

    await request(
      { query: ViewerDocument.text, variables: {} },
      { Authorization: "bearer user-token", "X-Github-Next-Global-ID": "0" },
    );

    scope.done();
  });
});
