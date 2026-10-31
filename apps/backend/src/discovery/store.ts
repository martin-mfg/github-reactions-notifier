import type { Queryable } from "../db.ts";

/** A content type, as GraphQL's `__typename` names it (§13). */
export type ContentType = "Issue" | "PullRequest" | "IssueComment";

/** An item a discovery task found, ready to upsert. */
export interface DiscoveredItem {
  nodeId: string;
  type: ContentType;
  repoFullName: string;
  url: string;
  /** The item's title; for a comment, its thread's. */
  title: string;
  /** `null` for a deleted ("ghost") author. */
  authorId: string | null;
  authorLogin: string | null;
  /** The new `tracked_content` row's `last_event_at` (GitHub's clock). */
  lastEventAt: string;
}

/** Where discovered items belong: the user, the matching source, and its category. */
export interface DiscoveryScope {
  userId: string;
  subscriptionId: string;
  categoryId: string;
}

/**
 * Upserts discovered items into `content`, `content_sources` and `tracked_content`, all
 * `ON CONFLICT DO NOTHING` (§9.2), so re-reading an item is free. `content` keeps the values of
 * its first write (a known gap, §1). A new `tracked_content` row starts with
 * `last_checked_at = now` and `watermark_at` = its type's `enabled_at`, which is all of FR-6.
 *
 * @param client Client inside the task's fenced transaction.
 * @param scope The user, source and category the items were found for.
 * @param items The items to store.
 * @returns How many items the user did not track before.
 */
export const storeDiscovered = async (
  client: Queryable,
  scope: DiscoveryScope,
  items: Array<DiscoveredItem>,
): Promise<number> => {
  if (items.length === 0) {
    return 0;
  }
  const nodeIds = items.map((item) => item.nodeId);
  const types = items.map((item) => item.type);
  await client.query(
    `INSERT INTO content (node_id, type, repo_full_name, url, title, author_id, author_login)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                          $6::text[], $7::text[])
     ON CONFLICT (node_id) DO NOTHING`,
    [
      nodeIds,
      types,
      items.map((item) => item.repoFullName),
      items.map((item) => item.url),
      items.map((item) => item.title),
      items.map((item) => item.authorId),
      items.map((item) => item.authorLogin),
    ],
  );
  await client.query(
    `INSERT INTO content_sources (user_id, node_id, subscription_id)
     SELECT $1, n, $2 FROM unnest($3::text[]) n
     ON CONFLICT DO NOTHING`,
    [scope.userId, scope.subscriptionId, nodeIds],
  );
  const { rows } = await client.query<{ node_id: string }>(
    `INSERT INTO tracked_content (user_id, node_id, last_event_at, watermark_at)
     SELECT $1, i.node_id, i.last_event_at, t.enabled_at
     FROM unnest($3::text[], $4::text[], $5::timestamptz[]) AS i(node_id, type, last_event_at)
     JOIN subscription_types t ON t.category_id = $2 AND t.content_type = i.type
     ON CONFLICT (user_id, node_id) DO NOTHING
     RETURNING node_id`,
    [
      scope.userId,
      scope.categoryId,
      nodeIds,
      types,
      items.map((item) => item.lastEventAt),
    ],
  );
  return rows.length;
};
