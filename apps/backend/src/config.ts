/**
 * Tunables from requirements §14. The defaults are pending M0 calibration; watch them in the
 * initial deployment and adjust as needed.
 */
export interface Config {
  /** `CLOCK_MARGIN`: applied wherever GRN's and GitHub's clocks meet (§7.4). */
  clockMarginSeconds: number;
  /** `TARGET`: share of the hourly GraphQL budget GRN may ramp up to (§8). */
  budgetTarget: number;
  /** `RESERVE`: points always left for the user's own tools (§8). */
  budgetReserve: number;
  /** Rate at which the machine account's token bucket refills (§12). */
  dispatchRatePerHour: number;
  /** Most tokens the bucket holds, i.e. the largest burst of writes (§12). */
  dispatchCapacity: number;
  /**
   * After a `5xx`, network error, timeout, or a rate limit that names no wait, a `deliver` job
   * waits `dispatchBackoffBaseSeconds × 2^min(attempts − 1, dispatchMaxExponent)` (§12).
   */
  dispatchBackoffBaseSeconds: number;
  dispatchMaxExponent: number;
  /** A failed write of a `deliver` job with at least this many attempts raises an alert. */
  dispatchAlertAttempts: number;
  /** Leases not renewed for this long are reaped (§7.3). */
  leaseReapAgeSeconds: number;
  /** A reaped job waits `reaperBackoffBaseSeconds × 2^min(attempts, reaperMaxExponent)`. */
  reaperBackoffBaseSeconds: number;
  reaperMaxExponent: number;
  /** A reaped job with at least this many attempts raises an alert. */
  reaperAlertAttempts: number;
  /**
   * Search overlap margin: the pass watermarks start this far before `discovery_started_at`
   * (§9.2). `[TBD]` Sized from the search lag measured in M0; the default is a placeholder.
   */
  searchOverlapSeconds: number;
  /** GRN aborts any GitHub request after this long (§7.3, step 4). */
  requestTimeoutSeconds: number;
  /** A query whose measured `rateLimit.cost` exceeds this raises an alert (§8). */
  costAlarm: number;
  /**
   * A `sync` job that failed transiently, or hit a secondary limit that named no wait, is due
   * again after this long. A secondary limit waits at least 60 s regardless (§12).
   */
  syncRetrySeconds: number;
  /** Most threads one thread-scan task reads, aliased into one query (§9.2). */
  threadScanBatch: number;
  /** `D`: an item is polled at most this often (§9.1). Must exceed `CLOCK_MARGIN` (§9.3). */
  minRecheckSeconds: number;
  /**
   * `D_discovery`: a category's incremental discovery runs at most this often (§9.1).
   * `[TBD]` max(search lag, `D`); the search lag is measured in M0, so the default is `D`.
   */
  discoveryMinRecheckSeconds: number;
  /** `P`: the score's exponent (§9.1). Below 1, so every score grows without bound. */
  scoreExponent: number;
  /** `w`: the weight of discovery, backfill and thread-scan tasks against polls (§9.1). */
  discoveryWeight: number;
  /** Most items one probe reads, aliased into one query (§9.3). At most 100. */
  probeBatch: number;
  /** Most items one snapshot task reads, aliased into one query (M1.1 §4.2). At most 100. */
  snapshotBatch: number;
  /** A snapshot row whose read failed is not picked again for this long (M1.1 §4.2). */
  snapshotRetryDelaySeconds: number;
  /**
   * FR-10's batching window: a digest is due this long after it opens, and its successor this
   * long after its own `run_at` (§10).
   */
  digestWindowSeconds: number;
  /** How many worker loops each cron run starts (§7.1). */
  workersPerCron: number;
  /** `IDLE_WAIT`: an idle worker waits this long, holding no lease, before claiming again. */
  idleWaitSeconds: number;
  /**
   * The function's `maxDuration` (§7.1). Workers claim no job within two request timeouts of
   * it. Must match the deployment's setting.
   */
  maxDurationSeconds: number;
  /** An offset of GitHub's `Date` header from Postgres' clock above this alerts (NFR-7). */
  clockOffsetAlarmSeconds: number;
  /**
   * Each process checks that offset at most once per this long. `[WHY]` It belongs to the two
   * clocks, not to a request, and drifts slowly; each check costs a query and a log line.
   */
  clockCheckIntervalSeconds: number;
}

export const defaultConfig: Config = {
  clockMarginSeconds: 3 * 60,
  budgetTarget: 0.8,
  budgetReserve: 500,
  dispatchRatePerHour: 480,
  dispatchCapacity: 10,
  dispatchBackoffBaseSeconds: 60,
  dispatchMaxExponent: 8,
  dispatchAlertAttempts: 1,
  leaseReapAgeSeconds: 15 * 60,
  reaperBackoffBaseSeconds: 60,
  reaperMaxExponent: 8,
  reaperAlertAttempts: 3,
  searchOverlapSeconds: 60 * 60,
  requestTimeoutSeconds: 2 * 60,
  costAlarm: 3,
  syncRetrySeconds: 5 * 60,
  threadScanBatch: 50,
  minRecheckSeconds: 4 * 60,
  discoveryMinRecheckSeconds: 4 * 60,
  scoreExponent: 0.8,
  discoveryWeight: 2,
  probeBatch: 50,
  snapshotBatch: 50,
  snapshotRetryDelaySeconds: 60 * 60,
  digestWindowSeconds: 3 * 60,
  workersPerCron: 1,
  idleWaitSeconds: 60,
  maxDurationSeconds: 790,
  clockOffsetAlarmSeconds: 2,
  clockCheckIntervalSeconds: 60,
};
