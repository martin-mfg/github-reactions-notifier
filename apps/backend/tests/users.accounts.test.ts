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

import type { Database } from "../src/db.ts";
import { deleteAccount, loadToken, signIn } from "../src/users/accounts.ts";
import type { GitHubIdentity } from "../src/users/accounts.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

let testDb: TestDatabase;
let db: Database;

const cipher = new AccessTokenCipher([randomBytes(32)]);
const siteUrl = "https://grn.example";
const alice: GitHubIdentity = {
  id: "U_alice",
  login: "alice",
  createdAt: "2015-03-04T05:06:07Z",
};
const bob: GitHubIdentity = {
  id: "U_bob",
  login: "bob",
  createdAt: "2016-01-01T00:00:00Z",
};

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
});

const count = async (sql: string, values: Array<unknown> = []) => {
  const { rows } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${sql}`,
    values,
  );
  return rows[0]?.n;
};

/** Every table holding a row about the user, keyed by its name. */
const rowsAbout = async (userId: string) => ({
  users: await count("users WHERE gh_user_id = $1", [userId]),
  subscriptions: await count("subscriptions WHERE user_id = $1", [userId]),
  categories: await count(
    "subscription_categories c JOIN subscriptions s ON s.id = c.subscription_id WHERE s.user_id = $1",
    [userId],
  ),
  channels: await count("notification_channels WHERE user_id = $1", [userId]),
  jobs: await count("jobs WHERE user_id = $1", [userId]),
  tracked: await count("tracked_content WHERE user_id = $1", [userId]),
  sources: await count("content_sources WHERE user_id = $1", [userId]),
  notifications: await count("reaction_notifications WHERE user_id = $1", [
    userId,
  ]),
  rateLimit: await count("rate_limit_state WHERE user_id = $1", [userId]),
});

describe("signIn", () => {
  it("creates every signup row for a new user", async () => {
    const result = await signIn(db, alice, "gho_alice", { cipher, siteUrl });
    expect(result).toEqual({ isNew: true, inboxRequested: true });

    const { rows: users } = await db.query<{
      login: string;
      gh_created_at: Date;
      token_enc: string;
      token_status: string;
    }>("SELECT * FROM users");
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({ login: "alice", token_status: "active" });
    expect(users[0]?.gh_created_at.toISOString()).toBe(
      "2015-03-04T05:06:07.000Z",
    );
    expect(users[0]?.token_enc).not.toContain("gho_alice");
    expect(await loadToken(db, alice.id, cipher)).toEqual({
      token: "gho_alice",
      tokenEnc: users[0]?.token_enc,
    });

    const { rows: categories } = await db.query<{
      category: string;
      discovery_started_at: Date;
      last_checked_at: Date;
      last_find_at: Date;
    }>("SELECT * FROM subscription_categories");
    expect(await count("subscriptions")).toBe(1);
    expect(categories).toHaveLength(1);
    expect(categories[0]?.category).toBe("issue");
    expect(categories[0]?.last_checked_at).toEqual(
      categories[0]?.discovery_started_at,
    );
    expect(categories[0]?.last_find_at).toEqual(
      categories[0]?.discovery_started_at,
    );

    const { rows: types } = await db.query<{
      content_type: string;
      behind: number;
    }>(
      `SELECT t.content_type,
              extract(epoch FROM c.discovery_started_at - t.enabled_at)::int AS behind
       FROM subscription_types t JOIN subscription_categories c ON c.id = t.category_id
       ORDER BY 1`,
    );
    expect(types).toEqual([
      { content_type: "Issue", behind: 180 },
      { content_type: "IssueComment", behind: 180 },
      { content_type: "PullRequest", behind: 180 },
    ]);

    const { rows: passes } = await db.query<{ pass: string; behind: number }>(
      `SELECT p.pass,
              extract(epoch FROM c.discovery_started_at - p.watermark)::int AS behind
       FROM subscription_passes p JOIN subscription_categories c ON c.id = p.category_id
       ORDER BY 1`,
    );
    expect(passes).toEqual([
      { pass: "Issue", behind: 3600 },
      { pass: "IssueComment", behind: 3600 },
      { pass: "PullRequest", behind: 3600 },
    ]);

    const { rows: windows } = await db.query<{ starts_at_signup: boolean }>(
      `SELECT w.window_start = u.gh_created_at
                AND w.window_end = c.discovery_started_at AS starts_at_signup
       FROM backfill_windows w
       JOIN subscription_categories c ON c.id = w.category_id
       JOIN subscriptions s ON s.id = c.subscription_id
       JOIN users u ON u.gh_user_id = s.user_id`,
    );
    expect(windows).toEqual([{ starts_at_signup: true }]);

    const { rows: channels } = await db.query(
      "SELECT kind, target, disabled_at FROM notification_channels",
    );
    expect(channels).toEqual([
      { kind: "github_issue", target: null, disabled_at: null },
    ]);

    const { rows: jobs } = await db.query<{
      id: string;
      kind: string;
      payload: { title: string; body: string } | null;
    }>("SELECT id, kind, payload FROM jobs ORDER BY kind");
    expect(jobs.map((job) => job.kind)).toEqual(["deliver", "sync"]);
    const opening = jobs[0];
    expect(opening?.payload?.title).toContain("alice");
    expect(opening?.payload?.body).toContain("@alice");
    expect(opening?.payload?.body).toContain(siteUrl);
    expect(opening?.payload?.body).toContain(
      `<!-- grn:${String(opening?.id)} -->`,
    );
    expect(jobs[1]?.payload).toBeNull();
  });

  it("reactivates a returning user without a second subscription or sync job", async () => {
    await signIn(db, alice, "gho_old", { cipher, siteUrl });
    await db.query("DELETE FROM jobs WHERE kind = 'sync'");

    for (const status of ["revoked", "invalid"]) {
      await db.query("UPDATE users SET token_status = $1", [status]);
      const result = await signIn(
        db,
        { ...alice, login: "alice-renamed" },
        `gho_${status}`,
        { cipher, siteUrl },
      );
      expect(result).toEqual({ isNew: false, inboxRequested: false });
      const { rows } = await db.query<{ login: string; token_status: string }>(
        "SELECT login, token_status FROM users",
      );
      expect(rows).toEqual([
        { login: "alice-renamed", token_status: "active" },
      ]);
      expect((await loadToken(db, alice.id, cipher))?.token).toBe(
        `gho_${status}`,
      );
    }

    expect(await count("subscriptions")).toBe(1);
    expect(await count("subscription_categories")).toBe(1);
    // A deleted sync job is not recreated (§12).
    expect(await count("jobs WHERE kind = 'sync'")).toBe(0);
    expect(await count("notification_channels")).toBe(1);
    expect(await count("jobs WHERE kind = 'deliver'")).toBe(1);
  });

  it("opens one inbox for concurrent sign-ins", async () => {
    const results = await Promise.all([
      signIn(db, alice, "gho_1", { cipher, siteUrl }),
      signIn(db, alice, "gho_2", { cipher, siteUrl }),
    ]);
    expect(results.filter((result) => result.isNew)).toHaveLength(1);
    expect(results.filter((result) => result.inboxRequested)).toHaveLength(1);
    expect(await count("users")).toBe(1);
    expect(await count("subscriptions")).toBe(1);
    expect(await count("notification_channels")).toBe(1);
    expect(await count("jobs WHERE kind = 'deliver'")).toBe(1);
  });

  it("requests no inbox while the user has an active one", async () => {
    await signIn(db, alice, "gho_1", { cipher, siteUrl });
    await db.query("DELETE FROM jobs");
    await db.query("UPDATE notification_channels SET target = 'o/r#1'");

    const result = await signIn(db, alice, "gho_2", { cipher, siteUrl });
    expect(result.inboxRequested).toBe(false);
    expect(await count("jobs")).toBe(0);
  });

  it("requests a new inbox after the old one was disabled", async () => {
    await signIn(db, alice, "gho_1", { cipher, siteUrl });
    await db.query("DELETE FROM jobs");
    await db.query("UPDATE notification_channels SET disabled_at = now()");

    const result = await signIn(db, alice, "gho_2", { cipher, siteUrl });
    expect(result.inboxRequested).toBe(true);
    expect(await count("notification_channels WHERE disabled_at IS NULL")).toBe(
      1,
    );
    expect(await count("jobs WHERE kind = 'deliver'")).toBe(1);
  });
});

describe("loadToken", () => {
  it("returns null for an unknown user", async () => {
    expect(await loadToken(db, "U_nobody", cipher)).toBeNull();
  });

  it("marks an undecryptable token invalid", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await signIn(db, alice, "gho_alice", { cipher, siteUrl });

    const otherKey = new AccessTokenCipher([randomBytes(32)]);
    expect(await loadToken(db, alice.id, otherKey)).toBeNull();
    expect(error).toHaveBeenCalled();
    const { rows } = await db.query("SELECT token_status FROM users");
    expect(rows).toEqual([{ token_status: "invalid" }]);
  });

  it("marks a plaintext token invalid", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await signIn(db, alice, "gho_alice", { cipher, siteUrl });
    await db.query(
      "UPDATE users SET token_enc = 'gho_plain', token_nonce = ''",
    );

    expect(await loadToken(db, alice.id, cipher)).toBeNull();
    const { rows } = await db.query("SELECT token_status FROM users");
    expect(rows).toEqual([{ token_status: "invalid" }]);
  });

  it("does not decrypt another user's token", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await signIn(db, alice, "gho_alice", { cipher, siteUrl });
    await signIn(db, bob, "gho_bob", { cipher, siteUrl });
    await db.query(
      `UPDATE users SET (token_enc, token_nonce) =
         (SELECT token_enc, token_nonce FROM users WHERE gh_user_id = $1)
       WHERE gh_user_id = $2`,
      [alice.id, bob.id],
    );
    expect(await loadToken(db, bob.id, cipher)).toBeNull();
  });
});

describe("deleteAccount", () => {
  /**
   * Gives the user tracked content with a reaction they were notified of.
   *
   * @param user The user.
   * @param nodeId The content.
   */
  const track = async (user: GitHubIdentity, nodeId: string) => {
    await db.query(
      `INSERT INTO content (node_id, type, repo_full_name, url, title)
       VALUES ($1, 'Issue', 'o/r', 'https://github.com/o/r/issues/1', 't')
       ON CONFLICT DO NOTHING`,
      [nodeId],
    );
    await db.query(
      `INSERT INTO tracked_content (user_id, node_id, last_event_at, watermark_at)
       VALUES ($1, $2, now(), now())`,
      [user.id, nodeId],
    );
    await db.query(
      `INSERT INTO content_sources (user_id, node_id, subscription_id)
       SELECT $1, $2, id FROM subscriptions WHERE user_id = $1`,
      [user.id, nodeId],
    );
    await db.query(
      `INSERT INTO reaction_events (node_id, reactor_id, emoji, reacted_at, reactor_login)
       VALUES ($1, 'U_carol', 'HEART', now(), 'carol')
       ON CONFLICT DO NOTHING`,
      [nodeId],
    );
    await db.query(
      `INSERT INTO reaction_notifications (user_id, node_id, reactor_id, emoji)
       VALUES ($1, $2, 'U_carol', 'HEART')`,
      [user.id, nodeId],
    );
    await db.query(
      `INSERT INTO rate_limit_state (user_id, limit_, used, reset_at)
       VALUES ($1, 5000, 1, now()) ON CONFLICT DO NOTHING`,
      [user.id],
    );
  };

  it("leaves no rows about the user", async () => {
    await signIn(db, alice, "gho_alice", { cipher, siteUrl });
    await track(alice, "I_only_alice");

    expect(await deleteAccount(db, alice.id)).toBe(true);

    expect(await rowsAbout(alice.id)).toEqual({
      users: 0,
      subscriptions: 0,
      categories: 0,
      channels: 0,
      jobs: 0,
      tracked: 0,
      sources: 0,
      notifications: 0,
      rateLimit: 0,
    });
    for (const table of [
      "subscription_categories",
      "subscription_types",
      "subscription_passes",
      "backfill_windows",
      "content",
      "reaction_events",
    ]) {
      expect(await count(table), table).toBe(0);
    }
  });

  it("keeps global rows another user still references", async () => {
    await signIn(db, alice, "gho_alice", { cipher, siteUrl });
    await signIn(db, bob, "gho_bob", { cipher, siteUrl });
    await track(alice, "I_shared");
    await track(alice, "I_only_alice");
    await track(bob, "I_shared");

    expect(await deleteAccount(db, alice.id)).toBe(true);

    const { rows: content } = await db.query("SELECT node_id FROM content");
    expect(content).toEqual([{ node_id: "I_shared" }]);
    const { rows: events } = await db.query(
      "SELECT node_id FROM reaction_events",
    );
    expect(events).toEqual([{ node_id: "I_shared" }]);
    expect(await rowsAbout(bob.id)).toMatchObject({
      users: 1,
      tracked: 1,
      notifications: 1,
      jobs: 2,
    });
  });

  it("returns false for an unknown user", async () => {
    expect(await deleteAccount(db, "U_nobody")).toBe(false);
  });

  it("allows signing up again afterwards", async () => {
    await signIn(db, alice, "gho_1", { cipher, siteUrl });
    await deleteAccount(db, alice.id);
    const result = await signIn(db, alice, "gho_2", { cipher, siteUrl });
    expect(result).toEqual({ isNew: true, inboxRequested: true });
  });
});
