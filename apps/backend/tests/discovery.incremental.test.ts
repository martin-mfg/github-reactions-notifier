import { randomBytes } from "node:crypto";

import { AccessTokenCipher, logger } from "@grn/core";
import type {
  AuthoredDiscoveryQuery,
  AuthoredDiscoveryQueryVariables,
  GraphQLFetcherFunction,
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

import type { Database } from "../src/db.ts";
import { runIncrementalDiscovery } from "../src/discovery/incremental.ts";
import type { SyncSession } from "../src/github/syncClient.ts";
import { LeaseLostError, claimJob } from "../src/jobs/queue.ts";
import { signIn } from "../src/users/accounts.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

type Fetcher = GraphQLFetcherFunction<
  AuthoredDiscoveryQuery,
  AuthoredDiscoveryQueryVariables
>;
type FetcherResponse = Awaited<ReturnType<Fetcher>>;
type Viewer = AuthoredDiscoveryQuery["viewer"];

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

/** Every pass's watermark in these tests. */
const WATERMARK = "2026-10-01T12:00:00.000Z";

/**
 * @param minutes Offset from {@link WATERMARK}.
 * @returns The ISO timestamp, in GitHub's whole seconds.
 */
const at = (minutes: number): string =>
  new Date(Date.parse(WATERMARK) + minutes * 60_000)
    .toISOString()
    .replace(".000Z", "Z");

/**
 * Signs Alice up, sets every pass's watermark to {@link WATERMARK}, and claims her `sync` job.
 *
 * @returns The leased job's session and her category's id.
 */
const setUp = async (): Promise<{
  session: SyncSession;
  categoryId: string;
}> => {
  await signIn(db, ALICE, "gho_alice", { cipher, siteUrl: "https://grn" });
  await db.query("UPDATE subscription_passes SET watermark = $1", [WATERMARK]);
  await db.query(
    "UPDATE jobs SET run_at = now() - interval '1 minute' WHERE kind = 'sync'",
  );
  const lease = await claimJob(db, "sync");
  if (!lease) {
    throw new Error("no lease");
  }
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM subscription_categories",
  );
  const { rows: users } = await db.query<{ token_enc: string }>(
    "SELECT token_enc FROM users",
  );
  return {
    session: {
      db,
      lease,
      token: "gho_alice",
      tokenEnc: users[0]?.token_enc ?? "",
      siteUrl: "https://grn",
    },
    categoryId: String(rows[0]?.id),
  };
};

const repository = { nameWithOwner: "octo/repo" };
const alice = { id: "U_alice", login: "alice" };

const issue = (id: string, createdAt: string) => ({
  __typename: "Issue" as const,
  id,
  url: `https://github.com/octo/repo/issues/${id}`,
  title: `Issue ${id}`,
  createdAt,
  repository,
  author: alice,
});

const pullRequest = (id: string, createdAt: string) => ({
  __typename: "PullRequest" as const,
  id,
  url: `https://github.com/octo/repo/pull/${id}`,
  title: `PR ${id}`,
  createdAt,
  repository,
  author: alice,
});

const comment = (id: string, createdAt: string, updatedAt = createdAt) => ({
  __typename: "IssueComment" as const,
  id,
  url: `https://github.com/octo/repo/issues/1#issuecomment-${id}`,
  createdAt,
  updatedAt,
  repository,
  issue: { title: "Thread" },
  author: alice,
});

interface Pages {
  issues?: Viewer["issues"]["nodes"];
  pullRequests?: Viewer["pullRequests"]["nodes"];
  issueComments?: Viewer["issueComments"]["nodes"];
  hasNextPage?: Partial<
    Record<"issues" | "pullRequests" | "issueComments", boolean>
  >;
  login?: string;
  viewerId?: string;
}

const discovery = (pages: Pages = {}): AuthoredDiscoveryQuery => ({
  viewer: {
    id: pages.viewerId ?? ALICE.id,
    login: pages.login ?? ALICE.login,
    issues: {
      pageInfo: { hasNextPage: pages.hasNextPage?.issues ?? false },
      nodes: pages.issues ?? [],
    },
    pullRequests: {
      pageInfo: { hasNextPage: pages.hasNextPage?.pullRequests ?? false },
      nodes: pages.pullRequests ?? [],
    },
    issueComments: {
      pageInfo: { hasNextPage: pages.hasNextPage?.issueComments ?? false },
      nodes: pages.issueComments ?? [],
    },
  },
  rateLimit: { cost: 1 },
});

const resolving = (pages: Pages = {}) =>
  vi.fn<Fetcher>(() =>
    Promise.resolve({
      status: 200,
      statusText: "",
      data: { data: discovery(pages) },
      headers: {},
      config: {},
    } as FetcherResponse),
  );

