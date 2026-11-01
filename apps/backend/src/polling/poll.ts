import {
  buildReactionDrillDownDocument,
  buildReactionProbeDocument,
  createGraphQLFetcher,
  logger,
} from "@grn/core";
import type {
  DrilledItem,
  DrilledReaction,
  GraphQLError,
  GraphQLFetcherFunction,
  ProbedItem,
  ReactionDrillDownQuery,
  ReactionPollQueryVariables,
  ReactionProbeQuery,
} from "@grn/core";

import { defaultConfig } from "../config.ts";
import { present } from "../discovery/results.ts";
import { validReactionPoll } from "../github/queryValidation.ts";
import { runQuery, settleSyncFailure } from "../github/syncClient.ts";
import type { SyncFailure, SyncSession } from "../github/syncClient.ts";
import { releaseSync, withLease } from "../jobs/queue.ts";
import { fanOut } from "../pipeline/fanOut.ts";
import type { NewReaction } from "../pipeline/fanOut.ts";
import { scoreSql } from "../sync/score.ts";

type ProbeFetcher = GraphQLFetcherFunction<
  ReactionProbeQuery,
  ReactionPollQueryVariables
>;
type DrillDownFetcher = GraphQLFetcherFunction<
  ReactionDrillDownQuery,
  ReactionPollQueryVariables
>;

/** Sends the poll's queries; tests substitute them. Defaults to ones built for the batch. */
export interface PollFetchers {
  probe?: ProbeFetcher;
  drillDown?: DrillDownFetcher;
}

export type PollResult =
  | {
      ok: true;
      /** Items probed, drilled down, and missing (in the probe or the drill-down). */
      probed: number;
      drilled: number;
      missing: number;
      /** The `reaction_events` rows this poll inserted. */
      newReactions: Array<NewReaction>;
      /** The `reaction_notifications` rows their fan-out queued. */
      queued: number;
    }
  | { ok: false; failure: SyncFailure };

interface DueItem {
  node_id: string;
  /** `watermark_at` in whole milliseconds, floored, so `>` against GitHub's times stays exact. */
  watermark_ms: number;
  probe_start: Date;
}

/** What one item's poll writes. */
interface ItemOutcome {
  item: DueItem;
  /** The newest reaction seen, for `last_event_at`. */
  newestAt: string | null;
  /** The probe's newest reaction, which moves the watermark; `null` keeps it. */
  watermarkTo: string | null;
  /** The drill-down's reactions, a deleted user's as a ghost; filtered by the watermark in SQL. */
  reactions: Array<
    DrilledReaction & { user: NonNullable<DrilledReaction["user"]> }
  >;
}

/**
 * A deleted user's reaction has no `user`. It is still notified, as GitHub's `ghost`, keyed by
 * its `createdAt`, which a re-read sees again. Ghost reactions with the same emoji in the same
 * second become one.
 *
 * @param reaction A reaction.
 * @returns The reaction, with a user.
 */
const withUser = (
  reaction: DrilledReaction,
): DrilledReaction & { user: NonNullable<DrilledReaction["user"]> } => ({
  ...reaction,
  user: reaction.user ?? {
    id: `ghost:${new Date(reaction.createdAt).toISOString()}`,
    login: "ghost",
  },
});

const alias = (index: number) => `item_${index}` as const;

/**
 * A deleted item comes back `null` with a `NOT_FOUND` error at its alias. Any other error,
 * such as `FORBIDDEN`, fails the query, which is logged and retried after `syncRetrySeconds`
 * (§12).
 *
 * @param error A GraphQL error of the response.
 * @returns Whether the error is a missing item's.
 */
const isMissingItem = (error: GraphQLError): boolean =>
  error.type === "NOT_FOUND" &&
  error.path?.length === 1 &&
  /^item_\d+$/.test(String(error.path[0]));

const hasReactions = <T extends ProbedItem | DrilledItem>(
  node: T | undefined,
): node is Extract<T, { reactions: unknown }> =>
  node !== undefined && node !== null && "reactions" in node;

/**
 * @param values ISO timestamps.
 * @returns The newest, or `null` if there are none.
 */
const newest = (values: Array<string>): string | null =>
  values.reduce<string | null>(
    (latest, value) =>
      latest === null || Date.parse(value) > Date.parse(latest)
        ? value
        : latest,
    null,
  );

/**
 * @param seconds Detection latencies, sorted ascending.
 * @param fraction Which quantile, such as 0.95.
 * @returns The quantile by the nearest-rank method.
 */
const quantile = (seconds: Array<number>, fraction: number) =>
  seconds[Math.max(0, Math.ceil(fraction * seconds.length) - 1)];

