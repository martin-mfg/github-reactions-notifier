# GRN — M1 (MVP) Implementation Requirements

**Source:** `reactions-notifier-requirements-architecture-v1.md` (the "full doc"). IDs (FR-x, NFR-x,
Cx) and section refs (§x.y) point there. This extract contains **only what M1 needs**. If it
conflicts with the full doc, ask what to do. Report the conflict; don't resolve it silently.

**Markers**
- `[WHY]` a one-line reason. Do not "simplify" these constraints away.
- `[TBD]` a value or mechanism the full doc leaves open. Do not invent one; use the stated
  placeholder and make it configurable.
- `[EXTRACTOR]` an interpretation made while extracting. Confirm during review.
- `[SIMPLIFIED]` a rare case that M1 only detects: it logs an error and moves on. The full
  doc's proper solution comes in a later milestone. Do
  **not** build the proper solution in M1.

---

## 0. M1 in one paragraph

A single-user alpha. A user signs in via a GitHub **OAuth App** with **no scopes**. GRN then
discovers everything the user **authored** (issues, PRs, and issue/PR comments), across all
time. It polls those items for new reactions with a budget-driven priority queue on the
user's own token. Batches of new reactions go out as comments on the user's own **inbox
issue**, which a **machine account** opens and posts to in a public inbox repo. Reactions
that existed before sign-in are never notified. The user can delete their account.

### Implemented policy baseline

The source of numeric defaults is `apps/backend/src/config.ts`, not earlier design examples.

| Policy | Implemented M1 behavior |
|---|---|
| Minimum polling and discovery delay | Both 4 min |
| Clock margin | 3 min; `D > CLOCK_MARGIN` |
| Search overlap | 1 hour placeholder, pending M0 calibration |
| Self and bot reactions | Included; no self/bot filter is implemented |
| Null reactor | Stored and notified as `ghost`, with synthetic identity `ghost:<createdAt>` (canonical ISO timestamp) |
| Backfill completion | No notification or summary |
| Permanent delivery failure | Log and delete all of that user's jobs, including `sync`; keep other rows. A returning sign-in does not recreate `sync` |
| GitHub request timeout | 2 min per request, including OAuth exchange, grant deletion and viewer lookup; no intermediate REST `/user` lookup |
| Health probe | Separate short-lived database connection; 5 s total deadline, connection and statement timeouts, always closed. Missing database is down (`503`, except shields format) |
| Backfill lower bound | `1970-01-01T00:00:00Z`, predating GitHub, regardless of account creation. Existing installations require the one-time `packages/core/sql/repair-backfill-history.sql` repair before restarting |
| Release image smoke test | Process/page liveness at `/`, with the page-content assertion retained; no database required |

### Remaining implementation and verification gaps

- Delivery reconciliation currently checks only 100 issues/comments. A missing marker on a
  full page is not proof of absence; this is an unresolved FR-9a gap. A recorded
  `attempted_at` triggers reconciliation, not every job claim or only a caught interruption.
- Database concurrency tests use a single serialized PGlite connection. They verify
  sequential outcomes, not PostgreSQL lock waits, snapshots or `SKIP LOCKED` races.

---

## 1. Out of scope for M1 (do NOT build)

- Sources other than `authored`: no `owned_repos`, no `repo:<owner/name>`.
- Content types other than `Issue`, `PullRequest`, and `IssueComment` (on issues and PRs). No
  discussions, discussion comments, PR reviews, review comments, commit comments, or releases.
- Per-type/category switches (FR-4d), filters (FR-11), mute, and parked rows.
- Cadences other than near-instant batching (FR-10). No settings UI, and no status page (FR-16).
- Channels other than the GitHub-native inbox: no Atom, webhooks, in-app inbox, or e-mail.
- The private tier (`repo` scope) and the upgrade/downgrade between tiers (FR-2).
- The `/`-command control plane, including `/stop` and `/start` (FR-3a), and the inbox-repo
  webhook route.
- Dead-letter queue (M3; alert instead), reactor opt-out list (FR-9b, M3), shared polling of
  public content (M4).
- FR-6's backfill-completion summary (removed from M1 by decision).
- Proper handling of these rare cases, which M1 only detects and logs (`[SIMPLIFIED]`): the
  livelock-guard handoffs (incl. comment catch-ups), drill-down overflow, the stuck second,
  inbox rollover, and permanent delivery failures (§12).
- Refreshing `content` metadata (titles, repo names, URLs, logins) after the first write.
  This is a known gap (§9.2).
- Data export (never). Reaction removals, trend alerts.
- **Rejected outright:** a per-user quota column, a `sync_cursors` table, and a per-item reaction
  count vector.
- **Deferred schema, do not add yet:** `subscriptions.kind/.target/.enabled`,
  `subscription_categories.enabled`, `subscription_types.enabled`, `tracked_content.parked`,
  `tracked_content.muted_at`, `users.tier/.scopes/.stopped_at/.gh_database_id`, `filters` columns,
  `rate_limit_state.observed_at`, `notification_channels.cadence/.secret/.verified_at`, and the
  `outbox`, `discovery_targets`, and `target_passes` tables.

## 2. Must not be precluded (M2+ depends on these)

Every later change is meant to be an **additive migration**. That holds only if M1 gets these
right:

- The **subscription → category → type → pass** table split ships in M1 in its fixed shape:
  1 subscription, 1 category `issue`, 3 types, 3 passes. `[WHY]` Adding it later would re-key
  `backfill_windows`, which is a rewrite.
- **`enabled_at` per type** (`subscription_types`), not per subscription.
- **Node IDs everywhere** as identities, always in the new global ID format (C13).
- `content` and `reaction_events` are **global**. `reaction_notifications` and `tracked_content`
  are **per user**. `content_sources` is a set. `[WHY]` Several users and sources will share
  items later (§6.5).
- The FR-6 silence test is **per reaction**: `reaction.createdAt` vs the type's `enabled_at`.
- **Deferred contract, not implemented:** source, channel and poller adapter interfaces.
  M1 currently hardcodes task dispatch in `sync/schedule.ts` and GitHub delivery in
  `inbox/dispatcher.ts`. Typed module functions are not the promised pluggable contracts.
- The score has a `value_weight` term (poll = 1, discovery/backfill = `w`).
- ~~Migrations are **real migrations**, not `CREATE TABLE IF NOT EXISTS` (§7.2).~~ **Decided
  in step 1:** M1 ships no migration framework. A single `schema.sql` creates
  everything, and the operator applies it by hand. How later schema changes get applied is
  deferred until one is needed.

---

## 3. Platform facts the implementation relies on (§2)

- **C1** There is no reaction webhook, so polling is mandatory.
- **C2/C3** `Reaction.createdAt` exists. `reactions(orderBy: {field: CREATED_AT, direction: DESC})`
  lets a poll stop at the first reaction older than the watermark.
- **C5/C7** `user.issues` and `user.pullRequests` can be ordered by `CREATED_AT`.
  `user.issueComments` can be ordered by `UPDATED_AT` **only**. `[WHY]` An `UPDATED_AT` order is
  unstable under pagination, so comment *backfill* must go through parent threads found by
  `search`.
- **C8** 5,000 GraphQL points per hour **per user**, shared with all of that user's other apps
  and PATs.
- **C9** `search(type: ISSUE)` supports `sort:created-asc`/`-desc`, `created:A..B`, and `involves:` /
  `author:` / `commenter:`. It returns **threads only, never comments**.
- **C10** The search index lags behind the data. Search-driven passes re-scan an overlap
  margin.
- **C13** **Every GraphQL request sends `X-Github-Next-Global-ID: 1`.** Optionally assert this in CI.
  `[WHY]` Otherwise most historical node IDs come back in a legacy format slated to stop
  working.
- Do **not** use `ReactionGroup.createdAt`. It returns the group's *oldest* reaction (§6.3).
- **No GraphQL cursors** in M1: every task is a single query, and watermarks, date windows and
  `since_at` carry progress between tasks. A connection that doesn't fit in one page is an
  **overflow**, which M1 only logs (§9.2, §9.3, `[SIMPLIFIED]`).
- **Design axiom:** poll with the **user's own token**, never a shared PAT pool.

---

## 4. Functional requirements (M1 subset)

### Onboarding and identity
- **FR-1** Sign-in uses a GitHub **OAuth App**, not a GitHub App. `[WHY]` A GitHub App cannot
  read the user's content in accounts where it isn't installed. The sign-in page states that
  GRN will open a **public inbox issue** for the user. Signing in is the user's only step.
- **FR-2a** Accept a sign-in only if the token-exchange response's `scope` is **empty**.
  Otherwise, discard the token without storing it, call
  `DELETE /applications/{client_id}/grant`, and restart the no-scope flow. `[WHY]` Scopes the
  user granted earlier stick to later sign-ins, and the `client_id` is public. A `repo` token
  could leak private content into the public inbox. Guard against an infinite loop.
- Use a **separate OAuth app and separate tokens** from github-stats-extended. Never reuse its
  tokens (Key decision 5).
- **FR-3** One action deletes the user's account and all data held about them: token, content
  index, reaction history, and channels. This **includes** the global `content` and
  `reaction_events` rows no other user still references. In M1 that is all of the user's.
  - (a) the OAuth grant is revoked via
    `DELETE /applications/{client_id}/grant`; (b) the inbox issue on GitHub is left as-is.
  - Deleting the user's `jobs` rows makes any running worker lose its lease at
    its next commit (§7.3, step 2), so deletion needs no extra coordination.

