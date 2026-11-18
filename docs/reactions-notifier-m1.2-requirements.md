# GRN — M1.2 Implementation Requirements: Summary-Only Mode

**Builds on:** `reactions-notifier-m1-requirements.md` (M1), `reactions-notifier-m1.1-requirements.md`
(M1.1) and `reactions-notifier-requirements-architecture-v1.md` (the "full doc"). IDs (FR-x,
NFR-x) and section refs (§x.y) point there; M1.1 refs are written "M1.1 §x". Where this doc and
M1 or M1.1 disagree, **this doc wins** for M1.2. The earlier docs stay unchanged as their
milestones' record.

**Markers:** as in M1.1 (`[WHY]`, `[TBD]`, `[CALL]`).

---

## 0. M1.2 in one paragraph

A user can sign in for a **one-time summary only**. GRN then scans their history and posts the
M1.1 summary as usual, but never polls for reactions, and does no work at all for them once the
summary is queued. The user can switch modes later with the two buttons on the home page:
"summary only" turns notifications off (a pause, for users who signed up for notifications),
and "get notified" turns them on again. Turning them on restarts the backfill from scratch and
re-counts every snapshot, so the user gets a fresh second summary. Choosing "summary only" again
after the summary was posted does the same rescan without turning notifications on. Mode
switches delete no data, except that turning notifications off drops notifications not yet
posted.

### What changes compared with M1 and M1.1

| Earlier docs say | M1.2 says |
|---|---|
| A `sync` job is deleted only on a permanent delivery failure (M1 §7.2) | Also when a summary-only user's summary is queued (§4.2), or when a user turns notifications off after their summary (§5) |
| "A returning sign-in does not recreate a deleted sync job" (M1 §12, §13) | A sign-in that **turns notifications on** or **asks for a fresh summary** recreates it (§6, §6.1). Other sign-ins still don't |
| `enabled_at` is stamped once, at signup (M1 §13) | Also re-stamped when notifications are turned on (§6) |
| One backfill window per category, inserted at signup, never re-walked (M1 §13) | Turning notifications on or asking for a fresh summary resets the window to cover all history up to now, so it is walked again (§6, §6.1) |
| The summary is posted exactly once (M1.1 §3) | Exactly once per completion. Both resets make the subscription incomplete again, so a fresh summary follows (§6, §6.1) |
| "Signup is the only place that creates a backfill window" (M1.1 §3) | Both resets create or reset one too (§6, §6.1) |
| Fan-out queues a notification for every user tracking the item (M1 §10) | Only for users in `notify` mode (§4.4). Turning notifications off drops the queued ones and the digest (§5) |

Everything else in M1 and M1.1 still holds, notably FR-6: no reaction older than the current
`enabled_at` is ever notified individually. As at signup, turning notifications on sets that
cutoff to `now − CLOCK_MARGIN`; reactions from the final two minutes of a pause may therefore
be notified if first discovered after resuming (§6, step 2).

## 1. Out of scope

- **A limit on fresh summaries** (§6.1). Each needs a full OAuth round trip, and its rescan
  spends the user's own quota.
- **Ordering successive summaries.** Keep the existing delivery queue unchanged. A later
  summary may be posted before an earlier one, for example while the earlier one awaits a
  retry. No enqueue sequence, predecessor check or ordering guarantee is required.
- **Confirmation comments in the inbox after a mode switch.** The status message on the site
  is the only confirmation.
- **Recovering users whose `sync` job a permanent delivery failure deleted** (M1 §12), except as
  a side effect of turning notifications on (§6) or of a fresh summary (§6.1).
- **Refreshing the inbox opening's text** after a mode switch. The opening reflects the mode the
  user first signed up with.
- **Any ongoing work for summary-only users** after their summary is queued, including
  incremental discovery. `[WHY]` Decided: a summary-only user who never returns must cost
  nothing.

## 2. Data model

Add to `users` in `packages/core/sql/schema.sql`:

```sql
  mode text NOT NULL DEFAULT 'notify' CHECK (mode IN ('notify', 'summary')),
```