/**
 * Runs one reaction poll (§9.3) as one task of the leased `sync` job.
 *
 * 1. Picks the user's top `probeBatch` items by score among those not checked for `D`.
 * 2. Probes them in one query for each item's newest reaction.
 * 3. Drills down, in one more query, into the items whose newest reaction is strictly newer
 *    than their `watermark_at`: the newest 100 reactions of each.
 * 4. In one fenced transaction: inserts the reactions at or after each item's `watermark_at`
 *    into `reaction_events` (`ON CONFLICT DO NOTHING`), raises `last_event_at` to the newest
 *    reaction, moves `watermark_at` to `max(watermark_at, min(newest, probe_start −
 *    CLOCK_MARGIN))` (the hot boundary), sets every probed item's `last_checked_at = now`, fans
 *    the inserted reactions out to `reaction_notifications` and opens digests (§10), and
 *    releases the job.
 *
 * Reactions before `watermark_at`, which starts at the type's `enabled_at`, are never stored.
 * A drill-down page that is full and still at or after `watermark_at` is logged as an error
 * and stored as usual, without a further query. A missing (`NOT_FOUND`) item is logged and
 * checked, and keeps its watermark. A failed query, including any other error at an item, is
 * settled (retried after `syncRetrySeconds`) and stores nothing, not even the probe's results.
 *
 * @param session The leased `sync` job.
 * @param fetchers Send the queries; tests substitute them.
 * @returns What the poll did, or the failure that was settled.
 * @throws {LeaseLostError} If the lease was lost; nothing is stored then.
 */
