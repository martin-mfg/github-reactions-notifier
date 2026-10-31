import { randomBytes } from "node:crypto";

import { AccessTokenCipher, logger } from "@grn/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { withTransaction } from "../src/db.ts";
import type { Database } from "../src/db.ts";
import type { ContentType } from "../src/discovery/store.ts";
import { LeaseLostError, claimJob, withLease } from "../src/jobs/queue.ts";
import type { Lease } from "../src/jobs/queue.ts";
import { finishDigest, renderDigest } from "../src/pipeline/digest.ts";
import type { DigestRenderer } from "../src/pipeline/digest.ts";
import { fanOut } from "../src/pipeline/fanOut.ts";
import type { NewReaction } from "../src/pipeline/fanOut.ts";
import { signIn } from "../src/users/accounts.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

let testDb: TestDatabase;
let db: Database;

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = testDb.db;
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.reset();
  vi.restoreAllMocks();
  vi.spyOn(logger, "log").mockImplementation(() => undefined);
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  vi.spyOn(logger, "error").mockImplementation(() => undefined);
});

const cipher = new AccessTokenCipher([randomBytes(32)]);

/**
 * Signs a user up with an inbox, so their digests are due, and without the opening job.
 *
 * @param login The user's login; their id is `U_<login>`.
 */
const signUp = async (login: string) => {
  const id = `U_${login}`;
  await signIn(
    db,
    { id, login, createdAt: "2015-01-01T00:00:00Z" },
    `gho_${login}`,
    { cipher, siteUrl: "https://grn" },
  );
  await db.query(
    "UPDATE notification_channels SET target = 'grn-inbox/inbox#1' WHERE user_id = $1",
    [id],
  );
  await db.query("DELETE FROM jobs WHERE user_id = $1 AND kind = 'deliver'", [
    id,
  ]);
};

/**
 * Stores an item and makes it a source for the users' subscriptions.
 *
 * @param nodeId The item.
 * @param userIds The users it was found for.
 * @param type Its type.
 */
const source = async (
  nodeId: string,
  userIds: Array<string>,
  type: ContentType = "Issue",
) => {
  await db.query(
    `INSERT INTO content (node_id, type, repo_full_name, url, title)
     VALUES ($1, $2, 'octo/repo', 'https://github.com/octo/repo/issues/1', 'Bug')`,
    [nodeId, type],
  );
  await db.query(
    `INSERT INTO content_sources (user_id, node_id, subscription_id)
     SELECT user_id, $1, id FROM subscriptions WHERE user_id = ANY($2::text[])`,
    [nodeId, userIds],
  );
};

/**
 * Stores a reaction, as a poll does before its fan-out.
 *
 * @param nodeId The item.
 * @param reactor The reactor's login; their id is `U_<login>`.
 * @param emoji The emoji.
 * @param secondsAgo When, relative to now.
 * @returns The stored reaction.
 */
const react = async (
  nodeId: string,
  reactor: string,
  emoji = "THUMBS_UP",
  secondsAgo = 10,
): Promise<NewReaction> => {
  const { rows } = await db.query<NewReaction>(
    `INSERT INTO reaction_events (node_id, reactor_id, emoji, reacted_at, reactor_login)
     VALUES ($1, $2, $3, now() - make_interval(secs => $4), $5)
     RETURNING node_id, reactor_id, emoji, reacted_at, reactor_login`,
    [nodeId, `U_${reactor}`, emoji, secondsAgo, reactor],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("no reaction");
  }
  return row;
};

/**
 * Fans reactions out in a transaction of their own, as a poll does.
 *
 * @param reactions The new reactions.
 * @returns How many notifications were queued.
 */
const queue = (reactions: Array<NewReaction>) =>
  withTransaction(db, (client) => fanOut(client, reactions));

/** @returns A lease on the oldest digest, made due if it isn't, or `null` if there is none. */
const claimDigest = async (): Promise<Lease | null> => {
  await db.query(
    `UPDATE jobs SET run_at = now() - interval '1 minute'
     WHERE kind = 'deliver' AND run_at > now() - interval '1 minute'`,
  );
  return claimJob(db, "deliver");
};

