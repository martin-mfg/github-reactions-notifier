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
import { runDeliver } from "../src/inbox/dispatcher.ts";
import {
  LeaseLostError,
  deleteJob,
  releaseSync,
  withLease,
} from "../src/jobs/queue.ts";
import { runSyncTask } from "../src/sync/schedule.ts";
import { signIn } from "../src/users/accounts.ts";
import { runWorker } from "../src/worker/worker.ts";
import type { WorkerDeps } from "../src/worker/worker.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

// the tasks are tested on their own; here only that the loop runs them
vi.mock("../src/sync/schedule.ts", () => ({ runSyncTask: vi.fn() }));
vi.mock("../src/inbox/dispatcher.ts", () => ({ runDeliver: vi.fn() }));

let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = testDb.db;
});

afterAll(async () => {
  await testDb.close();
});

const cipher = new AccessTokenCipher([randomBytes(32)]);
const SITE_URL = "https://grn.example";
const FAR = new Date("2100-01-01T00:00:00Z");

beforeEach(async () => {
  await testDb.reset();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
  // by default, a sync task releases its job until far away, and a delivery finishes its job
  vi.mocked(runSyncTask).mockImplementation(async ({ db, lease }) => {
    await withLease(db, lease, (client) => releaseSync(client, lease, FAR));
    return { kind: "poll", score: 1 };
  });
  vi.mocked(runDeliver).mockImplementation(async ({ db, lease }) => {
    await withLease(db, lease, (client) => deleteJob(client, lease));
    return "posted";
  });
});

/** Signs Alice up: her `sync` job and the job opening her inbox are both due. */
const signUpAlice = () =>
  signIn(
    db,
    { id: "U_alice", login: "alice", createdAt: "2015-01-01T00:00:00Z" },
    "gho_alice",
    { cipher, siteUrl: SITE_URL },
  );

/** A fake local clock: `sleep` advances it instead of waiting. */
const fakeClock = (start = 0) => {
  const clock = {
    t: start,
    now: () => clock.t,
    sleep: vi.fn((ms: number) => {
      clock.t += ms;
      return Promise.resolve();
    }),
  };
  return clock;
};

const deps = (
  clock: ReturnType<typeof fakeClock>,
  overrides: Partial<WorkerDeps> = {},
): WorkerDeps => ({
  db,
  cipher,
  machine: { token: "ghp_machine", inboxRepo: "grn-inbox/inbox" },
  siteUrl: SITE_URL,
  now: clock.now,
  sleep: clock.sleep,
  ...overrides,
});

const syncJob = async () => {
  const { rows } = await db.query<{ locked_by: string | null }>(
    "SELECT locked_by FROM jobs WHERE kind = 'sync'",
  );
  return rows[0];
};

// maxDuration − 2 × the request timeout
const STOP_CLAIMING_MS =
  (defaultConfig.maxDurationSeconds - 2 * defaultConfig.requestTimeoutSeconds) *
  1000;

