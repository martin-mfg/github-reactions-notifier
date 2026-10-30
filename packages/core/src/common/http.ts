import axios, { AxiosHeaders } from "axios";
import type { AxiosRequestConfig, AxiosResponse } from "axios";

import type { GraphQLDocument } from "../graphql/graphqlDocument.js";

const GITHUB_GRAPHQL_API = "https://api.github.com/graphql";

/**
 * Sent with every GraphQL request (C13). Without it, most historical node IDs
 * come back in a legacy format that GitHub plans to stop accepting.
 */
const NEXT_GLOBAL_ID_HEADERS = { "X-Github-Next-Global-ID": "1" } as const;

/** Response of a GraphQL call: the envelope the GitHub API wraps results in. */
type GraphQLResponse<TResult> = AxiosResponse<{
  data: TResult;
  errors?: Array<{ type?: string; message?: string }>;
}>;

/**
 * @param document Generated query document.
 * @param scheme `Authorization` scheme for the token.
 * @returns A fetcher `retryer` can drive.
 */
const createGraphQLFetcher = <TResult, TVariables>(
  document: GraphQLDocument<TResult, TVariables>,
  scheme: "bearer" | "token",
) => {
  return (
    variables: TVariables,
    token: string,
  ): Promise<GraphQLResponse<TResult>> => {
    return axios({
      url: GITHUB_GRAPHQL_API,
      method: "post",
      headers: {
        ...NEXT_GLOBAL_ID_HEADERS,
        Authorization: `${scheme} ${token}`,
      },
      data: { query: document.text, variables },
    });
  };
};

/** Body of a GraphQL request sent to the GitHub API. */
interface GraphQLRequest {
  /** The GraphQL query. */
  query: string;
  /** Variables referenced by the query. */
  variables: Record<string, unknown>;
}

/**
 * Send an untyped GraphQL request to the GitHub API.
 *
 * @param data Request data.
 * @param headers Request headers.
 * @returns Request response.
 *
 * @description Superseded by {@link createGraphQLFetcher}.
 * Still used by the backend status endpoints for their own `rateLimit` query,
 * and part of this package's published API.
 *
 * @todo consider dropping this once those endpoints post through axios directly,
 * which they already depend on.
 */
const request = (
  data: GraphQLRequest,
  headers: NonNullable<AxiosRequestConfig["headers"]>,
): Promise<AxiosResponse> => {
  return axios({
    url: GITHUB_GRAPHQL_API,
    method: "post",
    headers: {
      ...(headers instanceof AxiosHeaders ? headers.toJSON() : headers),
      ...NEXT_GLOBAL_ID_HEADERS,
    },
    data,
  });
};

export { createGraphQLFetcher, request };
export type { GraphQLResponse };
