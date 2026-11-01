import { randomBytes } from "node:crypto";

import { AccessTokenCipher, logger } from "@grn/core";
import type {
  DrilledItem,
  DrilledReaction,
  GraphQLError,
  GraphQLFetcherFunction,
  ProbedItem,
  ReactionDrillDownQuery,
  ReactionPollQueryVariables,
  ReactionProbeQuery,
} from "@grn/core";
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
import type { Database } from "../src/db.ts";
import type { SyncSession } from "../src/github/syncClient.ts";
import { claimJob } from "../src/jobs/queue.ts";
import { runPoll } from "../src/polling/poll.ts";
import { signIn } from "../src/users/accounts.ts";

import { createTestDatabase } from "./_db.ts";
import type { TestDatabase } from "./_db.ts";

type ProbeFetcher = GraphQLFetcherFunction<
  ReactionProbeQuery,
  ReactionPollQueryVariables
>;
type DrillDownFetcher = GraphQLFetcherFunction<
  ReactionDrillDownQuery,
  ReactionPollQueryVariables
>;

let testDb: TestDatabase;
let db: Database;
/** The test's start; `ago` counts from it so that its repeated calls in a test agree. */
let testNow: number;

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
  testNow = Date.now();
});

const cipher = new AccessTokenCipher([randomBytes(32)]);
const ALICE = {
  id: "U_alice",
  login: "alice",
  createdAt: "2015-01-01T00:00:00Z",
};
const bob = { id: "U_bob", login: "bob" };
const carol = { id: "U_carol", login: "carol" };
const dave = { id: "U_dave", login: "dave" };

/**
 * @param seconds How long before the test's start.
 * @returns The time, in GitHub's whole seconds.
 */
const ago = (seconds: number): string =>
  new Date(Math.floor(testNow / 1000 - seconds) * 1000)
    .toISOString()
    .replace(".000Z", "Z");

/** @returns A new lease on Alice's `sync` job, whenever it is due and whoever holds it. */
const claim = async () => {
  await db.query(
    `UPDATE jobs SET run_at = now() - interval '1 minute', locked_by = NULL
     WHERE kind = 'sync'`,
  );
  const lease = await claimJob(db, "sync");
  if (!lease) {
    throw new Error("no lease");
  }
  return lease;
};

/**
 * Signs Alice up (her types' `enabled_at` is 3 minutes ago) and claims her `sync` job.
 *
 * @returns The leased job's session.
 */
const setUp = async (): Promise<SyncSession> => {
  await signIn(db, ALICE, "gho_alice", { cipher, siteUrl: "https://grn" });
  return {
    db,
    lease: await claim(),
    token: "gho_alice",
    tokenEnc: "",
    siteUrl: "https://grn",
  };
};

/** @returns The session with a fresh lease, as for the next poll. */
const nextRun = async (session: SyncSession): Promise<SyncSession> => ({
  ...session,
  lease: await claim(),
});

/**
 * Tracks an item for Alice, found by her subscription.
 *
 * @param nodeId The item.
 * @param row Its `tracked_content` times, as `interval`s ago.
 * @param row.checkedAgo `last_checked_at`, by default due.
 * @param row.eventAgo `last_event_at`.
 * @param row.watermarkAt `watermark_at`; defaults to the type's `enabled_at`.
 */
const track = async (
  nodeId: string,
  row: { checkedAgo?: string; eventAgo?: string; watermarkAt?: string } = {},
) => {
  await db.query(
    `INSERT INTO content (node_id, type, repo_full_name, url, title)
     VALUES ($1, 'Issue', 'octo/repo', 'https://github.com/octo/repo/issues/1', 'Bug')`,
    [nodeId],
  );
  await db.query(
    `INSERT INTO tracked_content (user_id, node_id, last_checked_at, last_event_at, watermark_at)
     VALUES ('U_alice', $1, now() - $2::interval, now() - $3::interval,
             coalesce($4::timestamptz,
                      (SELECT enabled_at FROM subscription_types WHERE content_type = 'Issue')))`,
    [
      nodeId,
      row.checkedAgo ?? "5 minutes",
      row.eventAgo ?? "1 hour",
      row.watermarkAt ?? null,
    ],
  );
  await db.query(
    `INSERT INTO content_sources (user_id, node_id, subscription_id)
     SELECT 'U_alice', $1, id FROM subscriptions WHERE user_id = 'U_alice'`,
    [nodeId],
  );
};