- `notify`: today's behaviour. `summary`: no polling and no incremental discovery (§4).
- **No flag records whether the summary was sent.** "Summary sent" means the subscription is
  complete (M1.1 §3), checked with the existing `isSubscriptionComplete`. `[WHY]` Decided: a
  second summary after turning notifications on or asking again is wanted (§6, §6.1), so
  nothing needs to suppress it.
- Export and reuse `isSubscriptionComplete` from `summary/summary.ts` in the sign-in
  transaction (§3); do not duplicate its completion SQL.
- Schema delivery as in M1.1 §6: edit `schema.sql` directly, no upgrade script.

## 3. Sign-in: the two buttons and every transition

The home page offers two buttons, both of which run the OAuth flow:

- **"Get notified about reactions"**: the existing `/api/login`, action `signin`, target mode
  `notify`.
- **"Get a one-time summary"**: `/api/login?mode=summary`, new action `summary`, target
  mode `summary`.

The action travels in the OAuth `state`, as `signin` and `delete` do today (`STATE_PATTERN` in
`oauth.ts`). An FR-2a restart must keep the action; today it always restarts with `signin`.

Every sign-in, whatever its action, still stores the new token and login and sets
`token_status = 'active'` (FR-17), and requests the inbox if the user has none (§11).

"Complete" below means the user's subscription is complete (M1.1 §3), i.e. its summary has been
queued.

| Current state | "Get a one-time summary" | "Get notified about reactions" |
|---|---|---|
| **New user** | Signup with `mode = 'summary'`. Status `summary-requested` | Signup as today. Status `signed-in` |
| **`summary`, not complete** | No change. Status `summary-pending` | **Turn notifications on** (§6). Status `notifications-on-summary-pending` |
| **`summary`, complete** | **Fresh summary** (§6.1). Status `summary-again` | **Turn notifications on** (§6). Status `notifications-on` |
| **`notify`, not complete** | **Turn notifications off** (§5). Status `notifications-off-summary-pending` | No change. Status `signed-in` |
| **`notify`, complete** | **Turn notifications off** (§5). Status `notifications-off` | No change. Status `signed-in` |

- The completeness check and the transition run in the sign-in transaction, after the lock in
  §7.
- Signup in summary mode is today's signup transaction (M1 §13) plus `mode = 'summary'`: the
  same subscription, category, types, passes, window, `sync` job, channel and opening.
- The status texts are in §8.4.
- **Inbox link.** When the user's channel `target` is set, the callback adds it to the redirect:
  `/?status=…&inbox=owner%2Frepo%23123`. A new user's inbox isn't open yet, so their redirect
  has no `inbox`. The page links the inbox issue from it (§8.4).

## 4. Summary mode

### 4.1 Scheduling

In `sync/schedule.ts`, for users with `mode = 'summary'`:

- `CANDIDATES` yields **no `poll` and no `discovery` rows**. Backfill windows, thread scans and
  snapshots are scheduled as before.
- The idle wake-up likewise ignores `tracked_content` and `subscription_categories` for these
  users. Only deferred snapshot rows (M1.1 §4.1) can set it.
- Nothing else changes. `tracked_content` rows are still written by backfill and thread scans,
  just never polled, so turning notifications on has them ready (§6).

### 4.2 Deleting the `sync` job when the summary is queued

The transaction that queues the summary (`queueSummaryIfComplete`, M1.1 §3) reads the user's
`mode`. If it is `summary`, the same transaction **deletes the `sync` job instead of releasing
it**.

- The three callers (`runBackfill`, `runThreadScans`, `runSnapshotSweep`) end with `releaseSync`,
  which treats a missing row as a lost lease. The builder decides how the callers learn that
  the job was deleted (e.g., a helper that releases or deletes).
- After this the user has no jobs except possibly undelivered `deliver` jobs (the summary
  itself), and GRN does no work for them.

### 4.3 FR-17 in summary mode

A summary-mode user can still hit a `401` while their scan runs. Keep FR-17's behaviour, but
render a summary-mode variant of the notice (§8.3). After the summary, there are no requests, so
no `401` can occur.

### 4.4 No notifications in summary mode

`fanOut` queues `reaction_notifications` only for users with `mode = 'notify'` (join `users` on
`content_sources.user_id`). Users in summary mode get no rows, so no digest is opened for them.

