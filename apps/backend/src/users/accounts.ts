import { randomUUID } from "node:crypto";

import { TokenDecryptionError, logger } from "@grn/core";
import type { AccessTokenCipher } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { withTransaction } from "../db.ts";
import type { Database, Queryable } from "../db.ts";
import { renderOpening } from "../inbox/opening.ts";

/** The token's owner, as `viewer { id login createdAt }` names them. */
export interface GitHubIdentity {
  /** Global node id, in the new format (C13). */
  id: string;
  login: string;
  /** ISO timestamp of the account's creation. */
  createdAt: string;
}

interface SignInOptions {
  cipher: AccessTokenCipher;
  /** GRN's site, linked from the inbox opening. */
  siteUrl: string;
  config?: Config;
}

/** M1's one category of the `authored` source, its types, and one pass per type (§2, §9.2). */
const CATEGORY = "issue";
const CONTENT_TYPES = ["Issue", "PullRequest", "IssueComment"];
// Search dates belong to parent threads, which can predate the comment author's account.
const BACKFILL_START = "1970-01-01T00:00:00Z";

/**
 * The signup transaction's inserts after the user row (§13): the subscription, its `issue`
 * category, the category's 3 types and 3 passes, its one backfill window, and the `sync` job.
 *
 * @param client Client inside the sign-in transaction.
 * @param identity The new user.
 * @param config Tunables for `enabled_at` and the pass watermarks.
 */
const insertSubscription = async (
  client: Queryable,
  identity: GitHubIdentity,
  config: Config,
): Promise<void> => {
  const { rows: subscriptions } = await client.query<{ id: string }>(
    "INSERT INTO subscriptions (user_id) VALUES ($1) RETURNING id",
    [identity.id],
  );
  const { rows: categories } = await client.query<{ id: string }>(
    `INSERT INTO subscription_categories
       (subscription_id, category, discovery_started_at, last_checked_at, last_find_at)
     VALUES ($1, $2, now(), now(), now())
     RETURNING id`,
    [subscriptions[0]?.id, CATEGORY],
  );
  const categoryId = categories[0]?.id;
  // FR-6: a reaction notifies only if it is newer than its type's enabled_at.
  await client.query(
    `INSERT INTO subscription_types (category_id, content_type, enabled_at)
     SELECT $1, t, now() - make_interval(secs => $2::double precision)
     FROM unnest($3::text[]) t`,
    [categoryId, config.clockMarginSeconds, CONTENT_TYPES],
  );
  await client.query(
    `INSERT INTO subscription_passes (category_id, pass, watermark)
     SELECT $1, p, now() - make_interval(secs => $2::double precision)
     FROM unnest($3::text[]) p`,
    [categoryId, config.searchOverlapSeconds, CONTENT_TYPES],
  );
  await client.query(
    `INSERT INTO backfill_windows (category_id, window_start, window_end)
     VALUES ($1, $2::timestamptz, now())`,
    [categoryId, BACKFILL_START],
  );
  await client.query("INSERT INTO jobs (kind, user_id) VALUES ('sync', $1)", [
    identity.id,
  ]);
};

/**
 * Inserts the user's `github_issue` channel and its rendered opening job, unless the user has
 * an active channel already (§11). The partial unique index makes a concurrent sign-in's
 * insert wait for this one and then do nothing, so only one inbox is ever opened.
 *
 * @param client Client inside the sign-in transaction.
 * @param identity The user.
 * @param siteUrl GRN's site, linked from the opening.
 * @returns Whether an opening was queued.
 */
const requestInbox = async (
  client: Queryable,
  identity: GitHubIdentity,
  siteUrl: string,
): Promise<boolean> => {
  const { rows } = await client.query(
    `INSERT INTO notification_channels (user_id, kind) VALUES ($1, 'github_issue')
     ON CONFLICT (user_id) WHERE kind = 'github_issue' AND disabled_at IS NULL DO NOTHING
     RETURNING id`,
    [identity.id],
  );
  if (rows.length === 0) {
    return false;
  }
  const jobId = randomUUID();
  await client.query(
    `INSERT INTO jobs (id, kind, user_id, payload) VALUES ($1, 'deliver', $2, $3)`,
    [jobId, identity.id, renderOpening(identity.login, jobId, siteUrl)],
  );
  return true;
};

/**
 * Stores a sign-in whose token passed FR-2a's scope check (§13). A new user gets the full
 * signup; a returning user gets the new token and login and is reactivated (FR-17). Either
 * way, the user's inbox is requested unless they have one.
 *
 * @param db Pool to run the sign-in transaction on.
 * @param identity The token's owner.
 * @param accessToken The no-scope token, stored encrypted (NFR-3).
 * @param options The cipher, the site's URL, and tunables.
 * @param options.cipher Encrypts the token.
 * @param options.siteUrl The site the opening comment links to.
 * @param options.config Tunables for the signup rows.
 * @returns Whether the user is new and whether an inbox opening was queued.
 */
