import {
  buildReactionSnapshotDocument,
  createGraphQLFetcher,
  logger,
} from "@grn/core";
import type {
  GraphQLError,
  GraphQLFetcherFunction,
  ReactionPollQueryVariables,
  ReactionSnapshotQuery,
  SnapshotItem,
} from "@grn/core";

import { defaultConfig } from "../config.ts";
import { validReactionSnapshot } from "../github/queryValidation.ts";
import { runQuery, settleSyncFailure } from "../github/syncClient.ts";
import type { SyncFailure, SyncSession } from "../github/syncClient.ts";
import { releaseSync, withLease } from "../jobs/queue.ts";

import {
  REACTION_CONTENTS,
  SNAPSHOT_COLUMNS,
  queueSummaryIfComplete,
} from "./summary.ts";
import type { ReactionContent } from "./summary.ts";

type Fetcher = GraphQLFetcherFunction<
  ReactionSnapshotQuery,
  ReactionPollQueryVariables
>;

export type SnapshotResult =
  | {
      ok: true;
      /** Rows whose counts this task wrote. */
      filled: number;
      /** Rows deleted because their item is gone or not reactable. */
      deleted: number;
      /** Rows whose read failed, deferred by `snapshotRetryDelaySeconds`. */
      deferred: number;
      /** The summary's job id, if this task completed the subscription. */
      summary: string | null;
    }
  | { ok: false; failure: SyncFailure };

interface PendingRow {
  node_id: string;
  url: string;
}

/** What happens to one row. */
type Verdict =
  | { kind: "fill"; counts: Array<number>; unknown: Array<string> }
  | { kind: "delete"; reason: "missing" | "not reactable" }
  | {
      kind: "defer";
      failure: "graphql error";
      errorType: string;
      message: string;
    }
  | { kind: "defer"; failure: "unexpected null" };

const ALIAS = /^item_(\d+)$/;

/**
 * An error belongs to the alias its path starts with, nested fields included.
 *
 * @param error A GraphQL error of the response.
 * @param count How many aliases the query has.
 * @returns The alias' index, or `undefined` if the error belongs to none of them.
 */
const aliasIndex = (error: GraphQLError, count: number): number | undefined => {
  const first = error.path?.[0];
  const match = typeof first === "string" ? ALIAS.exec(first) : null;
  const index = match ? Number(match[1]) : Number.NaN;
  return Number.isInteger(index) && index < count ? index : undefined;
};

/** A deleted item: `null` with a `NOT_FOUND` error at its alias itself, as in `poll.ts`. */
const isMissing = (error: GraphQLError): boolean =>
  error.type === "NOT_FOUND" && error.path?.length === 1;

/**
 * Classifies one item (M1.1 §4.2). Its errors come first: only `NOT_FOUND` at the alias, with
 * the alias `null`, deletes the row; any other error defers it, whatever data survived. Without
 * errors, `null` (or `reactionGroups: null`) defers the row, an object without
 * `reactionGroups` deletes it, and anything else is the item's counts.
 *
 * @param node The item's alias.
 * @param errors The errors at the alias.
 * @returns What happens to the item's row.
 */
const classify = (node: SnapshotItem, errors: Array<GraphQLError>): Verdict => {
  if (errors.length > 0) {
    if (node === null && errors.every(isMissing)) {
      return { kind: "delete", reason: "missing" };
    }
    return {
      kind: "defer",
      failure: "graphql error",
      errorType: errors.map((error) => error.type ?? "unknown").join(","),
      message: errors.flatMap((error) => error.message ?? []).join("; "),
    };
  }
  if (node === null) {
    return { kind: "defer", failure: "unexpected null" };
  }
  if (!("reactionGroups" in node)) {
    return { kind: "delete", reason: "not reactable" };
  }
  if (node.reactionGroups === null) {
    return { kind: "defer", failure: "unexpected null" };
  }
  const counts = REACTION_CONTENTS.map(() => 0);
  const unknown: Array<string> = [];
  for (const group of node.reactionGroups) {
    const index = REACTION_CONTENTS.indexOf(group.content as ReactionContent);
    if (index === -1) {
      unknown.push(group.content);
    } else {
      counts[index] = (counts[index] ?? 0) + group.reactors.totalCount;
    }
  }
  return { kind: "fill", counts, unknown };
};

