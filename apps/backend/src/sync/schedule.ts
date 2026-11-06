import { logger } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Queryable } from "../db.ts";
import { runBackfill } from "../discovery/backfill.ts";
import { runIncrementalDiscovery } from "../discovery/incremental.ts";
import { runThreadScans } from "../discovery/threadScans.ts";
import type { SyncSession } from "../github/syncClient.ts";
import { releaseSync, withLease } from "../jobs/queue.ts";
import { runPoll } from "../polling/poll.ts";
import { runSnapshotSweep } from "../summary/snapshotSweep.ts";

import { scoreSql } from "./score.ts";

/** The task a `sync` job runs next (§9.1). */
export type SyncTask =
  | { kind: "poll"; score: number }
  | {
      kind: "discovery" | "backfill" | "threadScan";
      categoryId: string;
      score: number;
    }
  /** The snapshot sweep of a subscription whose backfill is finished (M1.1 §4). */
  | { kind: "snapshot"; subscriptionId: string; score: number }
  /** Nothing is eligible: the job waits until something is. */
  | { kind: "idle"; until: Date };

interface CandidateRow {
  kind: "poll" | "discovery" | "backfill" | "threadScan" | "snapshot";
  /** The category, or for `snapshot` the subscription; `NULL` for `poll`. */
  target_id: string | null;
  score: number;
}

/**
 * Whether subscription `s`'s backfill is finished (M1.1 §3, conditions 1 and 2): none of its
 * categories has a backfill window or a thread scan left.
 */
const BACKFILL_FINISHED = `
  NOT EXISTS (SELECT 1 FROM backfill_windows w
              JOIN subscription_categories c ON c.id = w.category_id
              WHERE c.subscription_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM thread_scans ts
                  JOIN subscription_categories c ON c.id = ts.category_id
                  WHERE c.subscription_id = s.id)`;

/**
 * The user's tasks, one row each, with their scores (§9.1): every item due for a poll (the
 * poll's score is its top item's), every category due for incremental discovery, every
 * backfill window, every thread scan, and every subscription with eligible snapshot rows once
 * its backfill is finished (M1.1 §4.1). A snapshot's score is over its eligible rows: `wait`
 * is the longest-waiting row's, `age` the freshest item's. `$1` is the user, `$2` `D`, `$3` `D_discovery`,
 * `$4` `P`, `$5` `w`.
 */
const CANDIDATES = `
  SELECT 'poll' AS kind, NULL::text AS target_id, t.node_id AS tiebreak,
         ${scoreSql({
           wait: "now() - t.last_checked_at",
           age: "now() - t.last_event_at",
           exponent: "$4::float8",
           weight: "1",
         })} AS score
  FROM tracked_content t
  WHERE t.user_id = $1 AND t.last_checked_at <= now() - make_interval(secs => $2)
  UNION ALL
  SELECT 'discovery', c.id::text, c.id::text,
         ${scoreSql({
           wait: "now() - c.last_checked_at",
           age: "now() - c.last_find_at",
           exponent: "$4::float8",
           weight: "$5::float8",
         })}
  FROM subscription_categories c
  JOIN subscriptions s ON s.id = c.subscription_id
  WHERE s.user_id = $1 AND c.last_checked_at <= now() - make_interval(secs => $3)
  UNION ALL
  SELECT 'backfill', w.category_id::text, w.category_id::text,
         ${scoreSql({
           wait: "now() - w.window_created_at",
           age: "now() - w.window_end",
           exponent: "$4::float8",
           weight: "$5::float8",
         })}
  FROM backfill_windows w
  JOIN subscription_categories c ON c.id = w.category_id
  JOIN subscriptions s ON s.id = c.subscription_id
  WHERE s.user_id = $1
  UNION ALL
  SELECT 'threadScan', t.category_id::text, t.thread_node_id,
         ${scoreSql({
           wait: "now() - t.scan_created_at",
           age: "now() - t.thread_created_at",
           exponent: "$4::float8",
           weight: "$5::float8",
         })}
  FROM thread_scans t
  JOIN subscription_categories c ON c.id = t.category_id
  JOIN subscriptions s ON s.id = c.subscription_id
  WHERE s.user_id = $1
  UNION ALL
  SELECT 'snapshot', s.id::text, s.id::text,
         ${scoreSql({
           wait: "now() - min(r.retry_at)",
           age: "now() - max(t.last_event_at)",
           exponent: "$4::float8",
           weight: "$5::float8",
         })}
  FROM reaction_snapshots r
  JOIN content_sources cs ON cs.user_id = r.user_id AND cs.node_id = r.node_id
  JOIN subscriptions s ON s.id = cs.subscription_id
  JOIN tracked_content t ON t.user_id = r.user_id AND t.node_id = r.node_id
  WHERE r.user_id = $1 AND r.thumbs_up IS NULL AND r.retry_at <= now()
    AND ${BACKFILL_FINISHED}
  GROUP BY s.id`;

