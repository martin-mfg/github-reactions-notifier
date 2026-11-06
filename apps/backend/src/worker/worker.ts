import { setTimeout as delay } from "node:timers/promises";

import { logger } from "@grn/core";
import type { AccessTokenCipher } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import type { Database } from "../db.ts";
import { runDeliver } from "../inbox/dispatcher.ts";
import type { DeliverResult, MachineAccount } from "../inbox/dispatcher.ts";
import {
  LeaseLostError,
  claimJob,
  releaseSync,
  withLease,
} from "../jobs/queue.ts";
import type { Lease } from "../jobs/queue.ts";
import { runSyncTask } from "../sync/schedule.ts";
import type { SyncTask } from "../sync/schedule.ts";
import { loadToken } from "../users/accounts.ts";

type JobKind = Lease["kind"];

/** Everything a worker needs from outside. */
export interface WorkerDeps {
  db: Database;
  cipher: AccessTokenCipher;
  machine: MachineAccount;
  /** GRN's site, linked from FR-17's notice. */
  siteUrl: string;
  config?: Config;
  /** When the function invocation started (epoch ms); defaults to the worker's start. */
  startedAt?: number;
  /** The local clock (epoch ms), used only for the invocation's deadline; replaced in tests. */
  now?: () => number;
  /** Waits `ms` milliseconds; replaced in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** One worker invocation's per-stage counters (NFR-7). */
export interface WorkerStats {
  claims: Record<JobKind, number>;
  /** The `sync` tasks that ran; `noToken` counts jobs released for an unreadable token. */
  syncTasks: Partial<Record<SyncTask["kind"] | "noToken", number>>;
  deliveries: Partial<Record<DeliverResult, number>>;
  leasesLost: number;
  /** Jobs that threw; their lease is left for the reaper. */
  errors: number;
  idleWaits: number;
  /** Why the loop ended. */
  exit: "deadline" | "claim-failed";
  durationSeconds: number;
}

const increment = <K extends string>(
  counts: Partial<Record<K, number>>,
  key: K,
): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * Runs a leased `sync` job's next task with the user's stored token. An unreadable token was
 * just set `invalid` by {@link loadToken}, so the released job is no longer due.
 *
 * @param deps The worker's dependencies.
 * @param lease The leased job.
 * @param stats The counters to update.
 * @returns The task that ran, or `noToken`.
 * @throws {LeaseLostError} If the lease was lost.
 */
const runSyncJob = async (
  deps: WorkerDeps,
  lease: Lease,
  stats: WorkerStats,
): Promise<SyncTask["kind"] | "noToken"> => {
  const { db, cipher, siteUrl, config } = deps;
  const stored = await loadToken(db, lease.userId, cipher);
  if (!stored) {
    await withLease(db, lease, (client) => releaseSync(client, lease));
    increment(stats.syncTasks, "noToken");
    return "noToken";
  }
  const task = await runSyncTask({
    db,
    lease,
    token: stored.token,
    tokenEnc: stored.tokenEnc,
    siteUrl,
    ...(config && { config }),
  });
  increment(stats.syncTasks, task.kind);
  return task.kind;
};

/**
 * One worker invocation (§7.1): claims a job, runs one task or one `deliver` job, releases
 * it, and repeats. The two kinds take turns being claimed first. When nothing is due, it
 * waits `IDLE_WAIT` without holding a lease, then claims again. It claims no job within two
 * request timeouts of `maxDuration`, and exits instead of waiting past that point.
 *
 * A job that throws keeps its lease, so the reaper retries it and alerts on repeats (§7.3);
 * the worker goes on with the next one. A failed claim ends the invocation. It never throws.
 * Each job's result and duration are logged as `job finished` (NFR-7).
 *
 * @param deps The worker's dependencies.
 * @returns The invocation's counters, also logged.
 */
export const runWorker = async (deps: WorkerDeps): Promise<WorkerStats> => {
  const config = deps.config ?? defaultConfig;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const startedAt = deps.startedAt ?? now();
  const stopClaimingAt =
    startedAt +
    (config.maxDurationSeconds - 2 * config.requestTimeoutSeconds) * 1000;
  const idleWaitMs = config.idleWaitSeconds * 1000;
  const stats: WorkerStats = {
    claims: { sync: 0, deliver: 0 },
    syncTasks: {},
    deliveries: {},
    leasesLost: 0,
    errors: 0,
    idleWaits: 0,
    exit: "deadline",
    durationSeconds: 0,
  };

  let order: [JobKind, JobKind] = ["deliver", "sync"];
  while (now() < stopClaimingAt) {
    let lease: Lease | null;
    try {
      lease =
        (await claimJob(deps.db, order[0], config)) ??
        (await claimJob(deps.db, order[1], config));
    } catch (error) {
      logger.error("worker: claim failed", { error });
      stats.exit = "claim-failed";
      break;
    }

    if (!lease) {
      if (now() + idleWaitMs >= stopClaimingAt) {
        break;
      }
      stats.idleWaits += 1;
      await sleep(idleWaitMs);
      continue;
    }

    stats.claims[lease.kind] += 1;
    order = lease.kind === "sync" ? ["deliver", "sync"] : ["sync", "deliver"];
    const context = { job: lease.id, user: lease.userId, kind: lease.kind };
    const jobStartedAt = now();
    let result: string;
    try {
      if (lease.kind === "sync") {
        result = await runSyncJob(deps, lease, stats);
      } else {
        const delivered = await runDeliver({
          db: deps.db,
          lease,
          machine: deps.machine,
          ...(deps.config && { config: deps.config }),
        });
        increment(stats.deliveries, delivered);
        result = delivered;
      }
    } catch (error) {
      if (error instanceof LeaseLostError) {
        stats.leasesLost += 1;
        result = "lease-lost";
        logger.warn("worker: lease lost", context);
      } else {
        stats.errors += 1;
        result = "error";
        logger.error("worker: job failed, left for the reaper", {
          ...context,
          error,
        });
      }
    }
    // the job's wall-clock: one sync task (§15's serial-poll time) or one delivery
    logger.log("job finished", {
      ...context,
      result,
      durationMs: Math.round(now() - jobStartedAt),
    });
  }

  stats.durationSeconds = Math.round((now() - startedAt) / 1000);
  logger.log("worker finished", stats);
  return stats;
};
