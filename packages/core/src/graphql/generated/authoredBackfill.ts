// Generated file — see packages/core/scripts/generate-graphql-types.js

/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
import { graphqlDocument } from "../graphqlDocument.js";
export type AuthoredBackfillQueryVariables = Exact<{
  query: string;
}>;

export type AuthoredBackfillQuery = {
  viewer: { id: string; login: string };
  search: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<
      | {
          __typename: "Issue";
          id: string;
          url: string;
          title: string;
          createdAt: string;
          repository: { nameWithOwner: string };
          author:
            | { id: string; login: string }
            | { id: string; login: string }
            | { id: string; login: string }
            | { id: string; login: string }
            | { id: string; login: string }
            | null;
          timelineItems: {
            pageInfo: { hasNextPage: boolean };
            nodes: Array<
              | {
                  __typename: "IssueComment";
                  id: string;
                  url: string;
                  createdAt: string;
                  repository: { nameWithOwner: string };
                  issue: { title: string };
                  author:
                    | { id: string; login: string }
                    | { id: string; login: string }
                    | { id: string; login: string }
                    | { id: string; login: string }
                    | { id: string; login: string }
                    | null;
                }
              | Record<PropertyKey, never>
              | null
            > | null;
          };
          reactions: { nodes: Array<{ createdAt: string } | null> | null };
        }
      | {
          __typename: "PullRequest";
          id: string;
          url: string;
          title: string;
          createdAt: string;
          repository: { nameWithOwner: string };
          author:
            | { id: string; login: string }
            | { id: string; login: string }
            | { id: string; login: string }
            | { id: string; login: string }
            | { id: string; login: string }
            | null;
          timelineItems: {
            pageInfo: { hasNextPage: boolean };
            nodes: Array<
              | {
                  __typename: "IssueComment";
                  id: string;
                  url: string;
                  createdAt: string;
                  repository: { nameWithOwner: string };
                  issue: { title: string };
                  author:
                    | { id: string; login: string }
                    | { id: string; login: string }
                    | { id: string; login: string }
                    | { id: string; login: string }
                    | { id: string; login: string }
                    | null;
                }
              | Record<PropertyKey, never>
              | null
            > | null;
          };
          reactions: { nodes: Array<{ createdAt: string } | null> | null };
        }
      | Record<PropertyKey, never>
      | null
    > | null;
  };
  rateLimit: { cost: number } | null;
};

export type BackfillCommentFragment = {
  __typename: "IssueComment";
  id: string;
  url: string;
  createdAt: string;
  repository: { nameWithOwner: string };
  issue: { title: string };
  author:
    | { id: string; login: string }
    | { id: string; login: string }
    | { id: string; login: string }
    | { id: string; login: string }
    | { id: string; login: string }
    | null;
};

export const AuthoredBackfillDocument = graphqlDocument<
  AuthoredBackfillQuery,
  AuthoredBackfillQueryVariables
>(`
query authoredBackfill($query: String!) {
  viewer {
    id
    login
  }
  search(type: ISSUE, query: $query, first: 100) {
    pageInfo {
      hasNextPage
    }
    nodes {
      ... on Issue {
        __typename
        id
        url
        title
        createdAt
        repository {
          nameWithOwner
        }
        author {
          login
          ... on Node {
            id
          }
        }
        timelineItems(itemTypes: [ISSUE_COMMENT], first: 100) {
          pageInfo {
            hasNextPage
          }
          nodes {
            ...BackfillComment
          }
        }
        reactions(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            createdAt
          }
        }
      }
      ... on PullRequest {
        __typename
        id
        url
        title
        createdAt
        repository {
          nameWithOwner
        }
        author {
          login
          ... on Node {
            id
          }
        }
        timelineItems(itemTypes: [ISSUE_COMMENT], first: 100) {
          pageInfo {
            hasNextPage
          }
          nodes {
            ...BackfillComment
          }
        }
        reactions(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) {
          nodes {
            createdAt
          }
        }
      }
    }
  }
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