- `[WHY]` A poll whose request started before a switch to summary mode commits after it (§7).
  Without this check, its fan-out would queue notifications and open a new digest after §5
  dropped the old ones.
- The poll still stores its `reaction_events`. These stored events are never notified later:
  fan-out only sees newly inserted `reaction_events`, not existing ones. Reactions first
  discovered after resuming instead follow the cutoff in §6, step 2.

## 5. Turning notifications off (`notify` → `summary`)

In the sign-in transaction:

1. Set `mode = 'summary'`.
2. If the subscription is **complete**: delete the user's `sync` job. A worker holding its lease
   loses it at its next commit (M1 §7.3), as in FR-3's deletion.
3. If it is **not complete**: keep the job. Polling and incremental discovery stop at the next
   task (§4.1). The job is deleted when the summary is queued (§4.2).
4. **Drop pending notifications**, in this order (§7):
   1. Delete the user's digest job, `open` or `rendered`. A dispatcher holding its lease loses
      it at its next fenced transaction, as with FR-3's deletion.
   2. Delete the user's `queued` `reaction_notifications` rows.
   - The only digest that can still appear is one whose post is already on its way to GitHub
     when the sign-in commits. A rendered digest that's waiting for a retry may or may not have
     been posted already. Deleting it means no retry and no marker check, so it can't be posted
     twice.
   - The deleted rows are never re-notified: their `reaction_events` remain stored, and fan-out
     only sees newly inserted `reaction_events`.
   - New notifications can't follow, not even from a poll already in flight (§4.4).

Nothing else changes.

## 6. Turning notifications on (`summary` → `notify`)

In the sign-in transaction, for each of the user's categories. Steps 3, 5 and 6 are **the
rescan**, which §6.1 reuses.

1. **Set `mode = 'notify'`.**
2. **Re-stamp FR-6.** `subscription_types.enabled_at = now − CLOCK_MARGIN`. Raise every
   `tracked_content.watermark_at` to at least that value, and set `last_checked_at = now()`.
   - `[WHY]` Fan-out tests each reaction against the *current* `enabled_at` (`fanOut.ts`), and
     `discovery/store.ts` seeds new rows from it, so reactions older than that cutoff are never
     notified. The watermarks only save the drill-downs.
   - **Accepted clock-margin overlap.** Retain signup's `CLOCK_MARGIN` (2 min) to accommodate
     clock skew. Reactions from the final two minutes of summary mode may be notified if
     first discovered after resuming. Strict exclusion of every reaction created during the
     pause is not required.
3. **Restart the backfill.** Upsert the category's window as
   `window_start = 1970-01-01T00:00:00Z, window_end = now()`:
   `INSERT … ON CONFLICT (category_id, window_start) DO UPDATE SET window_end = now()`.
   - If the original window is gone (backfill was finished), this inserts a new one. If it still
     exists, the walk starts over from the newest end.
   - `[WHY]` A window only covers threads *created* in its range. A window from the last scan to
     now would miss the user's new comments on older threads. A full re-walk reads every thread
     as it is now, so it finds them. Re-reading already stored content is idempotent and costs
     the same as the first signup. Decided: acceptable for the alpha.
   - Existing `thread_scans` rows are kept. A finished thread that a page reaches again gets a
     new row, as at signup (`ON CONFLICT DO NOTHING`). An unfinished one keeps its `since_at`,
     which is the point it has already read up to.
   - **No timestamps besides `window_end` are reset.** `thread_created_at` is the thread's real
     creation date and doesn't change. `window_created_at` and `scan_created_at` only feed the
     scheduling score's wait (M1 §9.1). An old value just makes the work due sooner, which is
     fine.
4. **Reset the incremental pass watermarks** to `now − search overlap margin`, as at signup.
   `[WHY]` In summary mode no pass ran. Walking the whole gap would overflow (M1 §9.2) and log
   errors for content the re-walk covers anyway.
5. **Reset the snapshots.** Set all eight counts to `NULL` and `retry_at = now()` for every
   snapshot row of the subscription (join as in M1.1 §2.2).
   - `[WHY]` Decided: the second summary must be accurate. Without the reset, old items would
     keep the counts of the first sweep.
   - The sweep runs only once the re-walk has finished (M1.1 §4.1), so the rows are not
     re-counted twice.