/** @returns A lease on the oldest digest. */
const claim = async (): Promise<Lease> => {
  const lease = await claimDigest();
  if (!lease) {
    throw new Error("no digest");
  }
  return lease;
};

/** One line per reaction, oldest first. */
const renderer: DigestRenderer = (reactions) =>
  reactions
    .map((reaction) => `${reaction.reactorLogin} ${reaction.emoji}`)
    .join("\n");

const render = (lease: Lease) =>
  withLease(db, lease, (client) => renderDigest(client, lease, renderer));

const finish = (lease: Lease) =>
  withLease(db, lease, (client) => finishDigest(client, lease));

/**
 * Sends every digest, successors included, as the dispatcher will.
 *
 * @returns The bodies posted, in order.
 */
const drain = async (): Promise<Array<string>> => {
  const bodies: Array<string> = [];
  for (let round = 0; round < 10; round++) {
    const lease = await claimDigest();
    if (!lease) {
      return bodies;
    }
    const rendered = await render(lease);
    if (rendered) {
      bodies.push(rendered.body);
      await finish(lease);
    }
  }
  throw new Error("the digests never drained");
};

const digests = async () => {
  const { rows } = await db.query<{
    user_id: string;
    state: string;
    run_at: Date;
    due_in: number;
  }>(
    `SELECT user_id, payload->>'state' AS state, run_at,
            extract(epoch FROM run_at - now())::float8 AS due_in
     FROM jobs WHERE kind = 'deliver' AND payload->>'digest' = 'true'
     ORDER BY user_id`,
  );
  return rows;
};

const notifications = async () => {
  const { rows } = await db.query<{
    user_id: string;
    reactor_id: string;
    emoji: string;
    outcome: string;
  }>(
    `SELECT user_id, reactor_id, emoji, outcome FROM reaction_notifications
     ORDER BY user_id, reactor_id, emoji`,
  );
  return rows;
};

/** @returns The users with `queued` notifications that no open digest will send. */
const stranded = async () => {
  const { rows } = await db.query<{ user_id: string }>(
    `SELECT DISTINCT n.user_id FROM reaction_notifications n
     WHERE n.outcome = 'queued'
       AND NOT EXISTS (
         SELECT 1 FROM jobs j
         WHERE j.user_id = n.user_id AND j.kind = 'deliver'
           AND j.payload->>'digest' = 'true' AND j.payload->>'state' = 'open'
       )`,
  );
  return rows.map((row) => row.user_id);
};

