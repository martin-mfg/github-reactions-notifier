import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";

import { openDigests } from "./digest.ts";

/**
 * A `reaction_events` row a producer just inserted: only rows actually inserted flow on to
 * fan-out (§10). The poll is M1's one producer; a reaction webhook could be another.
 */
export interface NewReaction {
  node_id: string;
  reactor_id: string;
  emoji: string;
  reacted_at: Date;
  reactor_login: string;
}

/**
 * Fans new reactions out to the users tracking their items (§10), in the producer's
 * transaction. A reaction reaches every user with a source for its item, if it is not older
 * than that source's `enabled_at` for the item's type (FR-6, per reaction). The user's own
 * reactions are kept (FR-12). Each reaction gets a `queued` `reaction_notifications` row
 * (`ON CONFLICT DO NOTHING`, so it notifies at most once per user, FR-7), and each user who got
 * one has their digest opened or locked.
 *
 * @param client Client inside the producer's transaction.
 * @param reactions The new reactions.
 * @param config Tunable `digestWindowSeconds`.
 * @returns How many notifications were queued.
 */
export const fanOut = async (
  client: Queryable,
  reactions: Array<NewReaction>,
  config: Config = defaultConfig,
): Promise<number> => {
  if (reactions.length === 0) {
    return 0;
  }
  const { rows } = await client.query<{ user_id: string }>(
    `INSERT INTO reaction_notifications (user_id, node_id, reactor_id, emoji)
     SELECT DISTINCT s.user_id, r.node_id, r.reactor_id, r.emoji
     FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[])
       AS r(node_id, reactor_id, emoji, reacted_at)
     JOIN content c ON c.node_id = r.node_id
     JOIN content_sources s ON s.node_id = r.node_id
     JOIN subscription_categories sc ON sc.subscription_id = s.subscription_id
     JOIN subscription_types st ON st.category_id = sc.id AND st.content_type = c.type
     WHERE r.reacted_at >= st.enabled_at
     ON CONFLICT DO NOTHING
     RETURNING user_id`,
    [
      reactions.map((reaction) => reaction.node_id),
      reactions.map((reaction) => reaction.reactor_id),
      reactions.map((reaction) => reaction.emoji),
      reactions.map((reaction) => reaction.reacted_at),
    ],
  );
  await openDigests(
    client,
    rows.map((row) => row.user_id),
    config,
  );
  return rows.length;
};