/**
 * Runs one snapshot task for one subscription (M1.1 §4) as one task of the leased `sync` job.
 *
 * 1. Picks up to `snapshotBatch` of the subscription's pending, eligible (`retry_at <= now`)
 *    snapshot rows, by `retry_at`, then `node_id`.
 * 2. Reads every item's reaction counts in one aliased query.
 * 3. In one fenced transaction: writes the counts of each item with error-free data (first
 *    write wins), deletes the rows of items that are gone (`NOT_FOUND`) or not reactable,
 *    defers every other row by `snapshotRetryDelaySeconds`, queues the summary if a row was
 *    filled or deleted and the subscription is now complete (M1.1 §3), and releases the job.
 *
 * Every deferred row is logged as an error, "snapshot stuck, summary held": it holds back the
 * summary until a later attempt succeeds. Rows are never given up on automatically. A failed
 * query, or an error that belongs to no item, is settled as for any other task and stores
 * nothing.
 *
 * @param session The leased `sync` job.
 * @param subscriptionId The subscription whose snapshots to take.
 * @param fetcher Sends the query; tests substitute it. Defaults to one built for the batch.
 * @returns What the task did, or the failure that was settled.
 * @throws {LeaseLostError} If the lease was lost; nothing is stored then.
 */
export const runSnapshotSweep = async (
  session: SyncSession,
  subscriptionId: string,
  fetcher?: Fetcher,
): Promise<SnapshotResult> => {
  const config = session.config ?? defaultConfig;
  const { lease } = session;
  const context = {
    job: lease.id,
    user: lease.userId,
    kind: lease.kind,
    subscription: subscriptionId,
  };

  const { rows } = await session.db.query<PendingRow>(
    `SELECT r.node_id, c.url
     FROM reaction_snapshots r
     JOIN content_sources cs ON cs.user_id = r.user_id AND cs.node_id = r.node_id
     JOIN content c ON c.node_id = r.node_id
     WHERE r.user_id = $1 AND cs.subscription_id = $2
       AND r.thumbs_up IS NULL AND r.retry_at <= now()
     ORDER BY r.retry_at, r.node_id
     LIMIT $3`,
    [lease.userId, subscriptionId, Math.min(config.snapshotBatch, 100)],
  );
  if (rows.length === 0) {
    throw new Error(
      `No eligible snapshots in subscription ${subscriptionId} of user ${lease.userId}`,
    );
  }

  const erred = (errors: Array<GraphQLError>) =>
    new Set(errors.flatMap((error) => aliasIndex(error, rows.length) ?? []));
  const result = await runQuery(
    session,
    fetcher ??
      createGraphQLFetcher(
        buildReactionSnapshotDocument(rows.length),
        "bearer",
      ),
    Object.fromEntries<string>(
      rows.map((row, index) => [`id_${index}`, row.node_id]),
    ),
    {
      query: "snapshot",
      isExpectedError: (error) => aliasIndex(error, rows.length) !== undefined,
      validate: (data, errors) =>
        validReactionSnapshot(data, rows.length, erred(errors)),
    },
  );
  if (!result.ok) {
    await settleSyncFailure(session, result.failure);
    return result;
  }

  const verdicts = rows.map((row, index) => ({
    row,
    verdict: classify(
      result.data[`item_${index}`] ?? null,
      result.errors.filter((error) => aliasIndex(error, rows.length) === index),
    ),
  }));
  const ids = (kind: Verdict["kind"]) =>
    verdicts
      .filter(({ verdict }) => verdict.kind === kind)
      .map(({ row }) => row.node_id);
  const fills = verdicts.flatMap(({ row, verdict }) =>
    verdict.kind === "fill" ? [{ nodeId: row.node_id, ...verdict }] : [],
  );

  const stored = await withLease(session.db, lease, async (client) => {
    let filled = 0;
    if (fills.length > 0) {
      const { rowCount } = await client.query(
        `UPDATE reaction_snapshots r
         SET ${SNAPSHOT_COLUMNS.map((column) => `${column} = v.${column}`).join(", ")}
         FROM unnest($2::text[], ${SNAPSHOT_COLUMNS.map(
           (_, index) => `$${index + 3}::int[]`,
         ).join(", ")}) AS v(node_id, ${SNAPSHOT_COLUMNS.join(", ")})
         WHERE r.user_id = $1 AND r.node_id = v.node_id AND r.thumbs_up IS NULL`,
        [
          lease.userId,
          fills.map((fill) => fill.nodeId),
          ...SNAPSHOT_COLUMNS.map((_, index) =>
            fills.map((fill) => fill.counts[index] ?? 0),
          ),
        ],
      );
      filled = rowCount ?? 0;
    }
    let deleted = 0;
    const toDelete = ids("delete");
    if (toDelete.length > 0) {
      const { rowCount } = await client.query(
        `DELETE FROM reaction_snapshots
         WHERE user_id = $1 AND node_id = ANY($2::text[]) AND thumbs_up IS NULL`,
        [lease.userId, toDelete],
      );
      deleted = rowCount ?? 0;
    }
    const toDefer = ids("defer");
    let deferredInSubscription = 0;
    if (toDefer.length > 0) {
      await client.query(
        `UPDATE reaction_snapshots
         SET retry_at = now() + make_interval(secs => $3)
         WHERE user_id = $1 AND node_id = ANY($2::text[]) AND thumbs_up IS NULL`,
        [lease.userId, toDefer, config.snapshotRetryDelaySeconds],
      );
      const { rows: counted } = await client.query<{ deferred: number }>(
        `SELECT count(*)::int AS deferred
         FROM reaction_snapshots r
         JOIN content_sources cs ON cs.user_id = r.user_id AND cs.node_id = r.node_id
         WHERE r.user_id = $1 AND cs.subscription_id = $2
           AND r.thumbs_up IS NULL AND r.retry_at > now()`,
        [lease.userId, subscriptionId],
      );
      deferredInSubscription = counted[0]?.deferred ?? 0;
    }
    // only removed work can complete the subscription
    const summary =
      filled + deleted > 0
        ? await queueSummaryIfComplete(
            client,
            { userId: lease.userId, subscriptionId },
            context,
          )
        : null;
    await releaseSync(client, lease);
    return { filled, deleted, deferredInSubscription, summary };
  });

  for (const { row, verdict } of verdicts) {
    const item = { ...context, item: row.node_id, url: row.url };
    if (verdict.kind === "defer") {
      logger.error("snapshot stuck, summary held", {
        ...item,
        failure: verdict.failure,
        ...(verdict.failure === "graphql error" && {
          errorType: verdict.errorType,
          message: verdict.message,
        }),
        deferred: stored.deferredInSubscription,
      });
    } else if (verdict.kind === "delete") {
      if (verdict.reason === "missing") {
        logger.log("snapshot: item missing, row deleted", item);
      } else {
        logger.warn("snapshot: item has no reactionGroups, row deleted", item);
      }
    } else if (verdict.unknown.length > 0) {
      logger.warn("snapshot: unknown reaction content ignored", {
        ...item,
        content: verdict.unknown.join(","),
      });
    }
  }
  const deferred = ids("defer").length;
  logger.log("snapshot", {
    ...context,
    items: rows.length,
    filled: stored.filled,
    deleted: stored.deleted,
    deferred,
    ...(stored.summary !== null && { summary: stored.summary }),
  });
  return {
    ok: true,
    filled: stored.filled,
    deleted: stored.deleted,
    deferred,
    summary: stored.summary,
  };
};
