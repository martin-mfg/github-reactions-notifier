import type { RateLimitHeaders } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";

/** A user's stored `graphql` bucket (§8). */
export interface BudgetState {
  limit: number;
  used: number;
  /** GitHub's clock. */
  resetAt: Date;
}

/**
 * §8's guard, evaluated before each request. It mirrors the `sync` due rule (§7.2) in
 * `jobs/queue.ts`, which applies it at claim time.
 *
 * - Without a stored state, nothing has been spent yet.
 * - Once `now` is past `reset_at + CLOCK_MARGIN`, the window has rolled over: `used` is 0.
 * - Otherwise spend ramps with the window's elapsed share, up to `TARGET × limit`, and never
 *   reaches into the last `RESERVE` points, which belong to the user's own tools.
 *
 * @param state The stored bucket, or `null`.
 * @param now The current time (Postgres `now()`).
 * @param config Tunables: `TARGET`, `RESERVE` and `CLOCK_MARGIN`.
 * @returns Whether a request may go out.
 */
export const budgetHasRoom = (
  state: BudgetState | null,
  now: Date,
  config: Config = defaultConfig,
): boolean => {
  if (!state) {
    return true;
  }
  const secondsToReset = (state.resetAt.getTime() - now.getTime()) / 1000;
  if (-secondsToReset > config.clockMarginSeconds) {
    return true;
  }
  const elapsed = 1 - secondsToReset / 3600;
  const allowance = config.budgetTarget * state.limit * elapsed - state.used;
  const remaining = state.limit - state.used;
  return allowance > 0 && remaining > config.budgetReserve;
};

/**
 * Evaluates the guard against the user's stored bucket and Postgres' clock (§7.4).
 *
 * @param db Pool or client to read with.
 * @param userId The user whose token is about to be used.
 * @param config Tunables for the guard.
 * @returns Whether a request may go out.
 */
export const checkBudget = async (
  db: Queryable,
  userId: string,
  config: Config = defaultConfig,
): Promise<boolean> => {
  const { rows } = await db.query<{
    now: Date;
    limit_: number | null;
    used: number | null;
    reset_at: Date | null;
  }>(
    `SELECT now() AS now, r.limit_, r.used, r.reset_at
     FROM (SELECT 1) AS one LEFT JOIN rate_limit_state r ON r.user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("checkBudget: no row");
  }
  const state =
    row.limit_ !== null && row.used !== null && row.reset_at !== null
      ? { limit: row.limit_, used: row.used, resetAt: row.reset_at }
      : null;
  return budgetHasRoom(state, row.now, config);
};

/**
 * Stores a response's `graphql` bucket, overwriting the stored row: the headers are
 * authoritative (§8). Headers of another bucket are ignored.
 *
 * @param client Client inside a transaction of the job's lease.
 * @param userId The token's owner.
 * @param headers The response's rate-limit headers.
 * @returns Whether the headers were stored.
 */
export const storeRateLimit = async (
  client: Queryable,
  userId: string,
  headers: RateLimitHeaders,
): Promise<boolean> => {
  if (headers.resource !== null && headers.resource !== "graphql") {
    return false;
  }
  await client.query(
    `INSERT INTO rate_limit_state (user_id, limit_, used, reset_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET limit_ = EXCLUDED.limit_, used = EXCLUDED.used, reset_at = EXCLUDED.reset_at`,
    [userId, headers.limit, headers.used, headers.resetAt],
  );
  return true;
};
