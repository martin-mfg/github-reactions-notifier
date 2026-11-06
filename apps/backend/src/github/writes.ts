import { logger, mutationRequest } from "@grn/core";
import type { GitHubOutcome, MutationRequest } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";

/** Identifies a write in logs (§12). */
export interface WriteContext {
  job: string;
  user: string;
  kind: string;
  /** The channel's target, such as `owner/repo#number`, once known. */
  target?: string | null;
  /** The dispatch bucket's level right after this write took its token (§12). */
  bucketLevel?: number;
}

/** A request's outcome, as logged: its method and how long it took. */
interface RequestTiming {
  method: string;
  durationMs: number;
}

/** What the dispatcher should do after one write (§12's table). */
export type WriteResult<T> =
  | { kind: "ok"; data: T }
  /** Pause after `retry-after`, until `x-ratelimit-reset + CLOCK_MARGIN`, or by backoff. */
  | {
      kind: "rate-limited";
      retryAfterSeconds: number | null;
      resetAt: Date | null;
    }
  /** Back off and retry: a `5xx`, network error, timeout, or unexpected response. */
  | { kind: "transient" }
  /** No retry: `404`, `410`, or `403` without access. */
  | { kind: "permanent" };

const PERMANENT_STATUSES = new Set([403, 404, 410]);

/**
 * Applies §12's table to one write's outcome. A `403` reaches the permanent row only after
 * the rate-limit rows ruled it out. Every limit hit raises an alert, because the token bucket
 * should have stopped short of it. Anything the table doesn't cover, a `401` or `422`
 * included, is logged as a warning and is transient.
 *
 * @template T Shape of the response body.
 * @param outcome The write's outcome.
 * @param context The write, for logs.
 * @param timing The request's method and duration, for logs.
 * @returns What to do next.
 */
export const classifyWrite = <T>(
  outcome: GitHubOutcome<T>,
  context: WriteContext,
  timing?: RequestTiming,
): WriteResult<T> => {
  if (outcome.kind === "ok") {
    return { kind: "ok", data: outcome.data };
  }
  const { status, errorTypes, message } = outcome.details;
  const logged = { ...context, ...timing, status, errorTypes, message };
  if (outcome.kind === "rate-limited") {
    logger.error("ALERT: machine account hit a rate limit", {
      ...logged,
      retryAfterSeconds: outcome.retryAfterSeconds,
      resetAt: outcome.resetAt,
    });
    return {
      kind: "rate-limited",
      retryAfterSeconds: outcome.retryAfterSeconds,
      resetAt: outcome.resetAt,
    };
  }
  if (outcome.kind === "failed") {
    if (status === null || status >= 500) {
      logger.warn(
        outcome.timedOut ? "write timed out" : "write failed",
        logged,
      );
      return { kind: "transient" };
    }
    if (PERMANENT_STATUSES.has(status)) {
      logger.error("write failed permanently", logged);
      return { kind: "permanent" };
    }
  }
  logger.warn("unexpected response to a write", logged);
  return { kind: "transient" };
};

/**
 * Sends one write on the mutation-safe path, aborted after the request timeout, and
 * classifies it. It never retries: an ambiguous write is the dispatcher's to settle (§12).
 * Every request's method and duration are logged, a success's as `machine account request`.
 *
 * @template T Shape of the response body.
 * @param request The write, without its timeout.
 * @param context The write, for logs.
 * @param config Tunables: the request timeout.
 * @param send The request path; replaced in tests.
 * @returns What to do next.
 */
export const sendWrite = async <T>(
  request: Omit<MutationRequest, "timeoutMs">,
  context: WriteContext,
  config: Config = defaultConfig,
  send: (
    request: MutationRequest,
  ) => Promise<GitHubOutcome<T>> = mutationRequest,
): Promise<WriteResult<T>> => {
  const startedAt = performance.now();
  const outcome = await send({
    ...request,
    timeoutMs: config.requestTimeoutSeconds * 1000,
  });
  const timing = {
    method: request.method,
    durationMs: Math.round(performance.now() - startedAt),
  };
  if (outcome.kind === "ok") {
    logger.log("machine account request", {
      ...context,
      ...timing,
      path: request.path,
      status: outcome.details.status,
    });
  }
  return classifyWrite(outcome, context, timing);
};
