import { logger } from "@grn/core";
import type {
  GraphQLFetcherFunction,
  ViewerQuery,
  ViewerQueryVariables,
} from "@grn/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { defaultConfig } from "../src/config.ts";
import type { Database } from "../src/db.ts";
import { runQuery, settleSyncFailure } from "../src/github/syncClient.ts";
import type { SyncFailure, SyncSession } from "../src/github/syncClient.ts";
import { LeaseLostError, claimJob } from "../src/jobs/queue.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

type Fetcher = GraphQLFetcherFunction<ViewerQuery, ViewerQueryVariables>;
type FetcherResponse = Awaited<ReturnType<Fetcher>>;

let testDb: TestDatabase;
let db: Database;

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
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

const SITE_URL = "https://grn.example";
const TOKEN_ENC = "gse.v1.iv.tag.alice";

/**
 * Inserts an active user with a due `sync` job and claims it.
 *
 * @returns The leased job's session.
 */
const leasedSession = async (): Promise<SyncSession> => {
  await db.query(
    `INSERT INTO users (gh_user_id, login, gh_created_at, token_enc, token_status)
     VALUES ('U_alice', 'alice', now() - interval '10 years', $1, 'active')`,
    [TOKEN_ENC],
  );
  await db.query(
    "INSERT INTO jobs (kind, user_id, run_at) VALUES ('sync', 'U_alice', now() - interval '1 minute')",
  );
  const lease = await claimJob(db, "sync");
  if (!lease) {
    throw new Error("no lease");
  }
  return {
    db,
    lease,
    token: "gho_alice",
    tokenEnc: TOKEN_ENC,
    siteUrl: SITE_URL,
  };
};

const resetEpoch = Math.floor(Date.now() / 1000) + 1800;

const rateLimitHeaders = (used: number, resource = "graphql") => ({
  "x-ratelimit-limit": "5000",
  "x-ratelimit-used": String(used),
  "x-ratelimit-remaining": String(5000 - used),
  "x-ratelimit-reset": String(resetEpoch),
  "x-ratelimit-resource": resource,
});

const viewer = (cost: number): ViewerQuery => ({
  viewer: { id: "U_alice", login: "alice", createdAt: "2015-01-01T00:00:00Z" },
  rateLimit: { cost },
});

const response = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
): FetcherResponse =>
  ({ status, statusText: "", data, headers, config: {} }) as FetcherResponse;

/** A fetcher that resolves with a 2xx response, as axios does. */
const resolving = (
  data: unknown,
  headers: Record<string, string> = rateLimitHeaders(10),
) => vi.fn<Fetcher>(() => Promise.resolve(response(200, data, headers)));

/** A fetcher that rejects with a non-2xx response, as axios does. */
const rejecting = (
  status: number,
  data: unknown,
  headers: Record<string, string> = {},
) =>
  vi.fn<Fetcher>(() =>
    Promise.reject(
      Object.assign(new Error(`Request failed with status code ${status}`), {
        isAxiosError: true,
        response: response(status, data, headers),
      }),
    ),
  );

const rateLimitRow = async () => {
  const { rows } = await db.query<{ used: number; reset_at: Date }>(
    "SELECT used, reset_at FROM rate_limit_state WHERE user_id = 'U_alice'",
  );
  return rows[0];
};

const syncJob = async () => {
  const { rows } = await db.query<{
    locked_by: string | null;
    attempts: number;
    due_in: number;
  }>(
    `SELECT locked_by, attempts, extract(epoch FROM run_at - now())::double precision AS due_in
     FROM jobs WHERE kind = 'sync'`,
  );
  return rows[0];
};