describe("fanOut", () => {
  it("queues a reaction for every user with a source and opens their digests", async () => {
    await signUp("alice");
    await signUp("bob");
    await signUp("carol");
    await source("I_1", ["U_alice", "U_bob"]);

    expect(await queue([await react("I_1", "dave")])).toBe(2);

    expect(await notifications()).toEqual([
      {
        user_id: "U_alice",
        reactor_id: "U_dave",
        emoji: "THUMBS_UP",
        outcome: "queued",
      },
      {
        user_id: "U_bob",
        reactor_id: "U_dave",
        emoji: "THUMBS_UP",
        outcome: "queued",
      },
    ]);
    const open = await digests();
    expect(open.map((row) => [row.user_id, row.state])).toEqual([
      ["U_alice", "open"],
      ["U_bob", "open"],
    ]);
    for (const row of open) {
      expect(row.due_in).toBeGreaterThan(175);
      expect(row.due_in).toBeLessThanOrEqual(180);
    }
  });

  it("keeps the user's own reactions (FR-12)", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);

    expect(await queue([await react("I_1", "alice", "HEART")])).toBe(1);
    expect(await notifications()).toEqual([
      expect.objectContaining({ user_id: "U_alice", reactor_id: "U_alice" }),
    ]);
  });

  it("queues no reaction from before its type's enabled_at (FR-6)", async () => {
    await signUp("alice");
    await source("I_issue", ["U_alice"]);
    await source("I_pr", ["U_alice"], "PullRequest");
    await db.query(
      `UPDATE subscription_types SET enabled_at = now() - interval '1 hour'
       WHERE content_type = 'PullRequest'`,
    );

    const queued = await queue([
      // the Issue type was enabled 3 minutes ago
      await react("I_issue", "bob", "THUMBS_UP", 600),
      await react("I_issue", "carol", "THUMBS_UP", 60),
      await react("I_pr", "bob", "THUMBS_UP", 600),
      await react("I_pr", "carol", "THUMBS_UP", 7200),
    ]);

    expect(queued).toBe(2);
    expect((await notifications()).map((row) => row.reactor_id).sort()).toEqual(
      ["U_bob", "U_carol"],
    );
  });

  it("opens no digest if nothing was queued", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);

    expect(await queue([await react("I_1", "bob", "THUMBS_UP", 600)])).toBe(0);
    expect(await queue([])).toBe(0);
    expect(await digests()).toEqual([]);
  });

  it("queues a reaction once, also after it was delivered (FR-7)", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    const reaction = await react("I_1", "bob");

    expect(await queue([reaction])).toBe(1);
    expect(await queue([reaction, reaction])).toBe(0);
    expect(await drain()).toEqual(["bob THUMBS_UP"]);

    expect(await queue([reaction])).toBe(0);
    expect(await notifications()).toEqual([
      expect.objectContaining({ outcome: "delivered" }),
    ]);
    expect(await digests()).toEqual([]);
  });

  it("does not move an open digest's run_at", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    await queue([await react("I_1", "bob")]);
    await db.query(
      "UPDATE jobs SET run_at = now() + interval '30 seconds' WHERE kind = 'deliver'",
    );
    const [before] = await digests();

    await queue([await react("I_1", "carol")]);

    const after = await digests();
    expect(after).toHaveLength(1);
    expect(after[0]?.run_at).toEqual(before?.run_at);
  });
});

describe("renderDigest and finishDigest", () => {
  it("renders all queued reactions, oldest first, and finishes without a successor", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    await queue([
      await react("I_1", "bob", "HEART", 20),
      await react("I_1", "carol", "THUMBS_UP", 30),
    ]);
    const lease = await claim();

    expect(await render(lease)).toEqual({
      body: "carol THUMBS_UP\nbob HEART",
    });
    expect(await digests()).toEqual([
      expect.objectContaining({ state: "rendered" }),
    ]);
    expect((await notifications()).map((row) => row.outcome)).toEqual([
      "delivered",
      "delivered",
    ]);
    expect(logger.log).toHaveBeenCalledWith(
      "digest rendered",
      expect.objectContaining({
        job: lease.id,
        user: "U_alice",
        reactions: 2,
        waitSeconds: expect.closeTo(60, 0) as number,
      }),
    );

    expect(await finish(lease)).toBe(false);
    expect(await digests()).toEqual([]);
  });

  it("re-renders a retry as the same body, without the reactions queued since", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    await queue([await react("I_1", "bob")]);
    const lease = await claim();
    const first = await render(lease);

    await queue([await react("I_1", "carol")]);
    const retry = await render(lease);

    expect(retry).toEqual(first);
    expect(await notifications()).toEqual([
      expect.objectContaining({ reactor_id: "U_bob", outcome: "delivered" }),
      expect.objectContaining({ reactor_id: "U_carol", outcome: "queued" }),
    ]);
  });

  it("finishes a digest with nothing queued, without a post", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    await queue([await react("I_1", "bob")]);
    // as if delivered by an earlier digest
    await db.query("UPDATE reaction_notifications SET outcome = 'delivered'");
    const lease = await claim();

    expect(await render(lease)).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "digest: nothing queued, finished without a post",
      expect.objectContaining({ job: lease.id }),
    );
    expect(await digests()).toEqual([]);
  });

  it("throws LeaseLostError and changes nothing if the lease was lost", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    await queue([await react("I_1", "bob")]);
    const lease = await claim();
    const lost = { ...lease, lockedBy: "00000000-0000-0000-0000-000000000000" };

    await expect(renderDigest(db, lost, renderer)).rejects.toThrow(
      LeaseLostError,
    );
    await expect(finishDigest(db, lost)).rejects.toThrow(LeaseLostError);
    expect(await digests()).toEqual([
      expect.objectContaining({ state: "open" }),
    ]);
    expect(await notifications()).toEqual([
      expect.objectContaining({ outcome: "queued" }),
    ]);
  });
});

