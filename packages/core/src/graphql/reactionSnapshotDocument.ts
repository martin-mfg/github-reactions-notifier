import { graphqlDocument } from "./graphqlDocument.js";
import type { ReactionPollQueryVariables } from "./reactionPollDocuments.js";

/** One emoji's count on an item. `content` is a `ReactionContent` value, or a newer one. */
interface SnapshotReactionGroup {
  content: string;
  reactors: { totalCount: number };
}

/**
 * An item's reaction counts per emoji; `null` if the node is gone (or its field failed), `{}`
 * if it is not reactable.
 */
type SnapshotItem =
  | { reactionGroups: Array<SnapshotReactionGroup> | null }
  | null
  | Record<PropertyKey, never>;

interface ReactionSnapshotQuery {
  rateLimit: { cost: number } | null;
  [alias: `item_${number}`]: SnapshotItem;
}

/**
 * Build the snapshot sweep's query (M1.1 §4.2): every item's reaction count per emoji, one
 * aliased `node(id: $id_<index>)` field per item. `reactors` needs no `first:` for
 * `totalCount`; 50 items cost 1 point (measured). The shape is only known at runtime.
 *
 * @param count Number of items, one `item_<index>` alias each.
 * @returns Document for `createGraphQLFetcher`.
 */
const buildReactionSnapshotDocument = (count: number) => {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map((index) => `$id_${index}: ID!`).join(", ");
  const items = indexes
    .map(
      (index) => `item_${index}: node(id: $id_${index}) {
    ... on Reactable {
      reactionGroups {
        content
        reactors {
          totalCount
        }
      }
    }
  }`,
    )
    .join("\n  ");
  return graphqlDocument<ReactionSnapshotQuery, ReactionPollQueryVariables>(`
query reactionSnapshot(${variables}) {
  ${items}
  rateLimit {
    cost
  }
}`);
};

export { buildReactionSnapshotDocument };
export type { ReactionSnapshotQuery, SnapshotItem };