const watermarks = async (): Promise<Record<string, string>> => {
  const { rows } = await db.query<{ pass: string; watermark: Date }>(
    "SELECT pass, watermark FROM subscription_passes",
  );
  return Object.fromEntries(
    rows.map((row) => [row.pass, row.watermark.toISOString()]),
  );
};

const tracked = async () => {
  const { rows } = await db.query<{
    node_id: string;
    last_event_at: Date;
    watermark_at: Date;
    enabled_at: Date;
    checked_ago: number;
  }>(
    `SELECT t.node_id, t.last_event_at, t.watermark_at, st.enabled_at,
            extract(epoch FROM now() - t.last_checked_at)::double precision AS checked_ago
     FROM tracked_content t
     JOIN content c USING (node_id)
     JOIN subscription_types st ON st.content_type = c.type
     ORDER BY t.node_id`,
  );
  return rows;
};

const trackedIds = async () => (await tracked()).map((row) => row.node_id);

const category = async () => {
  const { rows } = await db.query<{
    checked_ago: number;
    found_ago: number;
  }>(
    `SELECT extract(epoch FROM now() - last_checked_at)::double precision AS checked_ago,
            extract(epoch FROM now() - last_find_at)::double precision AS found_ago
     FROM subscription_categories`,
  );
  return rows[0];
};

const ageCategory = async () => {
  await db.query(
    `UPDATE subscription_categories
     SET last_checked_at = now() - interval '1 hour', last_find_at = now() - interval '1 hour'`,
  );
};