### Detection
- **FR-4/4a** M1 has exactly **one implicit `authored` source** per user. It covers issues,
  PRs, and issue/PR comments the user wrote, in all repositories the token can see (public
  tier).
- **FR-4b** Track content across **all time**, with no recency horizon. Check frequency decays
  with age (§6). A new reaction resets an item's age. No item is re-checked sooner than
  **`D` = 4 min**, even when budget is spare.
- **FR-5** Record the reactor, emoji, timestamp, the reacted-to item, and the matching
  source(s).
- **FR-6** Pre-existing reactions are **never** notified. The test is per reaction: a reaction
  notifies only if `createdAt ≥` its type's `enabled_at` (stamped `now − CLOCK_MARGIN`).
  The item's age, and how or when it was discovered, are irrelevant. This is implemented purely
  by initialising `tracked_content.watermark_at = enabled_at`; there is no special first poll.
  FR-6's backfill-completion summary is **not** part of M1.
- **FR-7** Each (content, reactor, emoji) notifies **at most once per user**, across re-adds,
  retries, and restarts.
- **FR-8** Detection latency is measured, not guaranteed. **Log** the p50/p95 latency
  (detection time − `reacted_at`) for recently active content. It is not stored.

### Notification
- **FR-9** The GitHub-native inbox (§11) is the **only** channel.
- **FR-9a** Delivery is serialised, paced, retried (§12), and **idempotent**. An ambiguous
  failure must never produce a duplicate comment.
- **FR-10** Near-instant only: batch each user's reactions over **3 min**. Under load, the
  batches simply grow larger and arrive further apart.
- **FR-12** Fixed policy, not stored settings: include the **user's own** reactions. This is only for testing and might be changed in a later version.
  Bot reactions are also included; there is no bot filter in M1.
- **FR-15** Digests group by content item, then by emoji: "5 new 👍 and 2 🎉 on *item*". In M1
  every item is the user's own, so no author or source labels are needed. The anti-mention and
  anti-cross-reference rendering rules are in §11.
- **FR-17** On a revoked or expired token (`401`), stop polling (`token_status = 'revoked'`) and
  queue a one-off notice to the inbox. That still works, because the machine account posts it.
  A new sign-in reactivates the account.

### Operations
- **FR-18** A public health endpoint, mirroring `/api/status/up`.
  - `[EXTRACTOR]` The roadmap doesn't explicitly place it in M1. It is cheap, so it is included.
    FR-16 (the user's sync status) is treated as **M2**, because §6.5 says "M1 has no status
    page".

## 5. Non-functional requirements (M1 subset)

- **NFR-1** Vercel **Pro** and Postgres, with no always-on cluster. `[WHY]` Hobby cron runs
  only once per day; Pro allows once per minute. Vercel runs the app as a Docker image built
  from `Dockerfile.vercel`.
- **NFR-2** Never exhaust a user's GitHub rate limit. One global budget policy (§8).
- **NFR-3** Tokens are encrypted at rest as in github-stats-extended PR #536: AES-256-GCM, a
  32-byte key from `TOKEN_ENCRYPTION_KEY` (hex or base64), `user_id` (= `gh_user_id`) as AAD,
  a `v1.` ciphertext prefix, and comma-separated keys for rotation (the first encrypts, all
  decrypt). **Stricter than PR #536:** the key is mandatory, with no plaintext fallback, no
  legacy read path, and no migration script. An undecryptable token sets
  `token_status = 'invalid'` (the user must log in again); it must not crash.
- **NFR-4** GDPR deletion (FR-3). M1 is public-tier only, so no private content can reach
  the inbox. FR-2a enforces this.
- **NFR-5** The service must not be usable as a spam relay. In M1 this means §11's rendering
  rules: never mention or cross-reference anyone but the inbox owner. NFR-5's webhook SSRF
  guard is M2.
- **NFR-6** Every stage is safely retryable: jobs run at least once, and user-visible effects
  happen exactly once.
- **NFR-7** Structured logs and per-stage counters. Until the M3 dead-letter queue exists, an
  alert stands in for it. Log at least: the measured `rateLimit.cost` of each query (alarm
  above 3), FR-8 latency, the delivery wait (§12), permanent delivery failures (§12), reaper
  rescues, missing items, login mismatches, and the offset of GitHub's `Date` header (alarm
  above 2 s).
- **NFR-8** Use the same toolchain as github-stats-extended: pnpm workspaces, turbo,
  TypeScript, vitest, eslint/prettier/knip, an Astro + React web app (Starlight docs), Vercel,
  and Postgres.

---

## 6. Repository and code reuse (§7.2, §7.3 Phase 0; Key decisions 1 and 6)

- Create a **new repo** under a **separate org or account for the beta**. `[WHY]` This is a
  reputational firewall for github-stats-extended.
- Copy these reusable modules from github-stats-extended into `packages/`, keeping their
  public API:
  - OAuth: `apps/backend/src/users.ts` and the user-related parts of `database.js`. Add
    NFR-3's encryption.
  - GitHub client: `packages/core/src/common/retryer.ts`, `http.ts`, `graphql/`, and the
    codegen script. Add a **per-user-token mode**.
  - Platform: `common/config.ts`, `log.ts`, `error.ts`.
  - Database: the pool, plus a manually applied `schema.sql` (see §2).
- **Done in step 1** as one package, `packages/core` (`@grn/core`), with a single entry
  point. Its files keep github-stats-extended's layout. The modules are copied unchanged,
  except:
  - `constants.ts` defines `RepositoryAffiliation` inline instead of importing it from
    generated GraphQL types.
  - `http.ts` sends the C13 header (§3) on every request.
  - `users.ts` exports `githubAuthenticate(code)`, a token exchange returning
    `{ accessToken, hasScope }` without an identity lookup. The sign-in callback revokes
    scoped grants and restarts before requesting `viewer`; only a no-scope token is stored.
  - The user-related parts of `database.js` target github-stats-extended's schema. They are
    adapted to §13 in step 3, together with NFR-3's encryption.
  - The retryer keeps PAT rotation (github-stats-extended needs it). Step 4 adds the
    per-user-token mode next to it, and GRN uses only that mode.
- **Unimplemented guard:** app-specific imports in `packages/` are forbidden by design, but
  `eslint.config.js` currently enables neither `import-x/no-restricted-paths` nor
  `no-restricted-imports`. This boundary is not lint-enforced.
- **Writes need a separate, mutation-safe retry path.** `[WHY]` The existing retryer rotates
  PATs and retries freely, which is unsafe for content creation (§12).

---

## 7. Runtime architecture (§6.1, §6.2)

Components: a **web app** (OAuth, sign-in page, account deletion, health endpoint), a
**scheduler** (Vercel Cron), **workers** (sync and deliver), a **token service**, and
**Postgres** for both state and the job queue. Workers are plain Node code driven by
`SELECT … FOR UPDATE SKIP LOCKED`, so they run unchanged as Vercel functions or in a
container.

### 7.1 Scheduler
- Vercel Cron runs **every minute**. It (a) starts worker invocations and (b) reaps expired
  leases. It makes **no GitHub calls** and enqueues nothing.
- How many worker invocations each cron run starts: make it configurable, start with 1.
  `[WHY]` Idle workers wait instead of exiting, so each runs for most of `maxDuration`. One per
  cron run already keeps about 10 invocations alive at the same time.
- Functions run for up to 800 s (`maxDuration`). A worker invocation loops: claim a job, run
  **one task** (§9.1) or one `deliver` job, release it, and repeat. When nothing is due, it
  does **not** exit. It waits `IDLE_WAIT` without holding a lease, then tries to claim again.
  Make `IDLE_WAIT` configurable, start with 60 s. The worker claims no job within two request
  timeouts (4 min) of `maxDuration`, and exits instead of waiting past that point.
  `[WHY]` A task makes at most two requests: a poll's probe and drill-down, or a delivery's
  marker check and post. Releasing after every task keeps leases short and gives a per-task
  round-robin across users (§7.2).
  `[WHY]` The dispatcher may not sleep while holding a lease (§7.3), and the next `deliver` job
  often becomes due shortly after the previous one: after the ≥ 1 s spacing, a bucket refill,
  or the end of a pause (§12). A worker that is still running picks that job up. If it exited
  instead, the job would wait for the next cron run.

### 7.2 Job kinds (M1)
| Kind | Rows | Purpose |
|---|---|---|
| `sync` | One per user, inserted at signup, never deleted except on a permanent delivery failure (§12). `UNIQUE (user_id) WHERE kind = 'sync'` | Works the user's score-ordered queue: discovery, backfill, thread scans, and polling. Fan-out and `reaction_notifications` inserts run inside its transactions. Creates FR-17's notice on a `401`. |
| `deliver` | One per message, deleted once posted | One machine-account write: a digest, a one-off message, or the inbox opening. |

`[WHY]` Each user has a single `sync` job, so there is only ever **one in-flight request per
user token**.

**Sync due rule** (evaluated at claim time, without calling GitHub):
```sql
locked_by IS NULL AND run_at <= now()
  AND users.token_status = 'active' AND budget_has_room(rate_limit_state)
```
`budget_has_room`: if `now > reset_at + CLOCK_MARGIN`, the window has rolled over, so treat
`used` as 0. Otherwise apply §8's guard to the stored `limit_`, `used`, and `reset_at`.

**`run_at` means "not before".** It stores only what no other table records:
- When a task ends normally: `run_at = now()`. `[WHY]` Claims take the oldest `run_at` first,
  which gives a round-robin across users.
