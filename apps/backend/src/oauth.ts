/**
 * @file The OAuth flows (FR-1, FR-2a, FR-3). GRN has no sessions: sign-in and account deletion
 * both go through GitHub's OAuth flow, and the callback identifies the user by the fresh
 * token's `viewer`. GitHub skips its consent page for an app the user has authorized already,
 * so either flow is one click.
 *
 * A random `state`, mirrored in a short-lived cookie, ties the callback to a flow this browser
 * started, and names the flow's action and its FR-2a attempt.
 */

import { randomBytes } from "node:crypto";

import {
  AccessTokenCipher,
  ViewerDocument,
  createGraphQLFetcher,
  deleteGrant,
  githubAuthenticate,
  logger,
  pool,
} from "@grn/core";

import type { ApiHandler, ApiRequest, ApiResponse } from "../api/_types.ts";

import type { Config } from "./config.ts";
import type { Database } from "./db.ts";
import { deleteAccount, signIn } from "./users/accounts.ts";
import type { GitHubIdentity } from "./users/accounts.ts";

type OAuthAction = "signin" | "delete";

/** The page the flows end on reads this from `?status=`. */
type Outcome =
  | "signed-in"
  | "scope-rejected"
  | "deleted"
  | "deleted-grant-kept"
  | "cancelled"
  | "invalid-state"
  | "error";

const STATE_COOKIE = "grn_oauth_state";
const STATE_PATTERN = /^(signin|delete)\.(\d)\.[A-Za-z0-9_-]{22}$/;
const STATE_MAX_AGE_SECONDS = 10 * 60;

/**
 * FR-2a: how often a sign-in whose token carries a scope deletes the grant and restarts.
 * Deleting the grant drops its scopes, so one restart suffices; a second scoped token
 * would loop.
 */
const MAX_SCOPE_RESTARTS = 1;

/** Everything the flows need from outside: GitHub, the database, and the environment. */
export interface OAuthDeps {
  db: () => Database | null;
  cipher: () => AccessTokenCipher;
  /** Exchanges the code; `hasScope` is true when the token-exchange's `scope` isn't empty. */
  exchangeCode: (
    code: string,
  ) => Promise<{ accessToken: string; hasScope: boolean }>;
  fetchViewer: (accessToken: string) => Promise<GitHubIdentity>;
  deleteGrant: (accessToken: string) => Promise<void>;
  env: () => { clientId: string | undefined; redirectUri: string | undefined };
  config?: Config;
}

const newState = (action: OAuthAction, attempt: number): string =>
  `${action}.${attempt}.${randomBytes(16).toString("base64url")}`;

const parseState = (
  value: string,
): { action: OAuthAction; attempt: number } | null => {
  const match = STATE_PATTERN.exec(value);
  return match
    ? { action: match[1] as OAuthAction, attempt: Number(match[2]) }
    : null;
};

const header = (req: ApiRequest, name: string): string | undefined => {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
};

const readCookie = (req: ApiRequest, name: string): string | undefined =>
  header(req, "cookie")
    ?.split(";")
    .map((pair) => pair.trim().split("="))
    .find(([key]) => key === name)?.[1];

