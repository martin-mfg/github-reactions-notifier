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
import { createCronHandler } from "../src/cron.ts";
import type { CronDeps } from "../src/cron.ts";
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
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

const SECRET = "s3cret";
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
  idleWaits: 0,
  exit: "deadline",
  durationSeconds: 0,
};

const now = () => 1234;

const setUp = (overrides: Partial<CronDeps> = {}) => {
  const runWorker = vi.fn((_deps: WorkerDeps) => Promise.resolve(STATS));
  const handler = createCronHandler({
    db: () => db,
    secret: () => SECRET,
    workerEnv: () => env,
    runWorker,
    now,
    ...overrides,
  });
  return { handler, runWorker };
};

const fakeResponse = () => ({
  statusCode: 200,
  setHeader: vi.fn(),
  send: vi.fn(),
});

const request = (authorization?: string) => ({
  query: {},
  headers: authorization === undefined ? {} : { authorization },
});

describe("/api/cron", () => {
  it("reaps expired leases, then runs the workers and answers once they exit", async () => {
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
    const { handler, runWorker } = setUp();
    const res = fakeResponse();

    await handler(request(`Bearer ${SECRET}`), res);

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
    expect(res.statusCode).toBe(200);
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(res.send).toHaveBeenCalledWith({
      rescued: 1,
      workers: Array.from(
        { length: defaultConfig.workersPerCron },
        () => STATS,
      ),
    });
  });

  it("runs `workersPerCron` workers", async () => {
    const config = { ...defaultConfig, workersPerCron: 3 };
    const { handler, runWorker } = setUp({ config });

    await handler(request(`Bearer ${SECRET}`), fakeResponse());

    expect(runWorker).toHaveBeenCalledTimes(3);
    expect(runWorker.mock.calls[0]?.[0].config).toBe(config);
  });

  it("still runs the workers when reaping fails", async () => {
    const broken = {
      query: () => Promise.reject(new Error("deadlock")),
      connect: vi.fn(),
    } as unknown as Database;
    const { handler, runWorker } = setUp({ db: () => broken });
    const res = fakeResponse();

    await handler(request(`Bearer ${SECRET}`), res);

    expect(logger.error).toHaveBeenCalledWith(
      "cron: reaping failed",
      expect.anything(),
    );
    expect(runWorker).toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(
      expect.objectContaining({ rescued: 0 }),
    );
  });

  it.each([
    ["no", undefined],
    ["a wrong", "Bearer nope"],
    ["a bare", SECRET],
  ])("refuses %s Authorization header", async (_, authorization) => {
    const { handler, runWorker } = setUp();
    const res = fakeResponse();

    await handler(request(authorization), res);

    expect(res.statusCode).toBe(401);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("refuses every call while CRON_SECRET is unset", async () => {
    const { handler, runWorker } = setUp({ secret: () => undefined });
    const res = fakeResponse();

    await handler(request("Bearer undefined"), res);

    expect(res.statusCode).toBe(500);
    expect(runWorker).not.toHaveBeenCalled();
  });

  it.each([
    ["no database", { db: () => null }],
    [
      "a missing worker setting",
      {
        workerEnv: () => {
          throw new Error("GRN_MACHINE_TOKEN is not set");
        },
      },
    ],
  ])("fails with %s", async (_, overrides: Partial<CronDeps>) => {
    const { handler, runWorker } = setUp(overrides);
    const res = fakeResponse();

    await handler(request(`Bearer ${SECRET}`), res);

    expect(res.statusCode).toBe(500);
    expect(runWorker).not.toHaveBeenCalled();
  });
});
