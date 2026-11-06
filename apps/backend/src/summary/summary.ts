import { randomUUID } from "node:crypto";

import { logger } from "@grn/core";

import type { Queryable } from "../db.ts";
import { renderReactionSummary } from "../inbox/notices.ts";
import type { ReactionSummary } from "../inbox/notices.ts";

/** GitHub's `ReactionContent` values; each is a `reaction_snapshots` column, lowercased. */
export const REACTION_CONTENTS = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
] as const;

export type ReactionContent = (typeof REACTION_CONTENTS)[number];

/** The `reaction_snapshots` count columns, in {@link REACTION_CONTENTS}' order. */
export const SNAPSHOT_COLUMNS = REACTION_CONTENTS.map((content) =>
  content.toLowerCase(),
);

/** The summary's columns come in this order; types not listed follow, alphabetically. */
const TYPE_ORDER = ["Issue", "PullRequest", "IssueComment"];

/** Where a summary belongs: the user and one of their subscriptions. */
export interface SummaryScope {
  userId: string;
  subscriptionId: string;
}

/**
 * A subscription's snapshot rows: the user's rows of the items the subscription matched
 * (M1.1 §2.2). `$1` is the user, `$2` the subscription.
 */
const SUBSCRIPTION_SNAPSHOTS = `
  reaction_snapshots r
  JOIN content_sources cs ON cs.user_id = r.user_id AND cs.node_id = r.node_id
  WHERE r.user_id = $1 AND cs.subscription_id = $2`;

/**
 * A subscription is complete (M1.1 §3) when none of its categories has a backfill window or a
 * thread scan left, and none of its items has a pending snapshot.
 *
 * @param client Client inside the task's fenced transaction.
 * @param scope The user and subscription.
 * @returns Whether the subscription is complete.
 */
const isSubscriptionComplete = async (
  client: Queryable,
  scope: SummaryScope,
): Promise<boolean> => {
  const { rows } = await client.query<{ complete: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM backfill_windows w
                        JOIN subscription_categories c ON c.id = w.category_id
                        WHERE c.subscription_id = $2)
        AND NOT EXISTS (SELECT 1 FROM thread_scans t
                        JOIN subscription_categories c ON c.id = t.category_id
                        WHERE c.subscription_id = $2)
        AND NOT EXISTS (SELECT 1 FROM ${SUBSCRIPTION_SNAPSHOTS} AND r.thumbs_up IS NULL)
        AS complete`,
    [scope.userId, scope.subscriptionId],
  );
  return rows[0]?.complete ?? false;
};

interface TypeRow {
  type: string;
  items: number;
  with_reactions: number;
  /** Reactions per emoji, in {@link REACTION_CONTENTS}' order. */
  counts: Array<number>;
}

/**
 * Aggregates a subscription's snapshots (M1.1 §5.1): items per content type, items with at
 * least one reaction, and reactions per emoji. The columns are the subscription's types, in a
 * fixed order, with 0 for a type without items.
 *
 * @param client Client inside the task's fenced transaction.
 * @param scope The user and subscription.
 * @returns The summary's numbers.
 */
const loadSummary = async (
  client: Queryable,
  scope: SummaryScope,
): Promise<ReactionSummary> => {
  const total = SNAPSHOT_COLUMNS.map((column) => `r.${column}`).join(" + ");
  const { rows } = await client.query<TypeRow>(
    `SELECT c.type, count(*)::int AS items,
            count(*) FILTER (WHERE ${total} > 0)::int AS with_reactions,
            ARRAY[${SNAPSHOT_COLUMNS.map(
              (column) => `coalesce(sum(r.${column}), 0)::int`,
            ).join(", ")}] AS counts
     FROM reaction_snapshots r
     JOIN content_sources cs ON cs.user_id = r.user_id AND cs.node_id = r.node_id
     JOIN content c ON c.node_id = r.node_id
     WHERE r.user_id = $1 AND cs.subscription_id = $2
     GROUP BY c.type`,
    [scope.userId, scope.subscriptionId],
  );
  const { rows: types } = await client.query<{ content_type: string }>(
    `SELECT DISTINCT t.content_type
     FROM subscription_types t
     JOIN subscription_categories c ON c.id = t.category_id
     WHERE c.subscription_id = $1`,
    [scope.subscriptionId],
  );
  const rank = (type: string) => {
    const index = TYPE_ORDER.indexOf(type);
    return index === -1 ? TYPE_ORDER.length : index;
  };
  const columns = [
    ...new Set([
      ...types.map((row) => row.content_type),
      ...rows.map((row) => row.type),
    ]),
  ].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return {
    items: columns.map((type) => ({
      type,
      count: rows.find((row) => row.type === type)?.items ?? 0,
    })),
    withReactions: rows.reduce((sum, row) => sum + row.with_reactions, 0),
    reactions: Object.fromEntries(
      REACTION_CONTENTS.map((content, index) => [
        content,
        rows.reduce((sum, row) => sum + (row.counts[index] ?? 0), 0),
      ]),
    ),
  };
};

/**
 * Queues the subscription's backfill summary if the subscription is complete (M1.1 §3). Call it
 * at the end of every transaction that removed outstanding work: a deleted backfill window, a
 * deleted thread scan, or a filled or deleted snapshot. The transaction that completes the
 * subscription is the only one that finds it complete, so the summary is queued exactly once,
 * with no stored flag.
 *
 * The summary is a one-off `deliver` job (`{ body }`), carrying its own id as the idempotency
 * marker, like FR-17's notice.
 *
 * @param client Client inside the task's fenced transaction.
 * @param scope The user and subscription.
 * @param context The task's log fields.
 * @returns The summary's job id, or `null` if the subscription isn't complete.
 */
export const queueSummaryIfComplete = async (
  client: Queryable,
  scope: SummaryScope,
  context: Record<string, string>,
): Promise<string | null> => {
  if (!(await isSubscriptionComplete(client, scope))) {
    return null;
  }
  const summary = await loadSummary(client, scope);
  const jobId = randomUUID();
  await client.query(
    `INSERT INTO jobs (id, kind, user_id, payload) VALUES ($1, 'deliver', $2, $3)`,
    [jobId, scope.userId, renderReactionSummary(jobId, summary)],
  );
  logger.log("backfill summary queued", {
    ...context,
    subscription: scope.subscriptionId,
    notice: jobId,
    items: summary.items.reduce((sum, item) => sum + item.count, 0),
    withReactions: summary.withReactions,
  });
  return jobId;
};