/** Makes every item due again, as `D` passing would. */
const makeDue = () =>
  db.query(
    "UPDATE tracked_content SET last_checked_at = now() - interval '5 minutes'",
  );

const respond = <T>(data: T, errors: Array<GraphQLError> = []) =>
  Promise.resolve({
    status: 200,
    statusText: "",
    data: { data, ...(errors.length > 0 && { errors }) },
    headers: {},
    config: {},
  } as Awaited<ReturnType<GraphQLFetcherFunction<T, unknown>>>);

const aliased = <T>(items: Array<T>) =>
  Object.fromEntries(items.map((item, index) => [`item_${index}`, item]));

const probing = (items: Array<ProbedItem>, errors: Array<GraphQLError> = []) =>
  vi.fn<ProbeFetcher>(() =>
    respond<ReactionProbeQuery>(
      { rateLimit: { cost: 1 }, ...aliased(items) },
      errors,
    ),
  );

const drilling = (
  items: Array<DrilledItem>,
  errors: Array<GraphQLError> = [],
) =>
  vi.fn<DrillDownFetcher>(() =>
    respond<ReactionDrillDownQuery>(
      { rateLimit: { cost: 1 }, ...aliased(items) },
      errors,
    ),
  );

/** A drill-down that must not be sent. */
const noDrillDown = () =>
  vi.fn<DrillDownFetcher>(() => Promise.reject(new Error("not expected")));

/**
 * @param createdAt The item's newest reaction, or `null` for none.
 * @returns The item's probe result.
 */
const newestAt = (createdAt: string | null): ProbedItem => ({
  reactions: { nodes: createdAt === null ? [] : [{ createdAt }] },
});

const reaction = (
  createdAt: string,
  user: DrilledReaction["user"] = bob,
  content: DrilledReaction["content"] = "THUMBS_UP",
): DrilledReaction => ({ content, createdAt, user });

/**
 * @param reactions The reactions, newest first.
 * @param hasNextPage Whether there are more.
 * @returns The item's drill-down result.
 */
const page = (
  reactions: Array<DrilledReaction>,
  hasNextPage = false,
): DrilledItem => ({
  reactions: { pageInfo: { hasNextPage }, nodes: reactions },
});

/** A SAML-protected item's error; it is not a missing item. */
const forbidden: GraphQLError = {
  type: "FORBIDDEN",
  message: "Resource protected by organization SAML enforcement.",
  path: ["item_0"],
};

const events = async () => {
  const { rows } = await db.query<{
    node_id: string;
    reactor: string;
    emoji: string;
    reacted_at: Date;
  }>(
    `SELECT node_id, reactor_login AS reactor, emoji, reacted_at FROM reaction_events
     ORDER BY reacted_at DESC, reactor_login`,
  );
  return rows;
};

const item = async (nodeId: string) => {
  const { rows } = await db.query<{
    last_event_at: Date;
    watermark_at: Date;
    enabled_at: Date;
    checked_ago: number;
  }>(
    `SELECT t.last_event_at, t.watermark_at, st.enabled_at,
            extract(epoch FROM now() - t.last_checked_at)::float8 AS checked_ago
     FROM tracked_content t, subscription_types st
     WHERE t.node_id = $1 AND st.content_type = 'Issue'`,
    [nodeId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`${nodeId} is not tracked`);
  }
  return row;
};

const syncJob = async () => {
  const { rows } = await db.query<{ locked_by: string | null; due_in: number }>(
    `SELECT locked_by, extract(epoch FROM run_at - now())::float8 AS due_in
     FROM jobs WHERE kind = 'sync'`,
  );
  return rows[0];
};

