// Generated file — see packages/core/scripts/generate-graphql-types.js

/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
import { graphqlDocument } from "../graphqlDocument.js";
export type ViewerQueryVariables = Exact<{ [key: string]: never }>;

export type ViewerQuery = {
  viewer: { id: string; login: string; createdAt: string };
  rateLimit: {
    cost: number;
    used: number;
    remaining: number;
    resetAt: string;
  } | null;
};

export const ViewerDocument = graphqlDocument<
  ViewerQuery,
  ViewerQueryVariables
>(`
query viewer {
  viewer {
    id
    login
    createdAt
  }
  rateLimit {
    cost
    used
    remaining
    resetAt
  }
}`);
