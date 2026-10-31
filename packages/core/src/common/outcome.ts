import axios from "axios";

/** One entry of a GraphQL response's `errors`. */
export interface GraphQLError {
  type?: string;
  message?: string;
  path?: Array<string | number>;
}

/** A response's `x-ratelimit-*` headers. */
export interface RateLimitHeaders {
  /** The bucket the headers describe, such as `graphql` or `core`. */
  resource: string | null;
  limit: number;
  used: number;
  remaining: number;
  /** When the window resets, on GitHub's clock (whole seconds). */
  resetAt: Date;
}

/** What is known about a response, for logs and for rate-limit bookkeeping. */
export interface ResponseDetails {
  /** HTTP status, or `null` if no response arrived. */
  status: number | null;
  /** The `type` of each GraphQL error. */
  errorTypes: Array<string>;
  /** The response's error message(s), or the network error's. Empty if there is none. */
  message: string;
  /** `null` unless the response carried the complete set of headers. */
  rateLimit: RateLimitHeaders | null;
}

/**
 * The outcome of exactly one GitHub request, classified without any app policy:
 * - `ok`: a 2xx response. For GraphQL it has `data`, and `errors` may hold partial errors.
 * - `rate-limited`: a primary or secondary limit. `retryAfterSeconds` comes from
 *   `retry-after`, `resetAt` from `x-ratelimit-reset` when `x-ratelimit-remaining` is 0; both
 *   are `null` when neither header says how long to wait.
 * - `unauthorized`: a `401`; the token is revoked or expired.
 * - `failed`: anything else, such as another status, a network error or a timeout.
 */
export type GitHubOutcome<T> =
  | {
      kind: "ok";
      data: T;
      errors: Array<GraphQLError>;
      details: ResponseDetails;
    }
  | {
      kind: "rate-limited";
      retryAfterSeconds: number | null;
      resetAt: Date | null;
      details: ResponseDetails;
    }
  | { kind: "unauthorized"; details: ResponseDetails }
  | { kind: "failed"; timedOut: boolean; details: ResponseDetails };

/** The parts of an Axios response the classification reads. */
interface RawResponse {
  status: number;
  headers: unknown;
  data: unknown;
}

/**
 * "You will receive an error message that indicates that you hit a secondary rate limit"
 * (GitHub docs); a primary limit's message says "API rate limit exceeded".
 */
const RATE_LIMIT_MESSAGE = /rate limit/i;

/**
 * @param headers Axios headers or a plain object.
 * @param name Header name, matched case-insensitively.
 * @returns The header's value, or `null` if absent.
 */
const headerValue = (headers: unknown, name: string): string | null => {
  if (typeof headers !== "object" || headers === null) {
    return null;
  }
  const entries = headers as Record<string, unknown>;
  const key = Object.keys(entries).find(
    (candidate) => candidate.toLowerCase() === name,
  );
  const value = key === undefined ? undefined : entries[key];
  const first: unknown = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" || typeof first === "number"
    ? String(first)
    : null;
};

