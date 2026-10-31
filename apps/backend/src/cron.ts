/**
 * @file The scheduler (§7.1). Vercel Cron calls `/api/cron` every minute with
 * `Authorization: Bearer $CRON_SECRET`. Each run reaps expired leases, then runs
 * `workersPerCron` worker loops in this invocation and answers once they all exit, shortly
 * before `maxDuration`. Overlapping runs keep about ten workers alive. It makes no GitHub
 * calls itself and enqueues nothing.
 */

import { timingSafeEqual } from "node:crypto";

import { AccessTokenCipher, logger, pool } from "@grn/core";

import type { ApiHandler, ApiRequest } from "../api/_types.ts";

import { defaultConfig } from "./config.ts";
import type { Config } from "./config.ts";
import type { Database } from "./db.ts";
import { machineAccountFromEnv } from "./inbox/dispatcher.ts";
import { reapExpiredLeases } from "./jobs/queue.ts";
import { runWorker } from "./worker/worker.ts";
import type { WorkerDeps, WorkerStats } from "./worker/worker.ts";

/** Everything the scheduler needs from outside. */
export interface CronDeps {
  db: () => Database | null;
  /** `CRON_SECRET`; without it, every call is refused. */
  secret: () => string | undefined;
  /** What the workers need from the environment. */
  workerEnv: () => Pick<WorkerDeps, "cipher" | "machine" | "siteUrl">;
  runWorker?: (deps: WorkerDeps) => Promise<WorkerStats>;
  config?: Config;
  now?: () => number;
}

const isAuthorized = (req: ApiRequest, secret: string): boolean => {
  const header = req.headers?.["authorization"];
  if (typeof header !== "string") {
    return false;
  }
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

/**
 * @param deps The scheduler's dependencies.
 * @returns The `/api/cron` handler.
 */
export const createCronHandler =
  (deps: CronDeps): ApiHandler =>
  async (req, res) => {
    const config = deps.config ?? defaultConfig;
    const startedAt = (deps.now ?? Date.now)();
    res.setHeader("Cache-Control", "no-store");

    const secret = deps.secret();
    if (!secret) {
      logger.error("cron: CRON_SECRET is not set, refusing");
      res.statusCode = 500;
      res.send("Not configured");
      return;
    }
    if (!isAuthorized(req, secret)) {
      res.statusCode = 401;
      res.send("Unauthorized");
      return;
    }

    const db = deps.db();
    let workerEnv: ReturnType<CronDeps["workerEnv"]>;
    try {
      if (!db) {
        throw new Error("POSTGRES_URL is not set");
      }
      workerEnv = deps.workerEnv();
    } catch (error) {
      logger.error("cron: not configured", { error });
      res.statusCode = 500;
      res.send("Not configured");
      return;
    }

    let rescued = 0;
    try {
      rescued = (await reapExpiredLeases(db, config)).length;
    } catch (error) {
      logger.error("cron: reaping failed", { error });
    }

    const run = deps.runWorker ?? runWorker;
    const workers = await Promise.all(
      Array.from({ length: config.workersPerCron }, () =>
        run({
          ...workerEnv,
          db,
          startedAt,
          ...(deps.now && { now: deps.now }),
          ...(deps.config && { config: deps.config }),
        }),
      ),
    );

    res.setHeader("Content-Type", "application/json");
    res.send({ rescued, workers });
  };

let cipher: AccessTokenCipher | undefined;

export const defaultCronHandler = createCronHandler({
  db: () => pool,
  secret: () => process.env["CRON_SECRET"],
  workerEnv: () => {
    const redirectUri = process.env["OAUTH_REDIRECT_URI"];
    if (!redirectUri) {
      throw new Error("OAUTH_REDIRECT_URI is not set");
    }
    return {
      cipher: (cipher ??= AccessTokenCipher.fromEnv()),
      machine: machineAccountFromEnv(),
      siteUrl: new URL(redirectUri).origin,
    };
  },
});
