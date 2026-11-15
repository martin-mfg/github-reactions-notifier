import { randomUUID } from "node:crypto";

import { logger, userTokenRetryer } from "@grn/core";
import type {
  GraphQLError,
  GraphQLFetcherFunction,
  ResponseDetails,
} from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import type { Database } from "../db.ts";
import { renderRevokedNotice } from "../inbox/notices.ts";
import { releaseSync, withLease } from "../jobs/queue.ts";
import type { Lease } from "../jobs/queue.ts";
import type { UserMode } from "../users/mode.ts";

import { evaluateBudget, readBudget, storeRateLimit } from "./budget.ts";
import { checkClockOffset } from "./clock.ts";

/** A leased `sync` job and the token it reads with. */
export interface SyncSession {
  db: Database;
  lease: Pick<Lease, "id" | "kind" | "userId" | "lockedBy">;
  /** The user's decrypted token. */
  token: string;
  /** The ciphertext `token` was read from; a `401` revokes only this token. */
  tokenEnc: string;
  /** GRN's site, linked from FR-17's notice. */
  siteUrl: string;
  config?: Config;
  /** Collects the task's one log line; without it, each query logs its own `query cost`. */
  taskLog?: TaskLog;
}

/** One request a task sent, as its log line reports it. */
interface RequestLog {
  query?: string;
  durationMs: number;
  /** `rateLimit.cost`, if the response carried it. */
  cost?: number;
}

/**
 * Collects a sync job's one log line (NFR-7): the task's summary, its score and its requests,
 * written by {@link writeTaskLog} once the job ends. `[WHY]` Vercel caps the log lines of a
 * request (256), and a cron run works many jobs, so each logs one line instead of one per
 * step. Problems are still logged on their own.
 */
export interface TaskLog {
  /** The line's message: the task's name once it logged its summary, else `sync task`. */
  message: string;
  /** The task's context and result, or until it logged them, the `sync task` details. */
  summary: Record<string, unknown>;
  /** Fields for the line whatever the task logs, such as its score. */
  fields: Record<string, unknown>;
  requests: Array<RequestLog>;
  /** `debug` for a task that found nothing, so its line isn't written. */
  level: "log" | "debug";
}

/** @returns An empty {@link TaskLog}, written as `sync task` unless the task logs its summary. */
export const createTaskLog = (): TaskLog => ({
  message: "sync task",
  summary: {},
  fields: {},
  requests: [],
  level: "log",
});

/**
 * Records a task's summary for the session's {@link TaskLog}, or without one logs it at once.
 *
 * @param session The leased `sync` job.
 * @param message The task's name, such as `poll`.
 * @param fields The task's context and result.
 * @param level `debug` if the task found nothing.
 */
export const logTask = (
  session: SyncSession,
  message: string,
  fields: Record<string, unknown>,
  level: TaskLog["level"] = "log",
): void => {
  const { taskLog } = session;
  if (!taskLog) {
    logger[level](message, fields);
    return;
  }
  taskLog.message = message;
  taskLog.summary = fields;
  taskLog.level = level;
};

/**
 * Writes a {@link TaskLog}'s line: its summary, its fields, its requests, then `job`.
 *
 * @param taskLog The collected line.
 * @param job The job's own fields, such as its `result` and `durationMs`.
 */
export const writeTaskLog = (
  taskLog: TaskLog,
  job: Record<string, unknown> = {},
): void => {
  logger[taskLog.level](taskLog.message, {
    ...taskLog.summary,
    ...taskLog.fields,
    ...(taskLog.requests.length > 0 && { requests: taskLog.requests }),
    ...job,
  });
};

/** Why a query brought no usable data. {@link settleSyncFailure} decides what comes next. */
export type SyncFailure =
  /** The guard (§8) left no room, so nothing was sent. */
  | { kind: "budget" }
  /** A primary or secondary limit, with GitHub's wait if it named one. */
  | {
      kind: "rate-limited";
      retryAfterSeconds: number | null;
      resetAt: Date | null;
    }
  /** The token is revoked or expired (FR-17). */
  | { kind: "unauthorized" }
  /** Anything else: `5xx`, a network error, a timeout, or an unexpected response (§12). */
  | { kind: "transient" };

export type QueryResult<T> =
  | { ok: true; data: T; errors: Array<GraphQLError> }
  | { ok: false; failure: SyncFailure };

