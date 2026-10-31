import { randomBytes } from "node:crypto";

import { AccessTokenCipher, logger } from "@grn/core";
import type { GitHubOutcome, MutationRequest } from "@grn/core";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { defaultConfig } from "../src/config.ts";
import { withTransaction } from "../src/db.ts";
import type { Database } from "../src/db.ts";
import { machineAccountFromEnv, runDeliver } from "../src/inbox/dispatcher.ts";
import type { MachineAccount } from "../src/inbox/dispatcher.ts";
import { claimJob, reapExpiredLeases } from "../src/jobs/queue.ts";
import type { Lease } from "../src/jobs/queue.ts";
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
const machine: MachineAccount = {
  token: "ghp_machine",
  inboxRepo: "grn-inbox/inbox",
};

/** A fake GitHub: records every request and answers with `reply`. */
const fakeGitHub = (reply: (request: MutationRequest) => unknown) => {
  const requests: Array<MutationRequest> = [];
  const send = <T>(request: MutationRequest): Promise<GitHubOutcome<T>> => {
    requests.push(request);
    return Promise.resolve(reply(request) as GitHubOutcome<T>);
  };
  return { requests, send };
};

const details = (status: number | null, message = "") => ({
  status,
  errorTypes: [],
  message,
  rateLimit: null,
});

const ok = (data: unknown) => ({
  kind: "ok",
  data,
  errors: [],
  details: details(201),
});

const failed = (status: number | null, timedOut = false) => ({
  kind: "failed",
  timedOut,
  details: details(status),
});

const rateLimited = (
  retryAfterSeconds: number | null,
  resetAt: Date | null = null,
) => ({
  kind: "rate-limited",
  retryAfterSeconds,
  resetAt,
  details: details(403, "You have exceeded a secondary rate limit"),
});

/**
 * Signs a user up, as the sign-in does: a `sync` job and the job opening their inbox.
 *
 * @param login The user's login; their id is `U_<login>`.
 * @param target Their inbox issue, if it is open; then the opening job is deleted.
 * @returns The user's id.
 */
const signUp = async (
  login: string,
  target: string | null = null,
): Promise<string> => {
  const id = `U_${login}`;
  await signIn(
    db,
    { id, login, createdAt: "2015-01-01T00:00:00Z" },
    `gho_${login}`,
    { cipher, siteUrl: "https://grn" },
  );
  if (target !== null) {
    await db.query(
      "UPDATE notification_channels SET target = $2 WHERE user_id = $1",
      [id, target],
    );
    await db.query("DELETE FROM jobs WHERE user_id = $1 AND kind = 'deliver'", [
      id,
    ]);
  }
  return id;
};

/**
 * @param userId The recipient.
 * @returns The id of a due one-off `deliver` job, its marker in its body.
 */
