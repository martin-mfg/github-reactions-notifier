# GRN — M1.1 Implementation Requirements: Backfill Reaction Summary

**Builds on:** `reactions-notifier-m1-requirements.md` (M1) and
`reactions-notifier-requirements-architecture-v1.md` (the "full doc"). IDs (FR-x, NFR-x) and
section refs (§x.y) point there. Where this doc and M1 disagree, **this doc wins** for M1.1.
The M1 docs stay unchanged as the record of M1.

**Markers:** as in M1 (`[WHY]`, `[TBD]`). Additionally, `[CALL]` marks a decision made while
writing this doc rather than by the product owner. Revisit it if it turns out wrong.

---

## 0. M1.1 in one paragraph

Once GRN has finished discovering a user's history, it posts **one** summary comment to the
user's inbox issue. The summary covers the reactions their content had already received: how many
items GRN found (split into issues, PRs and comments), how many of those have at least one
reaction, how many reactions they have in total, and the total per emoji. The counts come from a
per-item snapshot, taken by a new low-priority **snapshot sweep** that starts once backfill has
finished.

### What changes compared with M1

| M1 says | M1.1 says |
|---|---|
| "Backfill completion: no notification or summary" | One summary per subscription, posted once when all of its discovery and snapshot work is done (§3) |
| "Rejected outright: a per-item reaction count vector" | Allowed for this feature: `reaction_snapshots` (§2) |
| "M1 triggers nothing on completion" (§9.2) | Completion triggers the summary (§3) |

Everything else in M1 still holds, notably FR-6: pre-existing reactions are still **never**
notified individually. The summary reports only aggregate numbers.

## 1. Out of scope

- **Unique reactors.** Dropped. `[WHY]` It needs every reactor's identity on every item:
  per-item pagination (M1 has no cursors) and a deduplication set kept across tasks.
- **Excluding the user's own or bot reactions.** These are counted, like M1's notifications
  count them.
- **"Before sign-in" precision.** Counts are a snapshot at the time of the sweep, not filtered by
  `enabled_at`. Reactions added after sign-in that were already notified may be counted too.
  Removed reactions are not counted. This is accepted.
- **Per-emoji split by content type.** Emoji totals are shown only across all types.
- **Existing installations.** The app is unpublished. No migration path or retroactive summary
  for users whose backfill already completed.
- **Categories added to an existing subscription later** (e.g., M2 discussions for a user who
  signed up under M1.1). The new category's backfill would complete again and trigger a second,
  full summary (§3). Irrelevant before M2. Decide then whether that's wanted.
- Refreshing snapshots after they're taken, or reusing them for anything other than the summary.

## 2. Data model

### 2.1 New table `reaction_snapshots`

Add to `packages/core/sql/schema.sql`:

```sql
CREATE TABLE reaction_snapshots (
  user_id     text NOT NULL REFERENCES users ON DELETE CASCADE,
  node_id     text NOT NULL REFERENCES content,
  retry_at    timestamptz NOT NULL DEFAULT now(),  -- not picked before this (§4)
  thumbs_up   integer,
  thumbs_down integer,
  laugh       integer,
  hooray      integer,
  confused    integer,
  heart       integer,
  rocket      integer,
  eyes        integer,
  PRIMARY KEY (user_id, node_id),
  -- all eight counts are set (snapshot taken) or all are NULL (pending)
  CHECK (num_nulls(thumbs_up, thumbs_down, laugh, hooray, confused, heart, rocket, eyes) IN (0, 8))
);
CREATE INDEX reaction_snapshots_pending
  ON reaction_snapshots (user_id, retry_at) WHERE thumbs_up IS NULL;
```

- **One row per (user, item).** The counts describe the item, not the source that found it.
- **Per user, not on the global `content` table.** `[WHY]` A snapshot belongs to one user's
  backfill. From M2/M4 on, content is shared across users, and another user's backfill
  must not overwrite it.
- **Eight columns, one per GitHub `ReactionContent` value** (`THUMBS_UP`, `THUMBS_DOWN`,
  `LAUGH`, `HOORAY`, `CONFUSED`, `HEART`, `ROCKET`, `EYES`). `[WHY]` The summary is then one
  `SUM()` per column, and a new emoji would be one additive column. Write all eight columns, with
  `0` for emoji the item has none of. An unknown future `ReactionContent` value is logged as a
  warning and ignored.
- **A row whose counts are NULL is pending.** The set of pending rows *is* the sweep's work
  queue. There's no cursor or progress row. `[WHY]` This keeps every sweep task retryable on its
  own (NFR-6, §4.2).
