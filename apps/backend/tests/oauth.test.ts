import { randomBytes } from "node:crypto";

import { AccessTokenCipher, logger } from "@grn/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ApiHandler, ApiRequest } from "../api/_types.ts";
import type { Database } from "../src/db.ts";
import { createOAuthHandlers } from "../src/oauth.ts";
import type { OAuthDeps } from "../src/oauth.ts";
import { signIn } from "../src/users/accounts.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

let testDb: TestDatabase;
let db: Database;

const cipher = new AccessTokenCipher([randomBytes(32)]);
const alice = {
  id: "U_alice",
  login: "alice",
  createdAt: "2015-03-04T05:06:07Z",
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = testDb.db;
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  vi.restoreAllMocks();
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  setHeader: (name: string, value: string) => void;
  send: (body: unknown) => void;
}

const call = async (
  handler: ApiHandler,
  req: Partial<ApiRequest>,
): Promise<FakeResponse> => {
  const res: FakeResponse = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    send(body) {
      this.body = body;
    },
  };
  await handler({ query: {}, headers: {}, ...req }, res);
  return res;
};

/**
 * @param overrides Deps replacing the defaults: a token without scope, owned by alice.
 * @returns The handlers and the GitHub fakes.
 */
const setup = (overrides: Partial<OAuthDeps> = {}) => {
  const deps = {
    db: () => db,
    cipher: () => cipher,
    exchangeCode: vi.fn((code: string) =>
      Promise.resolve({ accessToken: `token-for-${code}`, hasScope: false }),
    ),
    fetchViewer: vi.fn(() => Promise.resolve(alice)),
    deleteGrant: vi.fn(() => Promise.resolve()),
    env: () => ({
      clientId: "client-id",
      redirectUri: "https://grn.example/api/oauth/callback",
    }),
    ...overrides,
  };
  return { ...createOAuthHandlers(deps), deps };
};

const stateFrom = (location: string | undefined): string => {
  const state = new URL(location ?? "").searchParams.get("state");
  if (!state) {
    throw new Error(`no state in ${String(location)}`);
  }
  return state;
};

/**
 * Follows a flow's redirect to GitHub and back, as the browser would.
 *
 * @param handler The callback handler.
 * @param start The response that sent the browser to GitHub.
 * @param code The code GitHub returns.
 * @returns The callback's response.
 */
const returnFromGitHub = (
  handler: ApiHandler,
  start: FakeResponse,
  code = "code",
): Promise<FakeResponse> => {
  const state = stateFrom(start.headers["location"]);
  return call(handler, {
    query: { code, state },
    headers: { cookie: `other=1; grn_oauth_state=${state}` },
  });
};

