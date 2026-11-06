import { logger } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { withTransaction } from "../db.ts";
import type { Database, Queryable } from "../db.ts";

type JobKind = "sync" | "deliver";

/** A claimed job. `lockedBy` is the lease's fencing token. */
export interface Lease {
  id: string;
  kind: JobKind;
  userId: string;
  payload: unknown;
  runAt: Date;
  lockedBy: string;
  attempts: number;
}

/** A reaped lease, as logged. */
interface RescuedJob {
  id: string;
  kind: JobKind;
  userId: string;
  attempts: number;
}

/** The job's lease was lost: it was reaped and maybe re-claimed, or the job was deleted. */
export class LeaseLostError extends Error {
  constructor(lease: Pick<Lease, "id" | "lockedBy">) {
    super(`Lease ${lease.lockedBy} on job ${lease.id} was lost`);
    this.name = "LeaseLostError";
  }
}

interface JobRow {
  id: string;
  kind: JobKind;
  user_id: string;
  payload: unknown;
  run_at: Date;
  locked_by: string;
  attempts: number;
}

/** A `sync` job that is due except, perhaps, for its user's budget. */
const SYNC_READY = `
  j.kind = 'sync' AND j.locked_by IS NULL AND j.run_at <= now()
  AND u.token_status = 'active'`;

/**
 * The user's GraphQL budget has room (§8). Without a stored `rate_limit_state` row nothing has
 * been spent yet. Parameters: $1 = CLOCK_MARGIN (s), $2 = TARGET, $3 = RESERVE.
 */
const BUDGET_HAS_ROOM = `(
    r.user_id IS NULL
    -- the window has rolled over, so treat used as 0
    OR now() > r.reset_at + make_interval(secs => $1::double precision)
    OR (
      $2::double precision * r.limit_
        * (1 - extract(epoch FROM r.reset_at - now())::double precision / 3600)
        - r.used > 0
      AND r.limit_ - r.used > $3::double precision
    )
  )`;

/**
 * A `sync` job is due when its user's token is active and their GraphQL budget has room
 * (§7.2, §8). Parameters as in {@link BUDGET_HAS_ROOM}.
 */
const SYNC_DUE = `${SYNC_READY} AND ${BUDGET_HAS_ROOM}`;

const SYNC_FROM = `jobs j
    JOIN users u ON u.gh_user_id = j.user_id
    LEFT JOIN rate_limit_state r ON r.user_id = j.user_id`;

/**
 * A `deliver` job is due when the dispatch bucket holds a token and its last write is at
 * least 1 s ago (§7.2, §12). Until a user's inbox issue exists, only the job opening it is
 * due: the opening is the one payload with a `title`.
 * Parameters: $1 = bucket capacity, $2 = refill rate per second.
 */
const DELIVER_DUE = `
  j.kind = 'deliver' AND j.locked_by IS NULL AND j.run_at <= now()
  AND EXISTS (
    SELECT 1 FROM dispatch_bucket b
    WHERE b.level_at <= now() - interval '1 second'
      AND least(
        $1::double precision,
        b.level + $2::double precision
          * extract(epoch FROM now() - b.level_at)::double precision
      ) >= 1
  )
  AND (
    j.payload ? 'title'
    OR EXISTS (
      SELECT 1 FROM notification_channels c
      WHERE c.user_id = j.user_id AND c.kind = 'github_issue'
        AND c.disabled_at IS NULL AND c.target IS NOT NULL
    )
  )`;

const claimSql = (from: string, due: string): string => `
  UPDATE jobs SET locked_by = gen_random_uuid(), locked_at = now(), attempts = attempts + 1
  WHERE id = (
    SELECT j.id FROM ${from}
    WHERE ${due}
    ORDER BY j.run_at, j.id
    LIMIT 1
    FOR UPDATE OF j SKIP LOCKED
  )
  RETURNING id, kind, user_id, payload, run_at, locked_by, attempts`;

const CLAIM_SYNC = claimSql(SYNC_FROM, SYNC_DUE);

const CLAIM_DELIVER = claimSql("jobs j", DELIVER_DUE);

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  error.code === "23505";

/**
 * Claims the due job of `kind` with the oldest `run_at`, in its own short transaction
 * (§7.3, step 1).
 *
 * @param db Pool to run the claim on.
 * @param kind Which kind of job to claim.
 * @param config Tunables for the due rules.
 * @returns The lease, or `null` if nothing is due.
 */