- **`retry_at`** is the insert time until an attempt fails, which pushes it back (§4.2). It
  is both the earliest time a row may be picked and the score's `wait` term (§4.1).
- **Which items the summary covers:** exactly the items that have a snapshot row, i.e. those that
  backfill or thread scans reached (§2.3). Items found only by incremental discovery (content
  created after sign-in) usually get no row, and are therefore not part of the summary. Items deleted on
  GitHub before their snapshot lose their row (§4.2).
- Rows are kept after the summary is posted `[CALL]`. They're small, and are deleted with the
  user.

### 2.2 Which subscription an item belongs to (ready for per-source summaries in M2+)

The table has **no `subscription_id`**. Attribution comes from the existing `content_sources`
table, which already records every subscription that matched an item (FR-5), and is written in
the same transaction as the snapshot row (§2.3). **Everything per subscription is a join:**

```sql
FROM reaction_snapshots r
JOIN content_sources cs ON cs.user_id = r.user_id AND cs.node_id = r.node_id
WHERE cs.subscription_id = $1
```

- `[WHY]` An item matched by two subscriptions (e.g., `authored` and M2's `repo:`) then counts
  towards **both** summaries, using one snapshot row and one query. A `subscription_id` column
  would force a choice between attributing the item to only one source and a second row with a
  duplicate query.
- M1.1 uses this join for the completion check (§3), the batch pick (§4.2) and the aggregation
  (§5.1), even though there is only one subscription. M2's sources then get summaries by
  inserting snapshot rows from their own backfills, with no schema change. Which sources send a
  summary is M2's decision.
- If a second source's backfill reaches an item that already has a snapshot, the insert is a
  no-op, and that source's summary reuses the existing counts. This is accepted, in line with the
  snapshot semantics in §1.

### 2.3 Inserting pending rows

- In the **same transaction** as their content upserts, backfill (`runBackfill`) and thread scans
  (`runThreadScans`) insert one pending row for each kept item (threads the user opened and the
  user's comments): `INSERT … ON CONFLICT (user_id, node_id) DO NOTHING`.
  - `[WHY]` The key is "this item has no snapshot yet", **not** "this item wasn't tracked
    before". Incremental discovery can track an old item first (an old comment found because it
    was recently edited). Backfill must still give it a snapshot row when it reaches it.
  - `[WHY]` `ON CONFLICT DO NOTHING` makes backfill's inclusive-boundary re-reads free, as for
    the other upserts.
- **Incremental discovery does not insert snapshot rows.** `storeDiscovered` (in
  `discovery/store.ts`) is shared by all three callers. The builder decides whether the snapshot
  insert goes inside it behind an option, or into a separate helper that only backfill and
  thread scans call.
- The backfill and thread-scan **GraphQL queries are unchanged**.

## 3. Completion and the summary trigger

A subscription is **complete** when all of these hold:

1. No `backfill_windows` row in any of its categories.
2. No `thread_scans` row in any of its categories.
3. No pending snapshot row among its items (the join in §2.2).

**Where the check runs:** completion can only become true when outstanding work is removed. So
the check runs only in transactions that remove work, at the end of that transaction:

- a backfill task that **deletes** its window;
- a thread-scan task that **deletes** at least one thread scan;
- a snapshot task that fills or deletes at least one pending row.

A backfill page that only shrinks its window, or a snapshot task whose every row failed, can't
complete anything, and doesn't run the check. If the subscription is complete after the
transaction's changes, the same transaction inserts the summary's `deliver` job.

**Why this fires exactly once, without a stored flag:**
- Before completion, the check never finds the subscription complete.
- The transaction that completes it inserts the job atomically with its own change. If it rolls
  back, neither happens, and the retry repeats both.
- After completion, no window, thread scan or pending row is left for that subscription, so no
  transaction of the listed kinds runs for it again.
- Signup is the only place that creates a backfill window. A returning sign-in doesn't recreate
  the subscription (`users/accounts.ts`). A user's `sync` tasks run one at a time under the job
  lease, so two tasks can't both observe completion.
- The one exception is a category added to an existing subscription later (M2, §1).

Further notes:
- The existing per-category `isBackfillComplete` (`discovery/backfill.ts`) stays. The new
  per-subscription check extends it with the snapshot condition and spans all categories.
- **A user with no content at all** still gets the summary, in a shortened form (§5.2) `[CALL]`.
  It doubles as "GRN has finished scanning your history". In that case the trigger is the
  transaction that deletes the last window or thread scan, because no snapshot task ever runs.
- The job is a one-off `deliver` job with a `{ body }` payload, created like FR-17's notice
  (`github/syncClient.ts`, `inbox/notices.ts`). It carries the `<!-- grn:<jobId> -->` idempotency
  marker. The dispatcher already holds one-off jobs until the inbox opening is posted.

## 4. The snapshot sweep (new sync task kind `snapshot`)

### 4.1 Scheduling

- Add `snapshot` to `SyncTask` and to the `CANDIDATES` union in `sync/schedule.ts`. The task
  carries a `subscriptionId`, not a `categoryId`.
- **A subscription has a `snapshot` candidate only once its backfill is finished** (conditions
  1 and 2 of §3) **and** it has at least one **eligible** row: pending, with `retry_at <= now()`.
  - `[WHY]` A request costs about the same for 1 item as for 50. Waiting until backfill has
    created every row means every batch is full except the last.
  - `[WHY]` A user's tasks run one after another anyway, so starting the sweep later doesn't
    delay the summary. The total number of requests is the same either way.
  - The snapshots are therefore taken some time after backfill reached each item. That's accepted
    (§1).
- **Idle wake-up:** when no task is eligible, include the earliest pending snapshot `retry_at`
  among subscriptions whose backfill windows and thread scans are both gone in the next wake-up
  calculation, alongside the existing polling and incremental-discovery due times. Deferred
  snapshots must not wait for an unrelated task to become due.
- Score: §9.1's `wait / age^P × weight`, over the eligible rows. The terms are `[CALL]`:
  - **wait** = `now() − min(retry_at)`: how long the longest-waiting eligible row has waited.
  - **age** = `now() − max(tracked_content.last_event_at)` over the eligible rows' items: how old
    the freshest content in the batch is. `[WHY]` It mirrors backfill's `window_end` term. Old
    content scores lower, so polling of active content keeps priority.
  - **weight** = `w` (`discoveryWeight`), as for backfill.

  The builder may adjust the terms if tests show the sweep starving or hogging the queue.

### 4.2 One task

1. Pick up to `snapshotBatch` eligible rows among the subscription's items (new tunable in
   `config.ts`, default 50 like `probeBatch`), ordered by `retry_at`, then `node_id`.
