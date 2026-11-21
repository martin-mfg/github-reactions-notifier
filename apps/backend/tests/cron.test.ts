import { randomBytes } from "node:crypto";

import { AccessTokenCipher, logger } from "@grn/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { defaultConfig } from "../src/config.ts";
import {
  runCron,
  startScheduler,
  startSchedulerFromEnv,
  workerEnvFromEnv,
} from "../src/cron.ts";
import type { CronDeps, CronResult } from "../src/cron.ts";
import type { Database } from "../src/db.ts";
import { signIn } from "../src/users/accounts.ts";
import type { WorkerDeps, WorkerStats } from "../src/worker/worker.ts";

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
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

const cipher = new AccessTokenCipher([randomBytes(32)]);
const env = {
  cipher,
  machine: { token: "ghp_machine", inboxRepo: "grn-inbox/inbox" },
  siteUrl: "https://grn.example",
};

const STATS: WorkerStats = {
  claims: { sync: 0, deliver: 0 },
  syncTasks: {},
  deliveries: {},
  leasesLost: 0,
  errors: 0,
  deliverWaits: 0,
  exit: "deadline",
  durationSeconds: 0,
};

const now = () => 1234;

const setUp = (overrides: Partial<CronDeps> = {}) => {
  const runWorker = vi.fn((_deps: WorkerDeps) => Promise.resolve(STATS));
  const run = () =>
    runCron({ db, workerEnv: env, runWorker, now, ...overrides });
  return { run, runWorker };
};

describe("runCron", () => {
  it("reaps expired leases, then runs the workers and resolves once they exit", async () => {
    await signIn(
      db,
      { id: "U_alice", login: "alice", createdAt: "2015-01-01T00:00:00Z" },
      "gho_alice",
      { cipher, siteUrl: env.siteUrl },
    );
    await db.query(
      `UPDATE jobs SET locked_by = gen_random_uuid(), locked_at = now() - interval '1 hour'
       WHERE kind = 'sync'`,
    );
    const { run, runWorker } = setUp();

    const result = await run();

    const { rows } = await db.query<{ locked_by: string | null }>(
      "SELECT locked_by FROM jobs WHERE kind = 'sync'",
    );
    expect(rows[0]?.locked_by).toBeNull();
    expect(runWorker).toHaveBeenCalledTimes(defaultConfig.workersPerCron);
    expect(runWorker).toHaveBeenCalledWith({
      ...env,
      db,
      startedAt: 1234,
      now,
    });
    expect(result).toEqual({
      rescued: 1,
      workers: Array.from(
        { length: defaultConfig.workersPerCron },
        () => STATS,
      ),
    });
  });

  it("logs the dispatch bucket and the sync jobs the budget holds back", async () => {
    await signIn(
      db,
      { id: "U_alice", login: "alice", createdAt: "2015-01-01T00:00:00Z" },
      "gho_alice",
      { cipher, siteUrl: env.siteUrl },
    );
    await db.query(
      "UPDATE jobs SET run_at = now() - interval '1 minute' WHERE kind = 'sync'",
    );
    await db.query(
      `INSERT INTO rate_limit_state (user_id, limit_, used, reset_at)
       VALUES ('U_alice', 5000, 4900, now() + interval '30 minutes')`,
    );
    const { run } = setUp();

    await run();

    expect(logger.log).toHaveBeenCalledWith("dispatch bucket", {
      bucketLevel: expect.any(Number) as number,
    });
    expect(logger.log).toHaveBeenCalledWith(
      "budget guard: sync jobs held back",
      {
        jobs: [
          {
            user: "U_alice",
            limit: 5000,
            used: 4900,
            resetAt: expect.any(Date) as Date,
          },
        ],
      },
    );
  });

  it("runs `workersPerCron` workers and passes them the config and signal", async () => {
    const config = { ...defaultConfig, workersPerCron: 3 };
    const { signal } = new AbortController();
    const { run, runWorker } = setUp({ config, signal });

    await run();

    expect(runWorker).toHaveBeenCalledTimes(3);
    expect(runWorker.mock.calls[0]?.[0].config).toBe(config);
    expect(runWorker.mock.calls[0]?.[0].signal).toBe(signal);
  });

  it("still runs the workers when reaping fails", async () => {
    const broken = {
      query: () => Promise.reject(new Error("deadlock")),
      connect: vi.fn(),
    } as unknown as Database;
    const { run, runWorker } = setUp({ db: broken });

    const result = await run();

    expect(logger.error).toHaveBeenCalledWith(
      "cron: reaping failed",
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "cron: reading the queue status failed",
      expect.anything(),
    );
    expect(runWorker).toHaveBeenCalled();
    expect(result.rescued).toBe(0);
  });
});