6. **Recreate the `sync` job** if it is missing:
   `INSERT INTO jobs (kind, user_id) VALUES ('sync', $1) ON CONFLICT DO NOTHING`
   (`jobs_one_sync_per_user`). If it exists, set its `run_at = now()`.

**The second summary.** When the re-walk, its thread scans and the snapshot sweep are all done,
the existing completion check fires again and queues a fresh summary (M1.1 §3), in notify
mode's wording (§8.2). If the user switches while their first summary is still undelivered, both
remain queued for delivery; their posting order is not guaranteed (§1).

**Repeated switches** work the same way each time. Every "turn on" restarts the walk and resets
the snapshots. Every "turn off" stops polling.

### 6.1 A fresh summary without notifications (`summary`, complete → `summary`)

A summary-mode user whose summary was queued chooses "Get a one-time summary" again. In
the sign-in transaction, run **only the rescan** (§6, steps 3, 5 and 6): reset the window,
reset the snapshots, and recreate the `sync` job.

- The mode stays `summary`, so §4 applies: no polling and no incremental discovery. When the
  rescan is done, the completion check queues the fresh summary in summary mode's wording (§8.2)
  and deletes the `sync` job again (§4.2).
- **Steps 1, 2 and 4 are skipped.** Nothing reads `enabled_at`, the item watermarks or the pass
  watermarks in summary mode. Fan-out skips the user (§4.4), and neither polls nor passes run.
  Turning notifications on later sets all three anyway (§6).
- The `sync` job was deleted with the first summary (§4.2), so no task can be running, and
  there's no `sync` row to lock (§7). A summary that hasn't been delivered yet remains queued
  alongside the fresh one; either may be posted first (§1).
- `summary`, **not** complete: no change (§3). The scan that's already running posts the
  summary.

## 7. Concurrency

- **Lock order: the user's `sync` job row, then the `users` row.** For an existing user, the
  sign-in transaction locks the `sync` job row (`SELECT … FOR UPDATE`) before it writes `users`.
  Every `sync` task transaction already starts by renewing its lease, which locks that row
  first. Permanent delivery failure and FR-3's deletion follow the explicit order below.
  - `[WHY]` Sign-in and the user's running task then take turns. A switch never interleaves with
    a task's transaction, and the task's completion check in §4.2 sees the committed mode.
  - The reverse order (sign-in locking `users` first) could deadlock with a task that refreshes
    `users.login`.
  - If the user has no `sync` job, skip that row lock, but still lock the `users` row to
    serialize sign-ins and cleanup that could otherwise race with recreating the job.
  - **Re-check once the `users` lock is held.** Waiting for that lock may have let a concurrent
    sign-in create and commit the `sync` job, and a worker may already hold it. Touching it now
    (a rescan's upsert, deleting the user's jobs) would take the locks in reverse. So set a
    savepoint before the two locks, and if no `sync` row was locked but one exists now, roll
    back to the savepoint, which gives up the `users` lock, and take both locks again in order.
    Only sign-in creates `sync` rows, and only under the `users` lock, so none can appear once
    that lock is held and a single check suffices. One helper (`lockSyncAndUser`) does this for
    sign-in, permanent delivery failure and FR-3's deletion.
    - `[WHY]` Without it, a fresh-summary sign-in that recreates the job, a second sign-in
      turning notifications on (or an account deletion) waiting for `users`, and a worker
      claiming the new job deadlock: Postgres aborts one of them after `deadlock_timeout`.
      Reproduced on a real Postgres (§9).
- **Permanent delivery failure: `sync` job, then `users`, then the leased `deliver` job.**
  In `settleFailure`, the permanent-failure branch opens a transaction, locks the user's
  existing `sync` row with `SELECT … FOR UPDATE`, then locks the `users` row, and only then
  renews/checks the delivery lease. If the lease was lost, roll back and stop without deleting
  anything. Otherwise delete all of the user's jobs in that same transaction, as today.
  - Do **not** enter the existing `withLease` first: its renewal already locks the delivery
    row. Perform the prerequisite locks before renewing the lease.
  - `[WHY]` Otherwise sign-in can hold `sync` while waiting for the digest, and permanent
    failure can hold that digest while waiting to delete `sync`, creating a deadlock.
  - **FR-3 account deletion uses the same order:** lock the existing `sync` row, then the
    `users` row, then delete the user's jobs before deleting their data. Do not rely on the
    row-lock order of the existing unordered bulk `DELETE FROM jobs`.