2. Send one aliased `node(id:)` query, built like `reactionPollDocuments.ts`:
   ```graphql
   n0: node(id: $id0) {
     ... on Reactable {
       reactionGroups { content reactors { totalCount } }
     }
   }
   ```
   Plus `rateLimit { cost }`, logged per task as the other tasks do. `[TBD]` Whether `reactors`
   needs a `first:` argument (e.g., `first: 0`) for `totalCount`, and the real cost per 50 items:
   measure on first use. The expectation is <=3 per batch. If the cost is higher,
   stop and report it before going on.
3. In **one transaction**, under the lease like other tasks:
   - **Classify errors before interpreting alias data.** Associate errors with their requested
     alias, including errors at nested fields. Any non-`NOT_FOUND` per-alias error takes
     precedence over data or a missing `reactionGroups` field: defer that row as below, even if
     partial data survived or the error propagated to make the alias `null`. Never write partial
     counts or delete that row. Successful aliases in the same response are still processed.
     Configure `runQuery`'s error acceptance and response validation to allow these handled
     per-alias failures; errors that cannot be attributed to a requested alias remain
     request-level failures.
   - **Item with error-free, validated data:** `UPDATE reaction_snapshots SET <8 counts> WHERE user_id = $1 AND
     node_id = $2 AND thumbs_up IS NULL` (first write wins).
   - **Item deleted on GitHub:** it comes back `null` with a `NOT_FOUND` error, detected as in
     `polling/poll.ts`. Delete its snapshot row. `[WHY]` A deleted item has no reactions to
     count, and "items found" should mean items that still existed. Backfill can't re-insert the
     row, because search no longer returns the item. An error-free item that comes back as an object
     without `reactionGroups` gets the same treatment plus a warning, since that shouldn't happen
     for issues, PRs or comments.
   - **Item with any other per-alias error** (e.g., `FORBIDDEN` from SAML, M1 §9.3): leave it
     pending, set `retry_at = now() + snapshotRetryDelay` (new tunable, `[CALL]` 1 h), and log
     the error described below. `[WHY]` Otherwise the same failing rows head every batch and
     starve the rest.
   - **`null` without an error:** leave the row pending, defer it by
     `snapshotRetryDelay`, and log `"snapshot stuck, summary held"` with the same context below,
     identifying the failure as an unexpected null response rather than inventing a GraphQL
     error type. A null alone is not confirmed deletion; do not delete the row or write zeros.
   - If at least one row was filled or deleted: run the completion check (§3).