describe("a reaction queued while a digest is sent", () => {
  it("joins the digest if queued before it is rendered", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    await queue([await react("I_1", "bob", "THUMBS_UP", 20)]);
    const lease = await claim();

    await queue([await react("I_1", "carol")]);

    expect(await render(lease)).toEqual({
      body: "bob THUMBS_UP\ncarol THUMBS_UP",
    });
    expect(await finish(lease)).toBe(false);
    expect(await stranded()).toEqual([]);
    expect(await digests()).toEqual([]);
  });

  it("waits for a successor due 3 minutes after the predecessor's run_at if queued after rendering", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    await queue([await react("I_1", "bob")]);
    const lease = await claim();
    await render(lease);

    await queue([await react("I_1", "carol")]);
    // still the rendered digest, not delayed
    expect(await digests()).toEqual([
      expect.objectContaining({ state: "rendered", run_at: lease.runAt }),
    ]);
    expect(await finish(lease)).toBe(true);

    const [successor] = await digests();
    expect(successor).toMatchObject({ user_id: "U_alice", state: "open" });
    expect(successor?.run_at).toEqual(
      new Date(lease.runAt.getTime() + 180_000),
    );
    expect(await stranded()).toEqual([]);
    expect(await drain()).toEqual(["carol THUMBS_UP"]);
  });

  it("opens a new digest, due in 3 minutes, if queued after finishing", async () => {
    await signUp("alice");
    await source("I_1", ["U_alice"]);
    await queue([await react("I_1", "bob")]);
    const lease = await claim();
    await render(lease);
    await finish(lease);

    await queue([await react("I_1", "carol")]);

    const [next] = await digests();
    expect(next).toMatchObject({ state: "open" });
    expect(next?.due_in).toBeGreaterThan(175);
    expect(await stranded()).toEqual([]);
  });

  it.each([
    { step: "rendering", queueFirst: true },
    { step: "rendering", queueFirst: false },
    { step: "finishing", queueFirst: true },
    { step: "finishing", queueFirst: false },
  ])(
    "is delivered exactly once if queued concurrently with $step (queued first: $queueFirst)",
    async ({ step, queueFirst }) => {
      await signUp("alice");
      await signUp("bob");
      await source("I_1", ["U_alice", "U_bob"]);
      await queue([await react("I_1", "carol", "THUMBS_UP", 20)]);
      const lease = await claim();
      const bodies: Array<string> = [];
      if (step === "finishing") {
        const rendered = await render(lease);
        bodies.push(rendered?.body ?? "");
      }
      const late = await react("I_1", "dave");

      const send = async () => {
        if (step === "rendering") {
          const rendered = await render(lease);
          bodies.push(rendered?.body ?? "");
        }
        await finish(lease);
      };
      await (queueFirst
        ? Promise.all([queue([late]), send()])
        : Promise.all([send(), queue([late])]));

      expect(await stranded()).toEqual([]);
      bodies.push(...(await drain()));
      const lines = bodies.flatMap((body) => body.split("\n"));
      // two users, each told of each reaction once
      expect(lines.sort()).toEqual([
        "carol THUMBS_UP",
        "carol THUMBS_UP",
        "dave THUMBS_UP",
        "dave THUMBS_UP",
      ]);
      expect(
        (await notifications()).every((row) => row.outcome === "delivered"),
      ).toBe(true);
      expect(await digests()).toEqual([]);
    },
  );
});
