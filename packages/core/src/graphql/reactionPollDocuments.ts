import { graphqlDocument } from "./graphqlDocument.js";

/** `id_<index>` per item. */
type ReactionPollQueryVariables = Record<`id_${number}`, string>;

/** GitHub's `ReactionContent` enum. */
type ReactionContent =
  | "THUMBS_UP"
  | "THUMBS_DOWN"
  | "LAUGH"
  | "HOORAY"
  | "CONFUSED"
  | "HEART"
  | "ROCKET"
  | "EYES";

/** An item's newest reaction, if any; `null` if the node is gone, `{}` if not reactable. */
type ProbedItem =
  | { reactions: { nodes: Array<{ createdAt: string } | null> | null } }
  | null
  | Record<PropertyKey, never>;

interface ReactionProbeQuery {
  rateLimit: { cost: number } | null;
  [alias: `item_${number}`]: ProbedItem;
}

interface DrilledReaction {
  content: ReactionContent;
  createdAt: string;
  /** `null` for a deleted ("ghost") user. */
  user: { id: string; login: string } | null;
}

/** An item's newest reactions; `null` if the node is gone, `{}` if not reactable. */
type DrilledItem =
  | {
      reactions: {
        pageInfo: { hasNextPage: boolean };
        nodes: Array<DrilledReaction | null> | null;
      };
    }
  | null
  | Record<PropertyKey, never>;

interface ReactionDrillDownQuery {
  rateLimit: { cost: number } | null;
  [alias: `item_${number}`]: DrilledItem;
}

/**
 * @param count Number of items, one `item_<index>` alias each.
 * @param reactions The selection of each item's reactions.
 * @param name The operation's name.
 * @returns The query's text: one aliased `node(id: $id_<index>)` field per item.
 */
const reactionPollText = (count: number, reactions: string, name: string) => {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map((index) => `$id_${index}: ID!`).join(", ");
  const items = indexes
    .map(
      (index) => `item_${index}: node(id: $id_${index}) {
    ... on Reactable {
      ${reactions}
    }
  }`,
    )
    .join("\n  ");
  return `
query ${name}(${variables}) {
  ${items}
  rateLimit {
    cost
  }
}`;
};

/**
 * Build the reaction probe (§9.3): each item's newest reaction only, which tells whether any
 * reaction is newer than the item's watermark. The shape is only known at runtime.
 *
 * @param count Number of items, one `item_<index>` alias each.
 * @returns Document for `createGraphQLFetcher`.
 */
const buildReactionProbeDocument = (count: number) =>
  graphqlDocument<ReactionProbeQuery, ReactionPollQueryVariables>(
    reactionPollText(
      count,
      `reactions(first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
        nodes {
          createdAt
        }
      }`,
      "reactionProbe",
    ),
  );

/**
 * Build the reaction drill-down (§9.3): the newest page of reactions of each item the probe
 * found newer reactions on. The shape is only known at runtime.
 *
 * @param count Number of items, one `item_<index>` alias each.
 * @returns Document for `createGraphQLFetcher`.
 */
const buildReactionDrillDownDocument = (count: number) =>
  graphqlDocument<ReactionDrillDownQuery, ReactionPollQueryVariables>(
    reactionPollText(
      count,
      `reactions(first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
        pageInfo {
          hasNextPage
        }
        nodes {
          content
          createdAt
          user {
            id
            login
          }
        }
      }`,
      "reactionDrillDown",
    ),
  );

export { buildReactionDrillDownDocument, buildReactionProbeDocument };
export type {
  DrilledItem,
  DrilledReaction,
  ProbedItem,
  ReactionDrillDownQuery,
  ReactionPollQueryVariables,
  ReactionProbeQuery,
};
