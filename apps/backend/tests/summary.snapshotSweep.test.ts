import { randomBytes } from "node:crypto";

import { AccessTokenCipher, logger } from "@grn/core";
import type {
  GraphQLError,
  GraphQLFetcherFunction,
  ReactionPollQueryVariables,
  ReactionSnapshotQuery,
  SnapshotItem,
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
import type { SyncSession } from "../src/github/syncClient.ts";
import { LeaseLostError, claimJob } from "../src/jobs/queue.ts";
import { runSnapshotSweep } from "../src/summary/snapshotSweep.ts";
import { signIn } from "../src/users/accounts.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

type Fetcher = GraphQLFetcherFunction<
  ReactionSnapshotQuery,
  ReactionPollQueryVariables
>;

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
const CONTENTS = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
];

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
 * Signs Alice up, finishes her backfill, and claims her `sync` job.
 *
 * @returns The leased job's session and her subscription's id.
 */
const setUp = async (): Promise<{
  session: SyncSession;
  subscriptionId: string;
}> => {
  await signIn(db, ALICE, "gho_alice", { cipher, siteUrl: "https://grn" });
  await db.query("DELETE FROM backfill_windows");
  const { rows } = await db.query<{ id: string }>(
    "SELECT id::text FROM subscriptions",
  );
  return {
    session: {
      db,
      lease: await claim(),
      token: "gho_alice",
      tokenEnc: "",
      siteUrl: "https://grn",
    },
    subscriptionId: String(rows[0]?.id),
  };
};

const url = (nodeId: string) => `https://github.com/octo/repo/issues/${nodeId}`;

/**
 * Adds backfilled items with pending snapshots, all eligible for an hour, so they are picked
 * by `node_id`.
 *
 * @param nodeIds The items.
 * @param type Their content type.
 */
const pending = async (nodeIds: Array<string>, type = "Issue") => {
  for (const nodeId of nodeIds) {
    await db.query(
      `INSERT INTO content (node_id, type, repo_full_name, url, title)
       VALUES ($1, $2, 'octo/repo', $3, 'Thread')`,
      [nodeId, type, url(nodeId)],
    );
    await db.query(
      `INSERT INTO tracked_content (user_id, node_id, last_event_at, watermark_at)
       VALUES ('U_alice', $1, now(), now())`,
      [nodeId],
    );
    await db.query(
      `INSERT INTO content_sources (user_id, node_id, subscription_id)
       SELECT 'U_alice', $1, id FROM subscriptions`,
      [nodeId],
    );
    await db.query(
      `INSERT INTO reaction_snapshots (user_id, node_id, retry_at)
       VALUES ('U_alice', $1, now() - interval '1 hour')`,
      [nodeId],
    );
  }
};

/** @returns An item's reaction groups: every emoji, 0 unless given. */
const reacted = (counts: Partial<Record<string, number>> = {}) => ({
  reactionGroups: CONTENTS.map((content) => ({
    content,
    reactors: { totalCount: counts[content] ?? 0 },
  })),
});

const respond = (
  items: Array<SnapshotItem>,
  errors: Array<GraphQLError> = [],
): ReturnType<Fetcher> =>
  Promise.resolve({
    status: 200,
    statusText: "",
    data: {
      data: {
        rateLimit: { cost: 1 },
        ...Object.fromEntries(
          items.map((item, index) => [`item_${index}`, item]),
        ),
      },
      ...(errors.length > 0 && { errors }),
    },
    headers: {},
    config: {},
  } as Awaited<ReturnType<Fetcher>>);

const responding = (
  items: Array<SnapshotItem>,
  errors: Array<GraphQLError> = [],
) => vi.fn<Fetcher>(() => respond(items, errors));

const snapshots = async () => {
  const { rows } = await db.query<{
    node_id: string;
    thumbs_up: number | null;
    heart: number | null;
    rocket: number | null;
    retry_in: number;
  }>(
    `SELECT node_id, thumbs_up, heart, rocket,
            extract(epoch FROM retry_at - now())::float8 AS retry_in
     FROM reaction_snapshots ORDER BY node_id`,
  );
  return rows;
};

const summaries = async () => {
  const { rows } = await db.query<{ id: string; body: string }>(
    `SELECT id, payload->>'body' AS body FROM jobs
     WHERE kind = 'deliver' AND payload->>'body' LIKE '## 📊%'`,
  );
  return rows;
};

const syncJob = async () => {
  const { rows } = await db.query<{ locked_by: string | null; due_in: number }>(
    `SELECT locked_by, extract(epoch FROM run_at - now())::float8 AS due_in
     FROM jobs WHERE kind = 'sync'`,
  );
  return rows[0];
};