const count = async (table: string) => {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table}`,
  );
  return rows[0]?.n;
};

describe("login", () => {
  it("redirects to GitHub without requesting scopes", async () => {
    const { login } = setup();
    const res = await call(login, { method: "GET" });

    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers["location"] ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://grn.example/api/oauth/callback",
    );
    expect(location.searchParams.has("scope")).toBe(false);
    const state = stateFrom(res.headers["location"]);
    expect(res.headers["set-cookie"]).toContain(`grn_oauth_state=${state};`);
    expect(res.headers["set-cookie"]).toContain("HttpOnly");
  });
});

describe("sign-in callback", () => {
  it("signs in with a no-scope token", async () => {
    const { login, callback, deps } = setup();
    const res = await returnFromGitHub(callback, await call(login, {}), "c1");

    expect(res.statusCode).toBe(302);
    expect(res.headers["location"]).toBe("/?status=signed-in");
    expect(res.headers["set-cookie"]).toContain("Max-Age=0");
    expect(deps.fetchViewer).toHaveBeenCalledWith("token-for-c1");
    expect(deps.deleteGrant).not.toHaveBeenCalled();
    expect(await count("users")).toBe(1);
    expect(await count("jobs WHERE kind = 'deliver'")).toBe(1);
  });

  it("rejects a scoped token, deletes the grant and restarts once (FR-2a)", async () => {
    const { login, callback, deps } = setup({
      exchangeCode: vi.fn(() =>
        Promise.resolve({ accessToken: "scoped", hasScope: true }),
      ),
    });

    const first = await returnFromGitHub(callback, await call(login, {}));
    expect(deps.deleteGrant).toHaveBeenCalledWith("scoped");
    expect(deps.fetchViewer).not.toHaveBeenCalled();
    expect(await count("users")).toBe(0);
    expect(first.statusCode).toBe(302);
    expect(first.headers["location"]).toMatch(
      /^https:\/\/github\.com\/login\/oauth\/authorize\?/,
    );
    expect(stateFrom(first.headers["location"])).toMatch(/^signin\.1\./);

    // The second token has a scope too: no further restart.
    const second = await returnFromGitHub(callback, first);
    expect(deps.deleteGrant).toHaveBeenCalledTimes(2);
    expect(second.headers["location"]).toBe("/?status=scope-rejected");
    expect(await count("users")).toBe(0);
  });

  it("signs in once the restarted flow returns a no-scope token", async () => {
    const exchangeCode = vi
      .fn<OAuthDeps["exchangeCode"]>()
      .mockResolvedValueOnce({ accessToken: "scoped", hasScope: true })
      .mockResolvedValueOnce({ accessToken: "clean", hasScope: false });
    const { login, callback } = setup({ exchangeCode });

    const first = await returnFromGitHub(callback, await call(login, {}));
    const second = await returnFromGitHub(callback, first);
    expect(second.headers["location"]).toBe("/?status=signed-in");
    expect(await count("users")).toBe(1);
  });

  it("rejects a state that does not match the cookie", async () => {
    const { login, callback, deps } = setup();
    const start = await call(login, {});
    const res = await call(callback, {
      query: { code: "c", state: stateFrom(start.headers["location"]) },
      headers: { cookie: "grn_oauth_state=signin.0.AAAAAAAAAAAAAAAAAAAAAA" },
    });
    expect(res.headers["location"]).toBe("/?status=invalid-state");
    expect(deps.exchangeCode).not.toHaveBeenCalled();

    const noCookie = await call(callback, {
      query: { code: "c", state: stateFrom(start.headers["location"]) },
    });
    expect(noCookie.headers["location"]).toBe("/?status=invalid-state");
  });

  it("reports a declined authorization", async () => {
    const { login, callback, deps } = setup();
    const state = stateFrom((await call(login, {})).headers["location"]);
    const res = await call(callback, {
      query: { error: "access_denied", state },
      headers: { cookie: `grn_oauth_state=${state}` },
    });
    expect(res.headers["location"]).toBe("/?status=cancelled");
    expect(deps.exchangeCode).not.toHaveBeenCalled();
  });

  it("reports a failure without storing anything", async () => {
    const { login, callback } = setup({
      fetchViewer: vi.fn(() => Promise.reject(new Error("boom"))),
    });
    const res = await returnFromGitHub(callback, await call(login, {}));
    expect(res.headers["location"]).toBe("/?status=error");
    expect(await count("users")).toBe(0);
  });
});

describe("account deletion", () => {
  const sameOrigin = {
    method: "POST",
    headers: { "sec-fetch-site": "same-origin" },
  };

  it("accepts only same-origin POSTs", async () => {
    const { deleteAccount } = setup();

    expect((await call(deleteAccount, { method: "GET" })).statusCode).toBe(405);
    const crossSite = await call(deleteAccount, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.headers["location"]).toBeUndefined();
    const foreignOrigin = await call(deleteAccount, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    const ownOrigin = await call(deleteAccount, {
      method: "POST",
      headers: { origin: "https://grn.example" },
    });
    expect(ownOrigin.statusCode).toBe(303);

    const res = await call(deleteAccount, sameOrigin);
    expect(res.statusCode).toBe(303);
    expect(stateFrom(res.headers["location"])).toMatch(/^delete\.0\./);
  });

  it("deletes the token owner's data and then the grant", async () => {
    await signIn(db, alice, "stored", { cipher, siteUrl: "https://x" });
    await signIn(
      db,
      { id: "U_bob", login: "bob", createdAt: alice.createdAt },
      "stored",
      { cipher, siteUrl: "https://x" },
    );
    const { deleteAccount, callback, deps } = setup();

    const res = await returnFromGitHub(
      callback,
      await call(deleteAccount, sameOrigin),
      "c2",
    );
    expect(res.headers["location"]).toBe("/?status=deleted");
    expect(deps.fetchViewer).toHaveBeenCalledWith("token-for-c2");
    expect(deps.deleteGrant).toHaveBeenCalledWith("token-for-c2");
    const { rows } = await db.query("SELECT gh_user_id FROM users");
    expect(rows).toEqual([{ gh_user_id: "U_bob" }]);
  });

  it("reports a grant that could not be deleted", async () => {
    await signIn(db, alice, "stored", { cipher, siteUrl: "https://x" });
    const { deleteAccount, callback } = setup({
      deleteGrant: vi.fn(() => Promise.reject(new Error("502"))),
    });

    const res = await returnFromGitHub(
      callback,
      await call(deleteAccount, sameOrigin),
    );
    expect(res.headers["location"]).toBe("/?status=deleted-grant-kept");
    expect(await count("users")).toBe(0);
  });

  it("does not sign in from a deletion flow", async () => {
    const { deleteAccount, callback } = setup();
    const res = await returnFromGitHub(
      callback,
      await call(deleteAccount, sameOrigin),
    );
    expect(res.headers["location"]).toBe("/?status=deleted");
    expect(await count("users")).toBe(0);
  });
});
