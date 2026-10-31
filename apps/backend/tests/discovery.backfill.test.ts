import { randomBytes } from "node:crypto";

import { AccessTokenCipher, logger } from "@grn/core";
import type {
  AuthoredBackfillQuery,
  AuthoredBackfillQueryVariables,
  BackfillCommentFragment,
  GraphQLError,
  GraphQLFetcherFunction,
  ScannedThread,
  ThreadScanQuery,
  ThreadScanQueryVariables,
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
import {
  backfillSearch,
  isBackfillComplete,
  runBackfill,
} from "../src/discovery/backfill.ts";
import { runThreadScans } from "../src/discovery/threadScans.ts";
import type { SyncSession } from "../src/github/syncClient.ts";
import { LeaseLostError, claimJob } from "../src/jobs/queue.ts";
import { signIn } from "../src/users/accounts.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

type BackfillFetcher = GraphQLFetcherFunction<
  AuthoredBackfillQuery,
  AuthoredBackfillQueryVariables
>;
type ScanFetcher = GraphQLFetcherFunction<
  ThreadScanQuery,
  ThreadScanQueryVariables
>;
type SearchNodes = NonNullable<AuthoredBackfillQuery["search"]["nodes"]>;

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

const cipher = new AccessTokenCipher([randomBytes(32)]);
const ALICE = {
  id: "U_alice",
  login: "alice",
  createdAt: "2015-01-01T00:00:00Z",
};

/** The window's end in these tests; its fraction is below what search can express. */
const WINDOW_END = "2026-10-01T12:00:00.500Z";
const BASE = "2026-10-01T12:00:00Z";

/**
 * @param minutes Offset from {@link BASE}.
 * @returns The ISO timestamp, in GitHub's whole seconds.
 */
const at = (minutes: number): string =>
  new Date(Date.parse(BASE) + minutes * 60_000)
    .toISOString()
    .replace(".000Z", "Z");

const iso = (time: string) => new Date(time).toISOString();

/** @returns A new lease on Alice's `sync` job, whenever it is due and whoever holds it. */
const claim = async () => {
  await db.query(
    `UPDATE jobs SET run_at = now() - interval '1 minute', locked_by = NULL
     WHERE kind = 'sync'`,
  );
  const lease = await claimJob(db, "sync");
  if (!lease) {
    throw new Error("no lease");
  }
  return lease;
};

/**
 * Signs Alice up, sets her window's end to {@link WINDOW_END}, and claims her `sync` job.
 *
 * @returns The leased job's session and her category's id.
 */
const setUp = async (): Promise<{
  session: SyncSession;
  categoryId: string;
}> => {
  await signIn(db, ALICE, "gho_alice", { cipher, siteUrl: "https://grn" });
  await db.query("UPDATE backfill_windows SET window_end = $1", [WINDOW_END]);
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM subscription_categories",
  );
  const { rows: users } = await db.query<{ token_enc: string }>(
    "SELECT token_enc FROM users",
  );
  return {
    session: {
      db,
      lease: await claim(),
      token: "gho_alice",
      tokenEnc: users[0]?.token_enc ?? "",
      siteUrl: "https://grn",
    },
    categoryId: String(rows[0]?.id),
  };
};

const repository = { nameWithOwner: "octo/repo" };
const alice = { id: "U_alice", login: "alice" };
const bob = { id: "U_bob", login: "bob" };

const comment = (
  id: string,
  createdAt: string,
  who = alice,
): BackfillCommentFragment => ({
  __typename: "IssueComment",
  id,
  url: `https://github.com/octo/repo/issues/1#issuecomment-${id}`,
  createdAt,
  repository,
  issue: { title: "Thread" },
  author: who,
});

interface HitOptions {
  author?: { id: string; login: string } | null;
  comments?: Array<BackfillCommentFragment>;
  moreComments?: boolean;
  /** The newest reaction's `createdAt`; `null` for a failed hint. */
  reactedAt?: string | null;
  type?: "Issue" | "PullRequest";
}

