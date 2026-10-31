import axios from "axios";

import { classifyError, classifyResponse } from "./outcome.js";
import type { GitHubOutcome } from "./outcome.js";

const GITHUB_REST_API = "https://api.github.com";

/** One REST request, such as posting an issue comment. */
interface MutationRequest {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path below the REST API's root, such as `/repos/owner/repo/issues/1/comments`. */
  path: string;
  token: string;
  /** JSON body. */
  body?: unknown;
  /** The request is aborted after this long, and counts as failed. */
  timeoutMs: number;
}

/**
 * The mutation-safe request path: sends a REST request exactly once, with the one token given.
 *
 * The PAT-rotating `retryer` retries freely, which is fine for reads but would
 * duplicate content on writes, or create it as another account. This never retries, never
 * rotates and never sleeps. A failed or timed-out write may still have been applied, so the
 * caller decides whether, when and how safely to try again. Reads the writer depends on, such
 * as checking for an already-posted comment, can use it too.
 *
 * @template T Shape of the response body.
 * @param request The request.
 * @returns The classified outcome. It never throws for a failed request.
 */
const mutationRequest = async <T>(
  request: MutationRequest,
): Promise<GitHubOutcome<T>> => {
  const signal = AbortSignal.timeout(request.timeoutMs);
  try {
    const response = await axios({
      url: `${GITHUB_REST_API}${request.path}`,
      method: request.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${request.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      ...(request.body !== undefined && { data: request.body }),
      signal,
      // every status is classified, none thrown
      validateStatus: () => true,
    });
    return classifyResponse<T>(response, "rest");
  } catch (error) {
    return classifyError<T>(error, "rest", signal.aborted);
  }
};

export { mutationRequest };
export type { MutationRequest };
