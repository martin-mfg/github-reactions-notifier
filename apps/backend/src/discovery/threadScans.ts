import {
  buildThreadScanDocument,
  createGraphQLFetcher,
  logger,
} from "@grn/core";
import type {
  BackfillCommentFragment,
  GraphQLError,
  GraphQLFetcherFunction,
  ScannedThread,
  ThreadScanQuery,
  ThreadScanQueryVariables,
} from "@grn/core";

import { defaultConfig } from "../config.ts";
import { validThreadScans } from "../github/queryValidation.ts";
import { runQuery, settleSyncFailure } from "../github/syncClient.ts";
import type { SyncFailure, SyncSession } from "../github/syncClient.ts";
import { releaseSync, withLease } from "../jobs/queue.ts";
import { scoreSql } from "../sync/score.ts";

import {
  commentItem,
  isComment,
  present,
  rejectForeignViewer,
  taskContext,
} from "./results.ts";
import { storeDiscovered } from "./store.ts";

type Fetcher = GraphQLFetcherFunction<
  ThreadScanQuery,
  ThreadScanQueryVariables
>;

const SECOND = 1000;

/** What a thread scan does to a thread's row after its page. */
type ScanStep =
  | { kind: "advance"; sinceAt: Date; stuck: boolean }
  /** The thread's last page is stored. */
  | { kind: "finish" }
  /** The thread is gone or no longer a thread. */
  | { kind: "drop" };

export type ThreadScanResult =
  | {
      ok: true;
      /** Items the user did not track before. */
      newItems: number;
      /** Threads whose rows advanced, finished (deleted), or were dropped (deleted). */
      advanced: number;
      finished: number;
      dropped: number;
    }
  | { ok: false; failure: SyncFailure };

interface ScanRow {
  thread_node_id: string;
  since_at: Date;
  subscription_id: string;
}

const alias = (index: number) => `thread_${index}` as const;

/**
 * A thread deleted since its scan was queued comes back `null` with a `NOT_FOUND` error at its
 * alias.
 *
 * @param error A GraphQL error of the response.
 * @returns Whether the error is a missing thread's.
 */
const isMissingThread = (error: GraphQLError): boolean =>
  error.type === "NOT_FOUND" &&
  error.path?.length === 1 &&
  /^thread_\d+$/.test(String(error.path[0]));

/**
 * @param row The thread's scan.
 * @param thread The thread's page, if it is still a thread.
 * @returns The page's comments and what happens to the row. The timeline is oldest-first, so
 *   the row advances to the page's newest comment.
 */
const scanPage = (
  row: ScanRow,
  thread: ScannedThread | undefined,
): { comments: Array<BackfillCommentFragment>; step: ScanStep } => {
  if (!thread || !("timelineItems" in thread)) {
    return { comments: [], step: { kind: "drop" } };
  }
  const comments = present(thread.timelineItems.nodes).filter(isComment);
  if (!thread.timelineItems.pageInfo.hasNextPage) {
    return { comments, step: { kind: "finish" } };
  }
  const newest = Math.max(
    ...comments.map((comment) => Date.parse(comment.createdAt)),
  );
  const sinceAt = row.since_at.getTime();
  const stuck = !(newest > sinceAt);
  return {
    comments,
    step: {
      kind: "advance",
      sinceAt: new Date(stuck ? sinceAt + SECOND : newest),
      stuck,
    },
  };
};

/**
 * Runs one thread-scan task for one category (§9.2) as one task of the leased `sync` job: one
 * query reads the next page of comments of up to `threadScanBatch` of the category's threads,
 * each `since` its row's `since_at − 1 s`, and one fenced transaction stores the user's
 * comments, advances each row's `since_at` to its page's newest comment, deletes the rows whose
 * last page this was, and releases the job.
 *
 * A full page whose newest comment does not pass `since_at` would be read again forever: that
 * is logged as an error and `since_at` moves one second on anyway (`[SIMPLIFIED]`, like the
 * stuck-second check). A thread that is gone is logged and its row deleted.
 *
 * The batch is the category's top `threadScanBatch` scans by score (§9.1): the longest
 * waiting, newest threads first.
 *
 * @param session The leased `sync` job.
 * @param categoryId The `subscription_categories.id` whose thread scans to run.
 * @param fetcher Sends the query; tests substitute it. Defaults to one built for the batch.
 * @returns What the scan did, or the failure that was settled.
 * @throws {LeaseLostError} If the lease was lost; nothing is stored then.
 */