const insertNotice = async (userId: string): Promise<string> => {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO jobs (kind, user_id, run_at) VALUES ('deliver', $1, now() - interval '1 minute')
     RETURNING id`,
    [userId],
  );
  const id = rows[0]?.id ?? "";
  await db.query("UPDATE jobs SET payload = $2 WHERE id = $1", [
    id,
    { body: `Notice\n\n<!-- grn:${id} -->` },
  ]);
  return id;
};

/** Fills the bucket and makes every `deliver` job due, as time would. */
const advance = async () => {
  await db.query(
    "UPDATE dispatch_bucket SET level = 10, level_at = now() - interval '1 hour'",
  );
  await db.query(
    "UPDATE jobs SET run_at = now() - interval '1 minute' WHERE kind = 'deliver'",
  );
};

const claim = async (): Promise<Lease> => {
  const lease = await claimJob(db, "deliver");
  if (!lease) {
    throw new Error("no due deliver job");
  }
  return lease;
};

const deliver = (lease: Lease, send: ReturnType<typeof fakeGitHub>["send"]) =>
  runDeliver({ db, lease, machine, send });

const job = async (id: string) => {
  const { rows } = await db.query<{
    locked_by: string | null;
    attempts: number;
    run_in: number;
    attempted_at: number | null;
  }>(
    `SELECT locked_by, attempts,
            extract(epoch FROM run_at - now())::float8 AS run_in,
            (payload->>'attempted_at')::float8 AS attempted_at
     FROM jobs WHERE id = $1`,
    [id],
  );
  return rows[0];
};

const jobKinds = async (userId: string) => {
  const { rows } = await db.query<{ kind: string }>(
    "SELECT kind FROM jobs WHERE user_id = $1 ORDER BY kind",
    [userId],
  );
  return rows.map((row) => row.kind);
};

const target = async (userId: string) => {
  const { rows } = await db.query<{ target: string | null }>(
    "SELECT target FROM notification_channels WHERE user_id = $1",
    [userId],
  );
  return rows[0]?.target;
};

/** @returns Seconds until the dispatcher may post again, negative if it may now. */
const pausedFor = async () => {
  const { rows } = await db.query<{ paused_for: number; level: number }>(
    `SELECT extract(epoch FROM level_at - now())::float8 AS paused_for, level
     FROM dispatch_bucket`,
  );
  return rows[0];
};

describe("runDeliver: opening", () => {
  it("opens the inbox issue and points the channel at it", async () => {
    const user = await signUp("alice");
    const github = fakeGitHub(() => ok({ number: 42 }));
    const lease = await claim();

    expect(await deliver(lease, github.send)).toBe("posted");

    expect(github.requests).toHaveLength(1);
    const [request] = github.requests;
    expect(request).toMatchObject({
      method: "POST",
      path: "/repos/grn-inbox/inbox/issues",
      token: "ghp_machine",
      body: { title: "Reactions inbox of alice" },
    });
    expect(JSON.stringify(request?.body)).toContain(`grn:${lease.id}`);
    expect(await target(user)).toBe("grn-inbox/inbox#42");
    expect(await jobKinds(user)).toEqual(["sync"]);
    const bucket = await pausedFor();
    expect(bucket?.level).toBeCloseTo(9, 0);
    expect(bucket?.paused_for).toBeCloseTo(0, 0);
  });

  it("drops an opening whose inbox is already open", async () => {
    const user = await signUp("alice");
    await db.query(
      "UPDATE notification_channels SET target = 'grn-inbox/inbox#1' WHERE user_id = $1",
      [user],
    );
    const github = fakeGitHub(() => ok({ number: 2 }));

    expect(await deliver(await claim(), github.send)).toBe("skipped");

    expect(github.requests).toHaveLength(0);
    expect(await jobKinds(user)).toEqual(["sync"]);
    expect(await target(user)).toBe("grn-inbox/inbox#1");
  });

  it("finds an issue opened by an attempt whose response had no number", async () => {
    const user = await signUp("alice");
    let created: unknown = null;
    const github = fakeGitHub((request) => {
      if (request.method === "POST") {
        created = { number: 42, body: (request.body as { body: string }).body };
        return ok({});
      }
      return ok([{ number: 43, body: "other" }, created]);
    });
    const lease = await claim();

    expect(await deliver(lease, github.send)).toBe("retrying");
    expect(await target(user)).toBeNull();
    await advance();
    expect(await deliver(await claim(), github.send)).toBe("found");

    expect(github.requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
    ]);
    expect(github.requests[1]?.path).toBe(
      "/repos/grn-inbox/inbox/issues?state=all&sort=created&direction=desc&per_page=100",
    );
    expect(await target(user)).toBe("grn-inbox/inbox#42");
    expect(await jobKinds(user)).toEqual(["sync"]);
  });
});

describe("runDeliver: comments", () => {
  it("posts a one-off as a comment on the inbox issue", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    const id = await insertNotice(user);
    const github = fakeGitHub(() => ok({ id: 1 }));

    expect(await deliver(await claim(), github.send)).toBe("posted");

    expect(github.requests).toEqual([
      {
        method: "POST",
        path: "/repos/grn-inbox/inbox/issues/7/comments",
        token: "ghp_machine",
        body: { body: `Notice\n\n<!-- grn:${id} -->` },
        timeoutMs: defaultConfig.requestTimeoutSeconds * 1000,
      },
    ]);
    expect(await job(id)).toBeUndefined();
  });

  it("renders and posts a digest, then finishes it", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    await db.query(
      `INSERT INTO content (node_id, type, repo_full_name, url, title)
       VALUES ('I_1', 'Issue', 'octo/repo', 'https://github.com/octo/repo/issues/1', 'Bug @here')`,
    );
    await db.query(
      `INSERT INTO content_sources (user_id, node_id, subscription_id)
       SELECT user_id, 'I_1', id FROM subscriptions WHERE user_id = $1`,
      [user],
    );
    const { rows: reactions } = await db.query<NewReaction>(
      `INSERT INTO reaction_events (node_id, reactor_id, emoji, reacted_at, reactor_login)
       VALUES ('I_1', 'U_bob', 'HEART', now() - interval '10 seconds', 'bob')
       RETURNING node_id, reactor_id, emoji, reacted_at, reactor_login`,
    );
    await withTransaction(db, (client) => fanOut(client, reactions));
    await advance();
    const github = fakeGitHub(() => ok({ id: 1 }));
    const lease = await claim();

    expect(await deliver(lease, github.send)).toBe("posted");

    const body = (github.requests[0]?.body as { body: string }).body;
    expect(body).toContain("1 new ❤️ on your issue [Bug \\@\u200Bhere]");
    expect(body).toContain("[@\u200Bbob](https://github.com/bob)");
    expect(body).toContain(`<!-- grn:${lease.id} -->`);
    expect(await jobKinds(user)).toEqual(["sync"]);
    const { rows } = await db.query<{ outcome: string }>(
      "SELECT outcome FROM reaction_notifications",
    );
    expect(rows).toEqual([{ outcome: "delivered" }]);
  });

  it("waits, untouched, when the bucket has no token", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    const id = await insertNotice(user);
    const lease = await claim();
    await db.query("UPDATE dispatch_bucket SET level = 0, level_at = now()");
    const github = fakeGitHub(() => ok({ id: 1 }));

    expect(await deliver(lease, github.send)).toBe("waiting");

    expect(github.requests).toHaveLength(0);
    expect(await job(id)).toMatchObject({
      locked_by: null,
      attempted_at: null,
    });
  });
});

describe("runDeliver: ambiguous attempts never post twice", () => {
  it("finds the comment of an attempt that timed out after it landed", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    const id = await insertNotice(user);
    const posted: Array<unknown> = [];
    const github = fakeGitHub((request) => {
      if (request.method === "POST") {
        posted.push(request.body);
        return failed(null, true);
      }
      return ok([{ body: "earlier" }, ...posted]);
    });

    expect(await deliver(await claim(), github.send)).toBe("retrying");
    const first = await job(id);
    expect(first?.attempted_at).toEqual(expect.any(Number));
    await advance();
    expect(await deliver(await claim(), github.send)).toBe("found");

    expect(posted).toHaveLength(1);
    const check = github.requests[1];
    expect(check?.method).toBe("GET");
    const since = new Date(
      ((first?.attempted_at ?? 0) - defaultConfig.clockMarginSeconds) * 1000,
    ).toISOString();
    expect(check?.path).toBe(
      `/repos/grn-inbox/inbox/issues/7/comments?since=${since}&per_page=100`,
    );
    expect(await job(id)).toBeUndefined();
  });

  it("finds the comment of an attempt whose lease the reaper rescued", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    const id = await insertNotice(user);
    const posted: Array<unknown> = [];
    const crash = fakeGitHub((request) => {
      posted.push(request.body);
      throw new Error("worker died");
    });
    await expect(deliver(await claim(), crash.send)).rejects.toThrow(
      "worker died",
    );
    await db.query(
      "UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = $1",
      [id],
    );
    expect(await reapExpiredLeases(db)).toHaveLength(1);
    await advance();
    const github = fakeGitHub(() => ok(posted));

    expect(await deliver(await claim(), github.send)).toBe("found");

    expect(posted).toHaveLength(1);
    expect(github.requests.map((request) => request.method)).toEqual(["GET"]);
    expect(await job(id)).toBeUndefined();
  });

  it("posts again if the earlier attempt didn't land", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    const id = await insertNotice(user);
    let failing = true;
    const github = fakeGitHub((request) => {
      if (request.method === "GET") {
        return ok([{ body: "unrelated" }]);
      }
      return failing ? failed(502) : ok({ id: 1 });
    });
    expect(await deliver(await claim(), github.send)).toBe("retrying");
    const first = await job(id);
    failing = false;
    await advance();

    expect(await deliver(await claim(), github.send)).toBe("posted");

    expect(github.requests.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "POST",
    ]);
    expect(first?.attempted_at).toEqual(expect.any(Number));
    expect(await job(id)).toBeUndefined();
  });
});

describe("runDeliver: failures", () => {
  it("backs off a transient failure, and alerts", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    const id = await insertNotice(user);
    const github = fakeGitHub((request) =>
      request.method === "GET" ? ok([]) : failed(502),
    );

    expect(await deliver(await claim(), github.send)).toBe("retrying");
    const first = await job(id);
    expect(first?.locked_by).toBeNull();
    expect(first?.attempts).toBe(1);
    expect(first?.run_in).toBeCloseTo(60, 0);
    expect(logger.error).toHaveBeenCalledWith(
      "ALERT: delivery failed",
      expect.objectContaining({ job: id, attempts: 1 }),
    );

    await advance();
    expect(await deliver(await claim(), github.send)).toBe("retrying");
    expect((await job(id))?.run_in).toBeCloseTo(120, 0);
  });

  it("pauses every delivery on a rate limit, keeping the job's run_at", async () => {
    const alice = await signUp("alice", "grn-inbox/inbox#7");
    const bob = await signUp("bob", "grn-inbox/inbox#8");
    const id = await insertNotice(alice);
    await insertNotice(bob);
    await db.query(
      "UPDATE jobs SET run_at = now() - interval '2 minutes' WHERE id = $1",
      [id],
    );
    const github = fakeGitHub(() => rateLimited(120));

    expect(await deliver(await claim(), github.send)).toBe("retrying");

    expect((await pausedFor())?.paused_for).toBeCloseTo(120, 0);
    expect((await job(id))?.run_in).toBeCloseTo(-120, 0);
    expect(await claimJob(db, "deliver")).toBeNull();
  });

  it("pauses until the reset plus the clock margin", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    await insertNotice(user);
    const resetAt = new Date(Date.now() + 600_000);
    const github = fakeGitHub(() => rateLimited(null, resetAt));

    expect(await deliver(await claim(), github.send)).toBe("retrying");

    expect((await pausedFor())?.paused_for).toBeCloseTo(
      600 + defaultConfig.clockMarginSeconds,
      0,
    );
  });

  it("pauses for the backoff when a rate limit names no wait", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    await insertNotice(user);
    const github = fakeGitHub(() => rateLimited(null));

    expect(await deliver(await claim(), github.send)).toBe("retrying");

    expect((await pausedFor())?.paused_for).toBeCloseTo(60, 0);
  });

  it("deletes all of the user's jobs on a permanent failure", async () => {
    const alice = await signUp("alice", "grn-inbox/inbox#7");
    const bob = await signUp("bob", "grn-inbox/inbox#8");
    await insertNotice(alice);
    await insertNotice(bob);
    const github = fakeGitHub(() => failed(404));
    const lease = await claim();
    const failing = lease.userId;
    const other = failing === alice ? bob : alice;

    expect(await deliver(lease, github.send)).toBe("failed");

    expect(await jobKinds(failing)).toEqual([]);
    expect(await jobKinds(other)).toEqual(["deliver", "sync"]);
    expect(logger.error).toHaveBeenCalledWith(
      "delivery failed permanently, all of the user's jobs deleted",
      expect.objectContaining({ user: failing, deletedJobs: 2 }),
    );
  });

  it("settles a failed marker check like a failed post", async () => {
    const user = await signUp("alice", "grn-inbox/inbox#7");
    const id = await insertNotice(user);
    await db.query(
      `UPDATE jobs SET payload = payload || '{"attempted_at": 1700000000}'
       WHERE id = $1`,
      [id],
    );
    const github = fakeGitHub(() => failed(503));

    expect(await deliver(await claim(), github.send)).toBe("retrying");

    expect(github.requests.map((request) => request.method)).toEqual(["GET"]);
    expect((await job(id))?.attempted_at).toBe(1_700_000_000);
  });
});

describe("machineAccountFromEnv", () => {
  it("reads the token and the inbox repo", () => {
    expect(
      machineAccountFromEnv({
        MACHINE_ACCOUNT_TOKEN: "ghp_x",
        INBOX_REPO: "grn-inbox/inbox",
      }),
    ).toEqual({ token: "ghp_x", inboxRepo: "grn-inbox/inbox" });
  });

  it("rejects a missing token or a malformed repo", () => {
    expect(() =>
      machineAccountFromEnv({ INBOX_REPO: "grn-inbox/inbox" }),
    ).toThrow("MACHINE_ACCOUNT_TOKEN");
    expect(() =>
      machineAccountFromEnv({
        MACHINE_ACCOUNT_TOKEN: "ghp_x",
        INBOX_REPO: "grn-inbox",
      }),
    ).toThrow("INBOX_REPO");
  });
});
