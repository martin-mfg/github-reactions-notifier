import nock from "nock";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { githubAuthenticate } from "../src/index.js";

const tokenExchange = (): nock.Interceptor =>
  nock("https://github.com").post(
    "/login/oauth/access_token",
    "client_id=client-id&client_secret=client-secret&code=the-code&redirect_uri=https%3A%2F%2Fgrn.example%2Fcallback",
  );

describe("githubAuthenticate", () => {
  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  beforeEach(() => {
    vi.stubEnv("OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://grn.example/callback");
  });

  it("exchanges the code for the user and token", async () => {
    tokenExchange().reply(200, { access_token: "gho_token", scope: "" });
    nock("https://api.github.com", {
      reqheaders: { authorization: "bearer gho_token" },
    })
      .get("/user")
      .reply(200, { login: "octocat" });

    await expect(githubAuthenticate("the-code", false)).resolves.toStrictEqual({
      userId: "octocat",
      accessToken: "gho_token",
      needDowngrade: false,
    });
  });

  // FR-2a: a public (no-scope) sign-in that returns a scoped token must be downgraded.
  it("flags a scoped token on a public sign-in", async () => {
    tokenExchange().reply(200, { access_token: "gho_token", scope: "repo" });
    nock("https://api.github.com").get("/user").reply(200, { login: "o" });

    const { needDowngrade } = await githubAuthenticate("the-code", false);

    expect(needDowngrade).toBe(true);
  });

  it("does not flag a scoped token on a private sign-in", async () => {
    tokenExchange().reply(200, { access_token: "gho_token", scope: "repo" });
    nock("https://api.github.com").get("/user").reply(200, { login: "o" });

    const { needDowngrade } = await githubAuthenticate("the-code", true);

    expect(needDowngrade).toBe(false);
  });

  it("fails when GitHub returns no token", async () => {
    tokenExchange().reply(200, { error: "bad_verification_code" });

    await expect(githubAuthenticate("the-code", false)).rejects.toThrow(
      'OAuth Error: access_token missing from response: {"error":"bad_verification_code"}',
    );
  });

  it("fails on an HTTP error", async () => {
    tokenExchange().reply(500);

    await expect(githubAuthenticate("the-code", false)).rejects.toThrow(
      "OAuth Error: 500",
    );
  });

  it("fails without OAuth configuration", async () => {
    vi.stubEnv("OAUTH_CLIENT_SECRET", "");

    await expect(githubAuthenticate("the-code", false)).rejects.toThrow(
      /environment variables .* are not set/,
    );
  });
});
