import {
  AuthoredBackfillDocument,
  createGraphQLFetcher,
  logger,
} from "@grn/core";
import type {
  AuthoredBackfillQuery,
  AuthoredBackfillQueryVariables,
  GraphQLError,
  GraphQLFetcherFunction,
} from "@grn/core";

import type { Queryable } from "../db.ts";
import { validBackfill } from "../github/queryValidation.ts";
import { runQuery, settleSyncFailure } from "../github/syncClient.ts";
import type { SyncFailure, SyncSession } from "../github/syncClient.ts";
import { releaseSync, withLease } from "../jobs/queue.ts";
import { queueSummaryIfComplete } from "../summary/summary.ts";

import {
  author,
  commentItem,
  isComment,
  present,
  rejectForeignViewer,
  taskContext,
} from "./results.ts";
import { insertPendingSnapshots, storeDiscovered } from "./store.ts";
import type { DiscoveredItem } from "./store.ts";

type Fetcher = GraphQLFetcherFunction<
  AuthoredBackfillQuery,
  AuthoredBackfillQueryVariables
>;

const defaultFetcher: Fetcher = createGraphQLFetcher(
  AuthoredBackfillDocument,
  "bearer",
);

type SearchNode = NonNullable<
  NonNullable<AuthoredBackfillQuery["search"]["nodes"]>[number]
>;
/** A search hit: an issue or a PR. Other result types come back as `{}`. */
type Hit = Extract<SearchNode, { __typename: string }>;

const isHit = (node: SearchNode): node is Hit => "__typename" in node;

/** What a backfill page did to its window. */
type WindowChange =
  /** `window_end` moved back to the page's oldest hit (or one second before it, if stuck). */
  | { kind: "moved"; windowEnd: Date }
  /** All the window's pages are stored. */
  | { kind: "deleted" };

export type BackfillResult =
  | {
      ok: true;
      status: "stored";
      /** Items the user did not track before. */
      newItems: number;
      /** `reaction_snapshots` rows this page queued (M1.1 §2.3). */
      newSnapshots: number;
      /** `thread_scans` rows this page inserted. */
      newThreadScans: number;
      window: WindowChange;
      /** The backfill summary's job id, if this page completed the subscription (M1.1 §3). */
      summary: string | null;
    }
  /** `viewer.login` differs from the search's: the page was discarded (§9.2). */
  | { ok: true; status: "login-changed" }
  | { ok: false; failure: SyncFailure };

/** The newest window of a category, and what its search needs. */
interface WindowRow {
  window_start: Date;
  window_end: Date;
  login: string;
  subscription_id: string;
}

const SECOND = 1000;

const floorToSecond = (time: number): number =>
  Math.floor(time / SECOND) * SECOND;

/**
 * @param date A window bound.
 * @returns The bound as a search qualifier wants it: whole seconds, floored. Content
 *   timestamps are whole seconds, so flooring the end includes the same hits.
 */
const searchTime = (date: Date): string =>
  new Date(floorToSecond(date.getTime()))
    .toISOString()
    .replace(".000Z", "+00:00");

/**
 * @param login The user's login.
 * @param window The window to search.
 * @param window.start Its oldest `createdAt`, inclusive.
 * @param window.end Its newest `createdAt`, inclusive.
 * @returns The `search` query string: newest-first (§9.2).
 */
export const backfillSearch = (
  login: string,
  window: { start: Date; end: Date },
): string =>
  `involves:${login} created:${searchTime(window.start)}..${searchTime(window.end)} sort:created-desc`;

/**
 * A hit's newest-reaction hint may fail on its own (§9.2): its error's path runs through
 * `search.nodes[i].reactions`.
 *
 * @param error A GraphQL error of the response.
 * @returns The hit's index, or `undefined` if the error is not a hint's.
 */
const hintErrorIndex = (error: GraphQLError): number | undefined => {
  const [search, nodes, index, field] = error.path ?? [];
  return search === "search" &&
    nodes === "nodes" &&
    typeof index === "number" &&
    field === "reactions"
    ? index
    : undefined;
};

/**
 * @param hit A search hit the user opened.
 * @returns The thread as an item: `last_event_at = max(createdAt, newest reaction)`, or
 *   `createdAt` if the hint failed (§9.2).
 */
const threadItem = (hit: Hit): DiscoveredItem => {
  const newestReaction = present(hit.reactions.nodes)[0]?.createdAt;
  return {
    nodeId: hit.id,
    type: hit.__typename,
    repoFullName: hit.repository.nameWithOwner,
    url: hit.url,
    title: hit.title,
    ...author(hit.author),
    lastEventAt:
      newestReaction !== undefined &&
      Date.parse(newestReaction) > Date.parse(hit.createdAt)
        ? newestReaction
        : hit.createdAt,
  };
};

