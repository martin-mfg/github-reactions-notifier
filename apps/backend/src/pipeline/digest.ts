import { logger } from "@grn/core";

import { defaultConfig } from "../config.ts";
import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";
import type { ContentType } from "../discovery/store.ts";
import { LeaseLostError } from "../jobs/queue.ts";
import type { Lease } from "../jobs/queue.ts";

/** A digest's `deliver` payload (§13). `body` is set once it is rendered. */
interface DigestPayload {
  digest: true;
  state: "open" | "rendered";
  body?: string;
}

const OPEN_DIGEST = JSON.stringify({ digest: true, state: "open" });

/** One reaction a digest reports, with the item it is on. */
interface DigestReaction {
  nodeId: string;
  type: ContentType;
  repoFullName: string;
  url: string;
  title: string;
  reactorId: string;
  reactorLogin: string;
  emoji: string;
  reactedAt: Date;
}

/**
 * Renders a digest's comment body.
 *
 * @param reactions The digest's reactions, oldest first; never empty.
 * @param jobId The digest's `deliver` job id, for the idempotency marker (§12).
 * @returns The comment's body.
 */
export type DigestRenderer = (
  reactions: Array<DigestReaction>,
  jobId: string,
) => string;

type DigestLease = Pick<Lease, "id" | "lockedBy">;

/**
 * Opens each user's digest, or locks it if one exists (§10). Runs in the same transaction as
 * the inserts of the users' `queued` rows. An existing digest, open or rendered, keeps its
 * `run_at`: later reactions join an open digest without delaying it, and wait in `queued` for
 * a rendered one's successor. The lock makes rendering or finishing that digest wait for this
 * transaction, so neither misses the `queued` rows.
 *
 * @param client Client inside the transaction that queued the users' notifications.
 * @param userIds The users with newly queued notifications.
 * @param config Tunable `digestWindowSeconds`.
 */
export const openDigests = async (
  client: Queryable,
  userIds: Array<string>,
  config: Config = defaultConfig,
): Promise<void> => {
  // one statement per user, in a fixed order, so concurrent fan-outs can't deadlock
  for (const userId of [...new Set(userIds)].sort()) {
    await client.query(
      `INSERT INTO jobs (kind, user_id, payload, run_at)
       VALUES ('deliver', $1, $2::jsonb, now() + make_interval(secs => $3::double precision))
       ON CONFLICT (user_id) WHERE kind = 'deliver' AND payload->>'digest' = 'true'
       DO UPDATE SET run_at = jobs.run_at`,
      [userId, OPEN_DIGEST, config.digestWindowSeconds],
    );
  }
};

/**
 * Deletes the posted digest and, if its user has `queued` notifications, opens its successor,
 * due `digestWindowSeconds` after the posted digest's `run_at` (§10).
 *
 * Unlike §10's single statement, the successor's check is a statement of its own. One
 * statement reads with one snapshot: if it is the transaction's first to wait for a fan-out
 * that locked the digest, its snapshot predates that fan-out's `queued` rows and no successor
 * opens for them. `withLease`'s renewal takes the lock first anyway; the split keeps this
 * correct without it.
 *
 * @param client Client inside the job's last, fenced transaction.
 * @param lease The digest's lease.
 * @param config Tunable `digestWindowSeconds`.
 * @returns Whether a successor was opened.
 * @throws {LeaseLostError} If the lease was lost.
 */
export const finishDigest = async (
  client: Queryable,
  lease: DigestLease,
  config: Config = defaultConfig,
): Promise<boolean> => {
  const { rows: deleted } = await client.query<{
    user_id: string;
    run_at: Date;
  }>(
    "DELETE FROM jobs WHERE id = $1 AND locked_by = $2 RETURNING user_id, run_at",
    [lease.id, lease.lockedBy],
  );
  const digest = deleted[0];
  if (!digest) {
    throw new LeaseLostError(lease);
  }
  const { rows } = await client.query(
    `INSERT INTO jobs (kind, user_id, payload, run_at)
     SELECT 'deliver', $1, $2::jsonb,
            $3::timestamptz + make_interval(secs => $4::double precision)
     WHERE EXISTS (
       SELECT 1 FROM reaction_notifications WHERE user_id = $1 AND outcome = 'queued'
     )
     RETURNING id`,
    [digest.user_id, OPEN_DIGEST, digest.run_at, config.digestWindowSeconds],
  );
  return rows.length === 1;
};

