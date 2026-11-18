import { randomUUID } from "node:crypto";

import { TokenDecryptionError, logger } from "@grn/core";
import type { AccessTokenCipher } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import { withTransaction } from "../db.ts";
import type { Database, Queryable } from "../db.ts";
import { renderOpening } from "../inbox/opening.ts";
import { lockSyncAndUser } from "../jobs/queue.ts";
import { isSubscriptionComplete } from "../summary/summary.ts";

import type { UserMode } from "./mode.ts";

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
  /**
   * The mode the button the user chose asks for (M1.2 §3): `notify` for "Get notified about
   * reactions", `summary` for "Get a one-time summary".
   */
  mode?: UserMode;
  config?: Config;
}

/** What a sign-in did, as the site reports it (M1.2 §3, §8.4). */
export type SignInStatus =
  | "signed-in"
  | "summary-requested"
  | "summary-pending"
  | "summary-again"
  | "notifications-on"
  | "notifications-on-summary-pending"
  | "notifications-off"
  | "notifications-off-summary-pending";

/** The outcome of {@link signIn}. */
interface SignInResult {
  isNew: boolean;
  inboxRequested: boolean;
  status: SignInStatus;
  /** The user's inbox issue, `owner/repo#number`, or `null` while it isn't open. */
  inbox: string | null;
}

/** M1's one category of the `authored` source, its types, and one pass per type (§2, §9.2). */
const CATEGORY = "issue";
const CONTENT_TYPES = ["Issue", "PullRequest", "IssueComment"];
// Search dates belong to parent threads, which can predate the comment author's account.
const BACKFILL_START = "1970-01-01T00:00:00Z";

/**
 * The signup transaction's inserts after the user row (§13): the subscription, its `issue`
 * category, the category's 3 types and 3 passes, its one backfill window, and the `sync` job.
 * They are the same in either mode (M1.2 §3).
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
 * @param mode The user's mode, which the opening is worded for (M1.2 §8.1).
 * @returns Whether an opening was queued.
 */
const requestInbox = async (
  client: Queryable,
  identity: GitHubIdentity,
  siteUrl: string,
  mode: UserMode,
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
    [jobId, identity.id, renderOpening(identity.login, jobId, siteUrl, mode)],
  );
  return true;
};

/**
 * @param client Client inside the sign-in transaction.
 * @param userId The user.
 * @returns Whether every one of the user's subscriptions is complete (M1.1 §3): its summary
 *   has been queued.
 */
const isUserComplete = async (
  client: Queryable,
  userId: string,
): Promise<boolean> => {
  const { rows } = await client.query<{ id: string }>(
    "SELECT id FROM subscriptions WHERE user_id = $1",
    [userId],
  );
  for (const { id } of rows) {
    if (
      !(await isSubscriptionComplete(client, { userId, subscriptionId: id }))
    ) {
      return false;
    }
  }
  return true;
};

/** The user's categories, for statements that touch each of them. `$1` is the user. */
const USER_CATEGORIES = `
  SELECT c.id FROM subscription_categories c
  JOIN subscriptions s ON s.id = c.subscription_id
  WHERE s.user_id = $1`;

/**
 * The rescan (M1.2 §6, steps 3, 5 and 6): restarts every category's backfill over all history
 * up to now, makes every snapshot pending again, and makes the `sync` job due now, recreating
 * it if it is gone. The subscription is incomplete again, so its next completion queues a
 * fresh summary.
 *
 * @param client Client inside the sign-in transaction, holding the locks of M1.2 §7.
 * @param userId The user.
 */
const rescan = async (client: Queryable, userId: string): Promise<void> => {
  // A running page that read the old window_end leaves the reset window alone (backfill.ts).
  await client.query(
    `INSERT INTO backfill_windows (category_id, window_start, window_end)
     SELECT id, $2::timestamptz, now() FROM (${USER_CATEGORIES}) AS c
     ON CONFLICT (category_id, window_start) DO UPDATE SET window_end = now()`,
    [userId, BACKFILL_START],
  );
  await client.query(
    `UPDATE reaction_snapshots r
     SET thumbs_up = NULL, thumbs_down = NULL, laugh = NULL, hooray = NULL,
         confused = NULL, heart = NULL, rocket = NULL, eyes = NULL, retry_at = now()
     WHERE r.user_id = $1
       AND EXISTS (SELECT 1 FROM content_sources cs
                   WHERE cs.user_id = r.user_id AND cs.node_id = r.node_id)`,
    [userId],
  );
  await client.query(
    `INSERT INTO jobs (kind, user_id) VALUES ('sync', $1)
     ON CONFLICT (user_id) WHERE kind = 'sync' DO UPDATE SET run_at = now()`,
    [userId],
  );
};