export const claimJob = async (
  db: Queryable,
  kind: JobKind,
  config: Config = defaultConfig,
): Promise<Lease | null> => {
  const [sql, values] =
    kind === "sync"
      ? [
          CLAIM_SYNC,
          [
            config.clockMarginSeconds,
            config.budgetTarget,
            config.budgetReserve,
          ],
        ]
      : [
          CLAIM_DELIVER,
          [config.dispatchCapacity, config.dispatchRatePerHour / 3600],
        ];
  let rows: Array<JobRow>;
  try {
    ({ rows } = await db.query<JobRow>(sql, values));
  } catch (error) {
    // Another worker holds the one deliver lease. SKIP LOCKED skips row locks, but not
    // conflicts on that unique index.
    if (isUniqueViolation(error)) {
      return null;
    }
    throw error;
  }
  const row = rows[0];
  return row
    ? {
        id: row.id,
        kind: row.kind,
        userId: row.user_id,
        payload: row.payload,
        runAt: row.run_at,
        lockedBy: row.locked_by,
        attempts: row.attempts,
      }
    : null;
};

/**
 * Renews the lease and proves it is still held (§7.3, step 2). Must open every transaction
 * the job commits.
 *
 * @param client Client inside the transaction.
 * @param lease The lease to renew.
 * @returns `false` if the lease is lost: roll back and stop working the job.
 */
export const renewLease = async (
  client: Queryable,
  lease: Pick<Lease, "id" | "lockedBy">,
): Promise<boolean> => {
  const { rowCount } = await client.query(
    "UPDATE jobs SET locked_at = now() WHERE id = $1 AND locked_by = $2",
    [lease.id, lease.lockedBy],
  );
  return rowCount === 1;
};

/**
 * Runs `fn` in a transaction that starts by renewing the lease (§7.3, step 2).
 *
 * @param db Pool to take a connection from.
 * @param lease The job's lease.
 * @param fn The job's writes, ending with a finishing write if this is its last transaction.
 * @returns Whatever `fn` returns.
 * @throws {LeaseLostError} If the lease is lost; nothing is committed then.
 */
export const withLease = async <T>(
  db: Database,
  lease: Pick<Lease, "id" | "lockedBy">,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> =>
  withTransaction(db, async (client) => {
    if (!(await renewLease(client, lease))) {
      throw new LeaseLostError(lease);
    }
    return fn(client);
  });

const finish = async (
  client: Queryable,
  lease: Pick<Lease, "id" | "lockedBy">,
  sql: string,
  values: Array<unknown> = [],
): Promise<void> => {
  const { rowCount } = await client.query(sql, [
    lease.id,
    lease.lockedBy,
    ...values,
  ]);
  if (rowCount !== 1) {
    throw new LeaseLostError(lease);
  }
};

/**
 * Releases a `sync` job (§7.3, step 3) and resets its attempts.
 *
 * @param client Client inside the job's last transaction.
 * @param lease The job's lease.
 * @param runAt When the job is due again: a backoff or a rate-limit wait. Defaults to now,
 *   which puts the user behind everyone who has waited longer (round-robin).
 */
export const releaseSync = async (
  client: Queryable,
  lease: Pick<Lease, "id" | "lockedBy">,
  runAt?: Date,
): Promise<void> => {
  await finish(
    client,
    lease,
    `UPDATE jobs SET locked_by = NULL, locked_at = NULL, attempts = 0,
       run_at = coalesce($3::timestamptz, now())
     WHERE id = $1 AND locked_by = $2`,
    [runAt ?? null],
  );
};

/**
 * Releases a `deliver` job for a retry. It keeps its attempts, which drive its backoff
 * (§12).
 *
 * @param client Client inside the job's last transaction.
 * @param lease The job's lease.
 * @param runAt The retry's backoff. If omitted the job keeps its `run_at`, as after a pause.
 */
export const releaseDeliver = async (
  client: Queryable,
  lease: Pick<Lease, "id" | "lockedBy">,
  runAt?: Date,
): Promise<void> => {
  await finish(
    client,
    lease,
    `UPDATE jobs SET locked_by = NULL, locked_at = NULL,
       run_at = coalesce($3::timestamptz, run_at)
     WHERE id = $1 AND locked_by = $2`,
    [runAt ?? null],
  );
};

/**
 * Deletes a finished job, such as a posted `deliver` job (§7.3, step 3).
 *
 * @param client Client inside the job's last transaction.
 * @param lease The job's lease.
 */
export const deleteJob = async (
  client: Queryable,
  lease: Pick<Lease, "id" | "lockedBy">,
): Promise<void> => {
  await finish(
    client,
    lease,
    "DELETE FROM jobs WHERE id = $1 AND locked_by = $2",
  );
};

/**
 * Releases leases not renewed for `leaseReapAgeSeconds`, behind an exponential backoff
 * (§7.3, step 5). Runs on every cron run. A rescued `deliver` job's next attempt counts as
 * ambiguous (§12) if it had attempted a post.
 *
 * @param db Pool to run on.
 * @param config Tunables for the reap age and backoff.
 * @returns The rescued jobs.
 */
export const reapExpiredLeases = async (
  db: Queryable,
  config: Config = defaultConfig,
): Promise<Array<RescuedJob>> => {
  const { rows } = await db.query<{
    id: string;
    kind: JobKind;
    user_id: string;
    attempts: number;
  }>(
    `UPDATE jobs SET locked_by = NULL, locked_at = NULL,
       run_at = now() + make_interval(secs => $2::double precision)
         * power(2, least(attempts, $3::integer))
     WHERE locked_by IS NOT NULL
       AND locked_at < now() - make_interval(secs => $1::double precision)
     RETURNING id, kind, user_id, attempts`,
    [
      config.leaseReapAgeSeconds,
      config.reaperBackoffBaseSeconds,
      config.reaperMaxExponent,
    ],
  );
  const rescued = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    userId: row.user_id,
    attempts: row.attempts,
  }));
  for (const job of rescued) {
    if (job.attempts >= config.reaperAlertAttempts) {
      logger.error("ALERT: lease rescued repeatedly", job);
    } else {
      logger.warn("lease rescued", job);
    }
  }
  return rescued;
};

