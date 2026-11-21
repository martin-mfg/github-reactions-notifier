/**
 * @file The scheduler (§7.1). The server process starts a cron run every
 * `cronIntervalSeconds`. Each run reaps expired leases, logs the queue's status, then runs
 * `workersPerCron` worker loops and ends once they all exit: as soon as nothing is due, or
 * shortly before `maxDuration` while work keeps coming. So overlapping runs keep up to about
 * ten workers alive under load, and none while idle. It makes no GitHub calls itself and
 * enqueues nothing.
 */

import { AccessTokenCipher, logger, pool } from "@grn/core";

import { defaultConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db.ts";
import { machineAccountFromEnv } from "./inbox/dispatcher.ts";
import {
  findBudgetHeldJobs,
  readDispatchBucket,
  reapExpiredLeases,
} from "./jobs/queue.ts";
import { runWorker } from "./worker/worker.ts";
import type { WorkerDeps, WorkerStats } from "./worker/worker.ts";

/** What the workers need from the environment. */
export type WorkerEnv = Pick<WorkerDeps, "cipher" | "machine" | "siteUrl">;

/** Everything a cron run needs from outside. */
export interface CronDeps {
  db: Database;
  workerEnv: WorkerEnv;
  runWorker?: (deps: WorkerDeps) => Promise<WorkerStats>;
  config?: Config;
  now?: () => number;
  /** Aborted on shutdown: the workers claim no more jobs. */
  signal?: AbortSignal;
}

/** What a cron run did. */
export interface CronResult {
  /** Expired leases it released. */
  rescued: number;
  workers: Array<WorkerStats>;
}

/**
 * Logs, once per cron run, what the claims skip silently: the dispatch bucket's level (§12)
 * and the `sync` jobs held back only by their user's budget (§8). A failure is logged and
 * doesn't stop the run.
 *
 * @param db Pool to read with.
 * @param config Tunables for the due rules.
 */
const logQueueStatus = async (db: Database, config: Config): Promise<void> => {
  try {
    logger.log("dispatch bucket", await readDispatchBucket(db, config));
    const held = await findBudgetHeldJobs(db, config);
    if (held.length > 0) {
      logger.log("budget guard: sync jobs held back", { jobs: held });
    }
  } catch (error) {
    logger.error("cron: reading the queue status failed", { error });
  }
};

/**
 * One cron run: reaps expired leases, logs the queue's status, then runs `workersPerCron`
 * worker loops and resolves once they all exit. A failed reap is logged, and the workers
 * still run. It never throws.
 *
 * @param deps The run's dependencies.
 * @returns What the run did.
 */
export const runCron = async (deps: CronDeps): Promise<CronResult> => {
  const config = deps.config ?? defaultConfig;
  const startedAt = (deps.now ?? Date.now)();
  const { db } = deps;

  let rescued = 0;
  try {
    rescued = (await reapExpiredLeases(db, config)).length;
  } catch (error) {
    logger.error("cron: reaping failed", { error });
  }
  await logQueueStatus(db, config);

  const run = deps.runWorker ?? runWorker;
  const workers = await Promise.all(
    Array.from({ length: config.workersPerCron }, () =>
      run({
        ...deps.workerEnv,
        db,
        startedAt,
        ...(deps.now && { now: deps.now }),
        ...(deps.config && { config: deps.config }),
        ...(deps.signal && { signal: deps.signal }),
      }),
    ),
  );
  return { rescued, workers };
};

/** Everything the scheduler needs from outside. */
export interface SchedulerDeps extends Omit<CronDeps, "signal"> {
  /** Runs one cron run; replaced in tests. */
  runCron?: (deps: CronDeps) => Promise<CronResult>;
}

/** A started scheduler. */
export interface Scheduler {
  /**
   * Starts no more cron runs, has the running ones' workers claim no more jobs, and resolves
   * once they all exit.
   */
  stop: () => Promise<void>;
}

/**
 * Starts a cron run now and every `cronIntervalSeconds`. Runs overlap: a new one starts
 * whether or not earlier ones have ended.
 *
 * @param deps The scheduler's dependencies.
 * @returns The scheduler, to stop on shutdown.
 */
export const startScheduler = (deps: SchedulerDeps): Scheduler => {
  const { runCron: run = runCron, ...cronDeps } = deps;
  const config = deps.config ?? defaultConfig;
  const controller = new AbortController();
  const running = new Set<Promise<unknown>>();

  const start = (): void => {
    const promise = run({ ...cronDeps, signal: controller.signal })
      .catch((error: unknown) => {
        logger.error("cron: run failed", { error });
      })
      .finally(() => running.delete(promise));
    running.add(promise);
  };

  start();
  const timer = setInterval(start, config.cronIntervalSeconds * 1000);

  return {
    stop: async () => {
      clearInterval(timer);
      controller.abort();
      await Promise.all(running);
    },
  };
};

/**
 * @param env Environment to read.
 * @returns What the workers need, from `TOKEN_ENCRYPTION_KEY`, `MACHINE_ACCOUNT_TOKEN`,
 *   `INBOX_REPO` and `OAUTH_REDIRECT_URI`.
 * @throws {Error} If a setting is missing or invalid.
 */
export const workerEnvFromEnv = (
  env: Partial<Record<string, string>> = process.env,
): WorkerEnv => {
  const redirectUri = env["OAUTH_REDIRECT_URI"];
  if (!redirectUri) {
    throw new Error("OAUTH_REDIRECT_URI is not set");
  }
  return {
    cipher: AccessTokenCipher.fromEnv(env),
    machine: machineAccountFromEnv(env),
    siteUrl: new URL(redirectUri).origin,
  };
};

/**
 * Starts the scheduler with the shared pool and the process's environment. Without a
 * database or a worker setting, it logs a warning and starts nothing, so the server still
 * serves the site, as in the Docker smoke test.
 *
 * @param db Database; defaults to the shared pool.
 * @param env Environment to read.
 * @param start Starts the scheduler; replaced in tests.
 * @returns The scheduler, or `null` if it wasn't started.
 */
export const startSchedulerFromEnv = (
  db: Database | null = pool,
  env: Partial<Record<string, string>> = process.env,
  start: (deps: SchedulerDeps) => Scheduler = startScheduler,
): Scheduler | null => {
  if (!db) {
    logger.warn("cron: POSTGRES_URL is not set, scheduler not started");
    return null;
  }
  let workerEnv: WorkerEnv;
  try {
    workerEnv = workerEnvFromEnv(env);
  } catch (error) {
    logger.warn("cron: not configured, scheduler not started", { error });
    return null;
  }
  return start({ db, workerEnv });
};