/**
 * Turns notifications on (M1.2 §6): `notify` mode, FR-6's cutoff re-stamped to
 * `now − CLOCK_MARGIN`, the pass watermarks reset as at signup, and the rescan.
 *
 * @param client Client inside the sign-in transaction, holding the locks of M1.2 §7.
 * @param userId The user.
 * @param config Tunables `clockMarginSeconds` and `searchOverlapSeconds`.
 */
const turnNotificationsOn = async (
  client: Queryable,
  userId: string,
  config: Config,
): Promise<void> => {
  await client.query("UPDATE users SET mode = 'notify' WHERE gh_user_id = $1", [
    userId,
  ]);
  // Fan-out tests each reaction against the current enabled_at, so reactions from the pause
  // (but its last CLOCK_MARGIN) never notify. The watermarks only save the drill-downs.
  await client.query(
    `UPDATE subscription_types
     SET enabled_at = now() - make_interval(secs => $2::double precision)
     WHERE category_id IN (${USER_CATEGORIES})`,
    [userId, config.clockMarginSeconds],
  );
  await client.query(
    `UPDATE tracked_content
     SET watermark_at = greatest(
           watermark_at, now() - make_interval(secs => $2::double precision)),
         last_checked_at = now()
     WHERE user_id = $1`,
    [userId, config.clockMarginSeconds],
  );
  // No pass ran in summary mode: walking the whole gap would overflow (§9.2).
  await client.query(
    `UPDATE subscription_passes
     SET watermark = now() - make_interval(secs => $2::double precision)
     WHERE category_id IN (${USER_CATEGORIES})`,
    [userId, config.searchOverlapSeconds],
  );
  await rescan(client, userId);
};

/**
 * Turns notifications off (M1.2 §5): `summary` mode, the `sync` job deleted if the summary was
 * queued already (else the summary deletes it, §4.2), and the user's pending notifications
 * dropped: the digest job first, then the `queued` rows, in `renderDigest`'s lock order. A
 * worker holding a deleted job's lease loses it at its next fenced transaction.
 *
 * @param client Client inside the sign-in transaction, holding the locks of M1.2 §7.
 * @param userId The user.
 * @param complete Whether the user's summary was queued already.
 */
const turnNotificationsOff = async (
  client: Queryable,
  userId: string,
  complete: boolean,
): Promise<void> => {
  await client.query(
    "UPDATE users SET mode = 'summary' WHERE gh_user_id = $1",
    [userId],
  );
  if (complete) {
    await client.query(
      "DELETE FROM jobs WHERE user_id = $1 AND kind = 'sync'",
      [userId],
    );
  }
  await client.query(
    `DELETE FROM jobs
     WHERE user_id = $1 AND kind = 'deliver' AND payload->>'digest' = 'true'`,
    [userId],
  );
  await client.query(
    "DELETE FROM reaction_notifications WHERE user_id = $1 AND outcome = 'queued'",
    [userId],
  );
};

/**
 * Applies a returning user's choice of button to their current mode (M1.2 §3's table).
 *
 * @param client Client inside the sign-in transaction, holding the locks of M1.2 §7.
 * @param userId The user.
 * @param current The user's mode before this sign-in.
 * @param target The mode the chosen button asks for.
 * @param config Tunables for turning notifications on.
 * @returns The sign-in's status.
 */
const switchMode = async (
  client: Queryable,
  userId: string,
  current: UserMode,
  target: UserMode,
  config: Config,
): Promise<SignInStatus> => {
  if (current === "notify" && target === "notify") {
    return "signed-in";
  }
  const complete = await isUserComplete(client, userId);
  if (target === "notify") {
    await turnNotificationsOn(client, userId, config);
    return complete ? "notifications-on" : "notifications-on-summary-pending";
  }
  if (current === "notify") {
    await turnNotificationsOff(client, userId, complete);
    return complete ? "notifications-off" : "notifications-off-summary-pending";
  }
  // summary → summary: a fresh summary once the first is queued (§6.1), else the running scan
  // posts it
  if (!complete) {
    return "summary-pending";
  }
  await rescan(client, userId);
  return "summary-again";
};

