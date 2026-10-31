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
}

export const defaultConfig: Config = {
  clockMarginSeconds: 3 * 60,
  budgetTarget: 0.8,
  budgetReserve: 500,
  dispatchRatePerHour: 480,
  dispatchCapacity: 10,
  leaseReapAgeSeconds: 15 * 60,
  reaperBackoffBaseSeconds: 60,
  reaperMaxExponent: 8,
  reaperAlertAttempts: 3,
  searchOverlapSeconds: 60 * 60,
  requestTimeoutSeconds: 2 * 60,
  costAlarm: 3,
  syncRetrySeconds: 5 * 60,
};
