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

import { defaultConfig } from "../src/config.ts";
import type { Database } from "../src/db.ts";
import { runBackfill } from "../src/discovery/backfill.ts";
import { runIncrementalDiscovery } from "../src/discovery/incremental.ts";
import { runThreadScans } from "../src/discovery/threadScans.ts";
import type { SyncSession } from "../src/github/syncClient.ts";
import { claimJob } from "../src/jobs/queue.ts";
import { runPoll } from "../src/polling/poll.ts";
import { chooseSyncTask, runSyncTask } from "../src/sync/schedule.ts";
import { signIn } from "../src/users/accounts.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

// the tasks themselves are tested on their own; here only which one runs
vi.mock("../src/polling/poll.ts", () => ({ runPoll: vi.fn() }));
vi.mock("../src/discovery/backfill.ts", () => ({ runBackfill: vi.fn() }));
vi.mock("../src/discovery/incremental.ts", () => ({
  runIncrementalDiscovery: vi.fn(),
}));
vi.mock("../src/discovery/threadScans.ts", () => ({
  runThreadScans: vi.fn(),
}));

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
  vi.clearAllMocks();
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
});

const cipher = new AccessTokenCipher([randomBytes(32)]);
const ALICE = {
  id: "U_alice",
  login: "alice",
  createdAt: "2015-01-01T00:00:00Z",
};

/**
 * Signs Alice up and claims her `sync` job.
 *
 * @returns The leased job's session and her category's id.
 */
const setUp = async (): Promise<{
  session: SyncSession;
  categoryId: string;
}> => {
  await signIn(db, ALICE, "gho_alice", { cipher, siteUrl: "https://grn" });
  const lease = await claimJob(db, "sync");
  if (!lease) {
    throw new Error("no lease");
  }
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM subscription_categories",
  );
  return {
    session: {
      db,
      lease,
      token: "gho_alice",
      tokenEnc: "",
      siteUrl: "https://grn",
    },
    categoryId: String(rows[0]?.id),
  };
};

const choose = () => chooseSyncTask(db, "U_alice");

/** Sets the category's discovery times, as `interval`s ago. */
const discovered = (checkedAgo: string, foundAgo: string) =>
  db.query(
    `UPDATE subscription_categories
     SET last_checked_at = now() - $1::interval, last_find_at = now() - $2::interval`,
    [checkedAgo, foundAgo],
  );

/** Tracks an item, with its times as `interval`s ago. */
const track = async (nodeId: string, checkedAgo: string, eventAgo: string) => {
  await db.query(
    `INSERT INTO content (node_id, type, repo_full_name, url, title)
     VALUES ($1, 'Issue', 'octo/repo', 'https://github.com/octo/repo/issues/1', 'Bug')`,
    [nodeId],
  );
  await db.query(
    `INSERT INTO tracked_content (user_id, node_id, last_checked_at, last_event_at, watermark_at)
     VALUES ('U_alice', $1, now() - $2::interval, now() - $3::interval, now())`,
    [nodeId, checkedAgo, eventAgo],
  );
};

/** Sets the backfill window's times, as `interval`s ago. */
const windowAt = (createdAgo: string, endAgo: string) =>
  db.query(
    `UPDATE backfill_windows
     SET window_created_at = now() - $1::interval, window_end = now() - $2::interval`,
    [createdAgo, endAgo],
  );