export const runThreadScans = async (
  session: SyncSession,
  categoryId: string,
  fetcher?: Fetcher,
): Promise<ThreadScanResult> => {
  const config = session.config ?? defaultConfig;
  const { lease } = session;
  const context = taskContext(session, categoryId);

  const { rows } = await session.db.query<ScanRow>(
    `SELECT t.thread_node_id, t.since_at, c.subscription_id
     FROM thread_scans t
     JOIN subscription_categories c ON c.id = t.category_id
     JOIN subscriptions s ON s.id = c.subscription_id
     WHERE t.category_id = $1 AND s.user_id = $2
     ORDER BY ${scoreSql({
       wait: "now() - t.scan_created_at",
       age: "now() - t.thread_created_at",
       exponent: "$4::float8",
       // the same `w` for every scan, so it can't change the order
       weight: "1",
     })} DESC, t.thread_node_id
     LIMIT $3`,
    [categoryId, lease.userId, config.threadScanBatch, config.scoreExponent],
  );
  const subscriptionId = rows[0]?.subscription_id;
  if (subscriptionId === undefined) {
    throw new Error(`No thread scans in category ${categoryId}`);
  }

  const variables: ThreadScanQueryVariables = {};
  // `since` excludes comments created at exactly `since`: re-read `since_at`'s second.
  rows.forEach((row, index) => {
    variables[`id_${index}`] = row.thread_node_id;
    variables[`since_${index}`] = new Date(
      row.since_at.getTime() - SECOND,
    ).toISOString();
  });
  const result = await runQuery(
    session,
    fetcher ??
      createGraphQLFetcher(buildThreadScanDocument(rows.length), "bearer"),
    variables,
    {
      isExpectedError: isMissingThread,
      validate: (data) => validThreadScans(data, rows.length),
    },
  );
  if (!result.ok) {
    await settleSyncFailure(session, result.failure);
    return result;
  }
  const { data } = result;
  const foreign = await rejectForeignViewer(session, data.viewer.id, context);
  if (foreign) {
    return { ok: false, failure: foreign };
  }

  const pages = rows.map((row, index) => ({
    row,
    ...scanPage(row, data[alias(index)]),
  }));

  const newItems = await withLease(session.db, lease, async (client) => {
    const found = await storeDiscovered(
      client,
      { userId: lease.userId, subscriptionId, categoryId },
      pages.flatMap((page) =>
        page.comments
          .filter((comment) => comment.author?.id === lease.userId)
          .map(commentItem),
      ),
    );
    for (const { row, step } of pages) {
      if (step.kind === "advance") {
        await client.query(
          `UPDATE thread_scans SET since_at = greatest(since_at, $3)
           WHERE category_id = $1 AND thread_node_id = $2`,
          [categoryId, row.thread_node_id, step.sinceAt],
        );
      } else {
        await client.query(
          "DELETE FROM thread_scans WHERE category_id = $1 AND thread_node_id = $2",
          [categoryId, row.thread_node_id],
        );
      }
    }
    await releaseSync(client, lease);
    return found;
  });

  const count = (kind: ScanStep["kind"]) =>
    pages.filter((page) => page.step.kind === kind).length;
  for (const { row, step } of pages) {
    if (step.kind === "drop") {
      logger.log("thread scan dropped: the thread is gone", {
        ...context,
        thread: row.thread_node_id,
      });
    } else if (step.kind === "advance" && step.stuck) {
      logger.error(
        "thread scan page stuck at since_at: comments in that second beyond the page are not tracked",
        {
          ...context,
          thread: row.thread_node_id,
          sinceAt: row.since_at.toISOString(),
        },
      );
    }
  }
  const advanced = count("advance");
  const finished = count("finish");
  const dropped = count("drop");
  logger.log("thread scans", {
    ...context,
    threads: rows.length,
    newItems,
    advanced,
    finished,
    dropped,
  });
  return { ok: true, newItems, advanced, finished, dropped };
};
