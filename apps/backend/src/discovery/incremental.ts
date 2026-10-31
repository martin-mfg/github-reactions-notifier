import {
  AuthoredDiscoveryDocument,
  createGraphQLFetcher,
  logger,
} from "@grn/core";
import type {
  AuthoredDiscoveryQuery,
  AuthoredDiscoveryQueryVariables,
  GraphQLFetcherFunction,
} from "@grn/core";

import type { Queryable } from "../db.ts";
import { runQuery, settleSyncFailure } from "../github/syncClient.ts";
import type { SyncFailure, SyncSession } from "../github/syncClient.ts";
import { releaseSync, withLease } from "../jobs/queue.ts";

import {
  author,
  present,
  rejectForeignViewer,
  taskContext,
} from "./results.ts";
import { storeDiscovered } from "./store.ts";
import type { ContentType, DiscoveredItem, DiscoveryScope } from "./store.ts";

type Fetcher = GraphQLFetcherFunction<
  AuthoredDiscoveryQuery,
  AuthoredDiscoveryQueryVariables
>;

const defaultFetcher: Fetcher = createGraphQLFetcher(
  AuthoredDiscoveryDocument,
  "bearer",
);

type Viewer = AuthoredDiscoveryQuery["viewer"];
type Node<C extends { nodes: Array<unknown> | null }> = NonNullable<
  NonNullable<C["nodes"]>[number]
>;
type ThreadNode = Node<Viewer["issues"]> | Node<Viewer["pullRequests"]>;

/** One page of a pass, each item with the value of the pass's sort key. */
interface PassPage {
  pass: ContentType;
  hasNextPage: boolean;
  entries: Array<{ item: DiscoveredItem; sortValue: string }>;
}

/** What one incremental pass did, as logged. */
interface PassReport {
  pass: ContentType;
  /** Items at or above the watermark. */
  kept: number;
  /** The watermark before and after the run (unchanged if nothing was kept). */
  watermark: Date;
  newWatermark: Date;
  /** The page's oldest sort value, if the page overflowed (§9.2, `[SIMPLIFIED]`). */
  overflowOldest: string | null;
}

export type IncrementalDiscoveryResult =
  | {
      ok: true;
      /** Items the user did not track before. */
      newItems: number;
      passes: Array<PassReport>;
    }
  | { ok: false; failure: SyncFailure };

/**
 * The three passes of category `issue` (§9.2). Threads are keyed by `createdAt`. Comments are
 * keyed by `updatedAt`, their connection's only order (C7): an old comment edited a minute
 * ago comes first, and a `createdAt` key would end the pass before any new comment.
 *
 * @param viewer The query's `viewer`.
 * @returns One page per pass.
 */
const passPages = (viewer: Viewer): Array<PassPage> => {
  const threads = (
    nodes: Array<ThreadNode | null> | null,
  ): PassPage["entries"] =>
    present(nodes).map((node) => ({
      item: {
        nodeId: node.id,
        type: node.__typename,
        repoFullName: node.repository.nameWithOwner,
        url: node.url,
        title: node.title,
        ...author(node.author),
        lastEventAt: node.createdAt,
      },
      sortValue: node.createdAt,
    }));

  return [
    {
      pass: "Issue",
      hasNextPage: viewer.issues.pageInfo.hasNextPage,
      entries: threads(viewer.issues.nodes),
    },
    {
      pass: "PullRequest",
      hasNextPage: viewer.pullRequests.pageInfo.hasNextPage,
      entries: threads(viewer.pullRequests.nodes),
    },
    {
      pass: "IssueComment",
      hasNextPage: viewer.issueComments.pageInfo.hasNextPage,
      entries: present(viewer.issueComments.nodes).map((node) => ({
        item: {
          nodeId: node.id,
          type: node.__typename,
          repoFullName: node.repository.nameWithOwner,
          url: node.url,
          title: node.issue.title,
          ...author(node.author),
          lastEventAt: node.createdAt,
        },
        sortValue: node.updatedAt,
      })),
    },
  ];
};

/**
 * @param client Client inside the task's transaction.
 * @param userId The leased job's user.
 * @param categoryId The category to discover.
 * @returns The category's scope and its passes' watermarks.
 */
const loadCategory = async (
  client: Queryable,
  userId: string,
  categoryId: string,
): Promise<{ scope: DiscoveryScope; watermarks: Map<string, Date> }> => {
  const { rows } = await client.query<{ subscription_id: string }>(
    `SELECT c.subscription_id FROM subscription_categories c
     JOIN subscriptions s ON s.id = c.subscription_id
     WHERE c.id = $1 AND s.user_id = $2`,
    [categoryId, userId],
  );
  const subscriptionId = rows[0]?.subscription_id;
  if (subscriptionId === undefined) {
    throw new Error(`No category ${categoryId} for user ${userId}`);
  }
  const { rows: passes } = await client.query<{
    pass: string;
    watermark: Date;
  }>("SELECT pass, watermark FROM subscription_passes WHERE category_id = $1", [
    categoryId,
  ]);
  return {
    scope: { userId, subscriptionId, categoryId },
    watermarks: new Map(passes.map((row) => [row.pass, row.watermark])),
  };
};