export const signIn = async (
  db: Database,
  identity: GitHubIdentity,
  accessToken: string,
  { cipher, siteUrl, config = defaultConfig }: SignInOptions,
): Promise<{ isNew: boolean; inboxRequested: boolean }> => {
  const { tokenEnc, tokenNonce } = cipher.encrypt(accessToken, identity.id);
  return withTransaction(db, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO users (gh_user_id, login, gh_created_at, token_enc, token_nonce)
       VALUES ($1, $2, $3::timestamptz, $4, $5)
       ON CONFLICT (gh_user_id) DO NOTHING
       RETURNING gh_user_id`,
      [identity.id, identity.login, identity.createdAt, tokenEnc, tokenNonce],
    );
    const isNew = rows.length === 1;
    if (isNew) {
      await insertSubscription(client, identity, config);
    } else {
      // A returning sign-in does not recreate a deleted sync job (§12).
      await client.query(
        `UPDATE users SET login = $2, token_enc = $3, token_nonce = $4, token_status = 'active'
         WHERE gh_user_id = $1`,
        [identity.id, identity.login, tokenEnc, tokenNonce],
      );
    }
    const inboxRequested = await requestInbox(client, identity, siteUrl);
    return { isNew, inboxRequested };
  });
};

/** A user's decrypted token, with the ciphertext it was read from. */
export interface StoredToken {
  token: string;
  /** Identifies the stored token, so a later write can check it wasn't replaced meanwhile. */
  tokenEnc: string;
}

/**
 * Reads and decrypts a user's stored token (NFR-3). An undecryptable token sets
 * `token_status = 'invalid'`, which stops polling until the user signs in again.
 *
 * @param db Pool or client to run on.
 * @param userId The user's `gh_user_id`.
 * @param cipher The token cipher.
 * @returns The token, or `null` if the user is gone or their token is unreadable.
 */
export const loadToken = async (
  db: Queryable,
  userId: string,
  cipher: AccessTokenCipher,
): Promise<StoredToken | null> => {
  const { rows } = await db.query<{ token_enc: string; token_nonce: string }>(
    "SELECT token_enc, token_nonce FROM users WHERE gh_user_id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  try {
    const token = cipher.decrypt(
      { tokenEnc: row.token_enc, tokenNonce: row.token_nonce },
      userId,
    );
    return { token, tokenEnc: row.token_enc };
  } catch (error) {
    if (!(error instanceof TokenDecryptionError)) {
      throw error;
    }
    logger.error(`${error.message} (user: ${userId})`);
    // Compare-and-swap, so a sign-in that stored a new token meanwhile is not clobbered.
    await db.query(
      `UPDATE users SET token_status = 'invalid'
       WHERE gh_user_id = $1 AND token_enc = $2 AND token_nonce = $3`,
      [userId, row.token_enc, row.token_nonce],
    );
    return null;
  }
};

/**
 * Deletes the user and all data held about them (FR-3), including the global `content` and
 * `reaction_events` rows no other user still references. The inbox issue on GitHub stays, and
 * revoking the OAuth grant is up to the caller.
 *
 * The user's jobs go first: that waits for any transaction a worker has open on them, and
 * makes that worker lose its lease at its next commit (§7.3), so every row it wrote is seen.
 *
 * @param db Pool to run the deletion transaction on.
 * @param userId The user's `gh_user_id`.
 * @returns Whether the user existed.
 */
export const deleteAccount = async (
  db: Database,
  userId: string,
): Promise<boolean> =>
  withTransaction(db, async (client) => {
    await client.query("DELETE FROM jobs WHERE user_id = $1", [userId]);
    const { rows: users } = await client.query(
      "SELECT 1 FROM users WHERE gh_user_id = $1 FOR UPDATE",
      [userId],
    );
    if (users.length === 0) {
      return false;
    }
    const { rows } = await client.query<{ node_id: string }>(
      `SELECT node_id FROM tracked_content WHERE user_id = $1
       UNION SELECT node_id FROM content_sources WHERE user_id = $1
       UNION SELECT node_id FROM reaction_notifications WHERE user_id = $1`,
      [userId],
    );
    const nodeIds = rows.map((row) => row.node_id);

    // Cascades to every per-user table.
    await client.query("DELETE FROM users WHERE gh_user_id = $1", [userId]);

    // Separate statements: each must see the previous one's deletions.
    await client.query(
      `DELETE FROM reaction_events e
       WHERE e.node_id = ANY($1::text[])
         AND NOT EXISTS (SELECT 1 FROM tracked_content t WHERE t.node_id = e.node_id)
         AND NOT EXISTS (SELECT 1 FROM content_sources s WHERE s.node_id = e.node_id)
         AND NOT EXISTS (
           SELECT 1 FROM reaction_notifications n
           WHERE (n.node_id, n.reactor_id, n.emoji) = (e.node_id, e.reactor_id, e.emoji)
         )`,
      [nodeIds],
    );
    await client.query(
      `DELETE FROM content c
       WHERE c.node_id = ANY($1::text[])
         AND NOT EXISTS (SELECT 1 FROM tracked_content t WHERE t.node_id = c.node_id)
         AND NOT EXISTS (SELECT 1 FROM content_sources s WHERE s.node_id = c.node_id)
         AND NOT EXISTS (SELECT 1 FROM reaction_events e WHERE e.node_id = c.node_id)`,
      [nodeIds],
    );
    return true;
  });