const stateCookie = (value: string, maxAge: number): string =>
  `${STATE_COOKIE}=${value}; Path=/api/oauth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

const redirect = (res: ApiResponse, location: string, status = 302): void => {
  res.statusCode = status;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.send("");
};

const finish = (res: ApiResponse, outcome: Outcome): void => {
  redirect(res, `/?status=${outcome}`);
};

/**
 * @param deps The flows' dependencies.
 * @returns The three route handlers.
 */
export const createOAuthHandlers = (
  deps: OAuthDeps,
): { login: ApiHandler; deleteAccount: ApiHandler; callback: ApiHandler } => {
  const settings = (): { clientId: string; redirectUri: string } => {
    const { clientId, redirectUri } = deps.env();
    if (!clientId || !redirectUri) {
      throw new Error(
        "OAuth Error: OAUTH_CLIENT_ID or OAUTH_REDIRECT_URI is not set.",
      );
    }
    return { clientId, redirectUri };
  };

  /** Sends the browser to GitHub's authorize page, requesting no scopes (FR-1). */
  const startFlow = (
    res: ApiResponse,
    action: OAuthAction,
    attempt: number,
    status = 302,
  ): void => {
    const { clientId, redirectUri } = settings();
    const state = newState(action, attempt);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });
    res.setHeader("Set-Cookie", stateCookie(state, STATE_MAX_AGE_SECONDS));
    redirect(
      res,
      `https://github.com/login/oauth/authorize?${params.toString()}`,
      status,
    );
  };

  /**
   * Deletion must not be startable from another site: GitHub would approve it silently.
   * Browsers send `Sec-Fetch-Site` (or at least `Origin`) with every POST.
   */
  const isSameOrigin = (req: ApiRequest): boolean => {
    const site = header(req, "sec-fetch-site");
    if (site !== undefined) {
      return site === "same-origin";
    }
    const origin = header(req, "origin");
    return (
      origin === undefined || origin === new URL(settings().redirectUri).origin
    );
  };

  const login: ApiHandler = (_req, res) => {
    startFlow(res, "signin", 0);
  };

  const deleteAccountHandler: ApiHandler = (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.send("Method Not Allowed");
      return;
    }
    if (!isSameOrigin(req)) {
      res.statusCode = 403;
      res.send("Forbidden");
      return;
    }
    // 303: the browser follows a POST's redirect with a GET.
    startFlow(res, "delete", 0, 303);
  };

  const callback: ApiHandler = async (req, res) => {
    const { code, state, error } = req.query;
    const expected = readCookie(req, STATE_COOKIE);
    res.setHeader("Set-Cookie", stateCookie("", 0));
    const flow =
      typeof state === "string" && state === expected
        ? parseState(state)
        : null;
    if (!flow) {
      finish(res, "invalid-state");
      return;
    }
    if (error !== undefined || typeof code !== "string") {
      // The user declined on GitHub's consent page.
      finish(res, "cancelled");
      return;
    }

    try {
      const db = deps.db();
      if (!db) {
        throw new Error("POSTGRES_URL is not set");
      }
      const { accessToken, hasScope } = await deps.exchangeCode(code);

      if (flow.action === "delete") {
        const viewer = await deps.fetchViewer(accessToken);
        await deleteAccount(db, viewer.id);
        logger.log("account deleted", { user: viewer.id });
        try {
          await deps.deleteGrant(accessToken);
        } catch (grantError) {
          logger.error("FR-3: deleting the OAuth grant failed", {
            user: viewer.id,
            error: grantError,
          });
          finish(res, "deleted-grant-kept");
          return;
        }
        finish(res, "deleted");
        return;
      }

      if (hasScope) {
        // FR-2a: never store a scoped token. Deleting the grant drops the stuck scopes.
        await deps.deleteGrant(accessToken);
        if (flow.attempt >= MAX_SCOPE_RESTARTS) {
          logger.error(
            "FR-2a: sign-in returned a scoped token again after its grant was deleted",
          );
          finish(res, "scope-rejected");
          return;
        }
        logger.log("FR-2a: scoped token discarded, grant deleted, restarting");
        res.setHeader("Set-Cookie", stateCookie("", 0));
        startFlow(res, "signin", flow.attempt + 1);
        return;
      }

      const viewer = await deps.fetchViewer(accessToken);
      const { isNew, inboxRequested } = await signIn(db, viewer, accessToken, {
        cipher: deps.cipher(),
        siteUrl: new URL(settings().redirectUri).origin,
        ...(deps.config && { config: deps.config }),
      });
      logger.log("signed in", { user: viewer.id, isNew, inboxRequested });
      finish(res, "signed-in");
    } catch (err) {
      logger.error(err);
      finish(res, "error");
    }
  };

  return { login, deleteAccount: deleteAccountHandler, callback };
};

const fetchViewerDocument = createGraphQLFetcher(ViewerDocument, "bearer");

/**
 * @param accessToken The fresh token.
 * @returns The token's owner.
 */
const fetchViewer = async (accessToken: string): Promise<GitHubIdentity> => {
  const { data } = await fetchViewerDocument({}, accessToken);
  if (data.errors?.length) {
    throw new Error(
      `viewer query failed: ${data.errors.map((e) => e.message).join("; ")}`,
    );
  }
  return data.data.viewer;
};

let cipher: AccessTokenCipher | undefined;

export const defaultHandlers = createOAuthHandlers({
  db: () => pool,
  cipher: () => (cipher ??= AccessTokenCipher.fromEnv()),
  exchangeCode: async (code) => {
    const { accessToken, needDowngrade } = await githubAuthenticate(
      code,
      false,
    );
    return { accessToken, hasScope: needDowngrade };
  },
  fetchViewer,
  deleteGrant,
  env: () => ({
    clientId: process.env["OAUTH_CLIENT_ID"],
    redirectUri: process.env["OAUTH_REDIRECT_URI"],
  }),
});
