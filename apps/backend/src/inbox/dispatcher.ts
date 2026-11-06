import { logger, mutationRequest } from "@grn/core";
import type { GitHubOutcome, MutationRequest } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import type { Database, Queryable } from "../db.ts";
import { checkClockOffset } from "../github/clock.ts";
import { sendWrite } from "../github/writes.ts";
import type { WriteContext, WriteResult } from "../github/writes.ts";
import {
  deleteJob,
  readDispatchBucket,
  releaseDeliver,
  withLease,
} from "../jobs/queue.ts";
import type { Lease } from "../jobs/queue.ts";
import { finishDigest, renderDigest } from "../pipeline/digest.ts";

import { renderDigestBody } from "./digestBody.ts";

/** The account that makes every write (§11), and the repo holding the inboxes. */
export interface MachineAccount {
  token: string;
  /** `owner/repo`. */
  inboxRepo: string;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const TARGET = /^([\w.-]+\/[\w.-]+)#(\d+)$/;

/**
 * Reads the machine account from `MACHINE_ACCOUNT_TOKEN` and `INBOX_REPO`.
 *
 * @param env The environment.
 * @returns The machine account.
 * @throws {Error} If either is missing or `INBOX_REPO` isn't `owner/repo`.
 */
export const machineAccountFromEnv = (
  env: Partial<Record<string, string>> = process.env,
): MachineAccount => {
  const token = env["MACHINE_ACCOUNT_TOKEN"];
  const inboxRepo = env["INBOX_REPO"];
  if (!token) {
    throw new Error("MACHINE_ACCOUNT_TOKEN is not set");
  }
  if (!inboxRepo || !REPO.test(inboxRepo)) {
    throw new Error("INBOX_REPO must be set to owner/repo");
  }
  return { token, inboxRepo };
};

/** The request path; replaced in tests. */
type Send = <T>(request: MutationRequest) => Promise<GitHubOutcome<T>>;

/**
 * @param session The leased job.
 * @param context The write, for logs.
 * @returns The session's request path, checking GitHub's clock offset on its responses (NFR-7).
 */
const sendWithClockCheck = (
  session: DeliverSession,
  context: WriteContext,
): Send => {
  const send: Send = session.send ?? mutationRequest;
  return async <T>(request: MutationRequest) => {
    const outcome = await send<T>(request);
    await checkClockOffset(
      session.db,
      outcome.details.date,
      { ...context },
      session.config,
    );
    if (
      request.method === "POST" &&
      outcome.kind === "ok" &&
      outcome.details.status !== 201
    ) {
      return {
        kind: "failed",
        timedOut: false,
        details: {
          ...outcome.details,
          message: "expected a 201 creation response",
        },
      };
    }
    return outcome;
  };
};

/** A leased `deliver` job and what it posts with. */
export interface DeliverSession {
  db: Database;
  lease: Pick<Lease, "id" | "userId" | "lockedBy" | "attempts" | "payload">;
  machine: MachineAccount;
  config?: Config;
  send?: Send;
}

/** How a `deliver` job ended. */
export type DeliverResult =
  /** Posted, and finished. */
  | "posted"
  /** An earlier, ambiguous attempt had posted it; finished without posting again. */
  | "found"
  /** Nothing to post: an empty digest, or an opening whose inbox exists. Finished. */
  | "skipped"
  /** The bucket held no token; released unchanged. */
  | "waiting"
  /** Released for a retry, after a backoff or behind a pause. */
  | "retrying"
  /** Failed permanently: all of the user's jobs are deleted. */
  | "failed";

/** A `deliver` job's payload (§13), plus when its first post was attempted. */
interface DeliverPayload {
  digest?: boolean;
  title?: string;
  body?: string;
  /** Postgres' epoch seconds, set right before the first post: later attempts are ambiguous. */
  attempted_at?: number;
}

interface IssueRef {
  repo: string;
  number: number;
}

type Message =
  | { kind: "opening"; title: string; body: string }
  | { kind: "digest" | "one-off"; body: string; target: IssueRef };

/** The fields of a created or listed issue or comment the dispatcher reads. */
interface Listed {
  number?: unknown;
  body?: unknown;
  pull_request?: unknown;
  user?: { id?: unknown } | null;
}

type Failure = Exclude<WriteResult<unknown>, { kind: "ok" }>;

const parseTarget = (target: string | null): IssueRef | null => {
  const match = target === null ? null : TARGET.exec(target);
  return match?.[1] && match[2]
    ? { repo: match[1], number: Number(match[2]) }
    : null;
};

const formatTarget = (ref: IssueRef): string => `${ref.repo}#${ref.number}`;

/**
 * Reads what the job posts, in its own fenced transaction. A digest is rendered here, before
 * its first attempt (§10). Finishes the job if there is nothing to post.
 *
 * @param client Client inside the job's fenced transaction.
 * @param session The leased job.
 * @returns The message, or `null` if the job is finished.
 * @throws {Error} If a comment has no inbox issue to go to, or the payload is malformed.
 */
const prepare = async (
  client: Queryable,
  session: DeliverSession,
): Promise<Message | null> => {
  const { lease } = session;
  const payload = lease.payload as DeliverPayload;
  const { rows } = await client.query<{ target: string | null }>(
    `SELECT target FROM notification_channels
     WHERE user_id = $1 AND kind = 'github_issue' AND disabled_at IS NULL`,
    [lease.userId],
  );
  const channel = rows[0];
  if (!channel) {
    throw new Error(`deliver job ${lease.id}: its user has no inbox channel`);
  }
  if (typeof payload.title === "string" && typeof payload.body === "string") {
    if (channel.target !== null) {
      logger.warn("inbox already open, opening dropped", {
        job: lease.id,
        user: lease.userId,
        target: channel.target,
      });
      await deleteJob(client, lease);
      return null;
    }
    return { kind: "opening", title: payload.title, body: payload.body };
  }

  const target = parseTarget(channel.target);
  if (!target) {
    throw new Error(
      `deliver job ${lease.id}: no inbox issue to post to (target ${String(channel.target)})`,
    );
  }
  if (payload.digest === true) {
    const rendered = await renderDigest(
      client,
      lease,
      renderDigestBody,
      session.config,
    );
    return rendered && { kind: "digest", body: rendered.body, target };
  }
  if (typeof payload.body !== "string") {
    throw new Error(`deliver job ${lease.id}: payload has no body`);
  }
  return { kind: "one-off", body: payload.body, target };
};

/**
 * Looks for the job's `grn:{uuid}` marker, which an earlier, ambiguous attempt may have posted
 * (§12): among the comments on the target issue since that attempt, or among the inbox repo's
 * 100 newest issues. It is a read, so it takes no bucket token.
 *
 * @param session The leased job.
 * @param message What the job posts.
 * @param attemptedAt When the first post was attempted, on Postgres' clock (epoch seconds).
 * @param context The job, for logs.
 * @returns The issue or comment that carries the marker, `null` if there is none, or the
 *   failed check to settle.
 */
const findMarker = async (
  session: DeliverSession,
  message: Message,
  attemptedAt: number,
  context: WriteContext,
): Promise<{ found: Listed | null } | Failure> => {
  const config = session.config ?? defaultConfig;
  const { machine } = session;
  const identity = await sendWrite<unknown>(
    { method: "GET", path: "/user", token: machine.token },
    context,
    config,
    sendWithClockCheck(session, context),
  );
  if (identity.kind !== "ok") {
    return identity;
  }
  const account = identity.data;
  if (
    typeof account !== "object" ||
    account === null ||
    !("id" in account) ||
    typeof account.id !== "number" ||
    !Number.isSafeInteger(account.id) ||
    account.id <= 0
  ) {
    logger.warn(
      "unexpected response to the machine account identity check",
      context,
    );
    return { kind: "transient" };
  }
  const marker = `<!-- grn:${session.lease.id} -->`;
  const path =
    message.kind === "opening"
      ? `/repos/${machine.inboxRepo}/issues?state=all&sort=created&direction=desc&per_page=100`
      : `/repos/${message.target.repo}/issues/${message.target.number}/comments?since=${new Date(
          (attemptedAt - config.clockMarginSeconds) * 1000,
        ).toISOString()}&per_page=100`;
  const result = await sendWrite<unknown>(
    { method: "GET", path, token: machine.token },
    context,
    config,
    sendWithClockCheck(session, context),
  );
  if (result.kind !== "ok") {
    return result;
  }
  if (
    !Array.isArray(result.data) ||
    result.data.some(
      (entry: unknown) =>
        typeof entry !== "object" || entry === null || Array.isArray(entry),
    )
  ) {
    logger.warn("unexpected response to the marker check", context);
    return { kind: "transient" };
  }
  const match = (result.data as Array<Listed>).find(
    (entry) =>
      entry.user?.id === account.id &&
      !(message.kind === "opening" && entry.pull_request) &&
      typeof entry.body === "string" &&
      entry.body.includes(marker),
  );
  return { found: match ?? null };
};

/**
 * Takes a bucket token right before posting, in a fenced transaction that also records the
 * first attempt (§12). Without a token the job is released unchanged, and the bucket's level
 * is logged.
 *
 * @param session The leased job.
 * @param context The job, for logs.
 * @returns The bucket's level after taking the token, or `null` if there was none.
 */
const takeToken = (
  session: DeliverSession,
  context: WriteContext,
): Promise<number | null> => {
  const config = session.config ?? defaultConfig;
  const { lease } = session;
  return withLease(session.db, lease, async (client) => {
    const { rows } = await client.query<{ level: number }>(
      `UPDATE dispatch_bucket
       SET level = least(
             $1::double precision,
             level + $2::double precision
               * extract(epoch FROM now() - level_at)::double precision
           ) - 1,
           level_at = now()
       WHERE level_at <= now() - interval '1 second'
         AND least(
           $1::double precision,
           level + $2::double precision
             * extract(epoch FROM now() - level_at)::double precision
         ) >= 1
       RETURNING level`,
      [config.dispatchCapacity, config.dispatchRatePerHour / 3600],
    );
    const taken = rows[0];
    if (!taken) {
      const bucket = await readDispatchBucket(client, config);
      logger.log("dispatcher: no bucket token, job released", {
        ...context,
        ...bucket,
      });
      await releaseDeliver(client, lease);
      return null;
    }
    await client.query(
      `UPDATE jobs
       SET payload = jsonb_set(payload, '{attempted_at}',
         coalesce(payload->'attempted_at', to_jsonb(extract(epoch FROM now()))))
       WHERE id = $1`,
      [lease.id],
    );
    return Math.round(taken.level * 100) / 100;
  });
};

/**
 * Finishes a delivered job: an opening points the channel at its issue, a digest opens its
 * successor if anything is queued (§10).
 *
 * @param client Client inside the job's last, fenced transaction.
 * @param session The leased job.
 * @param message What was delivered.
 * @param issueNumber The opened issue's number, for an opening.
 */
const finishDelivered = async (
  client: Queryable,
  session: DeliverSession,
  message: Message,
  issueNumber: number | null,
): Promise<void> => {
  const { lease } = session;
  if (message.kind === "opening" && issueNumber !== null) {
    await client.query(
      `UPDATE notification_channels SET target = $2
       WHERE user_id = $1 AND kind = 'github_issue' AND disabled_at IS NULL`,
      [
        lease.userId,
        formatTarget({ repo: session.machine.inboxRepo, number: issueNumber }),
      ],
    );
  }
  if (message.kind === "digest") {
    await finishDigest(client, lease, session.config);
  } else {
    await deleteJob(client, lease);
  }
};

/**
 * Settles a failed write or marker check by §12's table, in the job's last, fenced
 * transaction:
 * - A rate limit pauses the whole dispatcher: the bucket gets `level = 1` and `level_at` =
 *   the pause's end, `retry-after` or `x-ratelimit-reset + CLOCK_MARGIN`; a limit that names
 *   no wait pauses for the backoff. The job keeps its `run_at`.
 * - A transient failure backs the job off, and alerts.
 * - A permanent failure deletes all of the user's jobs, `sync` included.
 *
 * @param session The leased job.
 * @param result The failure.
 * @param context The job, for logs.
 * @returns How the job ended.
 */
const settleFailure = (
  session: DeliverSession,
  result: Failure,
  context: WriteContext,
): Promise<DeliverResult> => {
  const config = session.config ?? defaultConfig;
  const { lease } = session;
  const backoffSeconds =
    config.dispatchBackoffBaseSeconds *
    2 ** Math.min(Math.max(lease.attempts - 1, 0), config.dispatchMaxExponent);
  return withLease(session.db, lease, async (client) => {
    if (result.kind === "permanent") {
      const { rowCount } = await client.query(
        "DELETE FROM jobs WHERE user_id = $1",
        [lease.userId],
      );
      logger.error(
        "delivery failed permanently, all of the user's jobs deleted",
        {
          ...context,
          deletedJobs: rowCount,
        },
      );
      return "failed";
    }
    if (result.kind === "rate-limited") {
      const { rows } = await client.query<{ until: Date }>(
        `UPDATE dispatch_bucket SET level = 1, level_at = greatest(
           now() + make_interval(secs => $1::double precision),
           $2::timestamptz + make_interval(secs => $3::double precision)
         )
         RETURNING level_at AS until`,
        [
          result.retryAfterSeconds ?? (result.resetAt ? 0 : backoffSeconds),
          result.resetAt,
          config.clockMarginSeconds,
        ],
      );
      logger.warn("dispatcher paused", { ...context, until: rows[0]?.until });
      await releaseDeliver(client, lease);
      return "retrying";
    }
    if (lease.attempts >= config.dispatchAlertAttempts) {
      logger.error("ALERT: delivery failed", {
        ...context,
        attempts: lease.attempts,
        backoffSeconds,
      });
    }
    const { rows } = await client.query<{ run_at: Date }>(
      "SELECT now() + make_interval(secs => $1::double precision) AS run_at",
      [backoffSeconds],
    );
    await releaseDeliver(client, lease, rows[0]?.run_at);
    return "retrying";
  });
};

/**
 * Works one leased `deliver` job, the dispatcher's whole turn (§11, §12):
 * 1. Reads what to post, rendering a digest before its first attempt.
 * 2. If a post was attempted before, the attempt is ambiguous: looks for the job's marker and
 *    finishes without posting if it is there.
 * 3. Takes a bucket token, re-checking the lease, and posts as the machine account: an
 *    opening as a new issue in the inbox repo, anything else as a comment on the user's inbox
 *    issue.
 * 4. Finishes the job, or settles the failure by §12's table.
 *
 * It never sleeps while holding the lease: every wait is a `run_at` or a pause.
 *
 * @param session The leased job.
 * @returns How the job ended.
 * @throws {LeaseLostError} If the lease was lost; the post may have landed, and the next
 *   attempt's marker check finds it.
 */
export const runDeliver = async (
  session: DeliverSession,
): Promise<DeliverResult> => {
  const config = session.config ?? defaultConfig;
  const { db, lease, machine } = session;
  const message = await withLease(db, lease, (client) =>
    prepare(client, session),
  );
  if (!message) {
    return "skipped";
  }
  const context: WriteContext = {
    job: lease.id,
    user: lease.userId,
    kind: message.kind,
    target:
      message.kind === "opening"
        ? machine.inboxRepo
        : formatTarget(message.target),
  };

  const finish = async (
    delivered: unknown,
    outcome: "posted" | "found",
  ): Promise<DeliverResult> => {
    if (
      typeof delivered !== "object" ||
      delivered === null ||
      Array.isArray(delivered)
    ) {
      logger.warn("unexpected response: invalid delivery object", context);
      return settleFailure(session, { kind: "transient" }, context);
    }
    const issueNumber =
      "number" in delivered &&
      typeof delivered.number === "number" &&
      Number.isSafeInteger(delivered.number) &&
      delivered.number > 0
        ? delivered.number
        : null;
    if (
      outcome === "posted" &&
      message.kind !== "opening" &&
      (!("id" in delivered) ||
        typeof delivered.id !== "number" ||
        !Number.isSafeInteger(delivered.id) ||
        delivered.id <= 0)
    ) {
      logger.warn("unexpected response: a comment without an id", context);
      return settleFailure(session, { kind: "transient" }, context);
    }
    if (message.kind === "opening" && issueNumber === null) {
      // the issue exists, but where? The next attempt's marker check reads its number.
      logger.warn("unexpected response: an issue without a number", context);
      return settleFailure(session, { kind: "transient" }, context);
    }
    await withLease(db, lease, (client) =>
      finishDelivered(client, session, message, issueNumber),
    );
    logger.log(
      outcome === "posted" ? "delivered" : "found an earlier attempt's post",
      { ...context, ...(message.kind === "opening" && { issueNumber }) },
    );
    return outcome;
  };

  const { attempted_at: attemptedAt } = lease.payload as DeliverPayload;
  if (typeof attemptedAt === "number") {
    const check = await findMarker(session, message, attemptedAt, context);
    if ("kind" in check) {
      return settleFailure(session, check, context);
    }
    if (check.found) {
      return finish(check.found, "found");
    }
  }

  const bucketLevel = await takeToken(session, context);
  if (bucketLevel === null) {
    return "waiting";
  }
  context.bucketLevel = bucketLevel;
  const result = await sendWrite<unknown>(
    message.kind === "opening"
      ? {
          method: "POST",
          path: `/repos/${machine.inboxRepo}/issues`,
          token: machine.token,
          body: { title: message.title, body: message.body },
        }
      : {
          method: "POST",
          path: `/repos/${message.target.repo}/issues/${message.target.number}/comments`,
          token: machine.token,
          body: { body: message.body },
        },
    context,
    config,
    sendWithClockCheck(session, context),
  );
  return result.kind === "ok"
    ? finish(result.data, "posted")
    : settleFailure(session, result, context);
};
