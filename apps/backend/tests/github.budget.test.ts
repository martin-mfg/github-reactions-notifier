import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { defaultConfig } from "../src/config.ts";
import type { Database } from "../src/db.ts";
import {
  budgetHasRoom,
  checkBudget,
  storeRateLimit,
} from "../src/github/budget.ts";
import { claimJob } from "../src/jobs/queue.ts";

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
});

const now = new Date("2026-01-01T12:00:00Z");
const at = (secondsFromNow: number) =>
  new Date(now.getTime() + secondsFromNow * 1000);
const state = (used: number, resetInSeconds: number, limit = 5000) => ({
  limit,
  used,
  resetAt: at(resetInSeconds),
});

describe("budgetHasRoom", () => {
  it("has room without a stored state", () => {
    expect(budgetHasRoom(null, now)).toBe(true);
  });

  it("has no room at the very start of a window, even with nothing used", () => {
    expect(budgetHasRoom(state(0, 3600), now)).toBe(false);
  });

  it("ramps the allowance with the window's elapsed share", () => {
    // 1 s in: allowance = 0.8 × 5000 × 1/3600 ≈ 1.1
    expect(budgetHasRoom(state(1, 3599), now)).toBe(true);
    expect(budgetHasRoom(state(2, 3599), now)).toBe(false);
    // halfway: allowance = 2000
    expect(budgetHasRoom(state(1999, 1800), now)).toBe(true);
    expect(budgetHasRoom(state(2000, 1800), now)).toBe(false);
  });

  it("allows TARGET × limit at the window's end", () => {
    expect(budgetHasRoom(state(3999, 0), now)).toBe(true);
    expect(budgetHasRoom(state(4000, 0), now)).toBe(false);
  });

  it("never reaches into the RESERVE", () => {
    const config = { ...defaultConfig, budgetTarget: 1 };
    expect(budgetHasRoom(state(4499, 0), now, config)).toBe(true);
    // remaining = 500 = RESERVE, although the allowance is 500
    expect(budgetHasRoom(state(4500, 0), now, config)).toBe(false);
  });

  it("keeps the spent window until CLOCK_MARGIN after its reset", () => {
    expect(budgetHasRoom(state(5000, -180), now)).toBe(false);
    expect(budgetHasRoom(state(5000, -181), now)).toBe(true);
  });

  it("treats a rolled-over window as unused", () => {
    expect(budgetHasRoom(state(5000, -3600), now)).toBe(true);
  });
});

const insertUser = async (id: string): Promise<void> => {
  await db.query(
    `INSERT INTO users (gh_user_id, login, gh_created_at, token_enc, token_status)
     VALUES ($1, $1, now() - interval '10 years', 'gse.v1.enc', 'active')`,
    [id],
  );
};

const rateLimitRow = async (userId: string) => {
  const { rows } = await db.query<{
    limit_: number;
    used: number;
    reset_at: Date;
  }>("SELECT limit_, used, reset_at FROM rate_limit_state WHERE user_id = $1", [
    userId,
  ]);
  return rows[0];
};

describe("checkBudget", () => {
  it("has room without a stored row", async () => {
    await insertUser("U_alice");
    expect(await checkBudget(db, "U_alice")).toBe(true);
  });

  it.each([
    ["at the window's start", 0, 3600],
    ["early in the window", 10, 3590],
    ["halfway, with room", 1500, 1800],
    ["halfway, spent", 2500, 1800],
    ["at the end, with room", 3900, 5],
    ["at the end, in the reserve", 4600, 5],
    ["within the margin after the reset", 5000, -170],
    ["past the margin after the reset", 5000, -190],
  ])(
    "agrees with the sync claim's due rule %s",
    async (_, used, resetInSeconds) => {
      await insertUser("U_alice");
      await db.query(
        `INSERT INTO rate_limit_state (user_id, limit_, used, reset_at)
         VALUES ('U_alice', 5000, $1, now() + make_interval(secs => $2))`,
        [used, resetInSeconds],
      );
      await db.query(
        "INSERT INTO jobs (kind, user_id, run_at) VALUES ('sync', 'U_alice', now())",
      );
      const hasRoom = await checkBudget(db, "U_alice");
      expect((await claimJob(db, "sync")) !== null).toBe(hasRoom);
    },
  );
});

describe("storeRateLimit", () => {
  it("inserts and then overwrites the user's graphql bucket", async () => {
    await insertUser("U_alice");
    const first = {
      resource: "graphql",
      limit: 5000,
      used: 10,
      remaining: 4990,
      resetAt: new Date("2026-01-01T12:00:00Z"),
    };
    expect(await storeRateLimit(db, "U_alice", first)).toBe(true);
    expect(await rateLimitRow("U_alice")).toEqual({
      limit_: 5000,
      used: 10,
      reset_at: first.resetAt,
    });

    // the headers are authoritative, even when they show less use (a new window)
    const second = {
      ...first,
      used: 1,
      remaining: 4999,
      resetAt: new Date("2026-01-01T13:00:00Z"),
    };
    expect(await storeRateLimit(db, "U_alice", second)).toBe(true);
    expect(await rateLimitRow("U_alice")).toEqual({
      limit_: 5000,
      used: 1,
      reset_at: second.resetAt,
    });
  });

  it("ignores another bucket's headers", async () => {
    await insertUser("U_alice");
    expect(
      await storeRateLimit(db, "U_alice", {
        resource: "core",
        limit: 5000,
        used: 10,
        remaining: 4990,
        resetAt: now,
      }),
    ).toBe(false);
    expect(await rateLimitRow("U_alice")).toBeUndefined();
  });
});
