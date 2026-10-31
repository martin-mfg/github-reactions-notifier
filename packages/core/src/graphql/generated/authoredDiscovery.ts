// Generated file — see packages/core/scripts/generate-graphql-types.js

/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
import { graphqlDocument } from "../graphqlDocument.js";
export type AuthoredDiscoveryQueryVariables = Exact<{ [key: string]: never }>;

export type AuthoredDiscoveryQuery = {
  viewer: {
    id: string;
    login: string;
    issues: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{
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
      } | null> | null;
    };
    pullRequests: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{
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
      } | null> | null;
    };
    issueComments: {
      pageInfo: { hasNextPage: boolean };
      nodes: Array<{
        __typename: "IssueComment";
        id: string;
        url: string;
        createdAt: string;
        updatedAt: string;
        repository: { nameWithOwner: string };
        issue: { title: string };
        author:
          | { id: string; login: string }
          | { id: string; login: string }
          | { id: string; login: string }
          | { id: string; login: string }
          | { id: string; login: string }
          | null;
      } | null> | null;
    };
  };
  rateLimit: { cost: number } | null;
};

export const AuthoredDiscoveryDocument = graphqlDocument<
  AuthoredDiscoveryQuery,
  AuthoredDiscoveryQueryVariables
>(`
query authoredDiscovery {
  viewer {
    id
    login
    issues(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo {
        hasNextPage
      }
      nodes {
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
      }
    }
    pullRequests(first: 100, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo {
        hasNextPage
      }
      nodes {
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
      }
    }
    issueComments(first: 100, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo {
        hasNextPage
      }
      nodes {
        __typename
        id
        url
        createdAt
        updatedAt
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
      }
    }
  }
  rateLimit {
    cost
  }
}`);