/**
 * @param client Client inside or outside a transaction.
 * @param userId The leased job's user.
 * @param categoryId The category to backfill.
 * @returns The category's newest window, with the user's login and the subscription.
 */
const loadWindow = async (
  client: Queryable,
  userId: string,
  categoryId: string,
): Promise<WindowRow> => {
  const { rows } = await client.query<WindowRow>(
    `SELECT w.window_start, w.window_end, u.login, c.subscription_id
     FROM backfill_windows w
     JOIN subscription_categories c ON c.id = w.category_id
     JOIN subscriptions s ON s.id = c.subscription_id
     JOIN users u ON u.gh_user_id = s.user_id
     WHERE w.category_id = $1 AND s.user_id = $2
     ORDER BY w.window_end DESC
     LIMIT 1`,
    [categoryId, userId],
  );
  const window = rows[0];
  if (window === undefined) {
    throw new Error(`No backfill window in category ${categoryId}`);
  }
  return window;
};

/**
 * Where the window goes after a page (§9.2). A page without more hits finishes the window.
 * Otherwise `window_end` becomes the page's oldest hit, whose second the next page re-reads.
 * If that is the current `window_end`, the whole page is in one second and the walk is stuck:
 * it moves one second back anyway (`[SIMPLIFIED]`).
 *
 * @param window The window the page was read from.
 * @param hits The page's hits.
 * @param hasNextPage Whether the search has more hits.
 * @returns The new `window_end` (`null` to delete the window) and whether the page was stuck.
 */
const nextWindowEnd = (
  window: WindowRow,
  hits: Array<Hit>,
  hasNextPage: boolean,
): { windowEnd: Date | null; stuck: boolean } => {
  if (!hasNextPage || hits.length === 0) {
    return { windowEnd: null, stuck: false };
  }
  const oldest = Math.min(...hits.map((hit) => Date.parse(hit.createdAt)));
  const stuck = oldest >= floorToSecond(window.window_end.getTime());
  const windowEnd = new Date(stuck ? oldest - SECOND : oldest);
  return {
    windowEnd: windowEnd < window.window_start ? null : windowEnd,
    stuck,
  };
};

/**
 * Runs one page of the `authored` source's backfill for one category (§9.2) as one task of the
 * leased `sync` job: one `involves:` search over the category's newest window, then one fenced
 * transaction that stores the page and releases the job.
 *
 * The transaction upserts the user's own content among the hits (the threads they opened and
 * their comments; `involves:` also matches mentions and assignments), inserts a `thread_scans`
 * row for every hit with more comments than its inline page, and moves `window_end` back to
 * the page's oldest hit, or deletes the window after its last page. An interruption therefore
 * loses at most one page.
 *
 * If `viewer.login` is not the login the search was built with, the login is refreshed, the
 * page is discarded, the window is left untouched, and the job is due again at once.
 *
 * @param session The leased `sync` job.
 * @param categoryId The `subscription_categories.id` to backfill.
 * @param fetcher Sends the query; tests substitute it.
 * @returns What the page did, or the failure that was settled.
 * @throws {LeaseLostError} If the lease was lost; nothing is stored then.
 */