4. Request-level failures (timeout, rate limit, `401`) are handled exactly as for polling and
   backfill tasks.

**Permanently failing items (decided: never dropped):** a row that keeps failing with
non-`NOT_FOUND` errors stays pending and keeps being retried every `snapshotRetryDelay`. It holds
back the summary until it succeeds. Don't drop the row, write zeros for it, or otherwise give up
automatically. Instead, make the problem easy to spot so the operator can fix it: **every**
failed attempt on a row logs at **error** level, with the message `"snapshot stuck, summary
held"`. Include: user, subscription, `node_id`, the item's `url`, the GraphQL error type and
message, and how many of the subscription's rows are currently deferred (pending with
`retry_at > now()`).

## 5. The summary message

### 5.1 Aggregation

One query over the subscription's snapshot rows (the join in §2.2) joined with `content.type`:

- **Items found**: row count per type (`Issue`, `PullRequest`, `IssueComment`) and total.
- **Items with reactions**: rows whose eight counts sum to > 0 (total only).
- **Reactions**: sum of all eight columns over all rows (total only).
- **Per emoji**: sum of each column over all rows.

Content types added later (M2 discussions and discussion comments) become further columns in
the items table. The query must group by `content.type`, not hard-code three types. The columns
shown are the subscription's `subscription_types`, in a fixed order, with `0` for a type that has
no items `[CALL]`.

### 5.2 Rendering

New renderer next to `renderRevokedNotice` in `inbox/notices.ts`. Like every comment, it
mentions nobody (§11). Target layout, with numbers for illustration:

```markdown
## 📊 Your reactions so far

GRN finished scanning your history. Here's where things stand:

|             | Issues | Pull requests | Comments | Total |
|-------------|-------:|--------------:|---------:|------:|
| Items found |    120 |            45 |    2 310 | 2 475 |

- Items with reactions: 460
- Reactions: 1 359

👍 800 · ❤️ 210 · 🎉 120 · 🚀 90 · 😄 70 · 👀 40 · 😕 20 · 👎 9

From now on, new reactions show up here as they arrive.

<!-- grn:<jobId> -->
```

**Shortened form, when the subscription has no snapshot rows at all** `[CALL]`:

```markdown
## 📊 Your reactions so far

GRN finished scanning your history and found no issues, pull requests or comments of yours.

From now on, new reactions show up here as they arrive.

<!-- grn:<jobId> -->
```

- Emoji line: sorted by count, descending. Emoji with zero are omitted `[CALL]`. If there are no
  reactions at all, drop the emoji line.
- Number formatting is `[CALL]`: a thin/narrow no-break space as the thousands separator, as in
  the draft. Any consistent, locale-independent format is fine.
- Emoji glyphs are the ones `inbox/digestBody.ts` already uses for each `ReactionContent`. Reuse
  that mapping, don't duplicate it.

## 6. Schema delivery

M1 ships no migration framework (M1 §2). Add the table and index to
`packages/core/sql/schema.sql` directly. No upgrade script is needed (the app is unpublished, §1).

## 7. Tests (minimum)

- Backfill and thread-scan pages insert pending rows for kept items only. Re-reading a page
  inserts nothing new. An item already tracked by incremental discovery still gets a row.
- Incremental discovery inserts no snapshot rows.
- Scheduling: there's no `snapshot` candidate while the subscription has backfill windows or
  thread scans, even with 50 or more pending rows. There's one once both are gone and an
  eligible row exists. There's none while every pending row is deferred (`retry_at` in the
  future). When discovery is complete and a deferred snapshot becomes due before either polling
  or incremental discovery, the idle wake-up is that snapshot's `retry_at`. Snapshots belonging
  to subscriptions with unfinished discovery do not affect the idle wake-up.
- A sweep task fills counts, deletes rows for `NOT_FOUND`, and defers rows with other errors by
  `snapshotRetryDelay`, logging the "snapshot stuck, summary held" error on each failed attempt.
  Re-running it after a simulated crash changes nothing. Deferred rows don't block the next batch
  from picking other rows.
- The summary is queued exactly once, for each possible last step: the last window, the last
  thread scan (the zero-content case), the last snapshot batch, and the last pending row being
  deleted. It isn't queued before all three conditions hold, by a window that only shrank, or by
  a snapshot task whose every row failed.
- A user with zero content gets the shortened summary.
- Rendering: the table, totals, emoji ordering, emoji omission, the shortened form, and no
  mentions.