describe("runSnapshotSweep", () => {
  it("fills counts, deletes gone items, and defers failed ones, logging every failure", async () => {
    const { session, subscriptionId } = await setUp();
    await pending(["I_1", "I_2", "I_3", "I_4", "I_5", "I_6"]);
    const fetcher = responding(
      [
        {
          reactionGroups: [
            ...reacted({ THUMBS_UP: 3, HEART: 1 }).reactionGroups,
            { content: "SPARKLES", reactors: { totalCount: 4 } },
          ],
        },
        null,
        null,
        null,
        {},
        reacted({ ROCKET: 9 }),
      ],
      [
        { type: "NOT_FOUND", message: "gone", path: ["item_1"] },
        { type: "FORBIDDEN", message: "SAML enforced", path: ["item_2"] },
        // partial data survived a nested error: never written
        {
          type: "INTERNAL",
          message: "boom",
          path: ["item_5", "reactionGroups", 0, "reactors"],
        },
      ],
    );

    const result = await runSnapshotSweep(session, subscriptionId, fetcher);

    expect(result).toEqual({
      ok: true,
      filled: 1,
      deleted: 2,
      deferred: 3,
      summary: null,
    });
    expect(fetcher.mock.calls[0]?.[0]).toEqual({
      id_0: "I_1",
      id_1: "I_2",
      id_2: "I_3",
      id_3: "I_4",
      id_4: "I_5",
      id_5: "I_6",
    });
    const rows = await snapshots();
    expect(rows.map((row) => row.node_id)).toEqual([
      "I_1",
      "I_3",
      "I_4",
      "I_6",
    ]);
    expect(rows[0]).toMatchObject({ thumbs_up: 3, heart: 1, rocket: 0 });
    for (const row of rows.slice(1)) {
      expect(row.thumbs_up).toBeNull();
      expect(row.retry_in).toBeCloseTo(
        defaultConfig.snapshotRetryDelaySeconds,
        -1,
      );
    }

    const stuck = (item: string, details: Record<string, unknown>) => {
      expect(logger.error).toHaveBeenCalledWith(
        "snapshot stuck, summary held",
        {
          job: session.lease.id,
          user: "U_alice",
          kind: "sync",
          subscription: subscriptionId,
          item,
          url: url(item),
          deferred: 3,
          ...details,
        },
      );
    };
    expect(logger.error).toHaveBeenCalledTimes(3);
    stuck("I_3", {
      failure: "graphql error",
      errorType: "FORBIDDEN",
      message: "SAML enforced",
    });
    stuck("I_4", { failure: "unexpected null" });
    stuck("I_6", {
      failure: "graphql error",
      errorType: "INTERNAL",
      message: "boom",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "snapshot: item has no reactionGroups, row deleted",
      expect.objectContaining({ item: "I_5" }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "snapshot: unknown reaction content ignored",
      expect.objectContaining({ item: "I_1", content: "SPARKLES" }),
    );
    expect(await syncJob()).toMatchObject({ locked_by: null });
    expect(await summaries()).toEqual([]);
  });

  it.each([
    [
      "an error that belongs to no item",
      responding([reacted()], [{ type: "INTERNAL", message: "boom" }]),
    ],
    [
      "an error at an alias beyond the batch",
      responding([reacted()], [{ type: "FORBIDDEN", path: ["item_1"] }]),
    ],
    ["a missing alias", vi.fn<Fetcher>(() => respond([]))],
    [
      "malformed counts at an item without errors",
      responding([
        { reactionGroups: [{ content: "HEART", reactors: {} }] } as never,
      ]),
    ],
  ])("changes nothing on %s", async (_name, fetcher) => {
    const { session, subscriptionId } = await setUp();
    await pending(["I_1"]);
    const before = await snapshots();

    expect(await runSnapshotSweep(session, subscriptionId, fetcher)).toEqual({
      ok: false,
      failure: { kind: "transient" },
    });
    expect(await snapshots()).toEqual(
      before.map((row) => ({
        ...row,
        retry_in: expect.any(Number) as unknown,
      })),
    );
    expect((await syncJob())?.due_in).toBeCloseTo(
      defaultConfig.syncRetrySeconds,
      0,
    );
  });

  it("stores nothing if the lease was lost, and the re-run writes each row once", async () => {
    const { session, subscriptionId } = await setUp();
    await pending(["I_1", "I_2"]);
    const lost = vi.fn<Fetcher>(async () => {
      await db.query("UPDATE jobs SET locked_by = gen_random_uuid()");
      return respond(
        [reacted({ HEART: 1 }), null],
        [{ type: "NOT_FOUND", path: ["item_1"] }],
      );
    });

    await expect(
      runSnapshotSweep(session, subscriptionId, lost),
    ).rejects.toThrow(LeaseLostError);
    expect((await snapshots()).map((row) => row.thumbs_up)).toEqual([
      null,
      null,
    ]);

    const rerun = responding(
      [reacted({ HEART: 1 }), null],
      [{ type: "NOT_FOUND", path: ["item_1"] }],
    );
    const result = await runSnapshotSweep(
      { ...session, lease: await claim() },
      subscriptionId,
      rerun,
    );
    expect(result).toMatchObject({ ok: true, filled: 1, deleted: 1 });
    expect(await snapshots()).toMatchObject([{ node_id: "I_1", heart: 1 }]);
    expect(await summaries()).toHaveLength(1);
  });

  it("lets the next batch pick other rows while failed ones are deferred", async () => {
    const { session, subscriptionId } = await setUp();
    await pending(["I_1", "I_2", "I_3"]);
    const config = { ...defaultConfig, snapshotBatch: 2 };
    const forbidden = responding(
      [null, null],
      [
        { type: "FORBIDDEN", path: ["item_0"] },
        { type: "FORBIDDEN", path: ["item_1"] },
      ],
    );

    expect(
      await runSnapshotSweep({ ...session, config }, subscriptionId, forbidden),
    ).toMatchObject({ ok: true, filled: 0, deleted: 0, deferred: 2 });

    const next = responding([reacted()]);
    expect(
      await runSnapshotSweep(
        { ...session, config, lease: await claim() },
        subscriptionId,
        next,
      ),
    ).toMatchObject({ ok: true, filled: 1, summary: null });
    expect(next.mock.calls[0]?.[0]).toEqual({ id_0: "I_3" });
    // the deferred rows still hold the summary
    expect(await summaries()).toEqual([]);
  });

  it("queues the summary exactly once, with the last batch", async () => {
    const { session, subscriptionId } = await setUp();
    await pending(["C_1"], "IssueComment");
    await pending(["I_1"]);
    await pending(["PR_1"], "PullRequest");
    const config = { ...defaultConfig, snapshotBatch: 2 };

    expect(
      await runSnapshotSweep(
        { ...session, config },
        subscriptionId,
        responding([
          reacted({ THUMBS_UP: 1000, HEART: 2 }),
          reacted({ THUMBS_UP: 5, ROCKET: 2 }),
        ]),
      ),
    ).toMatchObject({ ok: true, filled: 2, summary: null });
    expect(await summaries()).toEqual([]);

    const last = await runSnapshotSweep(
      { ...session, config, lease: await claim() },
      subscriptionId,
      responding([reacted()]),
    );

    const notices = await summaries();
    expect(notices).toHaveLength(1);
    const id = notices[0]?.id;
    expect(last).toMatchObject({ ok: true, filled: 1, summary: id });
    expect(notices[0]?.body).toBe(
      [
        "## 📊 Your reactions so far",
        "",
        "GRN finished scanning your history. Here's where things stand:",
        "",
        "|   | Issues | Pull requests | Comments | Total |",
        "| --- | ---: | ---: | ---: | ---: |",
        "| Items found | 1 | 1 | 1 | 3 |",
        "",
        "- Items with reactions: 2",
        "- Reactions: 1\u202F009",
        "",
        "👍 1\u202F005 · ❤️ 2 · 🚀 2",
        "",
        "From now on, new reactions show up here as they arrive.",
        "",
        `<!-- grn:${String(id)} -->`,
      ].join("\n"),
    );
  });

  it("queues the summary when the last pending row is deleted", async () => {
    const { session, subscriptionId } = await setUp();
    await pending(["I_1", "I_2"]);
    await db.query(
      `UPDATE reaction_snapshots
       SET thumbs_up = 2, thumbs_down = 0, laugh = 0, hooray = 0, confused = 0, heart = 0,
           rocket = 0, eyes = 0
       WHERE node_id = 'I_1'`,
    );

    const result = await runSnapshotSweep(
      session,
      subscriptionId,
      responding([null], [{ type: "NOT_FOUND", path: ["item_0"] }]),
    );

    expect(result).toMatchObject({ ok: true, filled: 0, deleted: 1 });
    const notices = await summaries();
    expect(notices).toHaveLength(1);
    expect(notices[0]?.body).toContain("| Items found | 1 | 0 | 0 | 1 |");
    expect(notices[0]?.body).toContain("👍 2");
  });

  it("doesn't queue the summary from a batch whose every row failed", async () => {
    const { session, subscriptionId } = await setUp();
    await pending(["I_1"]);

    expect(
      await runSnapshotSweep(
        session,
        subscriptionId,
        responding([null], [{ type: "FORBIDDEN", path: ["item_0"] }]),
      ),
    ).toMatchObject({ ok: true, deferred: 1, summary: null });
    expect(await summaries()).toEqual([]);

    // the retry succeeds and completes the subscription
    await db.query("UPDATE reaction_snapshots SET retry_at = now()");
    expect(
      await runSnapshotSweep(
        { ...session, lease: await claim() },
        subscriptionId,
        responding([reacted()]),
      ),
    ).toMatchObject({
      ok: true,
      filled: 1,
      summary: expect.any(String) as unknown,
    });
    expect(await summaries()).toHaveLength(1);
  });

  it("doesn't queue the summary while a backfill window remains", async () => {
    const { session, subscriptionId } = await setUp();
    await pending(["I_1"]);
    await db.query(
      `INSERT INTO backfill_windows (category_id, window_start, window_end)
       SELECT id, now() - interval '1 year', now() FROM subscription_categories`,
    );

    expect(
      await runSnapshotSweep(session, subscriptionId, responding([reacted()])),
    ).toMatchObject({ ok: true, filled: 1, summary: null });
    expect(await summaries()).toEqual([]);
  });
});