describe("runWorker", () => {
  it("runs both kinds, then waits IDLE_WAIT between claims and exits before maxDuration", async () => {
    await signUpAlice();
    const clock = fakeClock();

    const stats = await runWorker(deps(clock));

    expect(runDeliver).toHaveBeenCalledOnce();
    expect(runSyncTask).toHaveBeenCalledOnce();
    expect(vi.mocked(runSyncTask).mock.calls[0]?.[0]).toMatchObject({
      token: "gho_alice",
      siteUrl: SITE_URL,
      lease: { kind: "sync", userId: "U_alice" },
    });
    // idle from 0 s: waits of 60 s while one more ends before STOP_CLAIMING_MS
    expect(clock.sleep).toHaveBeenCalledTimes(9);
    expect(clock.sleep).toHaveBeenCalledWith(
      defaultConfig.idleWaitSeconds * 1000,
    );
    expect(clock.t + defaultConfig.idleWaitSeconds * 1000).toBeGreaterThan(
      STOP_CLAIMING_MS,
    );
    expect(stats).toEqual({
      claims: { sync: 1, deliver: 1 },
      syncTasks: { poll: 1 },
      deliveries: { posted: 1 },
      leasesLost: 0,
      errors: 0,
      idleWaits: 9,
      exit: "deadline",
      durationSeconds: 540,
    });
    expect(logger.log).toHaveBeenCalledWith("worker finished", stats);
  });

  it("logs each job's result and duration", async () => {
    await signUpAlice();
    const clock = fakeClock();
    vi.mocked(runSyncTask).mockImplementationOnce(async ({ db, lease }) => {
      clock.t += 1500;
      await withLease(db, lease, (client) => releaseSync(client, lease, FAR));
      return { kind: "backfill", categoryId: "1", score: 1 };
    });

    await runWorker(deps(clock));

    expect(logger.log).toHaveBeenCalledWith("job finished", {
      job: expect.any(String) as string,
      user: "U_alice",
      kind: "deliver",
      result: "posted",
      durationMs: 0,
    });
    expect(logger.log).toHaveBeenCalledWith("job finished", {
      job: expect.any(String) as string,
      user: "U_alice",
      kind: "sync",
      result: "backfill",
      durationMs: 1500,
    });
  });

  it("claims a job that became due while it waited", async () => {
    await signUpAlice();
    const clock = fakeClock();
    clock.sleep.mockImplementationOnce(async (ms: number) => {
      clock.t += ms;
      await db.query("UPDATE jobs SET run_at = now() WHERE kind = 'sync'");
    });

    const stats = await runWorker(deps(clock));

    expect(stats.claims).toEqual({ sync: 2, deliver: 1 });
    expect(runSyncTask).toHaveBeenCalledTimes(2);
  });

  it("alternates which kind it claims first", async () => {
    await signUpAlice();
    await db.query(
      `INSERT INTO jobs (kind, user_id, payload) VALUES
         ('deliver', 'U_alice', '{"title": "x", "body": "x"}')`,
    );
    const order: Array<string> = [];
    vi.mocked(runDeliver).mockImplementation(async ({ db, lease }) => {
      order.push("deliver");
      await withLease(db, lease, (client) => deleteJob(client, lease));
      return "posted";
    });
    // due again at once, until the second run
    vi.mocked(runSyncTask).mockImplementation(async ({ db, lease }) => {
      order.push("sync");
      await withLease(db, lease, (client) =>
        releaseSync(client, lease, order.length >= 4 ? FAR : undefined),
      );
      return { kind: "poll", score: 1 };
    });

    await runWorker(deps(fakeClock()));

    expect(order).toEqual(["deliver", "sync", "deliver", "sync"]);
  });

  it("claims nothing within two request timeouts of maxDuration", async () => {
    await signUpAlice();
    const clock = fakeClock(STOP_CLAIMING_MS);

    const stats = await runWorker(deps(clock, { startedAt: 0 }));

    expect(stats.claims).toEqual({ sync: 0, deliver: 0 });
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(runSyncTask).not.toHaveBeenCalled();
    expect(runDeliver).not.toHaveBeenCalled();
  });

  it("claims no further job once a long one ran past the point", async () => {
    await signUpAlice();
    const clock = fakeClock();
    vi.mocked(runDeliver).mockImplementation(async ({ db, lease }) => {
      clock.t = STOP_CLAIMING_MS;
      await withLease(db, lease, (client) => deleteJob(client, lease));
      return "posted";
    });

    const stats = await runWorker(deps(clock));

    expect(stats.claims).toEqual({ sync: 0, deliver: 1 });
    expect(runSyncTask).not.toHaveBeenCalled();
  });

  it("goes on after a lost lease or a failed job, leaving its lease to the reaper", async () => {
    await signUpAlice();
    vi.mocked(runDeliver).mockImplementation(({ lease }) =>
      Promise.reject(new LeaseLostError(lease)),
    );
    vi.mocked(runSyncTask).mockRejectedValue(new Error("boom"));
    const clock = fakeClock();

    const stats = await runWorker(deps(clock));

    expect(stats).toMatchObject({
      claims: { sync: 1, deliver: 1 },
      leasesLost: 1,
      errors: 1,
      exit: "deadline",
    });
    expect((await syncJob())?.locked_by).not.toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      "worker: job failed, left for the reaper",
      expect.objectContaining({ kind: "sync", user: "U_alice" }),
    );
  });

  it("releases a sync job whose token is unreadable, which is then no longer due", async () => {
    await signUpAlice();
    const clock = fakeClock();

    const stats = await runWorker(
      deps(clock, { cipher: new AccessTokenCipher([randomBytes(32)]) }),
    );

    expect(runSyncTask).not.toHaveBeenCalled();
    expect(stats.syncTasks).toEqual({ noToken: 1 });
    expect(stats.claims.sync).toBe(1);
    expect((await syncJob())?.locked_by).toBeNull();
    const { rows } = await db.query<{ token_status: string }>(
      "SELECT token_status FROM users",
    );
    expect(rows[0]?.token_status).toBe("invalid");
  });

  it("ends the invocation when a claim fails, without throwing", async () => {
    const broken: Database = {
      query: () => Promise.reject(new Error("connection refused")),
      connect: () => Promise.reject(new Error("connection refused")),
    };
    const clock = fakeClock();

    const stats = await runWorker(deps(clock, { db: broken }));

    expect(stats.exit).toBe("claim-failed");
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "worker: claim failed",
      expect.anything(),
    );
  });
});