/** The dispatch bucket (§12), as logged. */
export interface DispatchBucketReading {
  /** Tokens it holds now, refilled; its stored level while paused. */
  bucketLevel: number;
  /** The end of a pause (§12), if one is running. */
  bucketPausedUntil?: Date;
}

/**
 * Reads the dispatch bucket's level as the `deliver` due rule sees it (§7.2, §12).
 *
 * @param db Pool or client to read with.
 * @param config Tunables: the bucket's capacity and refill rate.
 * @returns The bucket's level, and the end of a running pause.
 */
export const readDispatchBucket = async (
  db: Queryable,
  config: Config = defaultConfig,
): Promise<DispatchBucketReading> => {
  const { rows } = await db.query<{
    level: number;
    paused_until: Date | null;
  }>(
    `SELECT CASE WHEN level_at > now() THEN level
                 ELSE least(
                   $1::double precision,
                   level + $2::double precision
                     * extract(epoch FROM now() - level_at)::double precision)
            END AS level,
            CASE WHEN level_at > now() THEN level_at END AS paused_until
     FROM dispatch_bucket`,
    [config.dispatchCapacity, config.dispatchRatePerHour / 3600],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("readDispatchBucket: the dispatch_bucket row is missing");
  }
  return {
    bucketLevel: Math.round(row.level * 100) / 100,
    ...(row.paused_until && { bucketPausedUntil: row.paused_until }),
  };
};

/** A `sync` job held back only by its user's budget (§8), as logged. */
interface BudgetHeldJob {
  user: string;
  limit: number;
  used: number;
  resetAt: Date;
}

/**
 * Finds the `sync` jobs that would be due but for their user's budget (§7.2, §8). The claim
 * skips them silently; this makes the guard's refusals visible.
 *
 * @param db Pool or client to read with.
 * @param config Tunables: `CLOCK_MARGIN`, `TARGET` and `RESERVE`.
 * @returns The held-back jobs' users and their stored buckets.
 */
export const findBudgetHeldJobs = async (
  db: Queryable,
  config: Config = defaultConfig,
): Promise<Array<BudgetHeldJob>> => {
  const { rows } = await db.query<{
    user_id: string;
    limit_: number;
    used: number;
    reset_at: Date;
  }>(
    `SELECT j.user_id, r.limit_, r.used, r.reset_at FROM ${SYNC_FROM}
     WHERE ${SYNC_READY} AND NOT ${BUDGET_HAS_ROOM}
     ORDER BY j.user_id`,
    [config.clockMarginSeconds, config.budgetTarget, config.budgetReserve],
  );
  return rows.map((row) => ({
    user: row.user_id,
    limit: row.limit_,
    used: row.used,
    resetAt: row.reset_at,
  }));
};