describe("runPoll", () => {
  it("measures latency with Postgres even when the host clock is skewed", async () => {
    const session = await setUp();
    await track("I_1");
    const { rows: before } = await db.query<{ time: Date }>(
      "SELECT now() AS time",
    );
    vi.spyOn(Date, "now").mockReturnValue(testNow + 24 * 60 * 60 * 1000);

    await runPoll(session, {
      probe: probing([newestAt(ago(10))]),
      drillDown: drilling([
        page([reaction(ago(10)), reaction(ago(20), carol)]),
      ]),
    });

    const { rows: after } = await db.query<{ time: Date }>(
      "SELECT now() AS time",
    );
    const log = vi
      .mocked(logger.log)
      .mock.calls.find(([message]) => message === "poll")?.[1];
    for (const [field, age] of [
      ["latencyP50Seconds", 10],
      ["latencyP95Seconds", 20],
    ] as const) {
      const latency = (log as Record<string, number>)[field];
      expect(latency).toBeGreaterThanOrEqual(
        ((before[0]?.time.getTime() ?? 0) - Date.parse(ago(age))) / 1000,
      );
      expect(latency).toBeLessThanOrEqual(
        ((after[0]?.time.getTime() ?? 0) - Date.parse(ago(age))) / 1000,
      );
    }
  });

  it.each(["probe", "drill-down"])(
    "retries an omitted %s alias without committing poll progress",
    async (query) => {
      const session = await setUp();
      await track("I_1");
      const before = await item("I_1");
      const result = await runPoll(session, {
        probe: query === "probe" ? probing([]) : probing([newestAt(ago(10))]),
        drillDown: query === "drill-down" ? drilling([]) : noDrillDown(),
      });

      expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
      expect(await events()).toEqual([]);
      expect((await item("I_1")).watermark_at).toEqual(before.watermark_at);
      expect((await item("I_1")).checked_ago).toBeGreaterThanOrEqual(
        before.checked_ago,
      );
      expect(await syncJob()).toMatchObject({ locked_by: null });
      expect((await syncJob())?.due_in).toBeCloseTo(
        defaultConfig.syncRetrySeconds,
        0,
      );
    },
  );

  it("stores no reaction from before enabled_at", async () => {
    const session = await setUp();
    await track("I_1");
    const drillDown = drilling([
      page([
        reaction(ago(60), bob),
        reaction(ago(120), carol, "HEART"),
        // before enabled_at (3 minutes ago)
        reaction(ago(600), dave),
        reaction(ago(3600), carol),
      ]),
    ]);

    const result = await runPoll(session, {
      probe: probing([newestAt(ago(60))]),
      drillDown,
    });

    expect(result).toMatchObject({ ok: true, probed: 1, drilled: 1 });
    expect(result.ok && result.newReactions).toHaveLength(2);
    expect(drillDown.mock.calls[0]?.[0]).toEqual({ id_0: "I_1" });
    expect(await events()).toEqual([
      expect.objectContaining({ reactor: "bob", emoji: "THUMBS_UP" }),
      expect.objectContaining({ reactor: "carol", emoji: "HEART" }),
    ]);
    const row = await item("I_1");
    expect(row.last_event_at).toEqual(new Date(ago(60)));
    expect(row.checked_ago).toBeLessThan(5);
    expect(await syncJob()).toMatchObject({ locked_by: null });
  });

  it("queues the new reactions, the user's own included, and opens the digest", async () => {
    const session = await setUp();
    await track("I_1");
    const reactions = page([
      reaction(ago(10), { id: ALICE.id, login: ALICE.login }),
      reaction(ago(20), bob),
    ]);

    const result = await runPoll(session, {
      probe: probing([newestAt(ago(10))]),
      drillDown: drilling([reactions]),
    });

    expect(result).toMatchObject({ ok: true, queued: 2 });
    const { rows: queued } = await db.query<{ reactor_id: string }>(
      `SELECT reactor_id FROM reaction_notifications
       WHERE user_id = 'U_alice' AND outcome = 'queued' ORDER BY reactor_id`,
    );
    expect(queued.map((row) => row.reactor_id)).toEqual(["U_alice", "U_bob"]);
    const { rows: digests } = await db.query<{ due_in: number }>(
      `SELECT extract(epoch FROM run_at - now())::float8 AS due_in
       FROM jobs WHERE kind = 'deliver' AND payload->>'digest' = 'true'`,
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]?.due_in).toBeGreaterThan(170);
    expect(digests[0]?.due_in).toBeLessThanOrEqual(180);
    expect(logger.log).toHaveBeenCalledWith(
      "poll",
      expect.objectContaining({ newReactions: 2, queued: 2 }),
    );

    // a re-read inserts nothing, so it queues nothing (FR-7)
    await makeDue();
    const again = await runPoll(await nextRun(session), {
      probe: probing([newestAt(ago(10))]),
      drillDown: drilling([reactions]),
    });
    expect(again).toMatchObject({ ok: true, newReactions: [], queued: 0 });
  });

  it("does not drill down unless the newest reaction is strictly newer than the watermark", async () => {
    const session = await setUp();
    await track("I_old");
    await track("I_tie", { watermarkAt: ago(30) });
    await track("I_none");

    const result = await runPoll(session, {
      probe: probing([
        // a pre-enabled_at reaction still counts as activity
        newestAt(ago(600)),
        newestAt(ago(30)),
        newestAt(null),
      ]),
      drillDown: noDrillDown(),
    });

    expect(result).toMatchObject({ ok: true, probed: 3, drilled: 0 });
    expect(await events()).toEqual([]);
    const old = await item("I_old");
    expect(old.last_event_at).toEqual(new Date(ago(600)));
    expect(old.watermark_at).toEqual(old.enabled_at);
    expect((await item("I_tie")).watermark_at).toEqual(new Date(ago(30)));
    const none = await item("I_none");
    expect(none.watermark_at).toEqual(none.enabled_at);
    expect(none.checked_ago).toBeLessThan(5);
  });

  it("finds a hot-boundary reaction on the next poll", async () => {
    const session = await setUp();
    await track("I_1");
    const first = ago(30);

    await runPoll(session, {
      probe: probing([newestAt(first)]),
      drillDown: drilling([page([reaction(first, bob)])]),
    });

    // held back by CLOCK_MARGIN, not moved to the newest reaction
    const held = await item("I_1");
    expect(held.watermark_at.getTime()).toBeLessThan(Date.parse(first));
    expect(held.watermark_at.getTime()).toBeGreaterThanOrEqual(
      held.enabled_at.getTime(),
    );

    // readable only now: an older reaction, and one in the same second as the first
    await makeDue();
    const drillDown = drilling([
      page([
        reaction(first, bob),
        reaction(first, dave, "ROCKET"),
        reaction(ago(90), carol, "EYES"),
      ]),
    ]);
    const result = await runPoll(await nextRun(session), {
      probe: probing([newestAt(first)]),
      drillDown,
    });

    expect(drillDown).toHaveBeenCalledTimes(1);
    expect(
      result.ok && result.newReactions.map((row) => row.reactor_login).sort(),
    ).toEqual(["carol", "dave"]);
    expect(await events()).toHaveLength(3);
  });

  it("stops drilling down once the newest reaction is past the clock margin", async () => {
    const session = await setUp();
    await track("I_1", { watermarkAt: ago(3600) });
    const newest = ago(600);

    await runPoll(session, {
      probe: probing([newestAt(newest)]),
      drillDown: drilling([page([reaction(newest, bob)])]),
    });
    expect((await item("I_1")).watermark_at).toEqual(new Date(newest));

    await makeDue();
    const result = await runPoll(await nextRun(session), {
      probe: probing([newestAt(newest)]),
      drillDown: noDrillDown(),
    });
    expect(result).toMatchObject({ ok: true, drilled: 0 });
  });

  it("probes only items not checked for D, the top probeBatch by score", async () => {
    const session = await setUp();
    await track("I_recent", { checkedAgo: "3 minutes", eventAgo: "1 minute" });
    await track("I_hot", { checkedAgo: "5 minutes", eventAgo: "1 minute" });
    await track("I_cold", { checkedAgo: "5 minutes", eventAgo: "1 year" });
    await track("I_waiting", { checkedAgo: "10 days", eventAgo: "1 year" });
    const probe = probing([newestAt(null), newestAt(null)]);

    await runPoll(
      { ...session, config: { ...defaultConfig, probeBatch: 2 } },
      { probe, drillDown: noDrillDown() },
    );

    expect(probe.mock.calls[0]?.[0]).toEqual({
      id_0: "I_hot",
      id_1: "I_waiting",
    });
    expect((await item("I_cold")).checked_ago).toBeGreaterThan(299);
    expect((await item("I_recent")).checked_ago).toBeLessThan(181);
  });

  it("logs a drill-down overflow as an error, stores the page, and sends no second drill-down", async () => {
    const session = await setUp();
    await track("I_busy");
    await track("I_long");
    const probe = probing([newestAt(ago(10)), newestAt(ago(10))]);
    const drillDown = drilling([
      page([reaction(ago(10), bob), reaction(ago(20), carol)], true),
      // its page reaches back before the watermark: nothing unread beyond it
      page([reaction(ago(10), dave), reaction(ago(3600), carol)], true),
    ]);

    const result = await runPoll(session, { probe, drillDown });

    expect(result).toMatchObject({ ok: true, drilled: 2 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(drillDown).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "poll: drill-down page full: reactions beyond it are not notified",
      expect.objectContaining({ item: "I_busy", oldest: ago(20) }),
    );
    expect((await events()).map((row) => row.reactor)).toEqual([
      "bob",
      "dave",
      "carol",
    ]);
    const busy = await item("I_busy");
    expect(busy.watermark_at.getTime()).toBeGreaterThan(
      busy.enabled_at.getTime(),
    );
  });

  it("checks a missing item without moving its watermark", async () => {
    const session = await setUp();
    await track("I_gone");
    await track("I_vanished");
    await track("I_ok");

    const result = await runPoll(session, {
      probe: probing(
        [null, newestAt(ago(10)), newestAt(ago(10))],
        [{ type: "NOT_FOUND", message: "gone", path: ["item_0"] }],
      ),
      // deleted between the probe and the drill-down
      drillDown: drilling(
        [null, page([reaction(ago(10), bob)])],
        [{ type: "NOT_FOUND", message: "gone", path: ["item_0"] }],
      ),
    });

    expect(result).toMatchObject({ ok: true, probed: 3, missing: 2 });
    for (const nodeId of ["I_gone", "I_vanished"]) {
      const row = await item(nodeId);
      expect(row.watermark_at).toEqual(row.enabled_at);
      expect(row.checked_ago).toBeLessThan(5);
    }
    expect((await events()).map((row) => row.node_id)).toEqual(["I_ok"]);
    expect(logger.log).toHaveBeenCalledWith(
      "poll: item missing, skipped",
      expect.objectContaining({ item: "I_gone", query: "probe" }),
    );
    expect(logger.log).toHaveBeenCalledWith(
      "poll: item missing, skipped",
      expect.objectContaining({ item: "I_vanished", query: "drill-down" }),
    );
  });

  it("stores a deleted user's reaction as a ghost, once", async () => {
    const session = await setUp();
    await track("I_1");
    const ghosted = page([
      reaction(ago(10), null),
      reaction(ago(20), null),
      reaction(ago(20), bob),
    ]);

    const result = await runPoll(session, {
      probe: probing([newestAt(ago(10))]),
      drillDown: drilling([ghosted]),
    });
    expect(result.ok && result.newReactions).toHaveLength(3);

    // the hot boundary re-reads them
    await makeDue();
    const again = await runPoll(await nextRun(session), {
      probe: probing([newestAt(ago(10))]),
      drillDown: drilling([ghosted]),
    });

    expect(again.ok && again.newReactions).toEqual([]);
    expect(
      (await events()).map((row) => [row.reactor, row.reacted_at]),
    ).toEqual([
      ["ghost", new Date(ago(10))],
      ["bob", new Date(ago(20))],
      ["ghost", new Date(ago(20))],
    ]);
  });

  it.each([
    {
      query: "the probe",
      probe: () => probing([null, newestAt(ago(10))], [forbidden]),
      drillDown: noDrillDown,
    },
    {
      query: "the drill-down",
      probe: () => probing([newestAt(ago(10)), newestAt(ago(10))]),
      drillDown: () =>
        drilling([null, page([reaction(ago(10), bob)])], [forbidden]),
    },
  ])(
    "logs and retries later if $query has an error at an item other than NOT_FOUND",
    async ({ probe, drillDown }) => {
      const session = await setUp();
      await track("I_secret");
      await track("I_ok");

      const result = await runPoll(session, {
        probe: probe(),
        drillDown: drillDown(),
      });

      expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
      expect(logger.warn).toHaveBeenCalledWith(
        "unexpected GraphQL errors",
        expect.anything(),
      );
      expect(await events()).toEqual([]);
      for (const nodeId of ["I_secret", "I_ok"]) {
        const row = await item(nodeId);
        expect(row.checked_ago).toBeGreaterThan(299);
        expect(row.watermark_at).toEqual(row.enabled_at);
      }
      expect(await syncJob()).toMatchObject({ locked_by: null });
      expect((await syncJob())?.due_in).toBeGreaterThan(290);
    },
  );

  it("stores nothing if the drill-down fails", async () => {
    const session = await setUp();
    await track("I_1");

    const result = await runPoll(session, {
      probe: probing([newestAt(ago(10))]),
      drillDown: drilling(
        [page([reaction(ago(10), bob)])],
        [{ type: "INTERNAL", message: "boom" }],
      ),
    });

    expect(result).toEqual({ ok: false, failure: { kind: "transient" } });
    expect(await events()).toEqual([]);
    const row = await item("I_1");
    expect(row.checked_ago).toBeGreaterThan(299);
    expect(row.watermark_at).toEqual(row.enabled_at);
    expect(await syncJob()).toMatchObject({ locked_by: null });
    expect((await syncJob())?.due_in).toBeGreaterThan(290);
  });
});