/**
 * Scores the user's tasks afresh and picks the top one (§9.1), with a stable tiebreak and no
 * jitter. If none is eligible, the result says when the first poll, discovery or deferred
 * snapshot (of a subscription whose backfill is finished) will be.
 *
 * @param client Client to read with.
 * @param userId The job's user.
 * @param config Tunables `D`, `D_discovery`, `P` and `w`.
 * @returns The task to run.
 */
export const chooseSyncTask = async (
  client: Queryable,
  userId: string,
  config = defaultConfig,
): Promise<SyncTask> => {
  const { rows } = await client.query<CandidateRow>(
    `SELECT kind, target_id, score FROM (${CANDIDATES}) AS candidates
     ORDER BY score DESC, kind, tiebreak
     LIMIT 1`,
    [
      userId,
      config.minRecheckSeconds,
      config.discoveryMinRecheckSeconds,
      config.scoreExponent,
      config.discoveryWeight,
    ],
  );
  const top = rows[0];
  if (top) {
    if (top.kind === "poll" || top.target_id === null) {
      return { kind: "poll", score: top.score };
    }
    return top.kind === "snapshot"
      ? { kind: "snapshot", subscriptionId: top.target_id, score: top.score }
      : { kind: top.kind, categoryId: top.target_id, score: top.score };
  }

  // without tracked items or categories (no user has neither), check again after `D`
  const { rows: idle } = await client.query<{ until: Date }>(
    `SELECT greatest(now(), coalesce(least(
       (SELECT min(last_checked_at) FROM tracked_content WHERE user_id = $1)
         + make_interval(secs => $2),
       (SELECT min(c.last_checked_at) FROM subscription_categories c
        JOIN subscriptions s ON s.id = c.subscription_id WHERE s.user_id = $1)
         + make_interval(secs => $3),
       (SELECT min(r.retry_at) FROM reaction_snapshots r
        JOIN content_sources cs ON cs.user_id = r.user_id AND cs.node_id = r.node_id
        JOIN subscriptions s ON s.id = cs.subscription_id
        WHERE r.user_id = $1 AND r.thumbs_up IS NULL AND ${BACKFILL_FINISHED})
     ), now() + make_interval(secs => $2))) AS until`,
    [userId, config.minRecheckSeconds, config.discoveryMinRecheckSeconds],
  );
  const until = idle[0]?.until;
  if (until === undefined) {
    throw new Error("The idle query returned no row");
  }
  return { kind: "idle", until };
};

/**
 * Runs the leased `sync` job's next task: the top-scored one (§9.1). Each task ends the job's
 * run by releasing it (or settling its failure), so the next claim scores afresh. If nothing
 * is eligible, the job is released until the first item or category is due again.
 *
 * @param session The leased `sync` job.
 * @returns The task that ran.
 * @throws {LeaseLostError} If the lease was lost.
 */
export const runSyncTask = async (session: SyncSession): Promise<SyncTask> => {
  const { lease } = session;
  const task = await chooseSyncTask(
    session.db,
    lease.userId,
    session.config ?? defaultConfig,
  );
  logger.log("sync task", {
    job: lease.id,
    user: lease.userId,
    kind: lease.kind,
    task: task.kind,
    ...("categoryId" in task && { category: task.categoryId }),
    ...("subscriptionId" in task && { subscription: task.subscriptionId }),
    ...("score" in task && { score: task.score }),
    ...("until" in task && { until: task.until.toISOString() }),
  });
  switch (task.kind) {
    case "poll":
      await runPoll(session);
      break;
    case "discovery":
      await runIncrementalDiscovery(session, task.categoryId);
      break;
    case "backfill":
      await runBackfill(session, task.categoryId);
      break;
    case "threadScan":
      await runThreadScans(session, task.categoryId);
      break;
    case "snapshot":
      await runSnapshotSweep(session, task.subscriptionId);
      break;
    case "idle":
      await withLease(session.db, lease, (client) =>
        releaseSync(client, lease, task.until),
      );
      break;
  }
  return task;
};