interface QueryOptions {
  /** Which query this is, such as `probe` or `backfill`, for logs. */
  query?: string;
  /**
   * Checks the query-specific fields before callers may commit progress. It gets the
   * response's GraphQL errors too, so fields a handled error explains can be excused.
   */
  validate?: (data: unknown, errors: Array<GraphQLError>) => boolean;
  /**
   * Accepts GraphQL errors that a rule of §9 covers, such as a missing item's `NOT_FOUND`.
   * Any other error makes the response unexpected (§12).
   */
  isExpectedError?: (error: GraphQLError) => boolean;
}

/** A query's result must select `rateLimit { cost … }` (§8). */
interface MeasuredResult {
  rateLimit: { cost: number } | null;
}

const describe = (
  session: SyncSession,
  details?: ResponseDetails,
  request?: { query?: string | undefined; durationMs?: number | undefined },
) => ({
  user: session.lease.userId,
  kind: session.lease.kind,
  ...(request?.query !== undefined && { query: request.query }),
  ...(request?.durationMs !== undefined && {
    durationMs: request.durationMs,
  }),
  ...(details && {
    status: details.status,
    errorTypes: details.errorTypes,
    message: details.message,
  }),
});

/**
 * Sends one query with the user's own token (§8, §9, §12):
 * 1. Evaluates the budget guard. Without room, nothing is sent.
 * 2. Sends the query exactly once, aborted after the request timeout.
 * 3. Stores the response's `graphql` rate-limit headers, fenced by the job's lease.
 * 4. Records the query's duration and `rateLimit.cost` in the session's {@link TaskLog}, or
 *    without one logs them, and alarms above `COST_ALARM`. Logs the offset of the response's
 *    `Date` header (NFR-7).
 *
 * Every response no rule covers is logged as a warning and becomes a transient failure. Every
 * line about a response carries the query's name and the request's `durationMs`. A guard
 * refusal is logged with the stored bucket.
 *
 * @template TResult The query's result.
 * @template TVariables The query's variables.
 * @param session The leased `sync` job.
 * @param fetcher Fetcher created by `createGraphQLFetcher`.
 * @param variables The query's variables.
 * @param options Which GraphQL errors the caller handles.
 * @returns The data, or why there is none.
 * @throws {LeaseLostError} If the lease was lost before the headers were stored.
 */
export const runQuery = async <TResult extends MeasuredResult, TVariables>(
  session: SyncSession,
  fetcher: GraphQLFetcherFunction<TResult, TVariables>,
  variables: TVariables,
  options: QueryOptions = {},
): Promise<QueryResult<TResult>> => {
  const config = session.config ?? defaultConfig;
  const { db, lease } = session;
  const budget = await readBudget(db, lease.userId);
  const verdict = evaluateBudget(budget.state, budget.now, config);
  if (!verdict.hasRoom) {
    logger.log("budget guard: request refused", {
      ...describe(session, undefined, { query: options.query }),
      limit: budget.state?.limit,
      used: budget.state?.used,
      resetAt: budget.state?.resetAt,
      allowance: verdict.allowance,
      remaining: verdict.remaining,
    });
    return { ok: false, failure: { kind: "budget" } };
  }

  const startedAt = performance.now();
  const outcome = await userTokenRetryer(fetcher, variables, session.token, {
    timeoutMs: config.requestTimeoutSeconds * 1000,
  });
  const request = {
    query: options.query,
    durationMs: Math.round(performance.now() - startedAt),
  };
  const logged: RequestLog = {
    ...(options.query !== undefined && { query: options.query }),
    durationMs: request.durationMs,
  };
  session.taskLog?.requests.push(logged);
  await checkClockOffset(db, outcome.details.date, describe(session), config);
  const headers = outcome.details.rateLimit;
  if (headers) {
    await withLease(db, lease, (client) =>
      storeRateLimit(client, lease.userId, headers),
    );
  }

  switch (outcome.kind) {
    case "ok": {
      if (options.validate && !options.validate(outcome.data, outcome.errors)) {
        logger.warn(
          "unexpected GraphQL response shape",
          describe(session, outcome.details, request),
        );
        return { ok: false, failure: { kind: "transient" } };
      }
      const cost = outcome.data.rateLimit?.cost;
      if (cost !== undefined) {
        logged.cost = cost;
      }
      if (cost === undefined) {
        logger.warn(
          "query returned no rateLimit",
          describe(session, undefined, request),
        );
      } else if (cost > config.costAlarm) {
        logger.error("ALERT: query cost above the alarm", {
          ...describe(session, undefined, request),
          cost,
        });
      } else if (!session.taskLog) {
        logger.log("query cost", {
          ...describe(session, undefined, request),
          cost,
        });
      }
      const isExpected = options.isExpectedError ?? (() => false);
      if (!outcome.errors.every(isExpected)) {
        logger.warn(
          "unexpected GraphQL errors",
          describe(session, outcome.details, request),
        );
        return { ok: false, failure: { kind: "transient" } };
      }
      return { ok: true, data: outcome.data, errors: outcome.errors };
    }
    case "rate-limited":
      logger.warn("rate-limited", {
        ...describe(session, outcome.details, request),
        retryAfterSeconds: outcome.retryAfterSeconds,
        resetAt: outcome.resetAt,
      });
      return {
        ok: false,
        failure: {
          kind: "rate-limited",
          retryAfterSeconds: outcome.retryAfterSeconds,
          resetAt: outcome.resetAt,
        },
      };
    case "unauthorized":
      logger.log(
        "token revoked or expired",
        describe(session, undefined, request),
      );
      return { ok: false, failure: { kind: "unauthorized" } };
  }
  logger.warn(
    outcome.timedOut ? "request timed out" : "unexpected response",
    describe(session, outcome.details, request),
  );
  return { ok: false, failure: { kind: "transient" } };
};

