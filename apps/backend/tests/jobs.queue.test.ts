import { logger } from "@grn/core";
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
  LeaseLostError,
  claimJob,
  deleteJob,
  reapExpiredLeases,
  releaseDeliver,
  releaseSync,
  renewLease,
  withLease,
} from "../src/jobs/queue.ts";
import type { Lease } from "../src/jobs/queue.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

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
});

const insertUser = async (
  id: string,
  tokenStatus = "active",
): Promise<void> => {
  await db.query(
    `INSERT INTO users (gh_user_id, login, gh_created_at, token_enc, token_nonce, token_status)
     VALUES ($1, $1, now() - interval '10 years', 'v1.enc', 'nonce', $2)`,
    [id, tokenStatus],
  );
};

/**
 * @param kind Job kind.
 * @param userId Owner of the job.
 * @param runAt Offset from now, as a Postgres interval.
 * @param payload The job's payload.
 * @returns The new job's id.
 */
const insertJob = async (
  kind: "sync" | "deliver",
  userId: string,
  runAt = "-1 minute",
  payload: object | null = null,
): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, user_id, run_at, payload)
     VALUES ($1, $2, now() + $3::interval, $4) RETURNING id`,
    [kind, userId, runAt, payload],
  );
  return rows[0]?.id ?? "";
};

const insertChannel = async (
  userId: string,
  target: string | null,
): Promise<void> => {
  await db.query(
    `INSERT INTO notification_channels (user_id, kind, target)
     VALUES ($1, 'github_issue', $2)`,
    [userId, target],
  );
};

const setRateLimit = async (
  userId: string,
  used: number,
  resetIn: string,
  limit = 5000,
): Promise<void> => {
  await db.query(
    `INSERT INTO rate_limit_state (user_id, limit_, used, reset_at)
     VALUES ($1, $2, $3, now() + $4::interval)`,
    [userId, limit, used, resetIn],
  );
};

const setBucket = async (level: number, levelAt: string): Promise<void> => {
  await db.query(
    "UPDATE dispatch_bucket SET level = $1, level_at = now() + $2::interval",
    [level, levelAt],
  );
};

const jobRow = async (id: string) => {
  const { rows } = await db.query<{
    locked_by: string | null;
    attempts: number;
    run_in: number;
  }>(
    `SELECT locked_by, attempts, extract(epoch FROM run_at - now())::float8 AS run_in
     FROM jobs WHERE id = $1`,
    [id],
  );
  return rows[0];
};

const claim = (kind: "sync" | "deliver", config = defaultConfig) =>
  claimJob(db, kind, config);

const mustClaim = async (kind: "sync" | "deliver"): Promise<Lease> => {
  const lease = await claim(kind);
  if (!lease) {
    throw new Error(`expected a due ${kind} job`);
  }
  return lease;
};

describe("schema", () => {
  beforeEach(async () => {
    await insertUser("U_a");
  });

  it("allows only one sync job per user", async () => {
    await insertJob("sync", "U_a");

    await expect(insertJob("sync", "U_a")).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("allows only one active github_issue channel per user", async () => {
    await insertChannel("U_a", null);

    await expect(insertChannel("U_a", null)).rejects.toMatchObject({
      code: "23505",
    });
  });

  it("allows only one digest per user", async () => {
    await insertJob("deliver", "U_a", "0 s", { digest: true, state: "open" });
    await insertJob("deliver", "U_a", "0 s", { body: "one-off" });

    await expect(
      insertJob("deliver", "U_a", "0 s", { digest: true, state: "open" }),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps exactly one dispatch_bucket row", async () => {
    await expect(
      db.query(
        "INSERT INTO dispatch_bucket (level, level_at) VALUES (1, now())",
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("requires the global row behind each per-user row", async () => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO subscriptions (user_id) VALUES ('U_a') RETURNING id",
    );
    const subscriptionId = rows[0]?.id;

    await expect(
      db.query(
        `INSERT INTO tracked_content (user_id, node_id, last_event_at, watermark_at)
         VALUES ('U_a', 'I_x', now(), now())`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db.query(
        `INSERT INTO content_sources (user_id, node_id, subscription_id)
         VALUES ('U_a', 'I_x', $1)`,
        [subscriptionId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      db.query(
        `INSERT INTO reaction_notifications (user_id, node_id, reactor_id, emoji)
         VALUES ('U_a', 'I_x', 'U_r', 'HEART')`,
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps a global row while a per-user row references it", async () => {
    await db.query(
      `INSERT INTO content (node_id, type, repo_full_name, url, title)
       VALUES ('I_x', 'Issue', 'o/r', 'https://github.com/o/r/issues/1', 't')`,
    );
    await db.query(
      `INSERT INTO tracked_content (user_id, node_id, last_event_at, watermark_at)
       VALUES ('U_a', 'I_x', now(), now())`,
    );

    await expect(
      db.query("DELETE FROM content WHERE node_id = 'I_x'"),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("deletes a user's per-user rows with the user", async () => {
    await insertJob("sync", "U_a");
    await insertChannel("U_a", null);
    await setRateLimit("U_a", 0, "1 hour");

    await db.query("DELETE FROM users WHERE gh_user_id = 'U_a'");

    const { rows } = await db.query<{ n: number }>(
      `SELECT (SELECT count(*) FROM jobs)
            + (SELECT count(*) FROM notification_channels)
            + (SELECT count(*) FROM rate_limit_state) AS n`,
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });
});

describe("claiming sync jobs", () => {
  it("leases the job with a fresh fencing token and counts the attempt", async () => {
    await insertUser("U_a");
    const id = await insertJob("sync", "U_a");

    const first = await mustClaim("sync");
    expect(first).toMatchObject({
      id,
      kind: "sync",
      userId: "U_a",
      attempts: 1,
    });
    expect(await claim("sync")).toBeNull();

    await withLease(db, first, (client) => releaseSync(client, first));
    const second = await mustClaim("sync");

    expect(second.lockedBy).not.toBe(first.lockedBy);
    expect(second.attempts).toBe(1);
  });

  it("skips jobs that aren't due yet", async () => {
    await insertUser("U_a");
    await insertJob("sync", "U_a", "1 minute");

    expect(await claim("sync")).toBeNull();
  });

  it.each(["revoked", "invalid"])(
    "skips users whose token is %s",
    async (status) => {
      await insertUser("U_a", status);
      await insertJob("sync", "U_a");

      expect(await claim("sync")).toBeNull();
    },
  );

  it("takes the oldest run_at first, which makes a round-robin", async () => {
    await insertUser("U_a");
    await insertUser("U_b");
    await insertUser("U_c");
    await insertJob("sync", "U_b", "-2 minutes");
    await insertJob("sync", "U_c", "-1 minute");
    await insertJob("sync", "U_a", "-3 minutes");

    const order: Array<string> = [];
    for (let i = 0; i < 6; i++) {
      const lease = await mustClaim("sync");
      order.push(lease.userId);
      await withLease(db, lease, (client) => releaseSync(client, lease));
    }

    expect(order).toStrictEqual(["U_a", "U_b", "U_c", "U_a", "U_b", "U_c"]);
  });

  it("releases with attempts reset and the given run_at", async () => {
    await insertUser("U_a");
    const id = await insertJob("sync", "U_a");
    const lease = await mustClaim("sync");

    await withLease(db, lease, (client) =>
      releaseSync(client, lease, new Date(Date.now() + 60_000)),
    );

    const row = await jobRow(id);
    expect(row).toMatchObject({ locked_by: null, attempts: 0 });
    expect(row?.run_in).toBeGreaterThan(50);
    expect(await claim("sync")).toBeNull();
  });

  describe("budget", () => {
    beforeEach(async () => {
      await insertUser("U_a");
      await insertJob("sync", "U_a");
    });

    it("is due without a stored rate limit", async () => {
      expect(await claim("sync")).not.toBeNull();
    });

    it("follows the elapsed ramp: TARGET × limit × elapsed − used > 0", async () => {
      // Half the window has elapsed: allowance = 0.8 × 5000 × 0.5 − used = 2000 − used.
      await setRateLimit("U_a", 1990, "30 minutes");
      expect(await claim("sync")).not.toBeNull();
    });

    it("isn't due once the allowance is spent", async () => {
      await setRateLimit("U_a", 2010, "30 minutes");
      expect(await claim("sync")).toBeNull();
    });

    it("keeps RESERVE points for the user's own tools", async () => {
      // With TARGET = 1 near the window's end the allowance is positive, so only RESERVE binds.
      const config = { ...defaultConfig, budgetTarget: 1 };
      await setRateLimit("U_a", 4510, "5 seconds");
      expect(await claim("sync", config)).toBeNull();

      await db.query("UPDATE rate_limit_state SET used = 4490");
      expect(await claim("sync", config)).not.toBeNull();
    });

    it("treats the window as rolled over after reset_at + CLOCK_MARGIN", async () => {
      await setRateLimit("U_a", 5000, "-4 minutes");
      expect(await claim("sync")).not.toBeNull();
    });

    it("waits out CLOCK_MARGIN after reset_at", async () => {
      await setRateLimit("U_a", 5000, "-2 minutes");
      expect(await claim("sync")).toBeNull();
    });
  });
});

describe("leases", () => {
  beforeEach(async () => {
    await insertUser("U_a");
  });

  it("renews the lease at the start of each transaction", async () => {
    const id = await insertJob("sync", "U_a");
    const lease = await mustClaim("sync");
    await db.query(
      "UPDATE jobs SET locked_at = now() - interval '10 minutes' WHERE id = $1",
      [id],
    );

    await withLease(db, lease, () => Promise.resolve());

    expect(
      await reapExpiredLeases(db, {
        ...defaultConfig,
        leaseReapAgeSeconds: 60,
      }),
    ).toStrictEqual([]);
  });

  it("is lost once reaped and re-claimed: the old holder can't commit", async () => {
    const id = await insertJob("sync", "U_a");
    const stale = await mustClaim("sync");
    await db.query(
      "UPDATE jobs SET locked_at = now() - interval '16 minutes' WHERE id = $1",
      [id],
    );
    await reapExpiredLeases(db);
    await db.query("UPDATE jobs SET run_at = now() - interval '1 second'");
    const fresh = await mustClaim("sync");

    const work = vi.fn(() => Promise.resolve());
    await expect(withLease(db, stale, work)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    expect(work).not.toHaveBeenCalled();
    await expect(
      withLease(db, stale, (client) => releaseSync(client, stale)),
    ).rejects.toBeInstanceOf(LeaseLostError);

    await withLease(db, fresh, (client) => releaseSync(client, fresh));
    expect((await jobRow(id))?.locked_by).toBeNull();
  });

  it("is lost when the user's jobs are deleted", async () => {
    await insertJob("sync", "U_a");
    const lease = await mustClaim("sync");

    await db.query("DELETE FROM jobs WHERE user_id = 'U_a'");

    await expect(
      withLease(db, lease, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("rolls back the transaction's writes if a finishing write is fenced off", async () => {
    await insertJob("sync", "U_a");
    const lease = await mustClaim("sync");

    await expect(
      withLease(db, lease, async (client) => {
        await client.query(
          `INSERT INTO rate_limit_state (user_id, limit_, used, reset_at)
           VALUES ('U_a', 5000, 1, now())`,
        );
        await releaseSync(client, { ...lease, lockedBy: crypto.randomUUID() });
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    const { rows } = await db.query("SELECT * FROM rate_limit_state");
    expect(rows).toHaveLength(0);
    expect(await renewLease(db, lease)).toBe(true);
  });
});

describe("reaper", () => {
  beforeEach(async () => {
    await insertUser("U_a");
    await insertUser("U_b");
  });

  it("frees only leases not renewed for 15 minutes, behind a backoff", async () => {
    const expired = await insertJob("sync", "U_a");
    const fresh = await insertJob("sync", "U_b");
    const idle = await insertJob("deliver", "U_b", "-1 minute", { body: "x" });
    await db.query(
      `UPDATE jobs SET locked_by = gen_random_uuid(), attempts = 1,
         locked_at = now() - CASE WHEN id = $1 THEN interval '16 minutes' ELSE interval '14 minutes' END
       WHERE kind = 'sync'`,
      [expired],
    );
    const log = vi.spyOn(logger, "log").mockImplementation(() => undefined);

    const rescued = await reapExpiredLeases(db);

    expect(rescued).toStrictEqual([
      { id: expired, kind: "sync", userId: "U_a", attempts: 1 },
    ]);
    expect(log).toHaveBeenCalledWith("lease rescued", rescued[0]);
    const row = await jobRow(expired);
    expect(row?.locked_by).toBeNull();
    // 1 minute × 2^1
    expect(row?.run_in).toBeCloseTo(120, 0);
    expect((await jobRow(fresh))?.locked_by).not.toBeNull();
    expect((await jobRow(idle))?.run_in).toBeLessThan(0);
  });

  it("caps the backoff at 2^8 minutes and alerts after a few attempts", async () => {
    const id = await insertJob("deliver", "U_a", "-1 minute", { body: "x" });
    await db.query(
      `UPDATE jobs SET locked_by = gen_random_uuid(), attempts = 12,
         locked_at = now() - interval '1 hour'`,
    );
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);

    const rescued = await reapExpiredLeases(db);

    expect(error).toHaveBeenCalledWith(
      "ALERT: lease rescued repeatedly",
      rescued[0],
    );
    const row = await jobRow(id);
    expect(row?.run_in).toBeCloseTo(256 * 60, 0);
    // A rescued deliver job keeps its attempts, so its next attempt is ambiguous.
    expect(row?.attempts).toBe(12);
  });
});

describe("claiming deliver jobs", () => {
  beforeEach(async () => {
    await insertUser("U_a");
    await insertUser("U_b");
    await insertChannel("U_a", "grn/inbox#1");
    await insertChannel("U_b", "grn/inbox#2");
  });

  it("allows only one leased deliver job: a 23505 means nothing to claim", async () => {
    const first = await insertJob("deliver", "U_a", "-2 minutes", {
      body: "a",
    });
    const second = await insertJob("deliver", "U_b", "-1 minute", {
      body: "b",
    });

    const lease = await mustClaim("deliver");
    expect(lease.id).toBe(first);
    expect(await claim("deliver")).toBeNull();
    expect((await jobRow(second))?.locked_by).toBeNull();

    await withLease(db, lease, (client) => deleteJob(client, lease));
    expect((await mustClaim("deliver")).id).toBe(second);
  });

  it("takes jobs strictly by run_at", async () => {
    const digest = await insertJob("deliver", "U_b", "-3 minutes", {
      digest: true,
      state: "open",
    });
    await insertJob("deliver", "U_a", "-2 minutes", { body: "a" });

    expect((await mustClaim("deliver")).id).toBe(digest);
  });

  it("skips jobs whose run_at is in the future", async () => {
    await insertJob("deliver", "U_a", "3 minutes", {
      digest: true,
      state: "open",
    });

    expect(await claim("deliver")).toBeNull();
  });

  it("only has the opening due while the user's inbox issue doesn't exist", async () => {
    await insertUser("U_new");
    await insertChannel("U_new", null);
    const oneOff = await insertJob("deliver", "U_new", "-10 minutes", {
      body: "notice",
    });
    await insertJob("deliver", "U_new", "-5 minutes", {
      digest: true,
      state: "open",
    });
    const opening = await insertJob("deliver", "U_new", "-1 minute", {
      title: "Reactions inbox",
      body: "@U_new",
    });
    const other = await insertJob("deliver", "U_a", "-2 minutes", {
      body: "a",
    });

    const order: Array<string> = [];
    let lease = await claim("deliver");
    while (lease) {
      order.push(lease.id);
      const current = lease;
      await withLease(db, current, (client) => deleteJob(client, current));
      lease = await claim("deliver");
    }
    expect(order).toStrictEqual([other, opening]);

    await db.query(
      "UPDATE notification_channels SET target = 'grn/inbox#3' WHERE user_id = 'U_new'",
    );
    expect((await mustClaim("deliver")).id).toBe(oneOff);
  });

  it("releases for a retry keeping attempts, and run_at unless a backoff is given", async () => {
    const id = await insertJob("deliver", "U_a", "-1 minute", { body: "a" });

    const first = await mustClaim("deliver");
    await withLease(db, first, (client) => releaseDeliver(client, first));
    expect(await jobRow(id)).toMatchObject({ locked_by: null, attempts: 1 });
    expect((await jobRow(id))?.run_in).toBeLessThan(-50);

    const second = await mustClaim("deliver");
    expect(second.attempts).toBe(2);
    await withLease(db, second, (client) =>
      releaseDeliver(client, second, new Date(Date.now() + 60_000)),
    );
    expect((await jobRow(id))?.run_in).toBeGreaterThan(50);
  });

  describe("dispatch bucket", () => {
    beforeEach(async () => {
      await insertJob("deliver", "U_a", "-1 minute", { body: "a" });
    });

    it("isn't due without a token", async () => {
      // 480/h refills one token every 7.5 s.
      await setBucket(0, "-5 seconds");
      expect(await claim("deliver")).toBeNull();
    });

    it("is due once a token has refilled", async () => {
      await setBucket(0, "-8 seconds");
      expect(await claim("deliver")).not.toBeNull();
    });

    it("keeps at least 1 s between writes", async () => {
      await setBucket(5, "-0.5 seconds");
      expect(await claim("deliver")).toBeNull();
    });

    it("blocks every deliver job during a pause", async () => {
      await insertJob("deliver", "U_b", "-2 minutes", { body: "b" });
      await setBucket(1, "30 seconds");
      expect(await claim("deliver")).toBeNull();
    });
  });
});
