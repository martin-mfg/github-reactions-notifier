import nock from "nock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteGrant, githubAuthenticate } from "../src/index.js";

const tokenExchange = (): nock.Interceptor =>
  nock("https://github.com").post(
    "/login/oauth/access_token",
    "client_id=client-id&client_secret=client-secret&code=the-code&redirect_uri=https%3A%2F%2Fgrn.example%2Fcallback",
  );

afterEach(() => {
  vi.restoreAllMocks();
});

describe("githubAuthenticate", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("OAUTH_CLIENT_SECRET", "client-secret");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://grn.example/callback");
  });

  it("exchanges the code without an identity lookup", async () => {
    tokenExchange().reply(200, { access_token: "gho_token", scope: "" });
    const identity = nock("https://api.github.com").get("/user").reply(503);

    await expect(githubAuthenticate("the-code")).resolves.toStrictEqual({
      accessToken: "gho_token",
      hasScope: false,
    });
    expect(identity.isDone()).toBe(false);
  });

  // FR-2a: a public (no-scope) sign-in that returns a scoped token must be downgraded.
  it("returns a scoped token for revocation even when the identity endpoint is unavailable", async () => {
    tokenExchange().reply(200, { access_token: "gho_token", scope: "repo" });
    const identity = nock("https://api.github.com").get("/user").reply(503);
    const grant = nock("https://api.github.com")
      .delete("/applications/client-id/grant", { access_token: "gho_token" })
      .reply(204);

    const result = await githubAuthenticate("the-code");

    expect(result).toEqual({ accessToken: "gho_token", hasScope: true });
    await deleteGrant(result.accessToken);
    grant.done();
    expect(identity.isDone()).toBe(false);
  });

  it("fails when GitHub returns no token", async () => {
    tokenExchange().reply(200, { error: "bad_verification_code" });

    await expect(githubAuthenticate("the-code")).rejects.toThrow(
      'OAuth Error: access_token missing from response: {"error":"bad_verification_code"}',
    );
  });

  it("fails on an HTTP error", async () => {
    tokenExchange().reply(500);

    await expect(githubAuthenticate("the-code")).rejects.toThrow(
      "OAuth Error: 500",
    );
  });

  it("fails without OAuth configuration", async () => {
    vi.stubEnv("OAUTH_CLIENT_SECRET", "");

    await expect(githubAuthenticate("the-code")).rejects.toThrow(
      /environment variables .* are not set/,
    );
  });

  it("aborts a stalled exchange request", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const abort = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => timeout(20));
    tokenExchange()
      .delay(1000)
      .reply(200, { access_token: "gho_token", scope: "" });

    await expect(githubAuthenticate("the-code")).rejects.toMatchObject({
      code: "ERR_CANCELED",
    });
    expect(abort).toHaveBeenCalledWith(120_000);
    expect(abort).toHaveBeenCalledOnce();
  });
});

describe("deleteGrant", () => {
  beforeEach(() => {
    vi.stubEnv("OAUTH_CLIENT_ID", "client-id");
    vi.stubEnv("OAUTH_CLIENT_SECRET", "client-secret");
  });

  it("deletes the grant with the app's credentials", async () => {
    const scope = nock("https://api.github.com", {
      reqheaders: {
        authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
      },
    })
      .delete("/applications/client-id/grant", { access_token: "gho_token" })
      .reply(204);

    await deleteGrant("gho_token");

    expect(scope.isDone()).toBe(true);
  });

  it("fails on an HTTP error", async () => {
    nock("https://api.github.com")
      .delete("/applications/client-id/grant")
      .reply(422);

    await expect(deleteGrant("gho_token")).rejects.toThrow(
      "OAuth Error: grant deletion: 422",
    );
  });

  it("aborts stalled grant deletion", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const abort = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => timeout(20));
    nock("https://api.github.com")
      .delete("/applications/client-id/grant")
      .delay(1000)
      .reply(200, {});

    await expect(deleteGrant("gho_token")).rejects.toMatchObject({
      code: "ERR_CANCELED",
    });
    expect(abort).toHaveBeenCalledWith(120_000);
  });
});