/**
 * Releases the `sync` job after a failure, in one fenced transaction (§7.3, §8, §9.3, §12).
 * All times come from Postgres' clock (§7.4):
 * - `budget`: due now; the claim's guard holds it back until the budget has room.
 * - `rate-limited`: due after `retry-after`, or at `x-ratelimit-reset + CLOCK_MARGIN`. A
 *   secondary limit that names no wait waits `max(60 s, syncRetrySeconds)`.
 * - `transient`: due after `syncRetrySeconds`.
 * - `unauthorized` (FR-17): sets `token_status = 'revoked'` and queues the notice, worded for
 *   the user's mode (M1.2 §4.3). The job is then no longer due. If the user signed in again
 *   meanwhile, their new token is left alone.
 *
 * @param session The leased `sync` job.
 * @param failure The failure to settle.
 * @throws {LeaseLostError} If the lease was lost.
 */
export const settleSyncFailure = async (
  session: SyncSession,
  failure: SyncFailure,
): Promise<void> => {
  const config = session.config ?? defaultConfig;
  const { lease } = session;
  await withLease(session.db, lease, async (client) => {
    if (failure.kind === "unauthorized") {
      const { rows: revoked } = await client.query<{ mode: UserMode }>(
        `UPDATE users SET token_status = 'revoked'
         WHERE gh_user_id = $1 AND token_enc = $2 AND token_status = 'active'
         RETURNING mode`,
        [lease.userId, session.tokenEnc],
      );
      const mode = revoked[0]?.mode;
      if (mode !== undefined) {
        const jobId = randomUUID();
        await client.query(
          `INSERT INTO jobs (id, kind, user_id, payload) VALUES ($1, 'deliver', $2, $3)`,
          [
            jobId,
            lease.userId,
            renderRevokedNotice(jobId, session.siteUrl, mode),
          ],
        );
        logger.log("FR-17: token revoked, notice queued", {
          ...describe(session),
          notice: jobId,
        });
      }
      await releaseSync(client, lease);
      return;
    }

    const waitSeconds =
      failure.kind === "budget"
        ? 0
        : failure.kind === "transient"
          ? config.syncRetrySeconds
          : (failure.retryAfterSeconds ??
            (failure.resetAt ? 0 : Math.max(60, config.syncRetrySeconds)));
    const resetAt =
      failure.kind === "rate-limited" && failure.retryAfterSeconds === null
        ? failure.resetAt
        : null;
    const { rows } = await client.query<{ run_at: Date }>(
      `SELECT greatest(
         now() + make_interval(secs => $1::double precision),
         $2::timestamptz + make_interval(secs => $3::double precision)
       ) AS run_at`,
      [waitSeconds, resetAt, config.clockMarginSeconds],
    );
    await releaseSync(client, lease, rows[0]?.run_at);
  });
};