- **Dropping notifications (§5, step 4): the digest job, then `reaction_notifications`.**
  `renderDigest` locks the digest's job row first and then marks the rows `delivered`, so the
  sign-in takes the same order. Either way the digest job is deleted. If the dispatcher held
  its lease, it loses it.
  - `fanOut` locks in the opposite order (rows, then digest). In M1.2, the only source is
    `authored`: each item belongs to its author, so every fan-out recipient is the user whose
    poll produced the event. That poll holds the `sync` job lock taken at the top of the
    sign-in, so the two never overlap. This argument depends on the authored-only scope,
    not on `fanOut` itself, which selects every matching recipient through `content_sources`.
    Adding sources that let multiple users track the same item requires revisiting this
    locking protocol.
- **Compare-and-swap on the backfill window.** A worker may have read the window before a switch
  reset it (§6, step 3) and commit its page afterwards. `runBackfill` must update or delete the
  window only if `window_end` still equals the value it read the page with. If it changed, keep
  the page's upserts (they are idempotent) but leave the window as it is, then release the job
  as usual.
  - `[WHY]` Otherwise the old page would move the reset `window_end` back, or delete the reset
    window, and the restarted walk would skip everything newer.
- **Snapshot sweep during a switch.** A sweep whose request started before the reset may still
  fill rows with counts from seconds earlier. That's accepted (M1.1 §1's snapshot semantics). Its
  completion check sees the reset window and does nothing.

## 8. Texts

### 8.1 Inbox opening (`inbox/opening.ts`)

Rendered once, in the mode of the first sign-in.

- **Notify mode:** today's text, plus a pause hint. Replace the line
  "To stop, delete your account at {site}." with:

  > To stop notifications, choose "Get a one-time summary" at {site}. To resume,
  > choose "Get notified about reactions" there. To delete your data, delete your account there.

- **Summary mode:**

  > Hi @{login}, this is your GitHub-Reactions-Notifier inbox.
  >
  > Your sign-in to GitHub-Reactions-Notifier requested this issue. You asked for a one-time
  > summary of the reactions to your issues, pull requests and comments. It will be posted here
  > once GitHub-Reactions-Notifier has scanned your history.
  >
  > To also get notified about new reactions, choose "Get notified about reactions" at {site}.
  > To delete your data, delete your account there.

### 8.2 Summary (`renderReactionSummary`)

The summary is rendered when it is queued, in the user's mode at that moment.

- **Notify mode:** unchanged ("From now on, new reactions show up here as they arrive.").
- **Summary mode:** replace that closing line with:

  > That's it: you asked for a one-time summary, so GitHub-Reactions-Notifier won't post here
  > again unless you ask.
  > For a fresh summary, choose "Get a one-time summary" again at {site}. To get
  > notified about new reactions, choose "Get notified about reactions" there.

The site URL comes from where FR-17's notice gets it.

### 8.3 FR-17 notice in summary mode

> GitHub-Reactions-Notifier can no longer read your content: its access to your GitHub account
> was revoked or has expired. Scanning has stopped, so your summary can't be completed.
>
> To resume, choose "Get a one-time summary" again at {site}.

### 8.4 Status messages (`StatusMessage.tsx`)

| Status | Message |
|---|---|
| `signed-in` | unchanged without `inbox`. With it: You're signed in. New reactions show up in your inbox issue. |
| `summary-requested` | You're signed in. Your inbox issue will be opened shortly, and your summary is posted there once GitHub-Reactions-Notifier has scanned your history. |
| `summary-pending` | Your summary is still being prepared. It will be posted to your inbox issue once it's completed. |
| `summary-again` | GitHub-Reactions-Notifier is rescanning your history and will post a fresh summary to your inbox issue when it's done. |
| `notifications-on` | Notifications are on. Additionally, GitHub-Reactions-Notifier is rescanning your history and will post a fresh summary to your inbox issue when it's done. |
| `notifications-on-summary-pending` | Notifications are on. Additionally, your pending summary will be posted to your inbox issue when the scan is done. |
| `notifications-off` | Notifications are off. Choose "Get notified about reactions" to turn them back on. |
| `notifications-off-summary-pending` | Notifications are off. Your pending summary will still be posted to your inbox issue when the scan is done. |