export const runBackfill = async (
  session: SyncSession,
  categoryId: string,
  fetcher: Fetcher = defaultFetcher,
): Promise<BackfillResult> => {
  const { lease } = session;
  const context = taskContext(session, categoryId);
  const window = await loadWindow(session.db, lease.userId, categoryId);

  const result = await runQuery(
    session,
    fetcher,
    {
      query: backfillSearch(window.login, {
        start: window.window_start,
        end: window.window_end,
      }),
    },
    {
      query: "backfill",
      isExpectedError: (error) => hintErrorIndex(error) !== undefined,
      validate: validBackfill,
    },
  );
  if (!result.ok) {
    await settleSyncFailure(session, result.failure);
    return result;
  }
  const { viewer, search } = result.data;
  const foreign = await rejectForeignViewer(session, viewer.id, context);
  if (foreign) {
    return { ok: false, failure: foreign };
  }

  if (viewer.login !== window.login) {
    await withLease(session.db, lease, async (client) => {
      await client.query("UPDATE users SET login = $2 WHERE gh_user_id = $1", [
        lease.userId,
        viewer.login,
      ]);
      await releaseSync(client, lease);
    });
    logger.log("login changed", {
      ...context,
      oldLogin: window.login,
      login: viewer.login,
      backfillPage: "discarded",
    });
    return { ok: true, status: "login-changed" };
  }

  // A hint's error nulls its whole hit (`reactions` is non-null), and with it the hit's
  // comments: storing the page would skip them for good.
  const nodes = search.nodes ?? [];
  const lostHits = result.errors
    .map(hintErrorIndex)
    .filter((index) => index !== undefined && !nodes[index]);
  if (lostHits.length > 0) {
    logger.warn("backfill hits lost to reaction hint errors", {
      ...context,
      hits: lostHits.join(","),
    });
    const failure: SyncFailure = { kind: "transient" };
    await settleSyncFailure(session, failure);
    return { ok: false, failure };
  }

  const hits = present(nodes).filter(isHit);
  const own: Array<DiscoveredItem> = [];
  for (const hit of hits) {
    if (hit.author?.id === lease.userId) {
      own.push(threadItem(hit));
    }
    own.push(
      ...present(hit.timelineItems.nodes)
        .filter(isComment)
        .filter((comment) => comment.author?.id === lease.userId)
        .map(commentItem),
    );
  }
  // The timeline is oldest-first: a long thread resumes after its page's newest comment.
  const longThreads = hits
    .filter((hit) => hit.timelineItems.pageInfo.hasNextPage)
    .map((hit) => {
      const times = present(hit.timelineItems.nodes)
        .filter(isComment)
        .map((comment) => Date.parse(comment.createdAt));
      return {
        nodeId: hit.id,
        sinceAt: new Date(Math.max(Date.parse(hit.createdAt), ...times)),
        createdAt: hit.createdAt,
      };
    });
  const { windowEnd, stuck } = nextWindowEnd(
    window,
    hits,
    search.pageInfo.hasNextPage,
  );

  const { newItems, newSnapshots, newThreadScans, summary } = await withLease(
    session.db,
    lease,
    async (client) => {
      const found = await storeDiscovered(
        client,
        {
          userId: lease.userId,
          subscriptionId: window.subscription_id,
          categoryId,
        },
        own,
      );
      const snapshots = await insertPendingSnapshots(client, lease.userId, own);
      // An existing row may have advanced already: the boundary re-read must not reset it.
      const { rowCount } = await client.query(
        `INSERT INTO thread_scans (category_id, thread_node_id, since_at, thread_created_at)
         SELECT $1::bigint, * FROM unnest($2::text[], $3::timestamptz[], $4::timestamptz[])
         ON CONFLICT DO NOTHING`,
        [
          categoryId,
          longThreads.map((thread) => thread.nodeId),
          longThreads.map((thread) => thread.sinceAt),
          longThreads.map((thread) => thread.createdAt),
        ],
      );
      let queued: string | null = null;
      if (windowEnd === null) {
        await client.query(
          "DELETE FROM backfill_windows WHERE category_id = $1 AND window_start = $2",
          [categoryId, window.window_start],
        );
        // only removed work can complete the subscription
        queued = await queueSummaryIfComplete(
          client,
          { userId: lease.userId, subscriptionId: window.subscription_id },
          context,
        );
      } else {
        await client.query(
          `UPDATE backfill_windows SET window_end = $3
           WHERE category_id = $1 AND window_start = $2`,
          [categoryId, window.window_start, windowEnd],
        );
      }
      await releaseSync(client, lease);
      return {
        newItems: found,
        newSnapshots: snapshots,
        newThreadScans: rowCount ?? 0,
        summary: queued,
      };
    },
  );

  if (stuck) {
    logger.error(
      "backfill page stuck in one second: hits in it beyond the page are not tracked",
      {
        ...context,
        second: searchTime(window.window_end),
        windowEnd: windowEnd?.toISOString() ?? "deleted",
      },
    );
  }
  logger.log("backfill", {
    ...context,
    hits: hits.length,
    newItems,
    newSnapshots,
    newThreadScans,
    windowEnd: windowEnd?.toISOString() ?? "deleted",
    ...(summary !== null && { summary }),
  });
  return {
    ok: true,
    status: "stored",
    newItems,
    newSnapshots,
    newThreadScans,
    window:
      windowEnd === null ? { kind: "deleted" } : { kind: "moved", windowEnd },
    summary,
  };
};

/**
 * A category's backfill is complete when it has neither windows nor thread scans left (§9.2).
 * The backfill summary waits for its whole subscription, snapshots included (M1.1 §3; see
 * `queueSummaryIfComplete`).
 *
 * @param client Client inside or outside a transaction.
 * @param categoryId The `subscription_categories.id`.
 * @returns Whether the category's backfill is complete.
 */
export const isBackfillComplete = async (
  client: Queryable,
  categoryId: string,
): Promise<boolean> => {
  const { rows } = await client.query<{ complete: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM backfill_windows WHERE category_id = $1)
        AND NOT EXISTS (SELECT 1 FROM thread_scans WHERE category_id = $1) AS complete`,
    [categoryId],
  );
  return rows[0]?.complete ?? false;
};