const hit = (id: string, createdAt: string, options: HitOptions = {}) => ({
  __typename: options.type ?? ("Issue" as const),
  id,
  url: `https://github.com/octo/repo/issues/${id}`,
  title: `Thread ${id}`,
  createdAt,
  repository,
  author: options.author === undefined ? alice : options.author,
  timelineItems: {
    pageInfo: { hasNextPage: options.moreComments ?? false },
    nodes: options.comments ?? [],
  },
  reactions: {
    nodes:
      options.reactedAt === undefined
        ? []
        : [
            options.reactedAt === null
              ? null
              : { createdAt: options.reactedAt },
          ],
  },
});

interface Page {
  hits?: SearchNodes;
  hasNextPage?: boolean;
  login?: string;
  viewerId?: string;
  errors?: Array<GraphQLError>;
}

const respond = <T>(data: T, errors: Array<GraphQLError> = []) =>
  Promise.resolve({
    status: 200,
    statusText: "",
    data: { data, ...(errors.length > 0 && { errors }) },
    headers: {},
    config: {},
  } as Awaited<ReturnType<GraphQLFetcherFunction<T, unknown>>>);

const searchPage = (page: Page = {}) =>
  respond<AuthoredBackfillQuery>(
    {
      viewer: {
        id: page.viewerId ?? ALICE.id,
        login: page.login ?? ALICE.login,
      },
      search: {
        pageInfo: { hasNextPage: page.hasNextPage ?? false },
        nodes: page.hits ?? [],
      },
      rateLimit: { cost: 2 },
    },
    page.errors,
  );

const searching = (page: Page = {}) =>
  vi.fn<BackfillFetcher>(() => searchPage(page));

/** @returns A rejection as the fetcher gives it for a 502. */
const badGateway = () =>
  Promise.reject(
    Object.assign(new Error("Request failed with status code 502"), {
      isAxiosError: true,
      response: {
        status: 502,
        statusText: "",
        data: { message: "Bad Gateway" },
        headers: {},
        config: {},
      },
    }),
  );

const scanning = (
  threads: Array<ScannedThread>,
  errors: Array<GraphQLError> = [],
) =>
  vi.fn<ScanFetcher>(() =>
    respond<ThreadScanQuery>(
      {
        viewer: { id: ALICE.id, login: ALICE.login },
        rateLimit: { cost: 1 },
        ...Object.fromEntries(
          threads.map((thread, index) => [`thread_${index}`, thread]),
        ),
      },
      errors,
    ),
  );

const thread = (
  comments: Array<BackfillCommentFragment>,
  hasNextPage = false,
): ScannedThread => ({
  timelineItems: { pageInfo: { hasNextPage }, nodes: comments },
});

const tracked = async () => {
  const { rows } = await db.query<{
    node_id: string;
    title: string;
    last_event_at: Date;
    watermark_at: Date;
    enabled_at: Date;
    checked_ago: number;
  }>(
    `SELECT t.node_id, c.title, t.last_event_at, t.watermark_at, st.enabled_at,
            extract(epoch FROM now() - t.last_checked_at)::double precision AS checked_ago
     FROM tracked_content t
     JOIN content c USING (node_id)
     JOIN subscription_types st ON st.content_type = c.type
     ORDER BY t.node_id`,
  );
  return rows;
};

const trackedIds = async () => (await tracked()).map((row) => row.node_id);

const windows = async () => {
  const { rows } = await db.query<{ window_start: Date; window_end: Date }>(
    "SELECT window_start, window_end FROM backfill_windows",
  );
  return rows.map((row) => ({
    start: row.window_start.toISOString(),
    end: row.window_end.toISOString(),
  }));
};

const threadScans = async () => {
  const { rows } = await db.query<{
    thread_node_id: string;
    since_at: Date;
    thread_created_at: Date;
  }>(
    "SELECT thread_node_id, since_at, thread_created_at FROM thread_scans ORDER BY thread_node_id",
  );
  return rows.map((row) => ({
    thread: row.thread_node_id,
    since: row.since_at.toISOString(),
    created: row.thread_created_at.toISOString(),
  }));
};

const syncJob = async () => {
  const { rows } = await db.query<{
    locked_by: string | null;
    due_in: number;
  }>(
    `SELECT locked_by, extract(epoch FROM run_at - now())::double precision AS due_in
     FROM jobs WHERE kind = 'sync'`,
  );
  return rows[0];
};