describe("runQuery", () => {
  it("sends the query once with the user's token and stores the headers", async () => {
    const session = await leasedSession();
    const fetcher = resolving({ data: viewer(1) });

    const result = await runQuery(session, fetcher, {});

    expect(result).toEqual({ ok: true, data: viewer(1), errors: [] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]).toBe("gho_alice");
    expect(fetcher.mock.calls[0]?.[3].signal).toBeInstanceOf(AbortSignal);
    expect(await rateLimitRow()).toEqual({
      used: 10,
      reset_at: new Date(resetEpoch * 1000),
    });
    expect(logger.log).toHaveBeenCalledWith(
      "query cost",
      expect.objectContaining({ job: session.lease.id, cost: 1 }),
    );
    expect(logger.error).not.toHaveBeenCalled();

    // the next response's headers overwrite the stored row
    await runQuery(
      session,
      resolving({ data: viewer(1) }, rateLimitHeaders(11)),
      {},
    );
    expect((await rateLimitRow())?.used).toBe(11);
  });

  it("raises the cost alarm above COST_ALARM", async () => {
    const session = await leasedSession();
    await runQuery(session, resolving({ data: viewer(3) }), {});
    expect(logger.error).not.toHaveBeenCalled();

    await runQuery(session, resolving({ data: viewer(4) }), {});
    expect(logger.error).toHaveBeenCalledWith(
      "ALERT: query cost above the alarm",
      expect.objectContaining({ job: session.lease.id, cost: 4 }),
    );
  });

  it("checks GitHub's clock on responses, failed ones too", async () => {
    const session = {
      ...(await leasedSession()),
      config: { ...defaultConfig, clockCheckIntervalSeconds: 0 },
    };
    const ahead = new Date(Date.now() + 60_000).toUTCString();

    await runQuery(
      session,
      resolving({ data: viewer(1) }, { ...rateLimitHeaders(10), date: ahead }),
      {},
    );
    await runQuery(session, rejecting(502, "", { date: ahead }), {});

    const alerts = vi
      .mocked(logger.error)
      .mock.calls.filter(
        ([message]) =>
          message === "ALERT: GitHub's clock is offset above the alarm",
      );
    expect(alerts).toHaveLength(2);
    expect(alerts[0]?.[1]).toMatchObject({ job: session.lease.id });
  });

  it("sends nothing while the guard leaves no room", async () => {
    const session = await leasedSession();
    await db.query(
      `INSERT INTO rate_limit_state (user_id, limit_, used, reset_at)
       VALUES ('U_alice', 5000, 4000, now() + interval '30 minutes')`,
    );
    const fetcher = resolving({ data: viewer(1) });

    expect(await runQuery(session, fetcher, {})).toEqual({
      ok: false,
      failure: { kind: "budget" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("logs an unexpected GraphQL error as a warning and fails transiently", async () => {
    const session = await leasedSession();
    const fetcher = resolving({
      data: viewer(1),
      errors: [{ type: "SOMETHING_NEW", message: "Something new happened" }],
    });

    const result = await runQuery(session, fetcher, {});

    expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
    expect(logger.warn).toHaveBeenCalledWith("unexpected GraphQL errors", {
      job: session.lease.id,
      user: "U_alice",
      kind: "sync",
      status: 200,
      errorTypes: ["SOMETHING_NEW"],
      message: "Something new happened",
    });
    // the headers still count
    expect((await rateLimitRow())?.used).toBe(10);
  });

  it("returns the GraphQL errors the caller expects alongside the data", async () => {
    const session = await leasedSession();
    const errors = [
      { type: "NOT_FOUND", message: "Could not resolve", path: ["a0"] },
    ];
    const fetcher = resolving({ data: viewer(1), errors });

    const result = await runQuery(
      session,
      fetcher,
      {},
      {
        isExpectedError: (error) => error.type === "NOT_FOUND",
      },
    );

    expect(result).toEqual({ ok: true, data: viewer(1), errors });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unexpected status",
      rejecting(418, { message: "I'm a teapot" }),
      418,
      "I'm a teapot",
    ],
    ["a 5xx", rejecting(502, { message: "Bad Gateway" }), 502, "Bad Gateway"],
    [
      "a 200 without data",
      resolving({ errors: [{ message: "Parse error" }] }, {}),
      200,
      "Parse error",
    ],
    [
      "a network error",
      vi.fn<Fetcher>(() => Promise.reject(new Error("socket hang up"))),
      null,
      "socket hang up",
    ],
  ])(
    "logs %s as a warning and fails transiently",
    async (_, fetcher, status, message) => {
      const session = await leasedSession();

      const result = await runQuery(session, fetcher, {});

      expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(
        "unexpected response",
        expect.objectContaining({
          job: session.lease.id,
          user: "U_alice",
          kind: "sync",
          status,
          message,
        }),
      );
    },
  );

  it("aborts a request after the timeout", async () => {
    const session = {
      ...(await leasedSession()),
      config: { ...defaultConfig, requestTimeoutSeconds: 0.05 },
    };
    const fetcher = vi.fn<Fetcher>(
      (_variables, _token, _retries, { signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            reject(new Error("canceled"));
          });
        }),
    );

    const result = await runQuery(session, fetcher, {});

    expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
    expect(logger.warn).toHaveBeenCalledWith(
      "request timed out",
      expect.objectContaining({ status: null, message: "request timed out" }),
    );
  });

  it.each([
    [
      "retry-after",
      rejecting(
        403,
        { message: "You have exceeded a secondary rate limit." },
        {
          "retry-after": "30",
        },
      ),
      { retryAfterSeconds: 30, resetAt: null },
    ],
    [
      "an exhausted primary limit",
      rejecting(
        403,
        { message: "API rate limit exceeded" },
        rateLimitHeaders(5000),
      ),
      { retryAfterSeconds: null, resetAt: new Date(resetEpoch * 1000) },
    ],
    [
      "a secondary limit naming no wait",
      rejecting(403, {
        message: "You have exceeded a secondary rate limit.",
      }),
      { retryAfterSeconds: null, resetAt: null },
    ],
    [
      "a RATE_LIMITED error in a 200",
      resolving(
        {
          data: null,
          errors: [
            { type: "RATE_LIMITED", message: "API rate limit exceeded" },
          ],
        },
        rateLimitHeaders(5000),
      ),
      { retryAfterSeconds: null, resetAt: new Date(resetEpoch * 1000) },
    ],
  ])("reports %s as rate-limited", async (_, fetcher, wait) => {
    const session = await leasedSession();

    const result = await runQuery(session, fetcher, {});

    expect(result).toEqual({
      ok: false,
      failure: { kind: "rate-limited", ...wait },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("reports a 401 as unauthorized", async () => {
    const session = await leasedSession();
    const result = await runQuery(
      session,
      rejecting(401, { message: "Bad credentials" }),
      {},
    );
    expect(result).toEqual({ ok: false, failure: { kind: "unauthorized" } });
  });

  it("throws if the lease was lost before the headers were stored", async () => {
    const session = await leasedSession();
    await db.query("UPDATE jobs SET locked_by = gen_random_uuid()");

    await expect(
      runQuery(session, resolving({ data: viewer(1) }), {}),
    ).rejects.toThrow(LeaseLostError);
    expect(await rateLimitRow()).toBeUndefined();
  });
});

describe("settleSyncFailure", () => {
  it.each<[string, SyncFailure, number]>([
    ["a budget miss", { kind: "budget" }, 0],
    ["a transient failure", { kind: "transient" }, 300],
    [
      "a retry-after",
      { kind: "rate-limited", retryAfterSeconds: 30, resetAt: null },
      30,
    ],
    [
      "a secondary limit naming no wait",
      { kind: "rate-limited", retryAfterSeconds: null, resetAt: null },
      300,
    ],
  ])("releases the job after %s", async (_, failure, dueIn) => {
    const session = await leasedSession();

    await settleSyncFailure(session, failure);

    const job = await syncJob();
    expect(job).toMatchObject({ locked_by: null, attempts: 0 });
    expect(job?.due_in).toBeCloseTo(dueIn, 0);
  });

  it("waits at least 60 s after a secondary limit naming no wait", async () => {
    const session = {
      ...(await leasedSession()),
      config: { ...defaultConfig, syncRetrySeconds: 10 },
    };
    await settleSyncFailure(session, {
      kind: "rate-limited",
      retryAfterSeconds: null,
      resetAt: null,
    });
    expect((await syncJob())?.due_in).toBeCloseTo(60, 0);
  });

  it("waits until the reset plus CLOCK_MARGIN after an exhausted primary limit", async () => {
    const session = await leasedSession();
    const { rows } = await db.query<{ reset_at: Date }>(
      "SELECT now() + interval '20 minutes' AS reset_at",
    );
    const resetAt = rows[0]?.reset_at ?? new Date();

    await settleSyncFailure(session, {
      kind: "rate-limited",
      retryAfterSeconds: null,
      resetAt,
    });

    expect((await syncJob())?.due_in).toBeCloseTo(20 * 60 + 180, 0);
  });

  it("revokes the token on a 401 and queues FR-17's notice", async () => {
    const session = await leasedSession();

    await settleSyncFailure(session, { kind: "unauthorized" });

    const { rows: users } = await db.query<{ token_status: string }>(
      "SELECT token_status FROM users",
    );
    expect(users).toEqual([{ token_status: "revoked" }]);
    expect(await syncJob()).toMatchObject({ locked_by: null });
    expect(await claimJob(db, "sync")).toBeNull();

    const { rows: notices } = await db.query<{
      id: string;
      payload: { body: string };
    }>("SELECT id, payload FROM jobs WHERE kind = 'deliver'");
    expect(notices).toHaveLength(1);
    const body = notices[0]?.payload.body ?? "";
    expect(body).toContain(`<!-- grn:${notices[0]?.id ?? ""} -->`);
    expect(body).toContain(SITE_URL);
    expect(body).not.toContain("@");
    expect(notices[0]?.payload).not.toHaveProperty("title");
  });

  it("leaves a token stored by a later sign-in alone", async () => {
    const session = await leasedSession();
    await db.query("UPDATE users SET token_enc = 'gse.v1.iv.tag.new'");

    await settleSyncFailure(session, { kind: "unauthorized" });

    const { rows } = await db.query<{ token_status: string }>(
      "SELECT token_status FROM users",
    );
    expect(rows).toEqual([{ token_status: "active" }]);
    expect(await syncJob()).toMatchObject({ locked_by: null });
    const { rows: notices } = await db.query(
      "SELECT 1 FROM jobs WHERE kind = 'deliver'",
    );
    expect(notices).toHaveLength(0);
  });

  it("throws if the lease was lost", async () => {
    const session = await leasedSession();
    await db.query("UPDATE jobs SET locked_by = gen_random_uuid()");

    await expect(
      settleSyncFailure(session, { kind: "unauthorized" }),
    ).rejects.toThrow(LeaseLostError);
    const { rows } = await db.query<{ token_status: string }>(
      "SELECT token_status FROM users",
    );
    expect(rows).toEqual([{ token_status: "active" }]);
  });
});