/**
 * Runs the `authored` source's incremental discovery for one category (§9.2) as one task of
 * the leased `sync` job: one query reads one page of each pass, and one fenced transaction
 * stores what it found and releases the job.
 *
 * Per pass, it keeps the items whose sort value is `≥` the pass's watermark, upserts them, and
 * advances the watermark to the newest kept item's sort value, all in that transaction. A
 * failed query changes nothing, so the next run reads the same range again. A page that has
 * more items and whose oldest is still `≥` the watermark overflowed: that is logged as an
 * error and the pass reads no further (`[SIMPLIFIED]`).
 *
 * The category's `last_checked_at` becomes `now`, and so does `last_find_at` if an item was
 * new. The user's `login` is refreshed from `viewer`.
 *
 * @param session The leased `sync` job.
 * @param categoryId The `subscription_categories.id` to discover.
 * @param fetcher Sends the query; tests substitute it.
 * @returns What was found, or the failure that was settled.
 * @throws {LeaseLostError} If the lease was lost; nothing is stored then.
 */
export const runIncrementalDiscovery = async (
  session: SyncSession,
  categoryId: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<IncrementalDiscoveryResult> => {
  const { lease } = session;
  const context = taskContext(session, categoryId);

  const result = await runQuery(session, fetcher, {});
  if (!result.ok) {
    await settleSyncFailure(session, result.failure);
    return result;
  }
  const { viewer } = result.data;
  const foreign = await rejectForeignViewer(session, viewer.id, context);
  if (foreign) {
    return { ok: false, failure: foreign };
  }

  const { newItems, passes, oldLogin } = await withLease(
    session.db,
    lease,
    async (client) => {
      const { rows: users } = await client.query<{ login: string }>(
        "SELECT login FROM users WHERE gh_user_id = $1",
        [lease.userId],
      );
      const storedLogin = users[0]?.login;
      if (storedLogin !== viewer.login) {
        await client.query(
          "UPDATE users SET login = $2 WHERE gh_user_id = $1",
          [lease.userId, viewer.login],
        );
      }
      const { scope, watermarks } = await loadCategory(
        client,
        lease.userId,
        categoryId,
      );

      const reports: Array<PassReport> = [];
      const kept: Array<DiscoveredItem> = [];
      for (const page of passPages(viewer)) {
        const watermark = watermarks.get(page.pass);
        if (watermark === undefined) {
          throw new Error(`No pass ${page.pass} in category ${categoryId}`);
        }
        // `≥`, not `>`: re-reading boundary ties is free, skipping one is not.
        const keptEntries = page.entries.filter(
          (entry) => Date.parse(entry.sortValue) >= watermark.getTime(),
        );
        kept.push(...keptEntries.map((entry) => entry.item));

        const sortTimes = page.entries.map((entry) =>
          Date.parse(entry.sortValue),
        );
        const oldest = Math.min(...sortTimes);
        const overflowed =
          page.hasNextPage &&
          sortTimes.length > 0 &&
          oldest >= watermark.getTime();

        let newWatermark = watermark;
        if (keptEntries.length > 0) {
          const newest = keptEntries.reduce((a, b) =>
            Date.parse(b.sortValue) > Date.parse(a.sortValue) ? b : a,
          ).sortValue;
          const { rows } = await client.query<{ watermark: Date }>(
            `UPDATE subscription_passes SET watermark = greatest(watermark, $3::timestamptz)
             WHERE category_id = $1 AND pass = $2
             RETURNING watermark`,
            [categoryId, page.pass, newest],
          );
          newWatermark = rows[0]?.watermark ?? watermark;
        }
        reports.push({
          pass: page.pass,
          kept: keptEntries.length,
          watermark,
          newWatermark,
          overflowOldest: overflowed ? new Date(oldest).toISOString() : null,
        });
      }

      const found = await storeDiscovered(client, scope, kept);
      await client.query(
        `UPDATE subscription_categories
         SET last_checked_at = now(),
             last_find_at = CASE WHEN $2 THEN now() ELSE last_find_at END
         WHERE id = $1`,
        [categoryId, found > 0],
      );
      await releaseSync(client, lease);
      return {
        newItems: found,
        passes: reports,
        oldLogin: storedLogin === viewer.login ? undefined : storedLogin,
      };
    },
  );

  if (oldLogin !== undefined) {
    logger.log("login changed", {
      ...context,
      oldLogin,
      login: viewer.login,
    });
  }
  for (const report of passes) {
    if (report.overflowOldest !== null) {
      logger.error(
        "discovery pass overflowed: items between the watermark and the page are not tracked",
        {
          ...context,
          pass: report.pass,
          watermark: report.watermark.toISOString(),
          oldest: report.overflowOldest,
        },
      );
    }
  }
  logger.log("incremental discovery", {
    ...context,
    newItems,
    kept: Object.fromEntries(
      passes.map((report) => [report.pass, report.kept]),
    ),
  });
  return { ok: true, newItems, passes };
};