const searchedFor = (fetcher: BackfillFetcher) =>
  vi.mocked(fetcher).mock.calls.map(([variables]) => variables.query);

describe("backfillSearch", () => {
  it("searches the window newest-first, both bounds in whole seconds", () => {
    expect(
      backfillSearch("alice", {
        start: new Date("2015-01-01T00:00:00Z"),
        end: new Date(WINDOW_END),
      }),
    ).toBe(
      "involves:alice created:2015-01-01T00:00:00+00:00..2026-10-01T12:00:00+00:00 sort:created-desc",
    );
  });
});

describe("runBackfill", () => {
  it("stores only the user's own threads and comments, not mentions or assignments", async () => {
    const { session, categoryId } = await setUp();
    const fetcher = searching({
      hasNextPage: true,
      hits: [
        hit("I_own", at(-10), {
          reactedAt: at(30),
          comments: [comment("C_own", at(-9)), comment("C_bob", at(-8), bob)],
        }),
        // bob's thread that mentions alice, or that she is assigned to
        hit("I_mention", at(-20), {
          author: bob,
          comments: [comment("C_bob2", at(-19), bob)],
        }),
        // bob's PR she commented on
        hit("PR_bob", at(-30), {
          type: "PullRequest",
          author: bob,
          comments: [comment("C_own2", at(-29))],
        }),
        // a ghost's thread
        hit("I_ghost", at(-40), { author: null }),
      ],
    });

    const result = await runBackfill(session, categoryId, fetcher);

    expect(result).toEqual({
      ok: true,
      status: "stored",
      newItems: 3,
      newThreadScans: 0,
      window: { kind: "moved", windowEnd: new Date(at(-40)) },
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(searchedFor(fetcher)).toEqual([
      "involves:alice created:2015-01-01T00:00:00+00:00..2026-10-01T12:00:00+00:00 sort:created-desc",
    ]);
    expect(await trackedIds()).toEqual(["C_own", "C_own2", "I_own"]);

    const rows = await tracked();
    // threads: max(createdAt, newest reaction); comments: createdAt, no probe
    expect(rows.find((row) => row.node_id === "I_own")?.last_event_at).toEqual(
      new Date(at(30)),
    );
    expect(rows.find((row) => row.node_id === "C_own")?.last_event_at).toEqual(
      new Date(at(-9)),
    );
    // FR-6: every new row starts at its type's enabled_at
    for (const row of rows) {
      expect(row.watermark_at).toEqual(row.enabled_at);
      expect(row.checked_ago).toBeLessThan(5);
    }
    expect(rows.find((row) => row.node_id === "C_own2")?.title).toBe("Thread");

    expect(await windows()).toEqual([
      { start: iso(ALICE.createdAt), end: iso(at(-40)) },
    ]);
    expect(await syncJob()).toMatchObject({ locked_by: null });
    expect(await isBackfillComplete(db, categoryId)).toBe(false);
  });

  it("falls back to createdAt when a thread's reaction hint fails", async () => {
    const { session, categoryId } = await setUp();
    const fetcher = searching({
      hits: [hit("I_1", at(-10), { reactedAt: null })],
      errors: [
        {
          type: "SERVICE_UNAVAILABLE",
          message: "timeout",
          path: ["search", "nodes", 0, "reactions", "nodes", 0],
        },
      ],
    });

    const result = await runBackfill(session, categoryId, fetcher);

    expect(result).toMatchObject({ ok: true, newItems: 1 });
    expect((await tracked())[0]?.last_event_at).toEqual(new Date(at(-10)));
  });

  it("retries without storing when a hint's error took its whole hit", async () => {
    const { session, categoryId } = await setUp();
    const fetcher = searching({
      hits: [hit("I_1", at(-10)), null],
      errors: [
        {
          type: "SERVICE_UNAVAILABLE",
          message: "timeout",
          path: ["search", "nodes", 1, "reactions"],
        },
      ],
    });

    const result = await runBackfill(session, categoryId, fetcher);

    expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
    expect(logger.warn).toHaveBeenCalledWith(
      "backfill hits lost to reaction hint errors",
      expect.objectContaining({ hits: "1" }),
    );
    expect(await trackedIds()).toEqual([]);
    expect(await windows()).toEqual([
      { start: iso(ALICE.createdAt), end: WINDOW_END },
    ]);
  });

  it("walks newest-first and resumes after an interruption from the last stored page", async () => {
    const { session, categoryId } = await setUp();

    // page 1 is stored
    const first = searching({
      hasNextPage: true,
      hits: [hit("I_3", at(-10)), hit("I_2", at(-20))],
    });
    await runBackfill(session, categoryId, first);
    expect(await windows()).toEqual([
      { start: iso(ALICE.createdAt), end: iso(at(-20)) },
    ]);

    // page 2 is lost with the lease
    const lost = vi.fn<BackfillFetcher>(async () => {
      await db.query("UPDATE jobs SET locked_by = gen_random_uuid()");
      return searchPage({
        hasNextPage: true,
        hits: [hit("I_2", at(-20)), hit("I_1", at(-30))],
      });
    });
    await expect(
      runBackfill({ ...session, lease: await claim() }, categoryId, lost),
    ).rejects.toThrow(LeaseLostError);

    // then a failed query changes nothing and retries after 5 min
    const failed = vi.fn<BackfillFetcher>(badGateway);
    expect(
      await runBackfill(
        { ...session, lease: await claim() },
        categoryId,
        failed,
      ),
    ).toEqual({ ok: false, failure: { kind: "transient" } });
    expect((await syncJob())?.due_in).toBeCloseTo(300, 0);
    expect(await trackedIds()).toEqual(["I_2", "I_3"]);
    expect(await windows()).toEqual([
      { start: iso(ALICE.createdAt), end: iso(at(-20)) },
    ]);

    // the resumed walk re-reads page 1's oldest second, and its last page ends the window
    const last = searching({
      hits: [hit("I_2", at(-20)), hit("I_1", at(-30))],
    });
    const result = await runBackfill(
      { ...session, lease: await claim() },
      categoryId,
      last,
    );

    expect(result).toMatchObject({
      ok: true,
      newItems: 1,
      window: { kind: "deleted" },
    });
    const end = (minutes: number) =>
      iso(at(minutes)).replace(".000Z", "+00:00");
    expect([first, lost, failed, last].flatMap(searchedFor)).toEqual([
      expect.stringContaining("..2026-10-01T12:00:00+00:00 "),
      expect.stringContaining(`..${end(-20)} `),
      expect.stringContaining(`..${end(-20)} `),
      expect.stringContaining(`..${end(-20)} `),
    ]);
    expect(await trackedIds()).toEqual(["I_1", "I_2", "I_3"]);
    expect(await windows()).toEqual([]);
    expect(await isBackfillComplete(db, categoryId)).toBe(true);
  });

  it("deletes the window after an empty page", async () => {
    const { session, categoryId } = await setUp();

    const result = await runBackfill(session, categoryId, searching());

    expect(result).toMatchObject({ ok: true, window: { kind: "deleted" } });
    expect(await windows()).toEqual([]);
  });

  it("logs a page stuck in one second as an error and still moves window_end back", async () => {
    const { session, categoryId } = await setUp();
    const fetcher = searching({
      hasNextPage: true,
      hits: [hit("I_2", BASE), hit("I_1", BASE)],
    });

    const result = await runBackfill(session, categoryId, fetcher);

    const before = iso(new Date(Date.parse(BASE) - 1000).toISOString());
    expect(result).toMatchObject({
      ok: true,
      window: { kind: "moved", windowEnd: new Date(before) },
    });
    expect(await windows()).toEqual([
      { start: iso(ALICE.createdAt), end: before },
    ]);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("stuck in one second"),
      expect.objectContaining({
        job: session.lease.id,
        second: "2026-10-01T12:00:00+00:00",
        windowEnd: before,
      }),
    );
    expect(await trackedIds()).toEqual(["I_1", "I_2"]);
  });

  it("deletes a window whose stuck second was its first", async () => {
    const { session, categoryId } = await setUp();
    await db.query("UPDATE backfill_windows SET window_start = $1", [BASE]);

    const result = await runBackfill(
      session,
      categoryId,
      searching({ hasNextPage: true, hits: [hit("I_1", BASE)] }),
    );

    expect(result).toMatchObject({ ok: true, window: { kind: "deleted" } });
    expect(await windows()).toEqual([]);
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it("queues a scan for every long thread, and a boundary re-read keeps an advanced scan", async () => {
    const { session, categoryId } = await setUp();
    const page = {
      hasNextPage: true,
      hits: [
        hit("I_long", at(-10), {
          author: bob,
          moreComments: true,
          comments: [comment("C_1", at(-9), bob), comment("C_2", at(-5))],
        }),
      ],
    };

    expect(
      await runBackfill(session, categoryId, searching(page)),
    ).toMatchObject({ ok: true, newItems: 1, newThreadScans: 1 });
    expect(await threadScans()).toEqual([
      { thread: "I_long", since: iso(at(-5)), created: iso(at(-10)) },
    ]);

    // the scan advances, then the next page re-reads the thread at its window_end
    await db.query("UPDATE thread_scans SET since_at = $1", [at(50)]);
    const again = await runBackfill(
      { ...session, lease: await claim() },
      categoryId,
      searching(page),
    );

    expect(again).toMatchObject({ ok: true, newItems: 0, newThreadScans: 0 });
    expect(await threadScans()).toEqual([
      { thread: "I_long", since: iso(at(50)), created: iso(at(-10)) },
    ]);
  });

  it("discards the page and leaves the window untouched when the login changed", async () => {
    const { session, categoryId } = await setUp();
    const fetcher = searching({
      login: "alice-renamed",
      hasNextPage: true,
      hits: [hit("I_1", at(-10), { moreComments: true })],
    });

    const result = await runBackfill(session, categoryId, fetcher);

    expect(result).toEqual({ ok: true, status: "login-changed" });
    expect(await trackedIds()).toEqual([]);
    expect(await threadScans()).toEqual([]);
    expect(await windows()).toEqual([
      { start: iso(ALICE.createdAt), end: WINDOW_END },
    ]);
    const { rows } = await db.query("SELECT login FROM users");
    expect(rows).toEqual([{ login: "alice-renamed" }]);
    expect(logger.log).toHaveBeenCalledWith(
      "login changed",
      expect.objectContaining({ oldLogin: "alice", login: "alice-renamed" }),
    );
    // retried at once, with the new login
    const job = await syncJob();
    expect(job?.locked_by).toBeNull();
    expect(job?.due_in).toBeLessThan(1);

    const retry = searching({ login: "alice-renamed" });
    await runBackfill({ ...session, lease: await claim() }, categoryId, retry);
    expect(searchedFor(retry)[0]).toMatch(/^involves:alice-renamed /);
  });

  it("stores nothing if viewer is someone else", async () => {
    const { session, categoryId } = await setUp();

    const result = await runBackfill(
      session,
      categoryId,
      searching({ viewerId: "U_mallory", hits: [hit("I_1", at(-10))] }),
    );

    expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
    expect(logger.error).toHaveBeenCalledWith(
      "ALERT: viewer is not the job's user",
      expect.objectContaining({ viewer: "U_mallory" }),
    );
    expect(await trackedIds()).toEqual([]);
    expect(await windows()).toHaveLength(1);
  });
});

describe("runThreadScans", () => {
  /**
   * Queues scans for the given threads and finishes the window.
   *
   * @param categoryId The category to queue them in.
   * @param threads Node id and `since_at` of each scan; listed newest thread first.
   */
  const queueScans = async (
    categoryId: string,
    threads: Array<[string, string]>,
  ) => {
    await db.query("DELETE FROM backfill_windows");
    for (const [index, [nodeId, sinceAt]] of threads.entries()) {
      await db.query(
        `INSERT INTO thread_scans (category_id, thread_node_id, since_at, thread_created_at)
         VALUES ($1, $2, $3, $4)`,
        [categoryId, nodeId, sinceAt, at(-100 - index)],
      );
    }
  };

  it("stores the user's comments, advances a thread, and deletes one after its last page", async () => {
    const { session, categoryId } = await setUp();
    await queueScans(categoryId, [
      ["I_long", at(0)],
      ["I_done", at(0)],
    ]);
    const fetcher = scanning([
      thread(
        [
          comment("C_1", at(0)),
          comment("C_2", at(1), bob),
          comment("C_3", at(2)),
        ],
        true,
      ),
      thread([comment("C_4", at(3))]),
    ]);

    const result = await runThreadScans(session, categoryId, fetcher);

    expect(result).toEqual({
      ok: true,
      newItems: 3,
      advanced: 1,
      finished: 1,
      dropped: 0,
    });
    const since = iso(new Date(Date.parse(at(0)) - 1000).toISOString());
    expect(fetcher.mock.calls[0]?.[0]).toEqual({
      id_0: "I_long",
      since_0: since,
      id_1: "I_done",
      since_1: since,
    });
    expect(await trackedIds()).toEqual(["C_1", "C_3", "C_4"]);
    expect(
      (await tracked()).find((row) => row.node_id === "C_3")?.last_event_at,
    ).toEqual(new Date(at(2)));
    expect(await threadScans()).toEqual([
      { thread: "I_long", since: iso(at(2)), created: iso(at(-100)) },
    ]);
    expect(await syncJob()).toMatchObject({ locked_by: null });
    expect(await isBackfillComplete(db, categoryId)).toBe(false);

    // the thread's last page completes the backfill
    await runThreadScans(
      { ...session, lease: await claim() },
      categoryId,
      scanning([thread([comment("C_3", at(2))])]),
    );
    expect(await threadScans()).toEqual([]);
    expect(await isBackfillComplete(db, categoryId)).toBe(true);
  });

  it("reads at most threadScanBatch threads, newest first", async () => {
    const { session, categoryId } = await setUp();
    await queueScans(categoryId, [
      ["I_new", at(0)],
      ["I_old", at(0)],
    ]);
    const fetcher = scanning([thread([])]);

    await runThreadScans(
      { ...session, config: { ...defaultConfig, threadScanBatch: 1 } },
      categoryId,
      fetcher,
    );

    expect(Object.keys(fetcher.mock.calls[0]?.[0] ?? {})).toEqual([
      "id_0",
      "since_0",
    ]);
    expect(fetcher.mock.calls[0]?.[0]).toMatchObject({ id_0: "I_new" });
    expect((await threadScans()).map((row) => row.thread)).toEqual(["I_old"]);
  });

  it("drops the scan of a deleted thread", async () => {
    const { session, categoryId } = await setUp();
    await queueScans(categoryId, [["I_gone", at(0)]]);

    const result = await runThreadScans(
      session,
      categoryId,
      scanning(
        [null],
        [{ type: "NOT_FOUND", message: "gone", path: ["thread_0"] }],
      ),
    );

    expect(result).toMatchObject({ ok: true, dropped: 1 });
    expect(await threadScans()).toEqual([]);
    expect(logger.log).toHaveBeenCalledWith(
      "thread scan dropped: the thread is gone",
      expect.objectContaining({ thread: "I_gone" }),
    );
  });

  it("logs a page stuck at since_at as an error and still moves on a second", async () => {
    const { session, categoryId } = await setUp();
    await queueScans(categoryId, [["I_busy", at(0)]]);

    await runThreadScans(
      session,
      categoryId,
      scanning([thread([comment("C_1", at(0)), comment("C_2", at(0))], true)]),
    );

    expect(await threadScans()).toEqual([
      {
        thread: "I_busy",
        since: iso(new Date(Date.parse(at(0)) + 1000).toISOString()),
        created: iso(at(-100)),
      },
    ]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("stuck at since_at"),
      expect.objectContaining({ thread: "I_busy", sinceAt: iso(at(0)) }),
    );
  });

  it("changes nothing when the query fails", async () => {
    const { session, categoryId } = await setUp();
    await queueScans(categoryId, [["I_long", at(0)]]);

    const result = await runThreadScans(
      session,
      categoryId,
      vi.fn<ScanFetcher>(badGateway),
    );

    expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
    expect(await threadScans()).toEqual([
      { thread: "I_long", since: iso(at(0)), created: iso(at(-100)) },
    ]);
    expect((await syncJob())?.due_in).toBeCloseTo(300, 0);
  });
});