export const runPoll = async (
  session: SyncSession,
  fetchers: PollFetchers = {},
): Promise<PollResult> => {
  const config = session.config ?? defaultConfig;
  const { lease } = session;
  const context = { job: lease.id, user: lease.userId, kind: lease.kind };

  const { rows: items } = await session.db.query<DueItem>(
    `SELECT node_id, floor(extract(epoch FROM watermark_at) * 1000)::float8 AS watermark_ms,
            now() AS probe_start
     FROM tracked_content
     WHERE user_id = $1 AND last_checked_at <= now() - make_interval(secs => $2)
     ORDER BY ${scoreSql({
       wait: "now() - last_checked_at",
       age: "now() - last_event_at",
       exponent: "$3::float8",
       weight: "1",
     })} DESC, node_id
     LIMIT $4`,
    [
      lease.userId,
      config.minRecheckSeconds,
      config.scoreExponent,
      Math.min(config.probeBatch, 100),
    ],
  );
  const probeStart = items[0]?.probe_start;
  if (probeStart === undefined) {
    throw new Error(`No items due for a poll of user ${lease.userId}`);
  }

  const ids = (batch: Array<DueItem>): ReactionPollQueryVariables =>
    Object.fromEntries(
      batch.map((item, index) => [`id_${index}`, item.node_id]),
    );

  const probe = await runQuery(
    session,
    fetchers.probe ??
      createGraphQLFetcher(buildReactionProbeDocument(items.length), "bearer"),
    ids(items),
    {
      isExpectedError: isMissingItem,
      validate: (data) => validReactionPoll(data, items.length),
    },
  );
  if (!probe.ok) {
    await settleSyncFailure(session, probe.failure);
    return probe;
  }

  const missing: Array<{ item: DueItem; query: string }> = [];
  const outcomes: Array<ItemOutcome> = [];
  const toDrill: Array<ItemOutcome> = [];
  items.forEach((item, index) => {
    const node = probe.data[alias(index)];
    if (!hasReactions(node)) {
      missing.push({ item, query: "probe" });
      outcomes.push({
        item,
        newestAt: null,
        watermarkTo: null,
        reactions: [],
      });
      return;
    }
    const newestAt = newest(
      present(node.reactions.nodes).map((reaction) => reaction.createdAt),
    );
    const outcome: ItemOutcome = {
      item,
      newestAt,
      watermarkTo: newestAt,
      reactions: [],
    };
    outcomes.push(outcome);
    // strict: `≥` would drill down on every poll
    if (newestAt !== null && Date.parse(newestAt) > item.watermark_ms) {
      toDrill.push(outcome);
    }
  });

  const overflows: Array<{ item: DueItem; oldest: string }> = [];
  if (toDrill.length > 0) {
    const drillDown = await runQuery(
      session,
      fetchers.drillDown ??
        createGraphQLFetcher(
          buildReactionDrillDownDocument(toDrill.length),
          "bearer",
        ),
      ids(toDrill.map((outcome) => outcome.item)),
      {
        isExpectedError: isMissingItem,
        validate: (data) => validReactionPoll(data, toDrill.length, true),
      },
    );
    if (!drillDown.ok) {
      await settleSyncFailure(session, drillDown.failure);
      return drillDown;
    }
    toDrill.forEach((outcome, index) => {
      const node = drillDown.data[alias(index)];
      if (!hasReactions(node)) {
        missing.push({ item: outcome.item, query: "drill-down" });
        outcome.watermarkTo = null;
        return;
      }
      const page = present(node.reactions.nodes);
      outcome.reactions = page
        .filter(
          (reaction) =>
            Date.parse(reaction.createdAt) >= outcome.item.watermark_ms,
        )
        .map(withUser);
      outcome.newestAt = newest([
        ...(outcome.newestAt === null ? [] : [outcome.newestAt]),
        ...page.map((reaction) => reaction.createdAt),
      ]);
      const oldest = page.at(-1);
      if (
        node.reactions.pageInfo.hasNextPage &&
        oldest !== undefined &&
        Date.parse(oldest.createdAt) >= outcome.item.watermark_ms
      ) {
        overflows.push({ item: outcome.item, oldest: oldest.createdAt });
      }
    });
  }

  const reactions = outcomes.flatMap((outcome) =>
    outcome.reactions.map((reaction) => ({
      nodeId: outcome.item.node_id,
      ...reaction,
    })),
  );
  const stored = await withLease(session.db, lease, async (client) => {
    const { rows: times } = await client.query<{ detected_at: Date }>(
      "SELECT now() AS detected_at",
    );
    const detectedAt = times[0]?.detected_at;
    if (!detectedAt) {
      throw new Error("Postgres returned no detection timestamp");
    }
    // before the watermark moves: it filters by the watermark the drill-down was judged by
    const { rows } = await client.query<NewReaction>(
      `INSERT INTO reaction_events (node_id, reactor_id, emoji, reacted_at, reactor_login)
       SELECT r.node_id, r.reactor_id, r.emoji, r.reacted_at, r.reactor_login
       FROM unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[], $6::text[])
         AS r(node_id, reactor_id, emoji, reacted_at, reactor_login)
       JOIN tracked_content t ON t.user_id = $1 AND t.node_id = r.node_id
       WHERE r.reacted_at >= t.watermark_at
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        lease.userId,
        reactions.map((reaction) => reaction.nodeId),
        reactions.map((reaction) => reaction.user.id),
        reactions.map((reaction) => reaction.content),
        reactions.map((reaction) => reaction.createdAt),
        reactions.map((reaction) => reaction.user.login),
      ],
    );
    await client.query(
      `UPDATE tracked_content t
       SET last_checked_at = now(),
           last_event_at = greatest(t.last_event_at, i.newest_at),
           watermark_at = CASE WHEN i.watermark_to IS NULL THEN t.watermark_at
             ELSE greatest(t.watermark_at,
                           least(i.watermark_to, $3::timestamptz - make_interval(secs => $4)))
             END
       FROM unnest($2::text[], $5::timestamptz[], $6::timestamptz[])
         AS i(node_id, newest_at, watermark_to)
       WHERE t.user_id = $1 AND t.node_id = i.node_id`,
      [
        lease.userId,
        outcomes.map((outcome) => outcome.item.node_id),
        probeStart,
        config.clockMarginSeconds,
        outcomes.map((outcome) => outcome.newestAt),
        outcomes.map((outcome) => outcome.watermarkTo),
      ],
    );
    const queued = await fanOut(client, rows, config);
    await releaseSync(client, lease);
    return { newReactions: rows, queued, detectedAt };
  });
  const { newReactions, queued } = stored;

  for (const { item, query } of missing) {
    logger.log("poll: item missing, skipped", {
      ...context,
      item: item.node_id,
      query,
    });
  }
  for (const { item, oldest } of overflows) {
    logger.error(
      "poll: drill-down page full: reactions beyond it are not notified",
      {
        ...context,
        item: item.node_id,
        watermarkAt: new Date(item.watermark_ms).toISOString(),
        oldest,
      },
    );
  }
  const latencies = newReactions
    .map(
      (reaction) =>
        (stored.detectedAt.getTime() - reaction.reacted_at.getTime()) / 1000,
    )
    .sort((a, b) => a - b);
  logger.log("poll", {
    ...context,
    probed: items.length,
    drilled: toDrill.length,
    missing: missing.length,
    newReactions: newReactions.length,
    queued,
    // FR-8: how long after GitHub's createdAt GRN found them
    ...(latencies.length > 0 && {
      latencyP50Seconds: quantile(latencies, 0.5),
      latencyP95Seconds: quantile(latencies, 0.95),
    }),
  });
  return {
    ok: true,
    probed: items.length,
    drilled: toDrill.length,
    missing: missing.length,
    newReactions,
    queued,
  };
};
