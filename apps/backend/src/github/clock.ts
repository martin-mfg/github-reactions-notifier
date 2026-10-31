import { logger } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";

/**
 * Compares a response's `Date` header with Postgres' clock.
 *
 * @param db Where to read Postgres' clock.
 * @param date The response's `Date` header; nothing is checked without one.
 * @param context What the response was for, for logs.
 * @param config Tunables: the alarm and the check interval.
 * @returns The offset in seconds (GitHub's clock minus Postgres'), or `null` if not checked.
 */
type ClockCheck = (
  db: Queryable,
  date: Date | null,
  context: Record<string, unknown>,
  config?: Config,
) => Promise<number | null>;

/**
 * Creates a check that logs the offset of a response's `Date` header from Postgres' clock,
 * GRN's only clock (§7.4), and alerts above `clockOffsetAlarmSeconds` (NFR-7). It checks at
 * most once per `clockCheckIntervalSeconds`; responses in between are skipped. A failed check
 * is logged as a warning, doesn't count, and doesn't fail the caller.
 *
 * The header has whole seconds, so its second's midpoint is compared: the offset is accurate
 * to ±0.5 s plus the response's latency.
 *
 * @param now The local clock (epoch ms), used only to space the checks; replaced in tests.
 * @returns The check, with its own interval.
 */
export const createClockCheck = (now: () => number = Date.now): ClockCheck => {
  let lastCheckAt: number | null = null;

  return async (db, date, context, config = defaultConfig) => {
    if (!date) {
      return null;
    }
    const previous = lastCheckAt;
    const at = now();
    if (
      previous !== null &&
      at - previous < config.clockCheckIntervalSeconds * 1000
    ) {
      return null;
    }
    // claimed before the query, so concurrent responses don't check too
    lastCheckAt = at;

    let pgNow: number;
    try {
      const { rows } = await db.query<{ now: number }>(
        "SELECT extract(epoch FROM clock_timestamp())::float8 AS now",
      );
      pgNow = Number(rows[0]?.now);
    } catch (error) {
      lastCheckAt = previous;
      logger.warn("clock offset check failed", {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const offsetSeconds = date.getTime() / 1000 + 0.5 - pgNow;
    const logged = {
      ...context,
      offsetSeconds: Math.round(offsetSeconds * 1000) / 1000,
    };
    if (Math.abs(offsetSeconds) > config.clockOffsetAlarmSeconds) {
      logger.error("ALERT: GitHub's clock is offset above the alarm", logged);
    } else {
      logger.log("GitHub clock offset", logged);
    }
    return offsetSeconds;
  };
};

/** The process's clock check, shared by every GitHub request path. */
export const checkClockOffset = createClockCheck();