const headerNumber = (headers: unknown, name: string): number | null => {
  const value = headerValue(headers, name);
  if (value === null || value.trim() === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * @param headers The response's headers.
 * @returns The rate-limit headers, or `null` unless all of them are present.
 */
export const parseRateLimitHeaders = (
  headers: unknown,
): RateLimitHeaders | null => {
  const limit = headerNumber(headers, "x-ratelimit-limit");
  const used = headerNumber(headers, "x-ratelimit-used");
  const remaining = headerNumber(headers, "x-ratelimit-remaining");
  const reset = headerNumber(headers, "x-ratelimit-reset");
  if (limit === null || used === null || remaining === null || reset === null) {
    return null;
  }
  return {
    resource: headerValue(headers, "x-ratelimit-resource"),
    limit,
    used,
    remaining,
    resetAt: new Date(reset * 1000),
  };
};

/**
 * @param headers The response's headers.
 * @returns `retry-after` in seconds, or `null` if absent. GitHub sends seconds; an HTTP date
 *   is converted with the local clock.
 */
const parseRetryAfter = (headers: unknown): number | null => {
  const value = headerValue(headers, "retry-after");
  if (value === null || value.trim() === "") {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds);
  }
  const date = Date.parse(value);
  return Number.isNaN(date)
    ? null
    : Math.max(0, Math.ceil((date - Date.now()) / 1000));
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const graphQLErrors = (body: unknown): Array<GraphQLError> =>
  isObject(body) && Array.isArray(body["errors"])
    ? (body["errors"] as Array<unknown>).filter(isObject).map((error) => ({
        ...(typeof error["type"] === "string" && { type: error["type"] }),
        ...(typeof error["message"] === "string" && {
          message: error["message"],
        }),
        ...(Array.isArray(error["path"]) && {
          path: error["path"] as Array<string | number>,
        }),
      }))
    : [];

/**
 * Classifies a response to exactly one request (see {@link GitHubOutcome}).
 *
 * @template T Shape of the result: GraphQL's `data`, or a REST response's body.
 * @param response The response, whatever its status.
 * @param api `graphql` unwraps `data` and reads `errors`; `rest` keeps the body.
 * @returns The outcome.
 */
export const classifyResponse = <T>(
  response: RawResponse,
  api: "graphql" | "rest",
): GitHubOutcome<T> => {
  const { status, headers, data: body } = response;
  const errors = api === "graphql" ? graphQLErrors(body) : [];
  const bodyMessage =
    isObject(body) && typeof body["message"] === "string"
      ? body["message"]
      : "";
  const details: ResponseDetails = {
    status,
    errorTypes: errors.flatMap((error) => (error.type ? [error.type] : [])),
    message:
      errors
        .flatMap((error) => (error.message ? [error.message] : []))
        .join("; ") || bodyMessage,
    rateLimit: parseRateLimitHeaders(headers),
  };
  const isSuccess = status >= 200 && status < 300;

  if (status === 401) {
    return { kind: "unauthorized", details };
  }

  const saysRateLimited =
    errors.some((error) => error.type === "RATE_LIMITED") ||
    RATE_LIMIT_MESSAGE.test(details.message);
  // GraphQL reports an exhausted primary limit with a 200, too.
  if (status === 403 || status === 429 || (isSuccess && saysRateLimited)) {
    const retryAfterSeconds = parseRetryAfter(headers);
    if (retryAfterSeconds !== null) {
      return {
        kind: "rate-limited",
        retryAfterSeconds,
        resetAt: null,
        details,
      };
    }
    if (details.rateLimit?.remaining === 0) {
      return {
        kind: "rate-limited",
        retryAfterSeconds: null,
        resetAt: details.rateLimit.resetAt,
        details,
      };
    }
    if (status === 429 || saysRateLimited) {
      return {
        kind: "rate-limited",
        retryAfterSeconds: null,
        resetAt: null,
        details,
      };
    }
  }

  if (isSuccess) {
    if (api === "rest") {
      return { kind: "ok", data: body as T, errors, details };
    }
    // A GraphQL response without data, e.g. a query that failed to parse.
    if (isObject(body) && isObject(body["data"])) {
      return { kind: "ok", data: body["data"] as T, errors, details };
    }
  }
  return { kind: "failed", timedOut: false, details };
};

/**
 * Classifies an error thrown while requesting. One that carries a response is classified as
 * that response; anything else (network error, timeout) is `failed`.
 *
 * @template T Shape of the result.
 * @param error The thrown error.
 * @param api How to read a carried response.
 * @param timedOut Whether the request's own timeout aborted it.
 * @returns The outcome.
 */
export const classifyError = <T>(
  error: unknown,
  api: "graphql" | "rest",
  timedOut: boolean,
): GitHubOutcome<T> => {
  if (axios.isAxiosError(error) && error.response) {
    return classifyResponse<T>(error.response, api);
  }
  return {
    kind: "failed",
    timedOut,
    details: {
      status: null,
      errorTypes: [],
      message: timedOut
        ? "request timed out"
        : error instanceof Error
          ? error.message
          : String(error),
      rateLimit: null,
    },
  };
};