describe("startScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const RESULT: CronResult = { rescued: 0, workers: [] };
  const interval = defaultConfig.cronIntervalSeconds * 1000;

  it("starts a cron run now and every `cronIntervalSeconds`, overlapping", async () => {
    const runCron = vi.fn(
      (deps: CronDeps) =>
        new Promise<CronResult>((resolve) => {
          deps.signal?.addEventListener("abort", () => {
            resolve(RESULT);
          });
        }),
    );
    const scheduler = startScheduler({ db, workerEnv: env, runCron });

    expect(runCron).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(runCron).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runCron).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(interval);
    expect(runCron).toHaveBeenCalledTimes(3);
    expect(runCron).toHaveBeenCalledWith({
      db,
      workerEnv: env,
      signal: expect.any(AbortSignal) as AbortSignal,
    });

    await scheduler.stop();
  });

  it("logs a failed run and keeps scheduling", async () => {
    const runCron = vi
      .fn<(deps: CronDeps) => Promise<CronResult>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(RESULT);
    const scheduler = startScheduler({ db, workerEnv: env, runCron });

    await vi.advanceTimersByTimeAsync(interval);

    expect(logger.error).toHaveBeenCalledWith("cron: run failed", {
      error: expect.any(Error) as Error,
    });
    expect(runCron).toHaveBeenCalledTimes(2);
    await scheduler.stop();
  });

  it("on stop, starts no more runs, aborts the running ones and waits for them", async () => {
    let finish = (): void => undefined;
    const runCron = vi.fn(
      (deps: CronDeps) =>
        new Promise<CronResult>((resolve) => {
          deps.signal?.addEventListener("abort", () => {
            finish = () => {
              resolve(RESULT);
            };
          });
        }),
    );
    const scheduler = startScheduler({ db, workerEnv: env, runCron });

    let stopped = false;
    void scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    finish();
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(stopped).toBe(true);
    expect(runCron).toHaveBeenCalledTimes(1);
  });
});

describe("startSchedulerFromEnv", () => {
  const ENV = {
    TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    MACHINE_ACCOUNT_TOKEN: "ghp_machine",
    INBOX_REPO: "grn-inbox/inbox",
    OAUTH_REDIRECT_URI: "https://grn.example/api/oauth/callback",
  };
  const SCHEDULER = { stop: () => Promise.resolve() };

  it("starts the scheduler with the settings from the environment", () => {
    const start = vi.fn(() => SCHEDULER);

    expect(startSchedulerFromEnv(db, ENV, start)).toBe(SCHEDULER);
    expect(start).toHaveBeenCalledWith({
      db,
      workerEnv: {
        cipher: expect.any(AccessTokenCipher) as AccessTokenCipher,
        machine: { token: "ghp_machine", inboxRepo: "grn-inbox/inbox" },
        siteUrl: "https://grn.example",
      },
    });
  });

  it.each([
    ["no database", null, ENV],
    ["no OAUTH_REDIRECT_URI", "db", { ...ENV, OAUTH_REDIRECT_URI: "" }],
    ["no MACHINE_ACCOUNT_TOKEN", "db", { ...ENV, MACHINE_ACCOUNT_TOKEN: "" }],
  ] as const)(
    "warns and starts nothing with %s",
    (_, database, environment) => {
      const start = vi.fn(() => SCHEDULER);

      expect(
        startSchedulerFromEnv(database && db, environment, start),
      ).toBeNull();
      expect(start).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    },
  );
});

describe("workerEnvFromEnv", () => {
  it("throws without OAUTH_REDIRECT_URI", () => {
    expect(() => workerEnvFromEnv({})).toThrow("OAUTH_REDIRECT_URI is not set");
  });
});