/**
 * Stores a sign-in whose token passed FR-2a's scope check (§13). A new user gets the full
 * signup, in the chosen mode. A returning user gets the new token and login and is
 * reactivated (FR-17), and their mode is switched as the chosen button asks (M1.2 §3). Either
 * way, the user's inbox is requested unless they have one.
 *
 * A returning user's `sync` job row and `users` row are locked first, in that order (M1.2 §7),
 * so the sign-in and the user's running task take turns.
 *
 * @param db Pool to run the sign-in transaction on.
 * @param identity The token's owner.
 * @param accessToken The no-scope token, stored encrypted (NFR-3).
 * @param options The cipher, the site's URL, the chosen mode, and tunables.
 * @param options.cipher Encrypts the token.
 * @param options.siteUrl The site the opening comment links to.
 * @param options.mode The mode the chosen button asks for; `notify` by default.
 * @param options.config Tunables for the signup rows.
 * @returns Whether the user is new, whether an inbox opening was queued, the status to show,
 *   and the user's inbox issue if it is open.
 */
export const signIn = async (
  db: Database,
  identity: GitHubIdentity,
  accessToken: string,
  { cipher, siteUrl, mode = "notify", config = defaultConfig }: SignInOptions,
): Promise<SignInResult> => {
  const tokenEnc = cipher.encrypt(accessToken, identity.id);
  return withTransaction(db, async (client) => {
    // M1.2 §7: the sync job row, then the users row. A new user has neither yet.
    let current = await lockSyncAndUser(client, identity.id);
    let isNew = false;
    if (current === null) {
      const { rows } = await client.query(
        `INSERT INTO users (gh_user_id, login, gh_created_at, token_enc, mode)
         VALUES ($1, $2, $3::timestamptz, $4, $5)
         ON CONFLICT (gh_user_id) DO NOTHING
         RETURNING gh_user_id`,
        [identity.id, identity.login, identity.createdAt, tokenEnc, mode],
      );
      isNew = rows.length === 1;
      if (!isNew) {
        // A concurrent first sign-in committed meanwhile: continue as a returning user.
        current = await lockSyncAndUser(client, identity.id);
      }
    }
    let status: SignInStatus;
    if (isNew) {
      await insertSubscription(client, identity, config);
      status = mode === "summary" ? "summary-requested" : "signed-in";
    } else {
      if (current === null) {
        throw new Error(`User ${identity.id} was deleted during their sign-in`);
      }
      await client.query(
        `UPDATE users SET login = $2, token_enc = $3, token_status = 'active'
         WHERE gh_user_id = $1`,
        [identity.id, identity.login, tokenEnc],
      );
      // every transition ends in the mode the button asks for
      status = await switchMode(client, identity.id, current, mode, config);
    }
    const inboxRequested = await requestInbox(client, identity, siteUrl, mode);
    const { rows: channels } = await client.query<{ target: string | null }>(
      `SELECT target FROM notification_channels
       WHERE user_id = $1 AND kind = 'github_issue' AND disabled_at IS NULL`,
      [identity.id],
    );
    return {
      isNew,
      inboxRequested,
      status,
      inbox: channels[0]?.target ?? null,
    };
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
  const { rows } = await db.query<{ token_enc: string }>(
    "SELECT token_enc FROM users WHERE gh_user_id = $1",
    [userId],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }
  try {
    const token = cipher.decrypt(row.token_enc, userId);
    return { token, tokenEnc: row.token_enc };
  } catch (error) {
    if (!(error instanceof TokenDecryptionError)) {
      throw error;
    }
    logger.error(`${error.message} (user: ${userId})`);
    // Compare-and-swap, so a sign-in that stored a new token meanwhile is not clobbered.
    await db.query(
      `UPDATE users SET token_status = 'invalid'
       WHERE gh_user_id = $1 AND token_enc = $2`,
      [userId, row.token_enc],
    );
    return null;
  }
};

/**
 * Deletes the user and all data held about them (FR-3), including the global `content` and
 * `reaction_events` rows no other user still references. The inbox issue on GitHub stays, and
 * revoking the OAuth grant is up to the caller.
 *
 * The user's `sync` job row and `users` row are locked first, in that order (M1.2 §7), and
 * then all their jobs are deleted. That waits for any transaction a worker has open on them,
 * and makes that worker lose its lease at its next commit (§7.3), so every row it wrote is
 * seen.
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
    if ((await lockSyncAndUser(client, userId)) === null) {
      return false;
    }
    await client.query("DELETE FROM jobs WHERE user_id = $1", [userId]);
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