describe("runIncrementalDiscovery", () => {
  it("stores the items at or above each watermark and advances it in the same commit", async () => {
    const { session, categoryId } = await setUp();
    await ageCategory();
    const fetcher = resolving({
      issues: [issue("I_new", at(30)), issue("I_old", at(-1))],
      pullRequests: [pullRequest("PR_new", at(20))],
      issueComments: [comment("IC_new", at(10)), comment("IC_old", at(-5))],
    });

    const result = await runIncrementalDiscovery(session, categoryId, fetcher);

    expect(result).toMatchObject({ ok: true, newItems: 3 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await trackedIds()).toEqual(["IC_new", "I_new", "PR_new"]);
    expect(await watermarks()).toEqual({
      Issue: new Date(at(30)).toISOString(),
      PullRequest: new Date(at(20)).toISOString(),
      IssueComment: new Date(at(10)).toISOString(),
    });

    // FR-6: every new row starts at its type's enabled_at, and last_event_at = createdAt.
    for (const row of await tracked()) {
      expect(row.watermark_at).toEqual(row.enabled_at);
      expect(row.checked_ago).toBeLessThan(5);
    }
    const newIssue = (await tracked()).find((row) => row.node_id === "I_new");
    expect(newIssue?.last_event_at).toEqual(new Date(at(30)));

    const { rows: content } = await db.query(
      "SELECT * FROM content WHERE node_id = 'IC_new'",
    );
    expect(content).toEqual([
      {
        node_id: "IC_new",
        type: "IssueComment",
        repo_full_name: "octo/repo",
        url: "https://github.com/octo/repo/issues/1#issuecomment-IC_new",
        title: "Thread",
        author_id: "U_alice",
        author_login: "alice",
      },
    ]);
    const { rows: sources } = await db.query(
      "SELECT node_id FROM content_sources ORDER BY node_id",
    );
    expect(sources).toHaveLength(3);

    // finding something new resets last_find_at; every run resets last_checked_at
    expect((await category())?.checked_ago).toBeLessThan(5);
    expect((await category())?.found_ago).toBeLessThan(5);

    // the task released the sync job
    const { rows: jobs } = await db.query<{ locked_by: string | null }>(
      "SELECT locked_by FROM jobs WHERE kind = 'sync'",
    );
    expect(jobs).toEqual([{ locked_by: null }]);
  });

  it("keeps an item exactly at the watermark, and re-reading it is free", async () => {
    const { session, categoryId } = await setUp();
    const pages = { issues: [issue("I_tie", at(0))] };

    expect(
      await runIncrementalDiscovery(session, categoryId, resolving(pages)),
    ).toMatchObject({ ok: true, newItems: 1 });
    expect(await trackedIds()).toEqual(["I_tie"]);
    expect((await watermarks())["Issue"]).toBe(WATERMARK);

    // the next run reads the same tie again: nothing new, nothing changes
    await ageCategory();
    const lease = await claimJob(db, "sync");
    if (!lease) {
      throw new Error("no lease");
    }
    const again = await runIncrementalDiscovery(
      { ...session, lease },
      categoryId,
      resolving(pages),
    );

    expect(again).toMatchObject({ ok: true, newItems: 0 });
    expect(await trackedIds()).toEqual(["I_tie"]);
    expect((await watermarks())["Issue"]).toBe(WATERMARK);
    expect((await category())?.checked_ago).toBeLessThan(5);
    expect((await category())?.found_ago).toBeGreaterThan(3000);
  });

  it("leaves the watermarks and the category unchanged when the query fails", async () => {
    const { session, categoryId } = await setUp();
    await ageCategory();
    const fetcher = vi.fn<Fetcher>(() =>
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
      ),
    );

    const result = await runIncrementalDiscovery(session, categoryId, fetcher);

    expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
    expect(await watermarks()).toEqual({
      Issue: WATERMARK,
      PullRequest: WATERMARK,
      IssueComment: WATERMARK,
    });
    expect(await trackedIds()).toEqual([]);
    expect((await category())?.checked_ago).toBeGreaterThan(3000);
    const { rows } = await db.query<{
      locked_by: string | null;
      due_in: number;
    }>(
      `SELECT locked_by, extract(epoch FROM run_at - now())::double precision AS due_in
       FROM jobs WHERE kind = 'sync'`,
    );
    expect(rows[0]?.locked_by).toBeNull();
    expect(rows[0]?.due_in).toBeCloseTo(300, 0);
  });

  it("stops the comment pass on updatedAt, so an edited old comment doesn't end it early", async () => {
    const { session, categoryId } = await setUp();
    const fetcher = resolving({
      issueComments: [
        // edited a minute ago, written years ago: comes first
        comment("IC_edited", "2020-01-01T00:00:00Z", at(10)),
        comment("IC_new", at(5)),
        comment("IC_stale", "2020-01-01T00:00:00Z", at(-1)),
      ],
    });

    await runIncrementalDiscovery(session, categoryId, fetcher);

    expect(await trackedIds()).toEqual(["IC_edited", "IC_new"]);
    expect((await watermarks())["IssueComment"]).toBe(
      new Date(at(10)).toISOString(),
    );
    const edited = (await tracked()).find((row) => row.node_id === "IC_edited");
    expect(edited?.last_event_at).toEqual(new Date("2020-01-01T00:00:00Z"));
  });

  it("logs an overflowing pass as an error, makes no second query, and advances its watermark", async () => {
    const { session, categoryId } = await setUp();
    const fetcher = resolving({
      issues: [issue("I_2", at(20)), issue("I_1", at(10))],
      pullRequests: [pullRequest("PR_1", at(10)), pullRequest("PR_0", at(-1))],
      hasNextPage: { issues: true, pullRequests: true },
    });

    await runIncrementalDiscovery(session, categoryId, fetcher);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("overflowed"),
      expect.objectContaining({
        job: session.lease.id,
        user: "U_alice",
        pass: "Issue",
        watermark: WATERMARK,
        oldest: new Date(at(10)).toISOString(),
      }),
    );
    expect(await trackedIds()).toEqual(["I_1", "I_2", "PR_1"]);
    expect(await watermarks()).toMatchObject({
      Issue: new Date(at(20)).toISOString(),
      PullRequest: new Date(at(10)).toISOString(),
    });
  });

  it("refreshes the user's login from viewer", async () => {
    const { session, categoryId } = await setUp();

    await runIncrementalDiscovery(
      session,
      categoryId,
      resolving({ login: "alice-renamed" }),
    );

    const { rows } = await db.query("SELECT login FROM users");
    expect(rows).toEqual([{ login: "alice-renamed" }]);
    expect(logger.log).toHaveBeenCalledWith(
      "login changed",
      expect.objectContaining({ oldLogin: "alice", login: "alice-renamed" }),
    );
  });

  it("stores nothing if viewer is someone else", async () => {
    const { session, categoryId } = await setUp();

    const result = await runIncrementalDiscovery(
      session,
      categoryId,
      resolving({ viewerId: "U_mallory", issues: [issue("I_1", at(10))] }),
    );

    expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
    expect(logger.error).toHaveBeenCalledWith(
      "ALERT: viewer is not the job's user",
      expect.objectContaining({ viewer: "U_mallory" }),
    );
    expect(await trackedIds()).toEqual([]);
    expect((await watermarks())["Issue"]).toBe(WATERMARK);
  });

  it("stores nothing if the lease was lost", async () => {
    const { session, categoryId } = await setUp();
    const fetcher = resolving({ issues: [issue("I_1", at(10))] });
    fetcher.mockImplementationOnce(async (...args) => {
      await db.query("UPDATE jobs SET locked_by = gen_random_uuid()");
      return resolving({ issues: [issue("I_1", at(10))] })(...args);
    });

    await expect(
      runIncrementalDiscovery(session, categoryId, fetcher),
    ).rejects.toThrow(LeaseLostError);
    expect(await trackedIds()).toEqual([]);
    expect((await watermarks())["Issue"]).toBe(WATERMARK);
  });
});