/**
 * Renders the leased digest before its first attempt (§10): marks it rendered, marks all of
 * its user's `queued` notifications `delivered`, and stores the body. A digest rendered
 * before keeps its body, so a retry re-posts the same comment. Logs the batch's wait, from
 * `run_at` to rendering (§12).
 *
 * A digest with nothing queued is finished instead, without a post.
 *
 * Each statement reads afresh (READ COMMITTED) after the first one has locked the job: a
 * fan-out that locked the digest first has committed its `queued` rows by then.
 *
 * @param client Client inside the job's fenced transaction.
 * @param lease The digest's lease.
 * @param render Renders the body.
 * @param config Tunable `digestWindowSeconds`, for finishing an empty digest.
 * @returns The body to post, or `null` if there is nothing to post.
 * @throws {LeaseLostError} If the lease was lost.
 */
export const renderDigest = async (
  client: Queryable,
  lease: DigestLease,
  render: DigestRenderer,
  config: Config = defaultConfig,
): Promise<{ body: string } | null> => {
  const { rows: jobs } = await client.query<{
    user_id: string;
    payload: DigestPayload;
    wait_seconds: number;
  }>(
    `SELECT user_id, payload, extract(epoch FROM now() - run_at)::float8 AS wait_seconds
     FROM jobs WHERE id = $1 AND locked_by = $2
     FOR UPDATE`,
    [lease.id, lease.lockedBy],
  );
  const job = jobs[0];
  if (!job) {
    throw new LeaseLostError(lease);
  }
  if (job.payload.state === "rendered" && job.payload.body !== undefined) {
    return { body: job.payload.body };
  }

  const { rows } = await client.query<{
    node_id: string;
    type: ContentType;
    repo_full_name: string;
    url: string;
    title: string;
    reactor_id: string;
    reactor_login: string;
    emoji: string;
    reacted_at: Date;
  }>(
    `WITH n AS (
       UPDATE reaction_notifications SET outcome = 'delivered'
       WHERE user_id = $1 AND outcome = 'queued'
       RETURNING node_id, reactor_id, emoji
     )
     SELECT n.node_id, c.type, c.repo_full_name, c.url, c.title,
            n.reactor_id, e.reactor_login, n.emoji, e.reacted_at
     FROM n
     JOIN reaction_events e USING (node_id, reactor_id, emoji)
     JOIN content c ON c.node_id = n.node_id
     ORDER BY e.reacted_at, n.node_id, n.emoji, n.reactor_id`,
    [job.user_id],
  );
  const context = { job: lease.id, user: job.user_id, kind: "deliver" };
  if (rows.length === 0) {
    logger.warn("digest: nothing queued, finished without a post", context);
    await finishDigest(client, lease, config);
    return null;
  }

  const body = render(
    rows.map((row) => ({
      nodeId: row.node_id,
      type: row.type,
      repoFullName: row.repo_full_name,
      url: row.url,
      title: row.title,
      reactorId: row.reactor_id,
      reactorLogin: row.reactor_login,
      emoji: row.emoji,
      reactedAt: row.reacted_at,
    })),
    lease.id,
  );
  await client.query(
    `UPDATE jobs
     SET payload = payload || jsonb_build_object('state', 'rendered', 'body', $2::text)
     WHERE id = $1`,
    [lease.id, body],
  );
  logger.log("digest rendered", {
    ...context,
    reactions: rows.length,
    waitSeconds: job.wait_seconds,
  });
  return { body };
};