**Inbox link.** When the URL has an `inbox` parameter (§3), "your inbox issue" links to
`https://github.com/{owner}/{repo}/issues/{number}`. Without it, the text stays plain.

- Accept the parameter only if it matches `^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+#[0-9]+$`. Otherwise
  ignore it. `[WHY]` The URL can be edited, so the link must not point anywhere except a GitHub
  issue.
- Drop `inbox` from the URL together with `status`.

### 8.5 Home page (`Home.tsx`)

Two buttons instead of one sign-in link, with one sentence each:

- "Get notified about reactions": a summary of your existing reactions, then a notification for
  every new one.
- "Get a one-time summary": a summary of your existing reactions, nothing after that.
  You can turn notifications on later.

## 9. Tests (minimum)

- **Sign-in table:** each cell of §3 ends in the right mode, `sync` job state, window and
  snapshot state, and status. Every action reactivates a revoked token. An FR-2a restart keeps
  the `summary` action.
- **Scheduling:** a summary-mode user gets no `poll` or `discovery` task, even with due items and
  categories. The idle wake-up ignores them. Backfill, thread scans and snapshots still run.
- **Job deletion:** in summary mode, each of the three completing task kinds deletes the `sync`
  job instead of releasing it, in the transaction that queues the summary. In notify mode, the
  job is released as before. Turning notifications off on a complete subscription deletes the
  job; on an incomplete one it keeps it.
- **Turning notifications off:**
  - queued notifications and the digest job, open or rendered, are dropped;
  - a poll that started before the switch and commits after it queues nothing and opens no
    digest;
  - a dispatcher that leased the digest before the switch, and hasn't posted yet, loses its
    lease without posting.
- **Turning notifications on:**
  - a reaction older than the new `enabled_at` is never notified; a reaction from the accepted
    clock-margin overlap may notify if first discovered after resuming. An event already
    stored by a poll before resuming is not replayed;
  - a comment written during summary mode on a thread created before signup is tracked after
    the re-walk;
  - the snapshot rows are pending again, and a fresh summary is queued once the re-walk and the
    sweep are done;
  - a missing `sync` job is recreated, and an existing one is due immediately.
- **Fresh summary (§6.1):** after the first summary, "summary only" again resets the window and
  snapshots and recreates the `sync` job. It leaves `mode`, `enabled_at` and all watermarks
  unchanged and schedules no poll or discovery. It ends with a second summary in summary mode's
  wording and a deleted `sync` job. Before the first summary is complete, the same click changes
  nothing.
- **Concurrency:**
  - a backfill page read before a reset does not move or delete the reset window, but its
    upserts are kept;
  - a sign-in waits for a running task transaction, and vice versa (PGlite serialises them; check
    the lock order once against a real Postgres, as in M1 step 8);
  - `lockSyncAndUser` locks again in order when a `sync` row appeared while it waited for the
    `users` lock (PGlite: a stand-in insert after the first `users` lock forces the retry).
  - Checked once against a real Postgres 16 with several connections: both waits above hold.
    The §7 re-check race deadlocked (`40P01`) without the re-check, for sign-in and for FR-3's
    deletion alike, and completed with it.
- **Texts:** both opening variants (the notify one has the pause hint), both summary closing
  lines, the summary-mode FR-17 notice, and no mentions in any of them except the opening's
  mention of the user.
- **Inbox link:** the redirect carries `inbox` exactly when the channel `target` is set. The
  page links a valid value and ignores an invalid one, e.g. `evil.com/x#1/../` or a `javascript:`
  URL.

## 10. Follow-ups outside the code

- `README.md`: replace "Only want the summary?" with the new option. In the table, drop the
  "Pausing" row from "Not yet included". Explain that turning notifications on, or asking for the
  summary again, rescans your history and posts a fresh summary.
- `apps/frontend/src/content/docs/docs/index.md`: mention both options.