describe("chooseSyncTask", () => {
  it("picks the backfill right after signup", async () => {
    const { categoryId } = await setUp();

    expect(await choose()).toMatchObject({ kind: "backfill", categoryId });
  });

  it("picks the top score among polls, discovery, backfill and thread scans", async () => {
    const { categoryId } = await setUp();
    await windowAt("1 hour", "1 year");
    // ≈ 0.067 × w = 0.135
    await discovered("10 minutes", "1 day");
    expect(await choose()).toMatchObject({ kind: "discovery", categoryId });

    // ≈ 0.0003: an old item does not beat discovery
    await track("I_cold", "5 minutes", "1 year");
    expect(await choose()).toMatchObject({ kind: "discovery" });

    // ≈ 11.4: a hot item does
    await track("I_hot", "5 minutes", "1 minute");
    const poll = await choose();
    expect(poll).toMatchObject({ kind: "poll" });
    expect(poll.kind === "poll" && poll.score).toBeCloseTo(11.4, 0);

    await db.query(
      `INSERT INTO thread_scans (category_id, thread_node_id, since_at, thread_created_at,
                                 scan_created_at)
       VALUES ($1, 'I_thread', now(), now() - interval '1 minute', now() - interval '1 hour')`,
      [categoryId],
    );
    expect(await choose()).toMatchObject({ kind: "threadScan", categoryId });
  });

  it("weights discovery by w", async () => {
    await setUp();
    await windowAt("0 seconds", "0 seconds");
    // 0.2 × w for discovery against 0.2 for the item
    await discovered("1000 seconds", "5000 seconds");
    await track("I_1", "1000 seconds", "5000 seconds");

    expect(await choose()).toMatchObject({ kind: "discovery" });
    expect(
      await chooseSyncTask(db, "U_alice", {
        ...defaultConfig,
        discoveryWeight: 0.5,
      }),
    ).toMatchObject({ kind: "poll" });
  });

  it("does not poll or discover before D and D_discovery have passed", async () => {
    await setUp();
    await windowAt("0 seconds", "0 seconds");
    await discovered("3 minutes", "1 minute");
    await track("I_1", "3 minutes", "1 minute");

    expect(await choose()).toMatchObject({ kind: "backfill" });
  });

  it("waits until the first item or category is due when nothing is eligible", async () => {
    await setUp();
    await db.query("DELETE FROM backfill_windows");
    await discovered("1 minute", "1 minute");
    let task = await choose();
    expect(task.kind).toBe("idle");
    expect(
      task.kind === "idle" && (task.until.getTime() - Date.now()) / 1000,
    ).toBeCloseTo(180, -1);

    await track("I_1", "3 minutes", "1 minute");
    task = await choose();
    expect(
      task.kind === "idle" && (task.until.getTime() - Date.now()) / 1000,
    ).toBeCloseTo(60, -1);
  });
});

describe("runSyncTask", () => {
  it("runs the top task", async () => {
    const { session, categoryId } = await setUp();

    expect(await runSyncTask(session)).toMatchObject({ kind: "backfill" });
    expect(runBackfill).toHaveBeenCalledWith(session, categoryId);

    await discovered("10 minutes", "1 minute");
    await runSyncTask(session);
    expect(runIncrementalDiscovery).toHaveBeenCalledWith(session, categoryId);

    await db.query(
      `INSERT INTO thread_scans (category_id, thread_node_id, since_at, thread_created_at,
                                 scan_created_at)
       VALUES ($1, 'I_thread', now(), now() - interval '1 minute', now() - interval '1 day')`,
      [categoryId],
    );
    await runSyncTask(session);
    expect(runThreadScans).toHaveBeenCalledWith(session, categoryId);

    await track("I_1", "1 day", "1 second");
    await runSyncTask(session);
    expect(runPoll).toHaveBeenCalledWith(session);
  });

  it("releases the job until the next item is due when idle", async () => {
    const { session } = await setUp();
    await db.query("DELETE FROM backfill_windows");
    await track("I_1", "3 minutes", "1 minute");

    expect(await runSyncTask(session)).toMatchObject({ kind: "idle" });

    const { rows } = await db.query<{
      locked_by: string | null;
      due_in: number;
    }>(
      `SELECT locked_by, extract(epoch FROM run_at - now())::float8 AS due_in
       FROM jobs WHERE kind = 'sync'`,
    );
    expect(rows[0]?.locked_by).toBeNull();
    expect(rows[0]?.due_in).toBeCloseTo(60, -1);
  });
});