- Backoff after a failure.
- A secondary limit's `retry-after`, or `x-ratelimit-reset + CLOCK_MARGIN`.
- For a `deliver` job: the end of its batching window, then its retry backoff.

**Deliver due rule:** `run_at <= now()` AND the dispatch bucket holds at least one token AND at
least 1 s has passed since `level_at` (§12). Until a user's inbox issue exists (the channel's
`target IS NULL`), only that user's opening job is due.

### 7.3 Leases (not held locks)
`[WHY]` Holding a lock for up to 800 s breaks behind transaction-mode connection poolers.

1. **Claim** in its own short transaction. `locked_by` is a fresh UUID used as a fencing token,
   and `attempts` counts claims:
   ```sql
   UPDATE jobs SET locked_by = gen_random_uuid(), locked_at = now(), attempts = attempts + 1
   WHERE id = (SELECT id FROM jobs WHERE <due> ORDER BY run_at LIMIT 1 FOR UPDATE OF jobs SKIP LOCKED)
   RETURNING *;
   ```
2. **Renew and fence at the start of every transaction the job commits:**
   ```sql
   UPDATE jobs SET locked_at = now() WHERE id = $1 AND locked_by = $2;
   -- no row: the lease is lost, so ROLLBACK and exit
   ```
3. **Finish with the job's last write**, in the same transaction: release a `sync` job
   (`locked_by = NULL, attempts = 0, run_at` as in §7.2), or delete a `deliver` job (after a
   permanent failure, all of the user's jobs, §12).
4. **Abort any GitHub request after 2 min** with GRN's own timeout. `[WHY]` Node's `fetch`
   otherwise waits up to 300 s on a stalled connection. **Never sleep while holding a lease**:
   set `run_at` or empty the dispatch bucket, then release.
5. **Reap** on every cron run:
   ```sql
   UPDATE jobs SET locked_by = NULL, locked_at = NULL,
          run_at = now() + interval '1 minute' * power(2, least(attempts, 8))
   WHERE locked_by IS NOT NULL AND locked_at < now() - interval '15 minutes'
   RETURNING id, kind, user_id, attempts;   -- log as rescued
   ```
   Alert after a few attempts. A rescued `deliver` job counts as an **ambiguous** failure
   (§12).
- **Only one `deliver` job may be leased at a time:**
  `UNIQUE ((true)) WHERE kind = 'deliver' AND locked_by IS NOT NULL`. Whichever worker holds
  it is the dispatcher.
  - While a `deliver` job is leased, another worker's claim can still pick a different due
    `deliver` job. Its `UPDATE` then fails with a `unique_violation` (`23505`), because
    `SKIP LOCKED` only skips row locks, not unique-index conflicts. **Treat `23505` on a claim as
    "nothing to claim".**
  - `[EXTRACTOR]` The full doc writes `kind <> 'sync'`. Open point 7 in the full doc corrects it to
    `kind = 'deliver'`. Both are identical in M1, and `kind = 'deliver'` is safe for M2.

### 7.4 Two clocks (§6.2)
- All of GRN's timestamps come from Postgres `now()`. GitHub's `createdAt` and
  `x-ratelimit-reset` come from GitHub's clock, in whole seconds.
- **`CLOCK_MARGIN = 3 min`** is applied wherever the two clocks meet, always erring toward
  re-reading or waiting longer:
  - `enabled_at = now − CLOCK_MARGIN`.
  - The poll watermark is at most `probe start − CLOCK_MARGIN`.
  - The rate-limit rollover rule and every wait for `x-ratelimit-reset` add `CLOCK_MARGIN`.

---

## 8. Budget model (§6.4)

- After every response, store the `graphql` bucket from the headers in `rate_limit_state`
  (`limit_`, `used`, `reset_at`). This **overwrites** the stored row; the headers are
  authoritative.
- **Guard, evaluated before each request:**
  ```
  elapsed   = 1 − (reset_at − now) / 3600
  allowance = TARGET × limit × elapsed − used        TARGET  = 0.8
  remaining = limit − used                           RESERVE ≈ 500
  proceed only while allowance > 0 AND remaining > RESERVE
  ```
  `[WHY]` The `elapsed` ramp spreads spend across the hour. `RESERVE` leaves the user's own
  tools room, because the budget is shared with them.
- **Serial:** at most one in-flight request per token. Scaling comes from serving many users in parallel.
- Select `rateLimit { cost }` in **every** query (it's free). Log `cost` and alarm above 3.
  The budget uses the headers, not the body's `used`, `remaining` and `resetAt`.
- No cost prediction or accounting beyond this.
- On a secondary limit (`retry-after`), set the sync job's `run_at` and release it.
- `GET /rate_limit` is a fallback check only. Don't poll it per user.

---

## 9. Polling engine (§6.3)

### 9.1 One queue, one score
Discovery passes, backfill windows, thread scans, and reaction polls
compete in **one score-ordered queue per user**, worked by that user's `sync` job. Each task
is **one query**; nothing pages with cursors. All durations are in **seconds**.

```
score = (wait / content_age^P) × value_weight         P = 0.8
```
| Task | Eligible when | `wait` | `content_age` | weight |
|---|---|---|---|---|
| Poll (a batch of about 50 items) | `last_checked_at ≤ now − D` (D = 4 min) | `now − last_checked_at` | `now − last_event_at` | 1 |
| Incremental discovery (the category) | `last_checked_at ≤ now − D_discovery` | `now − last_checked_at` | `now − last_find_at` | `w` |
| Backfill window | always | `now − window_created_at` | `now − window_end` (the newest content still unread) | `w` |
| Thread scan | always | `now − scan_created_at` | `now − thread_created_at` | `w` |

- Polls are scored per item. The top ~50 items form one batched probe.
- Ensure content_age is never 0, because we divide by it.
- A backfill window's score falls as `window_end` moves back. Recent history competes with
  polling, while old history drains in the background.
- Use a **stable tiebreak** (`node_id`). No jitter.
- Score afresh on every claim and run the single top task. For a poll, that task is the top
  ~50 due items.
- `P < 1` makes every score grow without bound, so nothing starves. No other deadline
  mechanism is needed.
- Defaults pending M0: `w = 2`; `D_discovery` = max(search lag, D).

### 9.2 Discovery: `authored`, category `issue` (§6.3 Task kind A)

**Incremental passes.** There are 3 passes, aliased into **one query** that costs 1 point.
Each reads a single page (`first: 100`, plus `pageInfo { hasNextPage }`) and starts from
`viewer`, never `user(login:)`:

| Pass | Connection | Order | Watermark key |
|---|---|---|---|
| `Issue` | `viewer.issues` | `CREATED_AT DESC` | `created_at` |
| `PullRequest` | `viewer.pullRequests` | `CREATED_AT DESC` | `created_at` |
| `IssueComment` | `viewer.issueComments` | `UPDATED_AT DESC` (its only order) | `updated_at` |

- Read newest-first and keep the items **with `sort_value ≥ watermark`**. `[WHY]` Using `≥`
  instead of `>` re-reads boundary ties, which is free because upserts are idempotent; `>`
  could skip an item.
- **Advance the watermark in the same transaction as the pass's upserts**, to the sort value of
  the newest kept item (unchanged if none). A failed query changes nothing, and the next run
  reads the same range again.
- **The watermark must match the sort key.** `[WHY]` Mixing keys can truncate a pass silently.
- **`IssueComment` stops on `updatedAt`, never on `createdAt`.** `[WHY]` The connection is
  ordered by `updatedAt`, so `createdAt` isn't monotonic: an old comment edited a minute ago
  comes first and would end the pass before any new comment.
- Seed each watermark with `discovery_started_at − overlap margin`. `[TBD]` The margin is sized
  from the search lag measured in M0.
- Finding anything new sets the category's `last_find_at = now`. Each run sets
  `last_checked_at = now`.
- Newly found items get `last_event_at = createdAt`, with no reaction hint.
- **Overflow (livelock check)** `[SIMPLIFIED]`: if a pass's page has `hasNextPage` and its
  oldest sort value is still `≥ watermark`, items beyond the page may be unread. **Log an
  error** with the pass, the old watermark and the page's oldest sort value. Store the page and
  advance the watermark as usual; do not query further. Items between the old watermark and
  the page's oldest item are skipped (never tracked), which is a known gap. For
  `IssueComment` this holds whether the page's items are new or edits. `[WHY]` Such a burst
  between two passes a few minutes apart is very unlikely for one user. The full doc's proper
  solution (§6.3 "Livelock guard") hands the skipped range to a backfill window or a comment
  catch-up.

**Backfill** (one date window via `search`, walked newest-first, one page per task):
- On signup, insert **one** window that covers `1970-01-01T00:00:00Z` → `discovery_started_at`.
  Search filters parent-thread creation, so the lower bound must predate GitHub, not merely
  the user's account: a user who joined in 2015 can comment in 2020 on a 2010 thread.
  `[WHY]` Each page re-queries the remaining range, so the 1,000-result search cap never
  applies, and `sort:created-desc` already walks newest-first. Many small windows would buy
  the same order with more rows and a split step.
- Query per page:
  `search(type: ISSUE, query: "involves:USER created:window_start..window_end sort:created-desc", first: 100)`.
  Both bounds are inclusive.
  - `[EXTRACTOR]` The full doc also allows two passes instead (`author:` + `commenter:`).
    This extract picks `involves:`, as in §6.3's per-type table.
- Per hit, in the same query:
  - The thread's author, as `author { login ... on Node { id } }`.
  - `timelineItems(itemTypes: [ISSUE_COMMENT], first: 100)`, with each comment's author id.
  - The newest-reaction hint: `reactions(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt } }`.
  - Measured cost should be about 2 points.
- **Keep only the user's own content**, comparing author node ids with `gh_user_id`: the thread
  if the user opened it, and the user's comments. `[WHY]` `involves:` also matches mentions
  and assignments.
- For kept **threads**: `last_event_at = max(createdAt, newest reaction createdAt)`. If the
  hint returns a partial error, fall back to `createdAt`. For kept **comments**:
  `last_event_at = createdAt`, with **no per-comment probe**. `[WHY]` Probing every comment
  would cost about 100 points per page.
- All new `tracked_content` rows: `last_checked_at = now` and `watermark_at = enabled_at`.
  `[WHY]` The hint is a scheduling signal only. Watermarks still silence pre-`enabled_at`
  reactions.
- **Save progress after every page:** in the same transaction as the page's upserts, set
  `window_end =` the last (oldest) hit's `createdAt`. Both bounds are inclusive, so the next
  page re-reads the hits at exactly `window_end`. That overlap is expected and free, because
  upserts are idempotent. `[WHY]` An exclusive bound would skip the hits in that second that
  didn't fit on the page.
- **Stuck-second check** `[SIMPLIFIED]`: if a full page's oldest hit has `createdAt` equal to the current
  `window_end`, then the whole page is in that second, and setting `window_end` to the same value
  would just fetch the same page again. Detect this, **log an error**, and set
  `window_end =` that second − 1 s anyway. `[WHY]` This keeps the walk moving. M1 doesn't fully
  handle the case. Hits in that second beyond the first page are skipped, which is a known gap.
  The full doc's proper solution (§6.3 "Within a window") comes in a later milestone.
- **warn on failure:** if the search times out or fails for a reason other than rate
  limits or authentication, log a warning. Retry after 5 min.
- **Delete** the window when all its pages are stored.
- **Login check:** every query selects `viewer { id login }`. If the login differs from the
  one built into the search string, refresh `users.login`, **discard the page**, leave the
  window untouched, and retry. `[WHY]` A stale login returns nothing, or another person's
  content.

**Thread scans** handle threads too long for one page:
- A hit whose inline `timelineItems` reports `hasNextPage` gets a `thread_scans` row, inserted
  in the same transaction as the page, with `since_at =` the last comment's `createdAt`. Insert
  it with `ON CONFLICT DO NOTHING`. `[WHY]` The inclusive `window_end` re-reads boundary hits,
  and an existing row's `since_at` may already have advanced.
- One task reads up to about 50 threads, aliased, each with
  `timelineItems(itemTypes: [ISSUE_COMMENT], since: since_at − 1 s, first: 100)`.
- It stores the user's comments and advances `since_at` in the same transaction. A thread's
  row is deleted after its last page.
- `[WHY]` `timelineItems` takes a date filter, whereas `comments` orders only by the mutable
  `UPDATED_AT`.

**Completion:** backfill is complete when the category has **no** `backfill_windows` and **no**
`thread_scans` rows. This is a `NOT EXISTS` check, not a stored flag. M1 triggers nothing on
completion.

**Upserts:**
- Write `content`, `content_sources`, and `tracked_content` with `ON CONFLICT DO NOTHING`.
- `content` stores `type`, `repo_full_name`, `url`, `title`, `author_id`, and `author_login`.
  `type` is the GraphQL `__typename` (`Issue`, `PullRequest`, `IssueComment`), the same values
  as `subscription_types.content_type`. Select `__typename` on search hits.
  `author_id` may be null for a deleted ("ghost") author.
- **Stale metadata (known gap, accepted for M1):** `content` keeps the values from the first

### 9.3 Reaction polling (§6.3 Task kind B)

**Probe.** Batch about 50 due items into one aliased `node(id:)` query, each requesting
`... on Reactable { reactions(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt } } }`.
This costs 1 point.
- Drill down **only if `newest > watermark_at`**. Use a strict `>` here, never `≥`.
  `[WHY]` `≥` would trigger a drill-down on every poll.
- An empty `nodes` list means the item has no reactions: skip it.
- Always update `last_event_at = max(last_event_at, newest)`. The probe also returns
  pre-subscription reactions, which count as an activity signal.

**Drill-down.** One query fetches reactions for all of the probe's items that need it (≤100),
with `reactions(first: 100, orderBy: {field: CREATED_AT, direction: DESC})` selecting
`content createdAt user { id login }` and `pageInfo { hasNextPage }`.
- Keep the reactions with `createdAt ≥ watermark_at`; ignore older ones.
- **Overflow** `[SIMPLIFIED]`: if an item's page has `hasNextPage` and its oldest reaction is
  still `≥ watermark_at`, new reactions beyond the page may be unread. **Log an error** with
  the item, `watermark_at` and the page's oldest `createdAt`. Store the page and update the
  watermark as usual; do not query further. The unread reactions are never notified, which is
  a known gap. `[WHY]` More than 100 new reactions on one item between two polls is very rare.
  A later milestone hands the skipped range to a separate task.
- Store and notify a reaction with a null `user` as GitHub's deleted-account `ghost`:
  `reactor_login = 'ghost'`, `reactor_id = 'ghost:' || createdAt`, with the timestamp
  normalized to canonical ISO format. Re-reads deduplicate normally. Same-item, same-emoji
  ghost reactions with the same timestamp collapse to one synthetic identity. Do not skip
  the reaction or store a null key.
- Insert into `reaction_events` with `ON CONFLICT DO NOTHING RETURNING *`. Only rows actually
  returned flow on to fan-out (§10).

**Watermark update (hot boundary):** `watermark_at = max(watermark_at, min(newest, probe_start − CLOCK_MARGIN))`.
`[WHY]` A same-second tie or a reaction that becomes readable late would otherwise be missed
for good. Holding the watermark back forces exactly one free re-check, which settles because
`D > CLOCK_MARGIN`.

After each poll, set `last_checked_at = now`.

**Missing item** (the query succeeds but returns no data for an item): log it, advance
`last_checked_at`, keep `watermark_at` unchanged, and continue. Nothing is tombstoned.

**A `401`** sets `token_status = 'revoked'`, queues FR-17's notice, and releases the job, which
is then no longer due.

**Any other unexpected response** follows §12's "Unexpected responses" rule.

---

## 10. Notification pipeline (§6.6)

```
new reaction_events → fan out via content_sources (reacted_at ≥ the type's enabled_at)
  → INSERT reaction_notifications (outcome 'queued') ON CONFLICT DO NOTHING
  → open or lock the user's digest job
  → render when sent
  → dispatcher
```

- Insert into `reaction_notifications` **after** filtering. A filtered reaction leaves no row.
- **No late-discovery replay in M1.** In M1 each item has exactly one tracking user and one
  source, so a replay would always find nothing. It arrives in M2 (§6.6).

**One digest per user**, which is a `deliver` job:
```sql
CREATE UNIQUE INDEX ON jobs (user_id) WHERE kind = 'deliver' AND payload->>'digest' = 'true';

-- with every insert of a 'queued' row (same transaction):
INSERT INTO jobs (kind, user_id, payload, run_at)
VALUES ('deliver', $user, '{"digest": true, "state": "open"}', now() + interval '3 minutes')
  ON CONFLICT (user_id) WHERE kind = 'deliver' AND payload->>'digest' = 'true'
  DO UPDATE SET run_at = jobs.run_at;   -- changes nothing, but locks the digest

-- rendering: one transaction after the lease check, before the first attempt
UPDATE jobs SET payload = payload || '{"state": "rendered"}' WHERE id = $job;
UPDATE reaction_notifications SET outcome = 'delivered'
WHERE user_id = $user AND outcome = 'queued' RETURNING *;   -- render into payload.body, COMMIT

-- finishing: the same transaction that deletes the posted digest
WITH d AS (DELETE FROM jobs WHERE id = $job RETURNING run_at)
INSERT INTO jobs (kind, user_id, payload, run_at)
SELECT 'deliver', $user, '{"digest": true, "state": "open"}', d.run_at + interval '3 minutes'
FROM d
WHERE EXISTS (SELECT 1 FROM reaction_notifications WHERE user_id = $user AND outcome = 'queued');
```
- Later reactions join an open digest **without moving `run_at`**.
- While a digest is rendered, new reactions stay `queued` for its successor.
- A successor is due 3 min after its predecessor's `run_at`.
- A retry re-posts the **same body**. `[WHY]` A second digest beside a retrying one could
  overtake it.
- A digest that fails permanently deletes all of the user's jobs (§12). No successor opens.
- One-off messages (the FR-17 notice) are `deliver` jobs inserted
  **already rendered**. They are not digests.

---

## 11. GitHub-native inbox (§6.7)

- **Setup:** one public **inbox repo** owned by GRN, and one **machine account** that makes
  every write.
  - `[WHY]` GitHub doesn't notify users about their own actions.
  - `[WHY]` Opening the issue with the user's token would need `public_repo`.
- **Use Issues, not Discussions.** Leave inbox issues **open and unlocked**.
- **Opening at sign-in:**
  - Every sign-in tries to insert the user's `github_issue` channel with `target = NULL`, plus
    a rendered `deliver` job whose payload has a `title` and a `body`.
  - `UNIQUE (user_id) WHERE kind = 'github_issue' AND disabled_at IS NULL` ensures concurrent
    sign-ins open only one inbox. M1 never sets `disabled_at`.
  - The issue body **@mentions the user**. That is what subscribes them to later comments.
  - The body also states that **the user's sign-in requested this issue**.
  - Once the issue is posted, set the channel's `target = "owner/repo#number"`.
- **No rollover in M1** `[SIMPLIFIED]`. The full doc's proper solution (§6.7) opens a fresh
  inbox issue that links the previous one.
- **Each digest is a new comment.** Edits don't notify anyone.
- **Rendering rules** (mandatory; `[WHY]` prevent mention spam and avoid publicly marking
  others' threads):
  - The only live mention is of the user, in the body of their own inbox issue.
  - Every other login named (authors, reactors) gets a **zero-width space after `@`**, plus a
    link to their profile. Don't use a code span: an e-mail reply would make it live again.
  - Link every issue, PR, or comment **through `redirect.github.com`**, so no "mentioned this"
    event is created.
  - Escape all quoted text (titles) as plain text. Put a zero-width space in every `@` and in
    every issue reference (`#123`, `GH-123`, `owner/repo#123`), and redirect every thread URL
    in it.
  - Cap the body at **65,536 characters** and truncate with "…and N more items".
  - Every body (comment or issue) embeds `<!-- grn:{deliver job uuid} -->`.

## 12. Dispatcher: pacing and retries (§6.8)

- **Globally serialised**: one leased `deliver` job at a time (§7.3).
- **The dispatcher makes every machine-account write.** That covers openings and
  comments. Nothing else writes as the machine account, including the web UI or manual use.
  Every write, failed ones included, takes a bucket token before it is posted.
  `[WHY]` The bucket can only account for writes it sees.
- **≥ 1 s between writes.**
- **Token bucket**, stored in the `dispatch_bucket` row (`level`, `level_at`):
  - It holds `least(capacity, level + rate × (now − level_at))`.
  - Each write takes a token in the lease-renewal transaction right before posting.
  - Rate: **480/h**, pending M0.
  - `[WHY]` There is no API to query secondary limits (80/min and 500/h service-wide), so GRN
    must stop short of them. Each limit hit raises an alert.
- **Order:** strictly `run_at`.
- Log each batch's **wait** (from `run_at` to rendering). This is the capacity alarm.

| Condition | Action |
|---|---|
| `403`/`429` with `retry-after` | Pause exactly that many seconds |
| `403`/`429` with `x-ratelimit-remaining: 0` | Pause until `x-ratelimit-reset + CLOCK_MARGIN` |
| `403`/`429` with neither header | Wait ≥ 60 s, then back off exponentially; alert after 1 attempt |
| `5xx`, network error, timeout | same exponential backoff as the line above |
| `404`, `410`, or `403` without access | **Permanent:** no retry. Log an error and delete all of the user's jobs (below) `[SIMPLIFIED]`. |

"you will receive an error message that indicates that you hit a secondary rate limit." ([source](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api)). We use this to distinguish between row 3 and row 5 in the table above.

**Unexpected responses.** This covers any HTTP status, GraphQL `errors` entry (including those
returned with a `200`), or response shape that no rule here or in §9 covers. It applies to every
GitHub call, in `sync` and `deliver` jobs alike:
- Validate each sync query's required fields, connection nodes/page info, and every requested
  alias before committing progress. An omitted alias is malformed, not an explicit `null`
  missing-node result or an empty-object fragment result. Malformed data preserves discovery
  windows, scans, watermarks and check times, and releases the lease for a transient retry.
- Log a **warning** with the job id, user, kind, HTTP status, GraphQL error `type`s, and the
  response message.
- Treat the response as **transient** error.

- **A pause stops the whole dispatcher.** The releasing transaction sets the bucket to
  `level = 1, level_at = pause_end`, a time in the future. The job keeps its `run_at`.
- **After a permanent failure**, the finishing transaction runs
  `DELETE FROM jobs WHERE user_id = $user`, including the `sync` job. This stops delivery and
  polling for that user. The user's other rows stay.
  - The job is gone, so the error log carries the job id, user, kind, channel target, HTTP
    status, and response message.
  - A worker that holds the user's `sync` lease loses it at its next commit (§7.3), as in FR-3.
  - A returning sign-in doesn't recreate the `sync` job (§13), so the user stays inactive until
    someone intervenes manually. This is acceptable in M1.
  - A repo-wide or machine-account-wide failure (such as an archived inbox repo or lost
    access) deletes the jobs of every user whose delivery comes due. To recover, re-insert their
    `sync` jobs: polling resumes from the stored watermarks. Reactions in the failed digests are
    lost.
- **Idempotency:** any attempt after the first is **ambiguous**, including a reaper rescue.
  Concretely, `payload.attempted_at` is stamped just before the first POST; only jobs carrying
  it reconcile. A retry of work that never reached that transaction needs no marker check.
  Before re-posting, check whether the `grn:{uuid}` marker already exists:
  - For a comment: list the recent comments on the target issue.
  - For an opening: list the inbox repo's newest issues. If the marker is found, point the
    channel at that issue instead of opening a new one.
- Re-check the lease right before posting.
- Mutation requests never follow redirects. A delivery POST must return `201` and an object
  containing a positive safe-integer issue `number` (opening) or comment `id`. Arrays, nulls,
  missing identifiers and other statuses are transient/ambiguous, not proof of delivery.
  They release the lease with backoff and preserve the job for marker reconciliation.

---

## 13. Data model (M1 tables only; §6.5)

All ids are GraphQL global node ids in the new format unless stated otherwise. All timestamps
come from Postgres `now()` unless they are GitHub values.

```
users(gh_user_id PK, login, gh_created_at, token_enc, token_nonce, token_status)
  -- token_status ∈ {'active','revoked','invalid'}; gh_user_id is the FK target and NFR-3's AAD
  -- login is mutable; it's refreshed from viewer { id login } on every discovery query

subscriptions(id, user_id)                       -- exactly one per user in M1 (authored)

subscription_categories(id, subscription_id, category, discovery_started_at,
                        last_checked_at NOT NULL, last_find_at NOT NULL,
                        UNIQUE (subscription_id, category))
  -- category = 'issue' only; inserted at signup; discovery_started_at never moves
  -- last_checked_at = last_find_at = discovery_started_at initially

subscription_types(category_id, content_type, enabled_at, PK (category_id, content_type))
  -- 'Issue', 'PullRequest', 'IssueComment' (GraphQL __typename, same values as content.type);
  -- enabled_at = now − CLOCK_MARGIN; never null in M1

subscription_passes(category_id, pass, watermark NOT NULL, PK (category_id, pass))
  -- 'Issue', 'PullRequest', 'IssueComment' (one pass per content type in M1);
  -- seeded with discovery_started_at − overlap margin

backfill_windows(category_id, window_start, window_end, window_created_at,
                 PK (category_id, window_start))
  -- a row means "still to walk"; walked newest-first, so window_end moves back per page and
  -- window_start stays fixed; exactly one row per category in M1; deleted when done; never
  -- re-walked

thread_scans(category_id, thread_node_id, since_at, thread_created_at, scan_created_at,
             PK (category_id, thread_node_id))
  -- inserted ON CONFLICT DO NOTHING (the inclusive window_end re-reads boundary hits)

notification_channels(id, user_id, kind, target, disabled_at)
  -- kind = 'github_issue'; target "owner/repo#n" or NULL until opened
  -- UNIQUE (user_id) WHERE kind = 'github_issue' AND disabled_at IS NULL

content(node_id PK, type, repo_full_name, url, title, author_id NULL, author_login)   -- global
  -- type ∈ {'Issue','PullRequest','IssueComment'} (GraphQL __typename; joins to
  -- subscription_types.content_type); an IssueComment on a PR is still 'IssueComment'

tracked_content(user_id, node_id, last_checked_at DEFAULT now(), last_event_at,
                watermark_at NOT NULL, PK (user_id, node_id))
  -- INDEX (user_id, last_checked_at) INCLUDE (last_event_at)

rate_limit_state(user_id PK, limit_, used, reset_at)     -- graphql bucket only

content_sources(user_id, node_id, subscription_id, PK (user_id, node_id, subscription_id))

reaction_events(node_id, reactor_id, emoji, reacted_at, reactor_login,
                PK (node_id, reactor_id, emoji))           -- global

reaction_notifications(user_id, node_id, reactor_id, emoji, outcome,
                       PK (user_id, node_id, reactor_id, emoji))
  -- outcome ∈ {'queued','delivered'}; delivered rows are kept (FR-7)

jobs(id uuid, kind, user_id, payload jsonb, run_at, locked_by, locked_at, attempts)
  -- kind ∈ {'sync','deliver'}; unique indexes as in §7.2, §7.3, §10
  -- deliver payload: digest {"digest":true,"state":"open"|"rendered","body":…};
  --   one-off {"body":…}; opening {"title":…,"body":…}

dispatch_bucket(level, level_at)                          -- exactly one row
```

**Signup transaction** (web request), for a new user:
- Insert the user with the encrypted token.
- Insert the subscription, the `issue` category (`discovery_started_at = now`), its 3 types
  (`enabled_at = now − CLOCK_MARGIN`), its 3 passes, and its one backfill window.
- Insert the `sync` job, the channel, and the inbox-opening `deliver` job.

For a returning user, the sign-in instead updates the token and login, sets
`token_status = 'active'`, and attempts the channel insert (§11).

---

## 14. Configuration (defaults pending M0 calibration)

| Name | Default | Notes |
|---|---|---|
| `D` | 4 min | Minimum re-check delay per item |
| `D_discovery` | 4 min | Placeholder pending search-lag calibration; intended eventual value is max(search lag, D) |
| `P` | 0.8 | Score exponent |
| `w` | 2 | Discovery/backfill weight. No principled default; calibrate in M0. |
| `TARGET` | 0.8 | Budget ramp |
| `RESERVE` | ~500 points | Hard floor |
| `CLOCK_MARGIN` | 3 min | can hopefully be lowered after observing real timings |
| Probe batch | ~50 items | Drill-down ≤ 100 items, `first: 100` reactions each |
| Discovery page | 100 per pass | One page per run; no cursors |
| Thread scan batch | ~50 threads | |
| Digest batching window | 3 min | |
| Dispatch rate | 480/h | Bucket refill rate |
| Dispatch bucket capacity | 10 tokens | Largest burst of writes |
| Request timeout | 2 min | Shorten after observing real response times |
| Sync retry delay | 5 min | After a transient failure; ≥ 60 s after a secondary limit naming no wait |
| Lease reap age | 15 min | Shorten after observing real commit gaps |
| Reaper backoff | 1 min × 2^min(attempts, 8) | |
| Search overlap margin | 1 hour | Placeholder pending the M0 lag measurement |
| Max dispatch attempts before alert | 1 | |
| Cost alarm | > 3 points | |
| Clock-skew alarm | > 2 s | |

All these values need to be watched in the apps initial deployment, and adjusted if necessary.

---

## 15. To be measured after implementation

1. The two-phase probe works against a real account and one large repo. Every query shape
   costs ≤ 2 points; optionally assert this in CI together with the `X-Github-Next-Global-ID: 1` header.
2. Measure the serial-poll wall-clock. Confirm a concurrency of 1 is enough.
3. The search rate-limit behaviour for date windows, and whether a lifetime-wide
   `involves:USER created:A..B sort:created-desc` search returns without timing out for a
   heavy account. This decides whether backfill ever needs to split its window.
4. The size of the search indexing lag, which sets the overlap margin.
5. `timelineItems(itemTypes: [ISSUE_COMMENT], since:)` filters and orders by the comment's
   `createdAt`, not `updatedAt`. Measure its cost.
6. The machine account's real content-creation throughput, including whether opening an issue
   has a lower limit of its own. This sets the dispatch rate, and possibly a separate bucket
   for openings.
7. An issue opened by the machine account subscribes the @mentioned user to later comments,
   both on the web and by e-mail.
8. A digest notifies no one else and marks no linked or quoted thread, and neither does an
   e-mail reply that quotes it.

---

## 16. Suggested implementation order

Each step should end with its acceptance tests passing. Keep the tests basic in M1, since most things are expected to change later.

1. **Repo skeleton:** toolchain, the shared package copied from github-stats-extended, the lint
   boundary, the schema file (applied by hand, see §2), and CI.
   *Accept:* lint, tests, and build pass, and the CI assertions run.
   *Status:* done. It also sends the `X-Github-Next-Global-ID: 1` header (C13) early, on
   every GraphQL request.
2. **Schema and job queue:** all of §13, plus claim, renew/fence, release, the reaper, and
   the due rules (§7.2).
   *Accept:* tests cover lease loss, reaping, the round-robin order, the one-deliver-lease
   rule (a `23505` on a claim means "nothing to claim"), and that only the opening job is due
   while the channel's `target IS NULL`.
   *Status:* done. The schema is `packages/core/sql/schema.sql`. The queue is in
   `apps/backend/src/jobs/queue.ts`. Its tests run against PGlite (in-process Postgres), so
   they need no database server. Decided in step 2:
   - The `deliver` claim orders strictly by `run_at` (§12). The full doc's "a new user's inbox
     first" (§6.8) is not implemented.
   - The bucket capacity is configurable, separate from the 480/h rate, and defaults to 10
     tokens (§14).
   - An opening job is recognised by the `title` in its payload.
   - A missing `rate_limit_state` row counts as a budget with room.
   - Per-user tables reference `users` with `ON DELETE CASCADE`. `reaction_events` references
     `content`. `tracked_content` and `content_sources` reference `content`, and
     `reaction_notifications` references `reaction_events`, all without `ON DELETE` actions
     and without extra `node_id` indexes.
3. **OAuth, token service, and deletion:** sign-in, FR-2a, NFR-3 encryption, the signup
   transaction, the returning-user sign-in, and FR-3 deletion.
   *Accept:* tests show a non-empty scope is rejected and the grant deleted (without looping),
   an undecryptable token yields `'invalid'`, concurrent sign-ins open only one inbox, a
   returning sign-in sets `token_status = 'active'`, and deletion leaves no rows about the
   user, including global `content` and `reaction_events`.
   *Status:* done. The flows are in `apps/backend/src/oauth.ts`, the sign-in and deletion
   transactions in `apps/backend/src/users/accounts.ts`, the opening's text in
   `apps/backend/src/inbox/opening.ts`, and NFR-3's cipher in
   `packages/core/src/common/tokenEncryption.ts`. Decided in step 3:
   - GRN keeps no sessions. Deletion re-authenticates through the same OAuth flow, and GitHub
     skips its consent page for an authorized app. The callback deletes the data of the
     fresh token's `viewer`, then deletes the grant with that token. The form is a POST
     accepted only from the same origin (`Sec-Fetch-Site`, else `Origin`).
   - A random `state` mirrored in a 10-minute `HttpOnly` cookie ties each callback to a flow
     the browser started. It also carries the action (`signin`/`delete`) and the FR-2a
     attempt. A scoped token deletes the grant and restarts once; a second scoped token ends
     the flow with an error message.
   - `token_enc` is `v1.<auth tag>.<ciphertext>` (base64), `token_nonce` the 12-byte IV
     (base64), and the AAD is `gh_user_id`. `TOKEN_ENCRYPTION_KEY` is required and may list
     several comma-separated keys: the first encrypts, all decrypt.
   - Reading a token that does not decrypt sets `token_status = 'invalid'` only if the stored
     token is unchanged, so a concurrent sign-in's new token is not clobbered.
   - The search overlap margin defaults to 1 h until M0 measures the search lag (§14).
   - Deletion deletes the user's jobs first, then the user (cascading), then the
     `reaction_events` and `content` rows no remaining user references.
4. **Budget and GitHub client:** the per-user-token mode, the `X-Github-Next-Global-ID: 1`
   header (already sent since step 1), `rateLimit` selection and the cost alarm, header capture, the guard, the rollover
   rule, the 2-min timeout, secondary limits, `401` handling (FR-17), §12's
   "Unexpected responses" rule, and the separate mutation-safe write path (§6).
   *Accept:* unit tests of the guard at window edges, and an unexpected response is logged as
   a warning and retried as transient.
   *Status:* done. `@grn/core` gained the per-user-token mode (`userTokenRetryer` in
   `retryer.ts`), the mutation-safe path (`mutationRequest` in `mutation.ts`), and a
   policy-free classification of every response (`outcome.ts`). GRN's policy is in
   `apps/backend/src/github/`: the guard and header storage in `budget.ts`, the `sync` client
   in `syncClient.ts`, the write classification in `writes.ts`. FR-17's text is in
   `apps/backend/src/inbox/notices.ts`. Decided in step 4:
   - Both new core paths send exactly one request: no retries, no token rotation, no sleeping.
     They never throw for a failed request, and return the outcome (`ok`, `rate-limited`,
     `unauthorized` or `failed`) with the response's status, GraphQL error types, message and
     rate-limit headers. Callers decide when to try again, by setting `run_at`.
   - The 2-min timeout is GRN's own `AbortSignal.timeout`, covering the whole request.
   - A rate limit is recognised by a `403`/`429` with `retry-after` or
     `x-ratelimit-remaining: 0`, a `429`, or a message containing "rate limit", which includes
     a `RATE_LIMITED` error in a GraphQL `200`. Any other `403` is not a rate limit.
   - Headers are stored only for the `graphql` resource (or none named), in a fenced
     transaction right after the response. A lost lease then throws `LeaseLostError`.
   - The guard is evaluated in TypeScript before each request, with Postgres' `now()`. A test
     checks it agrees with the `sync` claim's SQL.
   - A `sync` job that failed transiently is due again after a fixed 5 min (configurable). A
     secondary limit that names no wait waits `max(60 s, that)`. The backoff is not
     exponential because releasing a `sync` job resets its attempts (§7.3).
   - A `401` revokes the token only if `token_enc` is unchanged, so a concurrent sign-in's
     new token stays active. The notice is queued only when the token was revoked.
     `loadToken` now also returns `token_enc` for this check.
   - The notice is a rendered `deliver` job with only a `body` (no `title`, so it waits for the
     inbox's opening). It mentions nobody and links to the site to sign in again.
   - Each query's `rateLimit.cost` is logged; above `COST_ALARM` it is logged as an `ALERT:`
     error. A missing `rateLimit` is logged as a warning, and the data is still used.
     `runQuery`'s type requires each query it sends to select `rateLimit { cost }`.
   - GraphQL errors make a response unexpected unless the caller accepts their type (as
     §9.3's missing items will). An unexpected write, including a `401` or `422`, is a
     warning and transient. Every write rate limit is logged as an `ALERT:` error.
   - `logger.warn` was added to the shared logger.
   - The `Date`-header clock-skew alarm is left to step 10 (NFR-7).
5. **Incremental discovery:** the three aliased passes and the watermark rules.
   *Accept:* tests cover a failed query leaving the watermark unchanged, ties at the boundary,
   and the watermark advancing with the upserts. An edited old comment doesn't end the comment
   pass early, and an overflowing pass logs an error, makes no second query, and still
   advances its watermark.
   *Status:* done. The task is `runIncrementalDiscovery` in
   `apps/backend/src/discovery/incremental.ts`, its query
   `packages/core/src/graphql/queries/authoredDiscovery.graphql`, and the shared upserts into
   `content`, `content_sources` and `tracked_content` are in
   `apps/backend/src/discovery/store.ts` (for step 6 to reuse). Decided in step 5:
   - The task is one complete `sync` task: one query, then one fenced transaction that stores
     the passes, advances their watermarks, sets the category's `last_checked_at` (and
     `last_find_at`), refreshes `users.login`, and releases the job. A failed query is settled
     by `settleSyncFailure` and changes nothing else. Choosing the category to run (scoring,
     `D_discovery`) is left to step 7.
   - The page is filtered, not walked: every item with `sort_value ≥ watermark` is kept, so an
     edited old comment above the watermark is tracked too. Its `last_event_at` is its
     `createdAt`.
   - "Finding anything new" means inserting a `tracked_content` row the user didn't have.
   - A comment's `content.title` is its thread's title (`issue { title }`, which a PR comment
     resolves to the PR). Checked against the live API, where the query also measured 1 point
     and returned only new-format ids in the expected orders.
   - A `viewer.id` other than the job's user is logged as an `ALERT:` error and retried as
     transient (§12), and nothing is stored.
   - A changed login is logged (NFR-7's login mismatches) and stored in the same transaction.
   - The codegen maps the `URI` scalar to `string`, as it does `DateTime`.
6. **Backfill and thread scans:** the window, per-page progress, the own-content filter, the
   login check, thread scans, and the completion check.
   *Accept:* tests cover resuming after an interruption, newest-first order, and the
   stuck-second check (an error is logged and `window_end` still moves back). A boundary
   re-read doesn't reset an existing thread scan's `since_at`. Mentions and assignments of the
   user are not tracked, and a login mismatch discards the page and leaves the window
   untouched.
   *Status:* done. The tasks are `runBackfill` in `apps/backend/src/discovery/backfill.ts`
   (with `isBackfillComplete`) and `runThreadScans` in
   `apps/backend/src/discovery/threadScans.ts`. The search's query is
   `packages/core/src/graphql/queries/authoredBackfill.graphql`. The thread scans' query is
   built at runtime with one alias per thread by `packages/core/src/graphql/threadScanDocument.ts`,
   as github-stats-extended builds its aliased documents, and reuses the generated
   `BackfillComment` fragment type. What the discovery tasks share (log context, the `viewer`
   check, comment items) moved to `apps/backend/src/discovery/results.ts`. Decided in step 6:
   - Each task is one complete `sync` task, as in step 5: one query, then one fenced
     transaction that stores the page, moves or deletes the window (or advances or deletes the
     thread scans), and releases the job. Neither task touches the category's
     `last_checked_at` or `last_find_at`, which schedule incremental discovery. Choosing which
     task to run is left to step 7.
   - The search is `involves:LOGIN created:START..END sort:created-desc` over the category's
     newest window, with both bounds floored to whole seconds (`+00:00` offsets). After a page
     with more hits, `window_end` becomes its oldest hit's `createdAt`. If that is not before
     the current `window_end`'s second, the page is stuck: an error is logged and `window_end`
     moves one second back. The window is deleted after a page without more hits, or when
     `window_end` would fall before `window_start`.
   - Own content is a hit the user authored (by `author.id`), plus the user's comments in any
     hit's inline timeline page. A thread's `last_event_at` is the newer of its `createdAt` and
     its newest reaction. If only the hint's reaction is nulled, it falls back to `createdAt`.
     A hint error that nulls the whole hit (`reactions` is non-null) would lose that hit's
     comments, so the page is not stored. A warning is logged and the task is retried as
     transient.
   - A hit whose inline timeline has more comments gets a `thread_scans` row. Its `since_at` is
     the newest of the hit's `createdAt` and the inline comments' `createdAt`s.
   - A login mismatch updates `users.login` and makes the job due at once, in the same
     fenced transaction. The page is discarded.
   - A thread-scan task reads up to `threadScanBatch` (§14's thread scan batch, 50) threads,
     newest thread first until step 7's scoring. Each thread is read `since` its
     `since_at − 1 s` through query variables. A row advances with
     `greatest(since_at, newest comment)`, and is deleted after its thread's last page. A full
     page that doesn't pass `since_at` is logged as an error, and the row moves one second on.
     A thread that is gone (`NOT_FOUND`) is logged, and its row is deleted.
   - Comments get no probe; their `last_event_at` is their `createdAt`.
   - Checked against the live API. The search parses `+00:00` and other offsets, both bounds
     are inclusive at whole seconds, hits come newest-first, and the backfill query costs
     2 points. `timelineItems(since:)` filters by `createdAt`, not by `updatedAt`. It returns
     oldest-first and excludes comments at exactly `since`, so `since_at − 1 s` re-reads
     `since_at`'s second. This holds for issues and PRs. A thread-scan query for 3 threads
     costs 1 point, and a missing thread comes back `null` with a `NOT_FOUND` error at its
     alias.
7. **Scoring and polling:** the unified score, probe and drill-down, the hot-boundary
   watermark, and missing items.
   *Accept:* tests show no pre-`enabled_at` reaction is ever stored, a hot-boundary reaction
   is found on the next poll, `D` is respected, and a drill-down overflow logs an error
   without a second query.
   *Status:* done. The poll is `runPoll` in `apps/backend/src/polling/poll.ts`. Choosing and
   running a `sync` job's next task is `chooseSyncTask` and `runSyncTask` in
   `apps/backend/src/sync/schedule.ts`, and the score is `scoreSql` in
   `apps/backend/src/sync/score.ts`. The probe and drill-down queries are built at runtime with
   one alias per item by `packages/core/src/graphql/reactionPollDocuments.ts`, as the thread
   scans' query is. §14 gained `minRecheckSeconds` (`D`), `discoveryMinRecheckSeconds`
   (`D_discovery`), `scoreExponent` (`P`), `discoveryWeight` (`w`) and `probeBatch`.
   Decided in step 7:
   - The score is computed in SQL against `now()`. Content age is at least 1 s, and a negative
     wait counts as 0. The candidates are every item not checked for `D` (wait since
     `last_checked_at`, age since `last_event_at`, weight 1), every category not checked for
     `D_discovery` (since `last_checked_at`, since `last_find_at`, weight `w`), every backfill
     window (since `window_created_at`, since `window_end`, `w`), and every thread scan (since
     `scan_created_at`, since `thread_created_at`, `w`). Ties break by kind, then by node or
     category id; there is no jitter. Thread-scan batches are now ordered by the same score,
     not newest thread first.
   - `D_discovery` defaults to `D` (240 s) as a placeholder until the search lag is measured.
   - If nothing is eligible, the job is released until the first item is due again (its
     `last_checked_at + D`) or the first category is (`last_checked_at + D_discovery`),
     whichever is sooner, and after `D` without either.
   - A poll is one `sync` task: the probe, an optional drill-down, then one fenced transaction
     that stores the reactions, updates every probed item, and releases the job. It probes the
     top `probeBatch` (50, at most 100) due items by score.
   - An item is drilled down only if its newest reaction is strictly newer than its
     `watermark_at`, compared in whole milliseconds (the watermark floored). A newest reaction
     at the watermark does not re-read the page each poll. Reactions at or after the
     watermark are inserted with `ON CONFLICT DO NOTHING`, and only the inserted rows are
     returned, for step 8's fan-out. The insert filters by the watermark in SQL, before the
     watermark moves.
   - The watermark moves to `max(watermark_at, min(probe's newest, probe start −
     CLOCK_MARGIN))`. `last_event_at` is raised to the newest reaction seen, including ones
     before the watermark. An item without reactions keeps both.
   - A drill-down page that is full and whose oldest reaction is still at or after the
     watermark is logged as an error. The page is stored and the watermark moves as usual;
     there is no second query.
   - A missing item is one that comes back `null` with a `NOT_FOUND` error at its alias, in
     either query. It is logged, its `last_checked_at` advances, and its watermark stays, as
     §9.3 says; nothing is untracked. Any other error at an item, such as `FORBIDDEN` (SAML),
     fails the query as §12's unexpected responses do, the same as thread scans: a warning is
     logged, nothing is stored, and the job is retried after `syncRetrySeconds`. A failed
     drill-down is handled the same way, and the probe's results are not stored either.
   - A reaction without a user (a deleted account) is still stored and notified, as GitHub's
     `ghost`: `reactor_login = 'ghost'` and `reactor_id = 'ghost:' || createdAt`. A re-read
     sees the same `createdAt`, so it is deduplicated as usual. Ghost reactions with the same
     emoji in the same second become one. `reactor_id` stays `NOT NULL`, since it is part of
     the primary keys of `reaction_events` and `reaction_notifications`.
   - Polls send no `viewer` check; discovery's catches a changed login.
   - FR-8's latency is logged per poll as `latencyP50Seconds` and `latencyP95Seconds` of the
     new reactions (nearest rank, GitHub's `createdAt` to Postgres `now()` in the poll's
     finishing transaction, never the application host's clock).
   - `runSyncTask` is not run by a worker yet; that is step 10.
8. **Pipeline and digest:** fan-out (the `enabled_at` test; FR-12 keeps the user's own
   reactions), `reaction_notifications`, and the digest SQL.
   *Accept:* tests show no reaction is stranded when it is queued concurrently with rendering
   or finishing a digest, a successor is due 3 min after its predecessor's `run_at`, and there
   are no duplicates (FR-7).
   *Status:* done. Fan-out is `fanOut` in `apps/backend/src/pipeline/fanOut.ts`; the digest
   SQL is `openDigests`, `renderDigest` and `finishDigest` in
   `apps/backend/src/pipeline/digest.ts`. §14's batching window is `digestWindowSeconds`.
   Decided in step 8:
   - Fan-out runs inside the poll's fenced transaction, after the `reaction_events` insert and
     before the release, on only the rows that insert returned. A reaction reaches every user
     with a `content_sources` row for its item if `reacted_at ≥` that source's
     `enabled_at` for the item's type; there is no reactor filter (FR-12). `runPoll` returns
     and logs how many notifications it `queued`.
   - Digests are opened (or locked) one statement per user, in sorted user order, so
     concurrent fan-outs can't deadlock.
   - Finishing is two statements, not §10's one: the delete, then the successor's insert with
     its `EXISTS` check. A single statement that is the transaction's first to wait for a
     fan-out holding the digest's lock reads with a snapshot from before that fan-out
     committed, and strands its reactions; this was reproduced on a real Postgres. Rendering
     likewise starts with `SELECT … FOR UPDATE` on the job. `withLease`'s renewal takes the
     lock first anyway; the split keeps both correct on their own. The PGlite tests run
     transactions one after the other, so they cover every ordering; the lock waits between
     them were checked once against a real Postgres.
   - Rendering takes a renderer callback; the body's format, FR-15 grouping and sanitising
     are step 9. A digest rendered before returns its stored body. The batch's wait (now −
     `run_at`) is logged at rendering.
   - A digest that finds nothing `queued` when rendered is finished without a post (with a
     warning), and opens no successor.
   - No dispatcher calls rendering or finishing yet; that is steps 9 and 10.
9. **Dispatcher and inbox:** opening, rendering rules and FR-15 grouping, token bucket, the
   retry table, permanent failures, and the idempotency marker.
   *Accept:* tests show an ambiguous failure never double-posts, a pause blocks all `deliver`
   jobs, a permanent failure deletes all of the user's jobs (including `sync`), the rendering
   sanitises `@`, `#123`, and links, and an oversized body is truncated at 65,536 characters.
   *Status:* implemented, with the unresolved one-page reconciliation gap below. The dispatcher
   is `runDeliver` in `apps/backend/src/inbox/dispatcher.ts`; it
   works one leased `deliver` job. The digest's body is `renderDigestBody` in
   `apps/backend/src/inbox/digestBody.ts`. The machine account comes from
   `MACHINE_ACCOUNT_TOKEN` and `INBOX_REPO` (`owner/repo`). §12's backoff is
   `dispatchBackoffBaseSeconds` × 2^min(attempts − 1, `dispatchMaxExponent`), 60 s × 2^≤8.
   Decided in step 9:
   - An attempt is **ambiguous** if an earlier one may have posted, not merely if it is not the
     first. The token-taking transaction stamps `payload.attempted_at` (Postgres' epoch
     seconds) right before the first post, and later posts keep it. An attempt that finds it
     checks for the marker first, so a rescue or failure before any post skips the check.
   - The marker check is a read, so it takes no bucket token. It reads one page of 100.
     For a comment, it reads the target issue's comments since `attempted_at − CLOCK_MARGIN`.
     For an opening, it reads the inbox repo's 100 newest issues, skipping pull requests.
     It resolves the machine account's immutable REST author id through authenticated
     `GET /user` and accepts markers only on issues/comments with that `user.id`.
     A failed check is settled by §12's table, like a failed post.
     **Known correctness gap:** a successful full page without the marker is currently treated
     as absent.
   - A rate limit with neither header also pauses the whole dispatcher, for the job's backoff,
     since secondary limits are account-wide. The job keeps its `run_at`, as in every pause.
     `classifyWrite` already alerts on every rate limit (step 4). A transient failure alerts on
     every attempt (`dispatchAlertAttempts` = 1).
   - A missing channel, a missing or malformed target, or a malformed payload is a bug, not
     §12's permanent row. `runDeliver` throws and keeps the lease, so the reaper's alerts
     surface it.
   - An opening whose channel already has a target is deleted with a warning, without a post.
   - Creation responses require `201` and a valid identifier (§12). A malformed response is
     transient, releases the lease, and retains `attempted_at`; the next attempt checks for
     the marker. It may still be unable to find it because of the one-page gap above.
   - Digest format (FR-15): one list item per item, in order of first reaction. Each reads
     "N new 👍 and M new 🎉 on your issue | your pull request | your comment on *[title](url)*
     in *repo*", with one sub-item per emoji listing who reacted.
     - At most 10 logins are named per emoji; the rest are counted ("and 3 others").
     - Each login links to its profile on `github.com` and has a zero-width space after its
       `@`, the user's own included (FR-12), so it mentions no one.
     - Item links go through `redirect.github.com`, so they create no "mentioned this" event.
       A non-`https` URL is not linked.
   - Quoted text (titles, repo names, unknown emoji names) goes on one line. Its github.com
     URLs go through `redirect.github.com`. A zero-width space follows every `@`, and every
     `#` or `GH-` before a digit. Every ASCII punctuation character is backslash-escaped, so no
     Markdown or HTML survives.
   - Truncation drops whole items from the end and appends "…and N more items" before the
     marker. The 65,536-character limit is counted in UTF-16 code units.
   - `WriteContext.kind` carries the message kind: `opening`, `digest` or `one-off`.
   - No worker calls `claimJob` and `runDeliver` yet; that is step 10.
10. **Cron wiring, worker loop, observability, health endpoint, and an end-to-end run** on one
    real account: the worker's `IDLE_WAIT` loop and its exit before `maxDuration`, and the
    NFR-7 logs and alarms.
    *Accept:* the end-to-end run opens the inbox, notifies a new reaction exactly once and no
    pre-existing one, and the health endpoint responds. Then take §15's measurements.
    *Status:* done, except the end-to-end run and §15's measurements, which were deferred.
    The scheduler is `/api/cron` (`apps/backend/src/cron.ts`), scheduled every minute in the
    root `vercel.json`. The worker loop is `runWorker` in `apps/backend/src/worker/worker.ts`.
    The clock-offset check is `checkClockOffset` in `apps/backend/src/github/clock.ts`. The
    health endpoint is `apps/backend/api/status/up.ts`. The new tunables are `workersPerCron`
    (1), `idleWaitSeconds` (60), `maxDurationSeconds` (800-10=790), and `clockOffsetAlarmSeconds` (2).
    Decided in step 10:
    - The cron run hosts its workers: it reaps, then runs `workersPerCron` worker loops in its
      own invocation and answers once they all exit. It makes no request to GRN's own origin.
      `[WHY]` Vercel may pause an instance once it has responded, so work after the response is
      unsafe. Cron invocations overlap, so this still keeps about 10 workers alive. Vercel's
      cron is best-effort (it may skip or repeat a run and never retries one); leases and the
      reaper make both harmless.
    - `/api/cron` fails closed. Without `CRON_SECRET` it answers `500`. A request whose
      `Authorization` header is not `Bearer <CRON_SECRET>` gets `401` (constant-time compare).
      A failed reap is logged, and the workers still run.
    - The worker's two claims take turns going first, starting with `deliver`: after running
      one kind, it tries the other kind first. A claim of either kind that finds nothing falls
      through to the other.
    - The worker stops claiming at `maxDurationSeconds` − 2 × `requestTimeoutSeconds` (550 s)
      after the invocation started. It skips any idle wait that would end past that point, and
      exits instead.
    - A job that throws keeps its lease. The worker logs an error and goes on; the reaper
      retries it and alerts on repeats (§7.3). A lost lease is logged as a warning. A failed
      claim ends the invocation. The worker never throws.
    - A `sync` job whose token can't be decrypted is released. `loadToken` has already set the
      token `invalid`, so the job is no longer due.
    - Each worker logs its per-stage counters once, as `worker finished`: claims per kind, sync
      tasks per kind, delivery results, lost leases, errors, idle waits, and why it exited.
    - The `Date` header's offset from Postgres' `clock_timestamp()` is checked on GitHub
      responses, reads and writes, failed or not, at most once per `clockCheckIntervalSeconds`
      (60 s) per process. The offset belongs to the two clocks, not to a request, and drifts
      slowly. Each check costs a database round trip and a log line, so checking every
      response would be wasteful. Concurrent responses don't check twice. A response without
      a `Date` header doesn't count, and neither does a failed check, so the next response
      retries. The header has whole seconds, so its second's midpoint is compared. The offset
      is accurate to about ±0.5 s plus the response's latency. A failed check logs a warning
      and never fails the request.
    - The health endpoint reports whether `SELECT 1` succeeds within 5 s, in the same three
      formats as github-stats-extended, with `Cache-Control: no-store`. Unlike
      github-stats-extended, it answers `503` while down, so monitors need no keyword match.
      The `shields` format still answers `200`, since shields.io renders only a `200`'s badge.
    - Not yet verified on Vercel; check these in the end-to-end run:
      - how to set `maxDuration` to 800 s for a container-runtime project (README: Project
        Settings → Functions);
      - whether Vercel Cron triggers a container-runtime project;
      - how a scale-in or redeploy ends a running cron invocation. The reaper covers any job
        cut off mid-task.
