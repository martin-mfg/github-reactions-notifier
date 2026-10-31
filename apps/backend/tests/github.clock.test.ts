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
import { createClockCheck } from "../src/github/clock.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

let testDb: TestDatabase;
let db: Database;
let checkClockOffset: ReturnType<typeof createClockCheck>;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = testDb.db;
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(() => {
  checkClockOffset = createClockCheck();
  vi.restoreAllMocks();
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

/** A `Date` header `offsetSeconds` from now: whole seconds, as GitHub sends it. */
const dateHeader = (offsetSeconds: number): Date =>
  new Date(Math.floor(Date.now() / 1000 + offsetSeconds) * 1000);

describe("createClockCheck", () => {
  it("checks nothing without a Date header", async () => {
    const query = vi.spyOn(db, "query");

    expect(await checkClockOffset(db, null, {})).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("logs a small offset against the second's midpoint", async () => {
    const offset = await checkClockOffset(db, dateHeader(0), { user: "U_a" });

    expect(Math.abs(offset ?? Infinity)).toBeLessThanOrEqual(1);
    expect(logger.log).toHaveBeenCalledWith("GitHub clock offset", {
      user: "U_a",
      offsetSeconds: Math.round((offset ?? 0) * 1000) / 1000,
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([10, -10])(
    "alerts on an offset of %i s, above the alarm",
    async (seconds) => {
      const offset = await checkClockOffset(db, dateHeader(seconds), {
        user: "U_a",
      });

      expect(Math.abs((offset ?? Infinity) - seconds)).toBeLessThanOrEqual(1);
      expect(logger.error).toHaveBeenCalledWith(
        "ALERT: GitHub's clock is offset above the alarm",
        { user: "U_a", offsetSeconds: Math.round((offset ?? 0) * 1000) / 1000 },
      );
      expect(logger.log).not.toHaveBeenCalled();
    },
  );

  it("warns instead of failing when the database is unreachable", async () => {
    const broken = {
      query: () => Promise.reject(new Error("connection refused")),
    };

    expect(
      await checkClockOffset(broken, dateHeader(0), { user: "U_a" }),
    ).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith("clock offset check failed", {
      user: "U_a",
      error: "connection refused",
    });
  });

  describe("at most once per clockCheckIntervalSeconds", () => {
    let now: number;
    let check: ReturnType<typeof createClockCheck>;

    beforeEach(() => {
      now = 1_000_000;
      check = createClockCheck(() => now);
    });

    it("skips responses within the interval, without a query", async () => {
      expect(await check(db, dateHeader(0), {})).not.toBeNull();
      const query = vi.spyOn(db, "query");
      now += defaultConfig.clockCheckIntervalSeconds * 1000 - 1;

      expect(await check(db, dateHeader(0), {})).toBeNull();
      expect(query).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledTimes(1);
    });

    it("checks again once the interval has passed", async () => {
      await check(db, dateHeader(0), {});
      now += defaultConfig.clockCheckIntervalSeconds * 1000;

      expect(await check(db, dateHeader(0), {})).not.toBeNull();
      expect(logger.log).toHaveBeenCalledTimes(2);
    });

    it("doesn't count a response without a Date header", async () => {
      await check(db, null, {});

      expect(await check(db, dateHeader(0), {})).not.toBeNull();
    });

    it("doesn't count a failed check", async () => {
      const broken = {
        query: () => Promise.reject(new Error("connection refused")),
      };
      await check(broken, dateHeader(0), {});

      expect(await check(db, dateHeader(0), {})).not.toBeNull();
    });

    it("checks once for concurrent responses", async () => {
      const offsets = await Promise.all([
        check(db, dateHeader(0), {}),
        check(db, dateHeader(0), {}),
      ]);

      expect(offsets.filter((offset) => offset !== null)).toHaveLength(1);
    });

    it("checks every response with an interval of 0", async () => {
      const config = { ...defaultConfig, clockCheckIntervalSeconds: 0 };
      await check(db, dateHeader(0), {}, config);

      expect(await check(db, dateHeader(0), {}, config)).not.toBeNull();
    });
  });
});
