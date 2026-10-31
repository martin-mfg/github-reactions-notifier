import type { BackfillCommentFragment } from "./generated/authoredBackfill.js";
import { graphqlDocument } from "./graphqlDocument.js";

/** `id_<index>` and `since_<index>` per thread. */
type ThreadScanQueryVariables = Record<
  `id_${number}` | `since_${number}`,
  string
>;

/** One page of a thread's comments; `null` if the node is gone, `{}` if not a thread. */
type ScannedThread =
  | {
      timelineItems: {
        pageInfo: { hasNextPage: boolean };
        nodes: Array<
          BackfillCommentFragment | Record<PropertyKey, never> | null
        > | null;
      };
    }
  | null
  | Record<PropertyKey, never>;

interface ThreadScanQuery {
  viewer: { id: string; login: string };
  rateLimit: { cost: number } | null;
  [alias: `thread_${number}`]: ScannedThread;
}

/**
 * Build a query for the next page of comments of several threads, one aliased
 * `node(id: $id_<index>)` field per thread, each with its own `since`. The shape is only
 * known at runtime.
 *
 * @param count Number of threads, one `thread_<index>` alias each.
 * @returns Document for `createGraphQLFetcher`.
 */
const buildThreadScanDocument = (count: number) => {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes
    .map((index) => `$id_${index}: ID!, $since_${index}: DateTime!`)
    .join(", ");
  // Issue and PullRequest have different timeline connection types, so no fragment spans both
  const timeline = (index: number) =>
    `timelineItems(itemTypes: [ISSUE_COMMENT], since: $since_${index}, first: 100) {
      pageInfo { hasNextPage }
      nodes { ...BackfillComment }
    }`;
  const threadFields = indexes
    .map(
      (index) => `thread_${index}: node(id: $id_${index}) {
    ... on Issue { ${timeline(index)} }
    ... on PullRequest { ${timeline(index)} }
  }`,
    )
    .join("\n  ");

  // fragment must match queries/authoredBackfill.graphql, which generates its type
  return graphqlDocument<ThreadScanQuery, ThreadScanQueryVariables>(`
query threadScan(${variables}) {
  viewer {
    id
    login
  }
  ${threadFields}
  rateLimit {
    cost
  }
}
fragment BackfillComment on IssueComment {
  __typename
  id
  url
  createdAt
  repository {
    nameWithOwner
  }
  issue {
    title
  }
  author {
    login
    ... on Node {
      id
    }
  }
}`);
};

export { buildThreadScanDocument };
export type { ScannedThread, ThreadScanQuery, ThreadScanQueryVariables };
