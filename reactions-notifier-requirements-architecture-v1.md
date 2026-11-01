# GitHub Reactions Notifier — Requirements & Architecture (Draft)

**Status:** Draft for discussion · **Working name:** `github-reactions-notifier` (GRN)

**M1 acceptance baseline:** `reactions-notifier-m1-requirements.md` is authoritative for
implemented M1 behavior and its known gaps; this document also describes future milestones.
Backfill starts at `1970-01-01T00:00:00Z`, not account creation.

---

## 1. Problem statement

GitHub sends notifications for issues, PRs, comments, mentions and reviews — but **never for
reactions**. If someone adds 👍 / ❤️ / 🎉 to your issue, PR, comment, discussion or release,
you only find out by accident. For maintainers and frequent contributors this is the single
biggest source of invisible positive feedback on the platform.

**GRN closes that gap:** users opt in once, and GRN tells them when their content gets new reactions.

---

## 2. Verified platform constraints

| # | Finding | Consequence |
|---|---|---|
| C1 | **There is no `reaction` webhook event.** No reaction event exists at repository, organization or app level. | Event-driven delivery is impossible. **Polling is mandatory.** |
| C2 | `Reaction` exposes `createdAt` (plus `content`, `user`, `reactable`, `databaseId`, `id`). | "New since X" is decidable by timestamp — no full set-diff needed, and backfill vs. notify is cleanly separable. |
| C3 | `Reactable.reactions` accepts `orderBy: {field: CREATED_AT, direction: DESC}`. | Incremental polling can **stop at the first reaction older than the watermark**. Cost per item ≈ O(new reactions), not O(all reactions). |
| C4 | Reactable types: `Issue`, `PullRequest`, `IssueComment`, `PullRequestReview`, `PullRequestReviewComment`, `CommitComment`, `Discussion`, `DiscussionComment`, `Release`, ~~`TeamDiscussion`, `TeamDiscussionComment`~~. | Defines the maximum possible scope. Gists and gist comments are **not** reactable → permanently out of scope. |
| C5 | `User` has connections for `issues` (`Issue`), `pullRequests` (`PullRequest`), `issueComments` (`IssueComment`, on issues **and** PRs), `commitComments` (`CommitComment`), `repositoryDiscussions` (`Discussion`), `repositoryDiscussionComments` (`DiscussionComment`). | These are the cheap content-discovery paths — **as far as their ordering allows** (C7). |
| C6 | `User` has **no** connection for `pullRequestReviews`, `pullRequestReviewComments` or `releases`. | These need fallback discovery → defer past MVP. See the connection table in §6.3 for the routes; for releases only a best-effort one exists (C11). |
| C7 | **Connection ordering is limited.** Thread connections can be ordered by the immutable **`CREATED_AT`**, but comment connections by **`UPDATED_AT` only** or **not at all** — per connection, see the connection table in §6.3 "Interruption and resumption". | Only creation-ordered connections can be paginated safely across interruptions, so backfill must reach comments **via their parent thread** — except commit comments, whose implicit order is safe (C12). This is a limit of the **connections**, not of the API as a whole: see C9. |
| C8 | GraphQL quota is 5 000 points/hour per **user**, and each user authorises their own token — but that budget is **shared** with every other app acting on their behalf and with their own PATs. | Capacity scales with the user base, but GRN must pace against observed headers and leave a reserve rather than assuming 5 000 are its own (§6.4). |
| C9 | **`search` supplies the ordering the connections lack — but only at thread granularity.** `search` accepts `sort:created-asc`/`-desc` and `sort:updated`, `created:`/`updated:` ranges, and the `author:` / `commenter:` / `involves:` actor qualifiers; `SearchType` includes **`DISCUSSION`** alongside `ISSUE`. Discussion search matches on comment bodies and commenters (`in:comments`, `commenter:`). **But `SearchResultItem` is `App / Discussion / Issue / MarketplaceListing / Organization / PullRequest / Repository / User` — there is no comment result type, and no comment `SearchType`.** | Every *thread* type in scope — issues, PRs **and discussions** — has a creation-ordered, date-windowable, resumable discovery route, **including threads the user merely commented on** (see the connection table in §6.3). So C7's parent-thread detour is the finest granularity the API exposes, not a workaround. `ISSUE` and `DISCUSSION` are **separate search types**, so covering both costs **two passes per window**. |
| C10 | **`search` lags behind the data.** Content reaches `search` results only after an indexing delay. GitHub documents no freshness guarantee. | A watermark pass driven by `search` must re-scan an **overlap margin** behind its watermark, or late-indexed items are skipped for good (§6.3). GraphQL connections do not read the search index and are unaffected by the delay. Its size — and so the margin — is measured in M0. |
| C11 | **There is no way to find all releases a user has created.** `User` has no `releases` connection (C6), `SearchType` has no release value, `ContributionsCollection` counts no releases, every REST release endpoint is scoped to a single repository (`/repos/{owner}/{repo}/releases…`), and the Events API reaches back only 30 days. `Repository.releases` has no author filter. | Release coverage can only be **best effort** (§6.3): first find the repositories where the user may create a release, then scan their releases for those the user created. Releases in repositories the user can no longer write to are missed. |
| C12 | **`User.commitComments` accepts no `orderBy`, yet it is ordered — and it is the only way to find a user's commit comments.** `SearchType` has no commit-comment value (C9), `ContributionsCollection` counts no commit comments, every REST commit-comment endpoint is scoped to a single repository (`/repos/{owner}/{repo}/comments…`, `/repos/{owner}/{repo}/commits/{sha}/comments`), and the Events API reaches back only 30 days. But the connection returns **every** commit comment the user wrote, in ascending `databaseId` — i.e. creation — order. Tested Sep 2026 (§6.3); the order is observed, not documented. | Unlike releases (C11), commit-comment coverage is **complete and cheap**: the connection is walked directly, with neither `search` nor a thread detour (§6.3). M0 re-checks the order; a periodic full walk is the backstop. Commit comments are deferred for scope, not feasibility (§3). |
| C13 | **GraphQL still returns legacy-format node IDs by default, and they cover most of history.** Tested Sep 2026. The format follows the **object's creation date**, not the request: `rails/rails` issues were legacy through 2021-07 and new from 2022-01. Legacy IDs still resolve as input *and are echoed back unchanged*, so the [announced sunset](https://github.blog/news-insights/product-news/new-global-id-format-coming-to-graphql/) — *"all requests made using the old IDs will result in an error"* — has not landed. With `X-Github-Next-Global-ID: 1` all 27 came back in the new format, no exceptions. | GRN stores node IDs as the primary key of `content` and the anchor of every per-user table (§6.5), and tracks content **across all time** (FR-4b), so the majority of what it indexes predates the cutover and would be stored in a format slated to stop working. **Every request must send `X-Github-Next-Global-ID: 1`**, asserted in CI (§9, M0). |

> **Design axiom:** poll with *the user's own token*, never with a shared PAT pool.
> A shared pool would make the whole service a single 5 000 pt/h bottleneck.

---

## 3. Scope

### Subscription sources (the core concept)

A user composes their coverage from independent **subscription sources**. This is the
long-term configurable model; sources ship incrementally (§9), and so do the columns that
name them (§6.5) — M1 stores a single implicit `authored` source per user.

| Source | Milestone | Meaning | Discovery cost |
|---|---|---|---|
| `authored` | M1 | Everything the user personally wrote | Low — direct `User.*` connections (C5) |
| `owned_repos` | M2 | All reactable content inside repos the user owns/admins, regardless of author | **High** — must walk repo content |
| `repo:<owner/name>` | M2 | All reactable content in one named repo | High, but explicitly opted into |

### In scope (M1–M2)
- Delivery: the GitHub-native inbox (§6.7); Atom feed, outgoing webhook, e-mail and in-app inbox follow in M2+.
- Reactions on content in *private* repos, from M2 (separate, explicitly-granted scope;
  Atom/webhook channels only — never the public inbox).

### In scope (later)
- **Per-type configuration** per source (FR-4d): issues, PRs and issue comments each get their
  own switch and filters, and a **category config** sets all three together. It applies when
  tracking, not when discovering, so a type that is off is never polled and switching one
  on or off needs no GitHub query. **No recency horizons and no item caps** — coverage is
  all-time, with check frequency decaying by age (§6.3).
- Self-service web UI for opt-in, source configuration, filters and channel management.
- PR reviews, PR review comments and releases (no `User` connection — needs C6 fallbacks;
  for releases only a best-effort one exists, C11); commit comments (deferred for scope, not
  feasibility: the `User` connection lists them all in creation order, C12).
- **Reactor opt-out list** (FR-9b) — the planned answer to the aggregation-privacy concern.
- Optional GitHub-App-based delivery to a user's own repo, if the shared ceiling binds (§6.7).
- Reaction **removals**, trend/milestone alerts ("your comment crossed 50 👍").

### Out of scope
- Gists (not reactable — C4).
- Team discussions (deprecated on GitHub).
- Acting on reactions (adding/removing them).
- Watching repos the user has no read access to.
- Any GitHub Enterprise Server support.

---

## 4. Functional requirements

### Onboarding & identity
- **FR-1** A user signs in with GitHub **OAuth** and thereby authorises GRN to read their content.
  **GRN must be an OAuth App, not a GitHub App.** A GitHub App acting on behalf of a user
  *"can only access resources in an account where it is installed"* — so it could not see the
  user's activity in organisations they belong to, or in other people's repositories, unless
  the App were installed in each of those accounts too. That is fatal for a product whose
  whole premise is reactions to *any* of the user's content, so the App route is closed for
  **reading**. It remains open for **delivery**, where scope is a single repo (§6.7).
  Signing in is the only step a user must take: GRN then opens their GitHub-native inbox for
  them (FR-9, §6.7).
- **FR-2** *(M2+)* Two access tiers, mirroring github-stats-extended: **public**
  (no scope) and **private** (`repo`), with an explicit upgrade and a
  **downgrade** path. M1 ships public-only.
- **FR-2a** A sign-in is accepted only if its token carries no scope beyond its tier's — in
  M1, **none**: the `scope` field of the token-exchange response must be empty. Otherwise GRN
  discards the token without storing it, deletes the user's grant
  (`DELETE /applications/{client_id}/grant`, as github-stats-extended's downgrade path does —
  which also invalidates any token GRN already holds for them), and sends them back through
  the no-scope flow. Requesting no scope does not ensure this: when a request omits `scope`,
  GitHub completes it *"with the set of scopes the user has authorized for the application"*
  ([GitHub docs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)),
  and GRN's `client_id` is public. So one approval of a hand-crafted
  `…/authorize?client_id=<GRN>&scope=repo` — by mistake, or via a phishing link — would make
  every later sign-in silently return a `repo` token, and private-repo content would reach
  the public inbox (NFR-4). From M2 the private tier's sign-in accepts `repo`; a public-tier
  sign-in that returns it goes through FR-2's downgrade path instead.
- **FR-3** A user can delete their account and all data held about them (token, content index,
  reaction history, channels) in one action. **No data export** is offered.
- **FR-3a** *(M2)* A user can stop all of GRN's activity for their account — polling and
  delivery — by replying `/stop` in their inbox issue, which GRN then closes, and resume it by
  replying `/start`, which opens a new one (§6.7). Stopping discards nothing: a resumed
  account picks up where it stopped. Until then, unwatching the inbox issue silences GRN, and
  deleting the account (FR-3) stops it.

### Detection
- **FR-4** A user configures any combination of **subscription sources** (§3): `authored`,
  `owned_repos`, and zero or more named `repo:<owner/name>` subscriptions.
- **FR-4a** GRN discovers content matching each enabled source across all repositories the
  user can see, and tracks it for reactions.
- **FR-4b** GRN tracks content **across all time**, with no recency horizon. Check *frequency*
  decays with an item's age instead (§6.3), so old content is still covered, just polled less
  often. Any new reaction resets an item's age, returning it to frequent polling. No item is
  ever re-checked sooner than a **minimum delay `D` (default 2 min)**, *even when the user has
  plenty of budget left* — a user with a single tracked issue must not have it polled
  continuously.
- **FR-4c** A `repo:` subscription is only accepted if the user currently has read access to
  that repository; access is re-validated on each discovery pass.
- **FR-4d** *(M2)* Each subscription source carries a **configuration per content type**
  (issues, PRs, issue comments, discussions, discussion comments, and later
  releases/reviews): an on/off switch and FR-11's filters. Types that one discovery query
  returns together form a **category** — issues, PRs and issue comments; discussions and
  discussion comments — and a **category config** controls a category's types together: a master
  switch, and filter defaults its types inherit unless they set their own. A type is on only
  while both its own switch and its category's are. A category that has never been on is
  configured as the user first switches it on; until then it shows its defaults (§6.5).
  The configuration applies at **tracking** time: a category is discovered while any of its
  types is on, keeping every type its query returns, but only types that are on are
  tracked. So a type that is off never consumes polling budget, and switching a type in a
  category already being discovered costs no GitHub query (§6.3).
- **FR-5** GRN detects reactions added to tracked content and records reactor, emoji, timestamp,
  the reacted-to item, and **which source(s) matched it**.
- **FR-6** Pre-existing reactions are never notified; the user is never spammed with a
  historical reaction backlog. The test is applied to **each reaction individually** — was it
  created before the moment its content type was enabled (`enabled_at`, §6.5, which errs a few
  seconds early for clock skew)? — so an item's
  age, and how or when GRN discovered it, are both irrelevant. A decade-old issue that
  receives a 👍 the day after the user subscribes therefore notifies, which an item-level
  test could not do. A type added to an
  existing source later — because a milestone ships it (discussions, M2) or because the user
  switches it on (FR-4d) — carries its own enable moment and so gets its own silent
  first sync; switched off and on again, it gets a new one. M1 sends no backfill-completion
  summary. A completion summary is deferred to M2.
- **FR-7** Each (content, reactor, emoji) triple notifies **at most once per user**, even when
  several of that user's sources match the same item, and across re-adds, retries and restarts.
- **FR-8** Detection latency is an **emergent, measured property**, not a guarantee — it falls
  out of the budget-driven scheduler (§6.3). GRN reports observed p50/p95 latency for recently
  active content, because that is the only signal that a user's budget is adequate.

### Notification
- **FR-9** Channels: the **GitHub-native inbox** (§6.7) is mandatory and the **only M1
  channel**. **Atom/RSS** (tokenised private URL), generic outgoing webhook and in-app inbox
  follow in M2; e-mail is later.
- **FR-9a** Delivery of GitHub-native notifications is serialised, paced and retried per §6.8,
  and is **idempotent**: an ambiguous failure must never produce a duplicate comment.
- **FR-9b** *(M3)* Any individual (not only GRN users) may request via a public opt-out
  list that their reactions are never tracked or named by GRN; matching reactions are then
  dropped or rendered anonymously. See §6.7.
- **FR-10** Cadence per channel: near-instant, hourly digest, daily digest, weekly digest, off.
  M1 offers only near-instant, batching each user's reactions over a few minutes; under load
  the shared content-creation ceiling stretches that interval rather than ruling the cadence
  out (§6.6–6.8). Its noise is accepted until users can choose a cadence in M2.
- **FR-11** *(M2)* Filters, settable globally, per subscription source, and per content-type
  category or single type (FR-4d), a type inheriting its category's filters unless it sets its own:
  by emoji, by repository/org (allow- or deny-list), by content type (FR-4d), by content author
  (e.g. "in my repos, only content written by others"), minimum reactions-per-batch
  threshold, mute a single thread.
- **FR-12** Reactions by the user themselves are excluded by default; bot reactors excluded by
  default. Both are implemented and become configurable with FR-11 in M2.
- **FR-14** *(M4, optional)* E-mail channels require double opt-in and one-click unsubscribe. The
  GitHub-native channel needs neither: signing in (FR-1) *is* the opt-in — the sign-in page
  states that GRN will open a public inbox issue for the user — and replying `/stop` in it *is*
  the unsubscribe (FR-3a). Relevant only if e-mail is ever added.
- **FR-15** Digests group by content item, then by emoji — "5 new 👍 and 2 🎉 on *comment reference*".
  Items the user did not author are labelled with their author and the matching source
  ("on **@octocat**'s comment in *your repo* `owner/name`"). That @ only looks like a mention:
  a digest must not notify anyone but its user, and must not mark any of the threads it links to (§6.7).

### Operations & transparency
- **FR-16** The user can see their sync status: last poll, items tracked, quota consumed, errors.
- **FR-17** If a token is revoked or expires, GRN stops polling, marks the account, and tells
  the user via a still-valid channel.
- **FR-18** Public service status/health endpoint (mirrors the existing `/api/status/up`).

---

## 5. Non-functional requirements

- **NFR-1 Cost:** runs on **Vercel Pro + Postgres** with no always-on cluster (§6.2).
- **NFR-2 Quota safety:** GRN must never exhaust a user's GitHub rate limit. It applies a
  **single global budget policy** (§6.4); per-user configurable caps are postponed.
- **NFR-3 Security:** OAuth tokens **encrypted at rest**, following the approach already
  taken in github-stats-extended
  [PR #536](https://github.com/stats-organization/github-stats-extended/pull/536):
  AES-256-GCM, 32-byte key from `TOKEN_ENCRYPTION_KEY` (hex or base64), `user_id` as AAD,
  a versioned `v1.` prefix marking ciphertext, and comma-separated keys for rotation
  (first encrypts, all decrypt). An undecryptable token is treated as "user must log in
  again" rather than a crash.
  **GRN should be stricter than the original in one respect:** because it is greenfield, the
  key is **mandatory** — no plaintext fallback, no legacy-plaintext read path, no migration
  script. That removes the compatibility surface PR #536 has to carry.
- **NFR-4 Privacy:** *(M2+ — depends on the private tier, FR-2)* content from private
  repositories must never appear in a notification body unless explicitly opted in; default to
  a bare link. Private-repo content must **never** be written to a publicly visible inbox
  issue under any configuration (§6.7). GDPR-compliant deletion applies from M1 (FR-3).
- **NFR-5 Abuse resistance:** the service must not be usable as a spam relay (FR-14),
  outgoing webhooks must be SSRF-guarded (block private IP ranges, redirects, non-HTTPS).
- **NFR-6 Idempotency:** every pipeline stage is safely retryable; at-least-once job execution
  with exactly-once *user-visible* effects.
- **NFR-7 Observability:** structured logs, per-stage counters, dead-letter queue for
  undeliverable notifications.
- **NFR-8 Stack parity:** same toolchain as github-stats-extended (pnpm workspaces, turbo,
  TypeScript, vitest, eslint/prettier/knip, Vercel + Postgres) so code can move between the
  two projects without friction.

---

## 6. Architecture

### 6.1 System context

```
┌───────────┐  OAuth + settings   ┌──────────────────────────────┐
│  Browser  │────────────────────▶│  Web app (Astro + React)     │
└───────────┘                     │  + API routes, inbox webhook │
                                  └──────────────┬───────────────┘
                                                 │
              ┌──────────────────────────────────┼───────────────────────────────┐
              │                                  ▼                               │
   ┌──────────┴──────────┐            ┌────────────────────┐          ┌──────────┴─────────┐
   │  Scheduler (cron)   │───reap───▶ │  Postgres          │◀─────────│  Workers (Node)    │
   │  Vercel Cron (Pro)  │            │  state + job queue │  claim   │  sync / deliver    │
   └─────────────────────┘            └────────────────────┘          └──────────┬─────────┘
                                                        ┌────────────────────────┼──────────┐
                                                        ▼                        ▼          ▼
                                                 GitHub GraphQL API     GitHub Issues     Webhooks
                                                 (per-user token)       (inbox comments)
```

### 6.2 Components

| Component | Responsibility |
|---|---|
| **Web app** | Marketing/docs (Starlight), OAuth flow — whose sign-in also queues the opening of the user's inbox issue (§6.7) — settings UI, and from M2 the Atom feed endpoint and the inbox repo's webhook route, which applies `/stop` and `/start` (§6.7). *(No in-app inbox in M1 — too much effort for too little, and FR-9 already limits M1 to the GitHub-native channel.)* |
| **Scheduler** | **Vercel Cron.** Pure trigger: every minute it starts worker invocations and frees the jobs of workers that died (below). It enqueues nothing: whether a user's budget window has room is decided when a worker claims their job. **No GitHub calls** — see below. |
| **Discovery workers** | One **pluggable source adapter** per subscription kind (`authored`, `owned_repos`, `repo`), each split into a cheap **incremental** pass and a low-priority **backfill** walk (§6.3). Honours FR-4d by discovering per content-type category and keeping every type the category's query returns: upserts `content`, `content_sources` and `tracked_content`, parking the rows of types that are off (§6.3); refreshes the category's `last_find_at` when it finds something. |
| **Reaction poller** | Drains the score-ordered queue (§6.3) while budget allows, fetching reactions newer than each item's watermark (C3). Emits new-reaction rows. |
| **Notifier** | Groups new reactions per user/channel/cadence and renders messages. Not a job of its own: the insert into `reaction_notifications` opens each user's pending message — a `deliver` job in M1, an outbox row from M2 — and the dispatcher has it rendered when it is sent (§6.6). |
| **Dispatcher** | Does all the machine account's work — opens each user's inbox issue and delivers the notifier's messages to it (§6.7) — a new user's inbox first, then strictly in `run_at` order. **Globally serialised** for the shared machine account, token-bucket paced, idempotent, with classified retry and a dead-letter queue (§6.8). |
| **Token service** | Encrypt/decrypt tokens, detect revocation, drive the downgrade path. |

Workers are plain Node processes driven by a Postgres queue
(`SELECT … FOR UPDATE SKIP LOCKED`), so the same code runs as a Vercel function or a
long-lived container without rewrites.

#### How a claim knows about budget without calling GitHub

A user's `sync` job (below) is due whenever their budget has room, and the claim decides that
afresh each time instead of a scheduler storing when to run. It reads the `rate_limit_state`
row each worker already writes from response headers (§6.4), and applies one deterministic rule:

```
if now > reset_at + CLOCK_MARGIN:   window has rolled over → treat as full budget (used = 0)
else:                               use the stored limit_ / used / reset_at
```

Window rollover needs no API call because the reset time is known in advance. The only thing
the claim cannot see is budget consumed **by other apps** since our last response in the
current window — but that is discovered from the headers on the very first request of the next
batch, which simply **overwrite** the stored row. The headers are authoritative, so this is a
refresh rather than a correction loop (§6.4), and scheduling stays purely database-driven.

> If budget drift ever proves a problem, `GET /rate_limit` is an authoritative check that **does not
> count against the primary limit** (it does cost secondary budget, so it must not be polled
> per user per cycle). Worth keeping in reserve rather than designing around.

**Two clocks.** GRN's stored timestamps all come from Postgres `now()`, so they compare exactly
with each other. GitHub's — `createdAt`, `x-ratelimit-reset` — come from GitHub's clock, in
whole seconds. Where the two meet, GRN errs by one constant, `CLOCK_MARGIN = 10 s`, toward
re-reading or waiting longer: `enabled_at` is stamped that much early (§6.5), the poll
watermark never passes the probe's start less it (§6.3), and the rollover rule above and
every wait for `x-ratelimit-reset` (below, §6.8) add it. The margin covers skew, the
whole-second truncation and any delay before a new reaction becomes readable. Discovery needs
none of its own: its watermarks are GitHub's own values, seeded with the larger search overlap
margin (C10). Skew is normally milliseconds; workers log the offset of GitHub's `Date`
response header from their own clock and alarm above 2 s (the header has whole-second
precision).

#### Hosting: Vercel Pro

Host on Vercel and schedule with **Vercel Cron** on the **Pro plan**. The app ships as a
Docker image, built from `Dockerfile.vercel` and published to the GitHub Container Registry.

Pro is a requirement rather than a preference: **Hobby cron jobs run at most once per day**
(per-hour precision, and over-frequent expressions fail at deployment), which cannot drive an
hourly budget window. Pro allows **once-per-minute** scheduling.

**Function budget on Pro:** 300 s default, raisable to **800 s**. Work is sliced anyway: cron
fires every minute and starts worker invocations, each of which claims a due job, works a
bounded slice of it — stopping well short of the time limit — and releases it. No invocation
needs to finish a user's queue — because the queue is score-ordered (§6.3), an interrupted pass
simply resumes at the right place, and a slice boundary costs nothing but a little latency. An
invocation killed mid-slice cannot release its job, which is why jobs are leased (below).

#### The job queue: kinds and leases

The queue is the `jobs` table (§6.5), with two kinds in M1:

| Kind | Rows | Runs |
|---|---|---|
| `sync` | One per user, inserted at signup and deleted on account deletion or permanent delivery failure | The user's score-ordered queue (§6.3) — discovery, backfill and polling — with fan-out, replays and `reaction_notifications` inserts inside its transactions (§6.6). It also creates the user's one-off messages: FR-6's summary, in the transaction that deletes a category's last backfill window, and FR-17's notice on a `401` |
| `deliver` | One per message, deleted once posted | One write by the machine account: a user's batch of reactions (§6.6), a one-off message, or the opening of an inbox issue — the user's first, at sign-in, or a rollover (§6.7) |

Discovery, backfill and polling are not kinds of their own: they compete in one queue for one
budget (§6.3), and holding the user's single `sync` job is what keeps one request in flight
per token (§6.4) — and why a backfill window being walked needs no marker (§6.5). Nor is
notifying: the insert into `reaction_notifications` opens the user's `deliver` job directly
(§6.6). Everything else runs inline where it arises — a sign-in, a type switch or account
deletion in its web request, a replay in the transaction that finds the item, revocation on
the `sync` job's own `401`.

The machine account's token gets the same guarantee from a single lease: at most one `deliver`
job is leased at a time (§6.5), and whichever worker holds it is the dispatcher (§6.8).

**`run_at` means "not before", and stores only what nothing else records.** A `sync` job is
due whenever its user's token is `active` and their budget has room — the rule above, which
the claim evaluates by joining `users` and `rate_limit_state`, so time alone makes a user due
and nothing needs to enqueue them:

```sql
-- a 'sync' job is due when
locked_by IS NULL AND run_at <= now()
  AND token_status = 'active' AND budget_has_room(rate_limit_state)  -- rule above, §6.4's guard
```

Its `run_at` holds only what no other table records: when its last slice ended, or when a wait
ends — backoff after a failure, a secondary limit's `retry-after` (§6.4). A slice that ends
normally sets `run_at = now()`: the job is due again as soon as the budget allows, but behind
every user who has waited longer, since a `sync` claim takes the oldest `run_at` first
(step 1). So when more users are due than workers are free, the due user left unchecked
longest gets the next free worker — a round-robin. Left untouched, `run_at` would keep its
signup time, and the earliest users would win every claim. A `deliver` job's `run_at` is the
end of its batching window (§6.6), then its retry backoff (§6.8). Until a user's inbox issue
exists, the job that opens it is the only one of theirs that is due (§6.7), and a claim takes
it before any other (§6.8). And no `deliver` job is due while the machine account's token
bucket is empty: the claim reads its row (§6.5) as a `sync` claim reads `rate_limit_state`,
so the bucket's pacing, and any pause it holds, bind whichever worker claims next (§6.8).

**Leases, not held locks.** A worker that dies — killed at the time limit, or crashed — must
not keep its job claimed for good. Holding a row or advisory lock for the whole job would free
it automatically, but needs a database session open for up to 800 s and breaks behind
transaction-mode connection poolers. A lease that is never renewed must outlast the longest
slice, which only Vercel's `maxDuration` bounds — nothing does in a container — whereas a
renewed one need only outlast the gap between two commits, so its timeout can shrink later
without shortening slices. Instead:

1. **Claim** in a short transaction of its own. `locked_by` is a fresh uuid per claim — a
   fencing token, not a worker name — and `attempts` counts claims, so a crash counts as an
   attempt:
   ```sql
   UPDATE jobs SET locked_by = gen_random_uuid(), locked_at = now(), attempts = attempts + 1
   WHERE id = (SELECT id FROM jobs WHERE …          -- due, as above
               ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
   RETURNING *;
   ```
2. **Renew and fence with every commit.** Every transaction a job commits starts by renewing
   its lease, which also proves it still holds it — free for `sync`, which writes
   `rate_limit_state` after every response anyway:
   ```sql
   UPDATE jobs SET locked_at = now() WHERE id = $1 AND locked_by = $2;
   -- no row: the lease is lost — ROLLBACK and exit
   ```
   The row lock this takes lasts until commit, so the reaper cannot take a lease
   mid-transaction, and a worker whose lease was reaped can no longer write.
3. **Finish with the job's last write**, in the same transaction: a `sync` job is released
   (`locked_by = NULL`, `attempts = 0`, `run_at` as above), a `deliver` job deleted — a
   digest opening its successor if reactions are queued (§6.6).
4. **Keep leases short.** GRN aborts any request not complete within 2 min — its own timeout,
   not GitHub's: GitHub ends a request after 10 s of its own processing (`502`/`504`), but
   that does not bound a stalled connection, on which Node's `fetch` would by default wait
   300 s. 2 min is a generous start, to be shortened once real response times have been
   observed. And no worker sleeps holding a lease: a `retry-after`, or an `x-ratelimit-reset`
   plus `CLOCK_MARGIN` (above), sets a `sync` job's `run_at`, or empties the machine
   account's token bucket until then (§6.8);
   a spent budget leaves the job undue; and either way the job is released. Slices stop well
   before `maxDuration`, starting no request within one timeout of it.
5. **Reap.** Every cron run releases leases not renewed for 15 min — so a dead worker's job is
   free again within about 16 min — behind a backoff that doubles with each attempt:
   ```sql
   UPDATE jobs SET locked_by = NULL, locked_at = NULL,
          run_at = now() + interval '1 minute' * power(2, least(attempts, 8))
   WHERE locked_by IS NOT NULL AND locked_at < now() - interval '15 minutes'
   RETURNING id, kind, user_id, attempts;          -- logged as rescued (NFR-7)
   ```
   15 min is deliberately generous: it need only exceed the longest gap between a live worker's
   commits, which the request timeout (step 4) bounds. Like that timeout, it is to be shortened
   once real gaps — logged at each renewal — have been observed. Until then a crash stalls its
   user's polling that long, or all delivery if it held the machine account's lease. On
   Vercel, 15 min also exceeds `maxDuration`, so for now no live invocation can lose its lease.

A rescued `sync` job resumes where it stopped, since all its progress is durable (§6.3). A
rescued `deliver` job may already have posted, so it retries as an ambiguous failure (§6.8). A
job that kills its worker every time backs off to ~4 h instead of looping, with an alert after
a few attempts; M3's dead-letter queue replaces the alert.

**Later kinds.** M2's outbox takes over from `deliver` in the same shape (§6.6). Its `/stop`
and `/start` (§6.7) need no kind of their own: the webhook route applies them inline, and the
closing or opening of an inbox that each asks of the machine account queues like its other
writes. Its other `/`-commands may arrive as `command` jobs, if the route queues them rather
than applying them inline. M4's shared polling of public content (§6.5) is not per user, so it
needs a kind of its own.

### 6.3 The polling engine (the heart of the system)

**One queue, one budget, 3 kinds of task.** Discovery, backfill and reaction polling share a single
budget-driven priority queue, worked by the user's one `sync` job (§6.2).

**All three kinds score by the same freshness rule**, `wait / content_age^P`, differing only in
what counts as an "event" — a new reaction vs. a newly found item. The general form is:

```
score = (wait / content_age^P) × value_weight
```

**One query is the unit of work**, and every query is assumed to return a full page: ~50 items
for a batched reaction probe, 100 hits for a `search` page, 100 nodes for a connection walk.

That makes `value_weight` a pure exchange rate between kinds. It
is **1 for poll tasks** — they are the unit the other kinds are priced against — and **`w` for
discovery and backfill**, which is what makes a full page of newly covered items comparable
to a full batch of re-checked reactions.

The full-page assumption errs in the obvious direction: a quiet incremental pass returns
nothing, and a sparse backfill window returns three hits rather than 100. It holds up because
the `1/content_age^P` term is a *measured* arrival rate, not a prior — a source that keeps
coming back empty has a stale `last_find_at` and sinks in the queue on its own, with no yield
estimate anywhere in the formula.

#### Task kind A — content discovery

Each subscription kind has its own adapter; all of them upsert into the shared `content`
table, link the item to the matching source via `content_sources`, and track it in
`tracked_content` if its type is on ("Discover per category, track per type", below).

- **`authored`** — *incremental:* walk `user.issues`, `user.pullRequests` and
  `user.repositoryDiscussions` ordered by `CREATED_AT DESC`, and `user.issueComments` by
  `UPDATED_AT DESC` (its only order, C7), each stopping at its stored watermark; cheap and
  precise. Creation order suffices for the three thread connections, and being immutable it is
  also the stable one (C7): a thread the user opened needs discovering only once — later
  reactions on it are the poller's job, and the user's later comments on it are found by the
  comment passes. **Discussion comments are the one exception:**
  `user.repositoryDiscussionComments` accepts no ordering at all (C7), so it admits no stop
  condition in either direction. They are reached instead through
  `search(type: DISCUSSION, query: "involves:USER sort:updated-desc")`, stopping at an
  `updated_at` watermark less the overlap margin every search-driven pass needs
  ("Interruption and resumption" below), and reading the matched discussion's comments and
  their threaded replies inline — the same newest-first, watermark-terminated shape as every
  other incremental pass (C9).
  *Backfill:* date-windowed `search`, reaching comments through their parent threads rather
  than through the comment connections, which have no stable sort (C7, and "Interruption and
  resumption" below).
  **`author:USER created:A..B` alone is not sufficient.** It returns only threads the user
  *opened*, so a comment the user wrote on *someone else's* thread is never reached — and that
  is the majority of most users' comment history. The window must cover threads the user
  merely participated in, via either:
  - `involves:USER created:A..B` — one query; a superset (it also matches mentions and
    assignments), so the thread walk must still filter to content the user actually wrote; or
  - two windowed queries, `author:USER` and `commenter:USER`. More precise, but note that
    mixing two *different* actor qualifiers **ANDs** them — `author:USER commenter:USER` means
    *both*, not *either* — so they cannot be collapsed into a single `OR` query; they are
    genuinely two passes.

  Either way the union is idempotent at the upsert, so overlap between the two is free.

  **Both search types must be windowed.** `ISSUE` and `DISCUSSION` are distinct `SearchType`
  values with disjoint result sets (C9), so they belong to two categories (FR-4d), each with **its
  own window set** — one query per window, scored and scheduled independently, the two sets
  free to differ in their bounds and their splits. Omitting the `DISCUSSION` category would
  silently drop discussions and discussion comments, which are in scope (§3). The actor
  qualifiers carry over unchanged: `type: DISCUSSION` supports `author:`, `commenter:` and
  `involves:` exactly as issue search does.
- **`owned_repos`** — walk `viewer.repositories(ownerAffiliations: OWNER)`, then per repo walk
  `issues` / `pullRequests` / `discussions` ordered by `UPDATED_AT DESC`, reading inline in the
  same query **every** issue or PR comment created since the watermark and
  **every** comment and reply of each discussion: a reply bumps the discussion's `updatedAt` but
  not its parent comment's (tested Oct 2026), so a new one can hide under an old comment.
  Backfill likewise reads every comment and reply. Reactions bump no `updatedAt` at all, so a
  thread that only collects reactions never resurfaces here; but both halves track every item,
  so the poller still probes it, and those reactions are **detected late** — at the item's
  long-tail interval (Task kind B) — never missed.
- **`repo:<owner/name>`** — identical to the per-repo step above, after an access re-check (FR-4c).

**Discover per category, track per type (FR-4d).** A content type is the unit of
*configuration*, not of discovery: one `type: ISSUE` window returns issues, PRs and the
threads holding the user's issue comments as a single result set, so discovering per type
would take three window sets and three query shapes, or logic to merge them. Discovery
therefore runs per **category** — the types one query returns together: `issue` (issues, PRs,
issue comments) in M1, and `discussion` (discussions, discussion comments) from M2. A later
type joins the category whose query returns it or, having a route of its own, forms its own
category: PR reviews with their comments (`reviewed-by:`), commit comments (C12), releases (C11).
A category has one window set and one set of incremental passes (§6.5) and runs while any of its
types is on. It keeps **every** type its query returns, in `content`, `content_sources` and
`tracked_content`, whatever the switches say. A `tracked_content` row whose type is off in every
source that matched it is **parked**: kept, with its `last_event_at`, but skipped by the poller,
which reads no switch itself. Discovery therefore inserts the rows of a type that is off parked,
and un-parks a parked row it finds again through a source where the type is on. Switching a
type only parks and un-parks rows — a database update, not a GitHub query:

- **On:** stamp the type's `enabled_at = now − CLOCK_MARGIN` (§6.2) and un-park the type's
  rows among the source's items (`content_sources`), setting `watermark_at = enabled_at` and,
  as for a new row, `last_checked_at = now`. FR-6's silent first sync is thus complete on commit for everything
  the category has found, and each item keeps its `last_event_at` for scoring; later finds
  are tracked as they arrive. The exception is the first type ever switched on in a category: it
  starts the category's discovery, backfill included — this is when the category's row is
  inserted (§6.5) — and its items are tracked as they are found.
- **Off:** clear `enabled_at` and park the type's `tracked_content` rows that none of the
  user's other sources still tracks with that type on (`tracked_content` is per user, not
  per source). Nothing is deleted, so per-item state such as a mute (FR-11) survives too.
  Still, this deselects rather than pauses: reactions arriving meanwhile are never notified,
  and switching back on is a fresh silent first sync. Suspending a source without that loss
  is a separate, deferred feature: pausing (`subscriptions.enabled`, §6.5).
- **Category off:** by its master switch, or when its last type goes off. Its types count as
  off, as above, and its discovery stops — but its row, windows and watermarks stay. Switching
  the category back on turns the types the user chose on again, each with a fresh `enabled_at`,
  and resumes discovery rather than restarting it: the next incremental pass walks down to the
  stored watermarks and finds everything created meanwhile, which keeps `content_sources`
  complete for later switches. A long gap only makes that pass longer; one too long ever to
  finish is what the livelock guard ("Interruption and resumption", below) is for.

Notification needs no check of its own: fan-out applies each source's cutoff, its
`enabled_at` for the item's type (§6.6), and a type that is off has none. Only races need
care, because `tracked_content` is shared by all of a user's sources. A discovery worker reads
the switches and then upserts a page, so a switch committed in between would leave an item
polled whose type is off, or parked whose type is on. And two switches on different
sources each decide from the other's state, so concurrently one could leave a row polled that no
source tracks any more, or park one the other has just relied on. Hence one lock per user:
every switch takes it exclusively and every worker upsert shared (`FOR UPDATE` / `FOR SHARE`
on the user's `users` row). Switches thus serialise with everything, workers only with
switches, and whichever goes second sees the other's result.

A category's incremental passes go out together, aliased side by side in one query that costs 1
point like a single pass (§6.4). So the category, not the pass, carries `last_checked_at` and
`last_find_at` and is scored as one source (below), while each pass keeps its own watermark
and pages on alone only while its pages come back full of new items. Repo-scoped sources (M2)
follow the same rule: a category's repository walks run while any of its types is on.

The price is discovery that ignores the switches. A type that is off still costs its share:
backfill cannot narrow its query to `author:USER` when comments are off, and still reads
every thread's comments. And GRN holds metadata and parked rows for it — the user's data under
FR-3, deleted with the account. Both buy what makes the switches cheap: switching a type on
never re-runs history.

**Split each source into two task types — this is what makes frequent discovery affordable:**

| | **Incremental** | **Backfill** |
|---|---|---|
| Job | Fetch newest-first, stop at the stored **watermark** | Walk history newest-first through a **date window** |
| Cost | Proportional to *activity*, not repo size — a quiet source costs ~1 query | Proportional to *history*; large but **finite and terminating** |
| Frequency | Very often (minutes) | Rarely; drains over days, competing by score for the shared budget |

The key property: incremental discovery on a quiet source is **one query that returns nothing
new**. That is cheap enough to run every few minutes even for repo-scoped sources. The
expensive historical walk is a separate, low-priority task that is **deliberately outranked**
by fresh detection.

**The two halves start together and run side by side:** when a category's discovery starts, that
moment is recorded as its `discovery_started_at` (§6.5); backfill windows cover history up to
it, and it less the overlap margin (C10) seeds each of the category's incremental watermarks, so
neither waits for the other. A type's own `enabled_at` plays no part here: it only seeds the
`tracked_content` watermarks that decide FR-6's silence.

**Scoring a discovery task — the same freshness rule as polling:**

A discovery source — for a subscription, each of its categories — behaves exactly like a content
item: *it has a last-checked time, and it has a last-event time, where the "event" is finding
something new.* So the poll score generalises directly, with only the weight changed.

```
eligible:  last_checked_at ≤ now − D_discovery
score   =  (wait / content_age^P) × w

  wait        = now − last_checked_at   (seconds; when did we last look here?)
  content_age = now − last_find_at         (seconds; how old is the newest thing found here?)
  w           = weight converting a page of newly covered items into probe-equivalents
```

This is the identical `wait / content_age^P` shape used for reaction polling below, and it rests on
the identical argument: new-item arrival, like reaction arrival, **clusters and then decays**.
A repo that just received an issue will probably receive another; a repo dormant for two years
probably will not. So `1/content_age^P` estimates the current arrival rate, and `wait` is the window
over which arrivals could have accumulated.

**Finding something new resets `last_find_at = now`**, exactly as a new reaction resets an
item's `last_event_at`. The nesting works too: when the `owned_repos` walk discovers a new
repository, that both (a) marks `owned_repos` itself as fresh, so it is re-checked soon, since
repos are often created in bursts, and (b) creates a new per-repo discovery target which starts
fresh and is therefore walked promptly. One rule, applied at every level.

Properties of this scheme:

- **Continuation is self-justifying.** A pass is scheduled as one
  query and paginates further only while pages keep coming back full of new items — that is
  exactly what the watermark stop condition means (except in case of a restarted pass, where not all returned items are truly new). A busy repo spends more queries than a
  quiet one *because* each extra query is paying off, so spend already tracks yield.
- **New subscriptions self-prioritise.** Initialise `last_find_at = now()` when a category's
  discovery starts, so `content_age`
  is small and the source is discovered eagerly, then relaxes if it proves quiet.
- **Guard rails**: `D_discovery` as a floor, and the same `content_age^P` damping used for
  polling, so a source that has gone quiet still climbs back and is re-checked periodically.

Guard rails, mirroring the poll path:

- **A minimum delay per source** (`D_discovery`, a few minutes) so a user with one small source
  cannot have it re-walked continuously just because they have budget to spare.
- **`content_age^P` damping** (as for polling) so a dormant source keeps climbing the queue and
  wakes up periodically — a quiet repo can become busy again. See "Starvation" below.

> **Why letting discovery lag is safe.** A late-discovered item does not *lose* its reactions.
> Silence is decided per reaction, by its own `createdAt` against the type's `enabled_at`
> (FR-6, §6.5) — never by the item, nor by which pass found it. So a late-found item still
> notifies every reaction it received after the user subscribed, even one that another user's
> poll recorded first, which is replayed when the item is found (§6.6). Discovery latency thus
> delays notifications rather than dropping them, which is what makes it acceptable to let
> expensive sources run rarely. It also means a backfill that misses an old item through
> search lag (C10) causes neither a burst of years-old notifications nor a silent hole when an
> incremental pass finds it weeks later.

#### Interruption and resumption

Running out of budget mid-pass is the normal case, not an exception, so every discovery task
must survive it.

**Do not store cursors across passes.** GitHub's docs describe a cursor as *"a specific
position in the data set"* — a position, with no stated durability guarantee. Decoding real
cursors shows why that matters:

| Sample | Decodes to | Meaning |
|---|---|---|
| `Y3Vyc29yOnYyOpHOUH8B7g==` | `cursor:v2:` + msgpack `[1350860270]` | a **row ID** |
| `MQ==` | `1` | a bare **offset** (search connections) |

An offset cursor is invalidated by any insertion or deletion earlier in the list — "item 100"
is a different item tomorrow. An ID cursor is better, but it still only means *"the position
of this row in the ordering of the query that produced it"*: stable under an immutable
`CREATED_AT` sort, meaningless hours later under `UPDATED_AT`. Neither is a contract we should
build completeness on.

**Therefore: cursors are for within a single pass; watermarks are for across passes.**
A watermark is an intrinsic value, stable by construction, forever. Paginate a pass with
`pageInfo.endCursor` as normal, then persist only the watermark.

**One timestamp is enough — `node_id` is not needed.** Node IDs are opaque and non-monotonic,
so "items newer than this ID" is not expressible, and a deleted anchor vanishes. A single
timestamp works provided the comparison errs toward re-processing:

```
walk newest-first, continue while  sort_value ≥ watermark,  stop when  <
```

Using `≥` rather than `>` re-processes items sharing the boundary timestamp. That is free —
every upsert is `ON CONFLICT DO NOTHING` — whereas `>` could silently skip a tie straddling a
page boundary. Prefer the cheap duplicate over the silent gap.

**Search-driven passes also re-scan an overlap margin.** `search` lags behind the data — a
confirmed indexing delay (C10) — so an item can become searchable only after a pass has
already advanced the watermark past it, and would then be skipped for good. A pass driven by
`search` therefore continues to `watermark − margin` rather than stopping at the watermark
itself; the overlap is free for the same reason ties are. Walks over GraphQL connections do not
read the search index, so the rule applies to search-driven passes only. The margin is sized
from the lag measured in M0; with no periodic re-walk (below), an item indexed later still is
found only once it changes again.

> **The watermark must match the sort key.** It is always *the ordering field's value at the
> newest item of the last completed pass*: `created_at` where `CREATED_AT` ordering is
> available, `updated_at` where only `UPDATED_AT` is (C7), `databaseId` for
> `user.commitComments`, whose only order is its implicit ascending `databaseId` (C12), and —
> for passes driven by `search` — whichever field the query's own `sort:` qualifier names (C9).
> Mixing the two — sorting by one field and comparing the other — would let the stop condition
> trigger arbitrarily early and silently truncate the pass. Creation-ordered is preferred where
> there is a choice, because it is immutable and therefore monotonic.

**Incremental passes are *restartable*.** They walk newest-first and stop when the sort value
falls below the stored watermark — a value comparison needing no stored cursor. Advance the
watermark **only on completion**; if the pass is cut off, the next one redoes it from the top —
safe, because every upsert is `ON CONFLICT DO NOTHING`, and cheap, because the pass was small.

> *Livelock guard:* a source under sustained burst could be interrupted every time and never
> complete. So a pass that reads a full page of new items, with no item seen before, pages no
> further and hands the rest to a mechanism that makes monotonic progress by construction:
>
> - **Creation-ordered passes** (`issues`, `pull_requests`) hand it to backfill (below). In the
>   same transaction as the page's upserts, add a backfill window from the pass's watermark to
>   the page's oldest `createdAt`, and advance the watermark to the page's newest `createdAt`;
>   the pass counts as complete. The window never overlaps the category's other windows, and,
>   because `search` lags (C10), it becomes eligible only once
>   `now ≥ window_created_at + overlap margin`.
> - **The `issue_comments` pass** cannot hand off to backfill: it is ordered by `UPDATED_AT`,
>   while windows are keyed by thread creation date. It stops on `updatedAt`, never on
>   `createdAt` — an old comment edited a minute ago comes first and would otherwise end the
>   pass before any new comment. If a full page still doesn't reach the watermark (its oldest
>   `updatedAt` is still `≥ watermark`), whether its items are new or edits, insert a
>   **comment catch-up** (below) with `updated_since =` the pass's current watermark. In the
>   same transaction, advance the watermark to the page's newest `updatedAt`; the pass counts
>   as complete.

**Backfill is resumed by date window, not by cursor.** Each category starts with **one**
window (`created:A..B`) via `search`, covering the user's whole history up to its
`discovery_started_at`: an idempotent, re-runnable unit. Progress is *"what range is left"* —
durable, inspectable, and immune to both cursor invalidation and list drift. Since `ISSUE` and
`DISCUSSION` are separate queries, each category walks its own window. Note `search` carries
its own rate limits, so windows are scheduled through the same budget as everything else.

**Within a window, progress is saved after every page.** A window's query sorts by
`sort:created-desc`, and once a page's hits are stored, the window's `window_end` (§6.5)
moves to the last (oldest) hit's `createdAt`, in the same transaction. The next page, or the
restart after an interrupted slice, queries `created:window_start..window_end` (both bounds
inclusive) instead of using a cursor. The bound is inclusive because several hits can share
one second: the boundary hit is read again, and the `ON CONFLICT DO NOTHING` upserts make that
harmless. So a window only ever shrinks, and an interruption loses at most one page. If a full
page has a single `createdAt` equal to `window_end`, the window cannot advance; that window
falls back to a cursor walk over the hits sharing that second.

**Why one window, not many small ones.** Every page is a fresh query over the remaining range,
so the search cap (1 000 results per query) never applies: only the first 100 hits are ever
read. And `sort:created-desc` already walks newest-first, the order the score wants (below).
Many small windows would buy that same order with more rows and a split step. A window is
split only as a fallback: if its search times out or fails for a reason other than rate
limits or authentication, it is replaced by its two halves in one transaction (§6.5). M0
checks whether a lifetime-wide search ever needs this (§9). Windows are also added when the
livelock guard hands a burst to backfill (above). A category's windows never overlap.

**Long threads are finished by thread-scan tasks.** A window's search page reads the first
page of each hit's comments inline, as
`timelineItems(itemTypes: [ISSUE_COMMENT], first: 100)` on `Issue` and `PullRequest`. A hit
whose page reports `hasNextPage` gets a `thread_scans` row (§6.5), written in the same
transaction as the page's upserts. The row's `since_at` is the `createdAt` of the last comment
read. The window does not wait for it: a search page is complete once its hits and their
inline comments are stored, so a window page stays one query, however long its threads are.
A thread-scan task reads the next
`timelineItems(itemTypes: [ISSUE_COMMENT], since: since_at − 1 s, first: 100)` page of one or
more threads, up to ~50 aliased into one query (§6.4). It stores the user's comments,
advances each thread's `since_at` to its page's last `createdAt` in the same transaction, and
deletes a thread's row after its last page. An interruption therefore loses at most one page,
and a thread with thousands of comments becomes many small tasks instead of one that never
fits a slice.
- **No stored cursors.** `timelineItems` is used rather than `comments` because `comments`
  takes no date filter and orders only by the mutable `UPDATED_AT` (C7).
  `since` makes the thread scan resume like a window, from an intrinsic timestamp. The 1 s
  back-off covers comments sharing a second and an inclusive or exclusive `since`; the
  re-read boundary comments are harmless under the `ON CONFLICT DO NOTHING` upserts.
  M0 confirms that `since` filters, and the timeline orders, by the comment's `createdAt`.
- **Scoring.** A thread scan is scored like a window: `wait = now − scan_created_at`,
  `content_age` = the thread's age, weight `w`. It is part of its category's backfill, which
  is complete only when the category has neither windows nor thread scans left (§6.5).
- **Discussions (M2)** have no `timelineItems`, and neither `discussion.comments` nor
  `replies` takes a date filter. How a long discussion is resumed without a stored cursor, and
  how its replies are paged, is still open (§11).

**Comment catch-ups finish a burst the `issue_comments` pass handed off** (livelock guard,
above). They find the user's comments updated since the handoff on threads of any age:
- One `comment_catchups` row (§6.5) per handoff, with `updated_since =` the pass's old
  watermark, `window_end = now`, and `catchup_created_at = now`. Because `search` lags (C10), a
  catch-up becomes eligible only once `now ≥ catchup_created_at + overlap margin`.
- Query per page:
  `search(type: ISSUE, query: "commenter:USER updated:>=updated_since created:<=window_end sort:created-desc", first: 100)`.
  `created:` only drives the paging, exactly as in a backfill window: after each page,
  `window_end` moves to the oldest hit's `createdAt` in the same transaction as the page's
  upserts, with the same inclusive bound and the same fallback for a full page sharing one
  second ("Within a window", above). There is no lower `created:` bound, because the comments
  can sit on threads of any age.
- Per hit, in the same query: the thread's `createdAt`, and
  `timelineItems(itemTypes: [ISSUE_COMMENT], since: updated_since, first: 100)` with each
  comment's author id. Keep only the user's comments and upsert them as backfill does.
  Threads aren't stored here: the user's own threads come from the `issues` and
  `pull_requests` passes.
- A hit whose `timelineItems` reports `hasNextPage` gets a `thread_scans` row with
  `since_at =` the last comment's `createdAt`. **If the thread already has a row** — a window
  or another catch-up queued it — **keep the earlier `since_at`**, so neither scan's unread
  range is skipped.
- The login check and deletion after the last page work as for windows. Scoring: `wait = now − catchup_created_at`, `content_age = now − updated_since`,
  weight `w`.
- A category's catch-ups may overlap. Rereads are idempotent, and a handoff is rare (more than
  a page of comment activity between two passes), so merging rows isn't worth the complexity.
  Catch-ups don't count toward backfill completion (§6.5).
- M0 confirms that a new comment shows up in its thread's indexed `updated_at` within the
  overlap margin, and that `commenter:USER updated:>=A` finds every such thread (§9).

**A window's query names the user by login, so it checks the login it used.** Every query that
builds the login into its search string — `involves:`, `author:`, `commenter:`,
`reviewed-by:` — selects `viewer { id login }` alongside, and on a mismatch discards its results,
keeps the window (or, for a search-driven incremental pass, its watermark) untouched, refreshes
the stored login and retries (§6.5).

This also sidesteps a schema problem that would otherwise be fatal:

| Connection | Orderable by | Stable to paginate? | Ordered `search` route to the same content |
|---|---|---|---|
| `user.issues`, `user.pullRequests`, `user.repositoryDiscussions`, `repository.issues` / `.pullRequests` / `.discussions` | `CREATED_AT` (also `UPDATED_AT`) | ✅ Immutable sort key (`CREATED_AT`) | ✅ `type: ISSUE` / `type: DISCUSSION` + `sort:created` |
| `user.issueComments`, `issue.comments`, `pullRequest.comments` | **`UPDATED_AT` only** | ⚠️ No | ✅ via parent thread — `type: ISSUE`, `commenter:` / `involves:` |
| `user.repositoryDiscussionComments`, `discussion.comments`, `discussionComment.replies` | **no `orderBy` at all** | ⚠️ No | ✅ via parent thread — `type: DISCUSSION`, `commenter:` / `involves:` |
| `pullRequest.reviews`, `pullRequestReview.comments` — no `user.*` connection (C6) | **no `orderBy` at all** | ⚠️ No | ✅ via parent PR — `type: ISSUE`, `is:pr reviewed-by:` |
| `user.commitComments` | **no `orderBy`**, but a fixed implicit order: ascending `databaseId` (C12) | ✅ Immutable sort key — observed, not documented | ❌ none — and none needed: walked directly (C12) |
| `repository.releases` — no `user.*` connection (C6) | `CREATED_AT` (or `NAME`) | ✅ Immutable sort key | ❌ none (C11): walked per candidate repository instead — best effort only |

Ordering by `UPDATED_AT` is unstable under pagination: editing an old comment mid-walk moves
it to the front, shifts everything by one, and **silently skips** an item not yet reached.
An unordered connection is worse still: it offers no stop condition at all.
So issue, PR and discussion comments, reviews and review comments are never backfilled through
their own connection — they are reached **via their parent thread**, which *is* creation-ordered,
and read as a short bounded list. The resumable unit becomes the thread, not the comment. Commit
comments are the exception: `user.commitComments` has a fixed creation order (C12), so it is
walked directly.

> **The thread detour is not a workaround — it is the finest granularity the API offers.**
> It would be easy to read the table above as "discussion comments cannot be enumerated in a
> stable order, so we make do". That understates the position in one direction and overstates
> it in the other. `search` supplies exactly the ordering the comment connections lack —
> `sort:created-desc`, `created:A..B` windows, and `commenter:` / `involves:` actor
> qualifiers, on `type: DISCUSSION` no less than on `type: ISSUE` — so the thread walk is
> **fully ordered and fully resumable**, not a degraded fallback. But search will never hand
> back a `DiscussionComment` or an `IssueComment`: it matches on comment bodies and returns
> the *parent* `Discussion` / `Issue` / `PullRequest` (C9). There is therefore no
> ordered comment-level enumeration anywhere in the API to prefer over the thread walk, and
> no reason to keep looking for one.

> **Consequence: a comment is windowed by its *thread's* creation date, not its own.**
> A comment written last week on a 2019 issue is backfilled when the walk reaches 2019. Completeness is
> unaffected — every thread is still visited exactly once, so every comment on it is covered —
> but backfill's newest-first property (below) then orders *threads*, not comments, and recent
> comments on old threads are among the **last** to be backfilled.
>
> This is acceptable only because incremental discovery reaches those comments immediately by
> a route that is *not* creation-bounded: `user.issueComments (UPDATED_AT DESC)` for issue and
> PR comments, and `search(type: DISCUSSION, "involves:USER sort:updated-desc")` for
> discussion comments, whose own connection cannot be ordered at all (C7/C9). The division
> of labour is therefore not "the same query over different date ranges": incremental covers
> recent activity on threads of *any* age, and backfill closes the pre-subscription tail.
> Removing either one leaves a real coverage gap — and note that **without the search route,
> discussion comments would have no incremental half at all**, since there is no
> `user.repositoryDiscussionComments (UPDATED_AT DESC)` to fall back on. That is exactly the
> gap that reading C7 as a property of the whole API, rather than of its connections, hides.

Backstop: drift detection — if page *N+1* starts with an item already seen on page *N*, the
list shifted, so restart that window rather than trusting it.

#### Reactable types at a glance (`authored`, M0–M1 focus)

M1 ships only the `authored` adapter (§9), so this overview covers that source; `owned_repos`
and `repo:` follow in M2 and are not shown. "M0 check" names the spike result each route
depends on.

| Reactable type (C4) | Milestone | M0 check | Backfill (history) | New content afterwards |
|---|---|---|---|---|
| `Issue` | M1 | `search` rate-limit and timeout behaviour | `search(type: ISSUE, "involves:USER created:A..B sort:created-desc")` over a date window on the thread's creation date; keep threads the user opened | `user.issues` by `CREATED_AT DESC`, down to the watermark |
| `PullRequest` | M1 | as `Issue` | The same `type: ISSUE` window, which returns PRs too | `user.pullRequests` by `CREATED_AT DESC`, down to the watermark |
| `IssueComment` (issues and PRs) | M1 | as `Issue` | Read every thread the `type: ISSUE` window returns and keep the comments the user wrote (procedure below) | `user.issueComments` by `UPDATED_AT DESC` (its only order, C7), down to the watermark |
| `Discussion` | M2 | as `Issue`, plus: `type: DISCUSSION` honours `created:`, `sort:` and `involves:` (C9) | `search(type: DISCUSSION, "involves:USER created:A..B sort:created-desc")` over the `discussion` category's own date window; keep discussions the user opened | `user.repositoryDiscussions` by `CREATED_AT DESC`, down to the watermark |
| `DiscussionComment` (incl. replies) | M2 | as `Discussion`, plus: whether `commenter:` / `involves:` match a discussion where the user only replied; the indexing lag's size (C10) | Read every discussion the `type: DISCUSSION` window returns — comments **and** their threaded replies — and keep the user's own (step by step below) | `search(type: DISCUSSION, "involves:USER sort:updated-desc")` down to the watermark minus the overlap margin (C10); read comments and replies inline, keep the user's own |
| `PullRequestReview` | Later | as `Issue`, plus the indexing lag's size (C10) | `search(type: ISSUE, "is:pr reviewed-by:USER created:A..B sort:created-desc")` over a date window on the PR's creation date; read each PR's `reviews(author: USER)` and keep the submitted ones (see below) | The same query with `sort:updated-desc`, down to the watermark minus the overlap margin (C10); read each PR's newest reviews by the user |
| `PullRequestReviewComment` (incl. replies) | Later | as `PullRequestReview` | The `PullRequestReview` window: page through each kept review's `comments` — all of them are the user's | The `PullRequestReview` pass: every new comment, a reply too, arrives in a new review; read its `comments` |
| `Release` | Later | — | Best effort only (C11): list the repos where the user may create releases, walk each one's `releases` and keep the user's (see below) | The same walk each pass over a freshly listed set of repos, by `CREATED_AT DESC` down to the watermark |
| `CommitComment` | Later | `user.commitComments` still returns ascending `databaseId` order (C12) | One walk of `user.commitComments` up to a probed `databaseId` — every node is the user's (see below) | `user.commitComments` newest-first (`last:` / `before:`), down to the `databaseId` watermark |
| `TeamDiscussion` | Never | — | — out of scope (§3) | — |
| `TeamDiscussionComment` | Never | — | — out of scope (§3) | — |

**`DiscussionComment` backfill, step by step.**

1. **Window.** Cover all possible parent-thread history up to the `discussion`
   category's `discovery_started_at` — the subscription's start, the M2 rollout, or whenever the
   user first switches on one of its types (FR-4d) — with one date window on the *discussion's*
   creation date (`created:A..B`). It is a `backfill_windows` row of that category, so
   it progresses independently of the `issue` category's window, and its one query serves
   discussions and discussion comments alike.
   The lower bound must predate the oldest possible parent, not the user's account:
   a new user can comment on an older thread.
2. **Query.** Run
   `search(type: DISCUSSION, query: "involves:USER created:A..B sort:created-desc")`,
   re-querying the remaining range after every page (§6.3 "Within a window"). `involves:` is `author:` OR `mentions:` OR
   `commenter:`
   ([GitHub docs](https://docs.github.com/en/search-github/searching-on-github/searching-discussions)),
   so it also finds discussions the user only commented on; mention-only hits yield nothing in
   step 4. The two-pass `author:` + `commenter:` variant (Task kind A) works the same way.
3. **Split.** Only if the search times out or fails for a reason other than rate limits or
   authentication: replace the window with its two halves (§6.3, §6.5).
4. **Read.** For every hit, read `discussion.comments` and each comment's `replies` —
   threaded replies are `DiscussionComment`s too, and reactable — and keep those whose author
   is the user. Neither connection has an `orderBy` or a date filter (C7), and `Discussion`
   has no `timelineItems`, so a discussion cannot use the issue thread scan (§6.3 "Long
   threads"). It is read in full within its search page, so the discussion, not the comment,
   is the unit of progress. How a discussion too long for one slice is resumed is open (§11).
5. **Store.** Upsert each kept comment into `content`, `content_sources` and `tracked_content`
   — parked if discussion comments are off (FR-4d) — all `ON CONFLICT DO NOTHING`, except that
   a parked row is un-parked if they are on (§6.3); reactions it already carries from before
   the type's `enabled_at` are not stored or notified (FR-6, §6.3).
6. **Complete.** Delete the window once all its search pages are stored — unless a page's
   `viewer { login }` no longer matches the login in its query, which discards the page and
   retries the window under the refreshed login instead (§6.3, §6.5). After every stored page,
   the window's `window_end` moves to the last (oldest) hit's `createdAt`, so an interrupted window
   resumes from there rather than from its original end (§6.3 "Within a window").

A comment thus belongs to its discussion's creation date, not to its own: a recent comment on an
old discussion is backfilled late, and the incremental search pass covers it until then.
`IssueComment` backfill (M1) is the same procedure with `type: ISSUE` and the
thread's `timelineItems(itemTypes: [ISSUE_COMMENT])`, minus the reply level — issue and PR
comments are flat — and with long threads continued as thread scans (§6.3 "Long threads").

**`PullRequestReview` and `PullRequestReviewComment`: one pass for both.** A review comment is
always part of a review by its author — replying to a review thread creates a new review that
holds only the reply — so the user's reviews lead to all of their review comments.

1. **Backfill.** A date window on the PR's creation date, queried with
   `search(type: ISSUE, "is:pr reviewed-by:USER created:A..B sort:created-desc")`. Per hit, page through
   `reviews(author: USER)`, skip `PENDING` drafts (only their author can see them), and page
   through each kept review's `comments`. The window is the types' own rather than the
   `involves:` one: `reviewed-by:` is documented to match reviewers, `involves:` is not
   (though it did in the test below).
2. **Afterwards.** The same query with `sort:updated-desc`, down to the watermark minus the
   overlap margin (C10); per hit, read the user's newest reviews and their comments.

Tested Sep 2026, read-only: on one account, `reviewed-by:` returned all 152 PRs with a
submitted review by the user — checked against all 1 072 PRs involving the user, the user's
own PRs and their contributions — plus 2 whose only review was a `PENDING` draft. Across 304
open PRs in 8 large repositories, no PR's `updatedAt` predated its latest review; 15 PRs whose
last change was a reply-only review had `updatedAt` equal to the reply, and `search` found
each with `updated:>=` that time, including replies less than an hour old.

Not used: `contributionsCollection.pullRequestReviewContributions`. It avoids the search index
but ignores reviews that hold only a reply — on that account 74 of 276 reviews: the 19 PRs
where the user had only replied were missing, and on 9 PRs a later reply did not move the
entry. New replies would never be discovered.

**`Release`: best effort only.** There is no way to find all releases a user has created
(C11). The work-around approximates that set in two steps:

1. **Candidate repositories.** Creating a release requires write access
   ([*"Users with push access to the repository can create a release"*](https://docs.github.com/en/rest/releases/releases#create-a-release)),
   so list `viewer.repositories` with both `affiliations` and `ownerAffiliations` set to
   `[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]`, and keep those whose `viewerPermission` is
   `WRITE`, `MAINTAIN` or `ADMIN`. Both arguments are needed: with `affiliations` alone,
   organization repositories go missing (tested Sep 2026: 58 instead of 67 repositories).
2. **Releases.** Walk each candidate's `releases(orderBy: {field: CREATED_AT, direction: DESC})`
   and keep those whose `author` is the user — there is no author filter. Batched, a query
   covering 100 repositories costs 1 point (measured). Backfill walks each list in full, with
   the repository as the unit of progress; afterwards each pass re-lists the candidates and
   stops each walk at the watermark.

Blind spot: releases in repositories the user can no longer write to — they left the
organization or team, or were removed as a collaborator — are never found.

**`CommitComment`: one connection, walked directly.** `user.commitComments` lists every commit
comment the user wrote, in ascending `databaseId` order (C12), so neither `search` nor a thread
detour is needed:

1. **Split point.** A `databaseId` watermark cannot be read off the clock, so a one-point
   `last: 1` query fetches the newest commit comment's `databaseId` (0 if there is none) and
   seeds the incremental watermark with it. This probe stands in for the `discovery_started_at`
   that splits history for the other categories; it needs no overlap margin, since no `search` is
   involved (C10). Both halves wait for the probe, not for each other. Like every task, it is
   queued, budgeted and retried, so it may run well after the type was enabled: once the
   budget allows (§6.4), after a failed request, or after a revoked token is replaced (FR-17).
   The delay loses no comment: one written in the meantime lies at or below the watermark, so
   the backfill finds it — just later than an incremental pass would have. It changes no
   notification either: silence is per reaction, not per item, so the comment's reactions
   notify or not on their own timestamps regardless of which half found it (FR-6).
2. **Backfill.** Walk the connection with `first: 100` / `after:` up to that `databaseId` and
   keep every node — all of them are the user's. The walk is short (at most 22 pages on the
   accounts sampled), so an interrupted one simply restarts from the top.
3. **New comments.** Walk it newest-first with `last: 100` / `before:`, down to the
   `databaseId` watermark. The watermark is `databaseId` because that is the sort key;
   `createdAt` agreed with it in every test, but nothing guarantees that it always will.
4. **Backstop.** The order is observed, not documented. A page that comes back out of
   `databaseId` order triggers a full walk, and a periodic full walk backs that up — cheap at
   these sizes.

Tested Sep 2026, read-only: full walks of four accounts (21 to 2 051 commit comments) returned
exactly `totalCount` nodes, in strictly ascending `databaseId` and `createdAt` order, with no
cap at 1 000 and at 1 point per 100 nodes. The newest-first walk returned all 443 of one
account's comments in strictly descending order. Cursors decode to `cursor:v2:` + msgpack
`[databaseId]` — ID cursors, not offsets. In 7 repositories, the REST listing
(`/repos/{owner}/{repo}/comments`, documented as *"ordered by ascending ID"*) matched the
connection exactly. Across 24 sampled accounts, mostly prolific open-source maintainers, the
largest count was 2 143.

#### Budget contention between discovery and polling

Every task — incremental discovery, backfill, and reaction polling — spends the same per-user
token budget (§6.4) and sits in **one queue ordered by score**. There is no reserved share for
any task class; contention is resolved entirely by the priority formula.

This is safe because of the unbounded-score property established below: a backfill window that
keeps losing accumulates `wait`, its score grows linearly and without limit, and it
eventually outranks the steady-state work.

**Scoring a backfill window.** A window is scored by the same `wait × rate × weight`
structure, with each term reinterpreted for historical work:

```
score = wait × (1 / content_age^P) × w

  wait         = now − window_created_at      (how long coverage has been missing)
  content_age  = now − window_end             (age of the newest content still unread,
                                               i.e. of the next page)
  w            = the same page-of-coverage weight discovery uses
```

This is exactly the poll score, with `wait` and `content_age` measured against the window
rather than a single item — the two task kinds are structurally identical, differing only in
what "an event" means.

**Why we assume that each search window returns a full list of results:** Where the assumption is worst — a window that could return 100
hits but returns 1 — it costs almost nothing, because **backfill is finite**: every window
must be run exactly once regardless, so a yield estimate could only reorder coverage, never
reduce its total cost.

Three properties still follow, none hard-coded:

- **Backfill proceeds newest-first.** Within a window, `sort:created-desc` reads the newest
  history first. And as `window_end` moves back, `content_age` grows, so the window's score
  falls: content one year old outranks content ten years old by `(3650/365)^0.8 ≈ 6.3×` at
  equal `wait`, because recent content is far likelier to still attract reactions. Recent
  history therefore competes hard with polling, and ancient history drains in the
  background. Right after discovery starts, `window_end` is close to `now`, so the first days
  of history are covered almost at once. No explicit ordering rule is needed.
- **No starvation.** `wait` grows without bound, so any window eventually crosses the cutoff —
  the same guarantee as everywhere else in the queue.
- **No splitting by default.** Each page re-queries the remaining range, so the search cap
  never forces one. A window is split only when its search fails (above).

One genuine redundancy is worth noting: a category's window and any halves split from it share
one `window_created_at`, so `wait` is a **common factor within a category** and has no effect
on the order in which that category's own history is covered. It matters only for comparison
against poll tasks and across categories of different ages.

> **Scores compare directly across kinds, because they are all per query.** A poll task is one
> batched probe, a backfill window is one `search` page, an incremental pass is one connection
> query: same cost, same units, no normalisation step and nothing to reinstate. The only thing
> that needs calibrating is `w`, the exchange rate between a page of newly covered items and a
> batch of re-checked reactions.
>
> Worked example, in seconds, with `P = 0.8` and `w = 2`:
>
> ```
> poll, 1-day-old item at a 15-min interval
>     wait = 15 * 60 = 900              content_age^P = (24 * 3600)^0.8 ≈ 8 896
>     score = 900 / 8 896 ................................ ≈ 0.101
>
> backfill, window_end 1 year back, waiting 1 day
>     wait = 24 * 3600 = 86 400         content_age^P = (365 * 24 * 3600)^0.8 ≈ 997 800
>     score = 86 400 × 2 / 997 800 ....................... ≈ 0.173
> ```
>
> So a window at recent history outranks steady-state polling by **≈ 1.7×** — enough to make real
> progress, not enough to monopolise. Every poll task sits at the same ≈ 0.101 cutoff in
> equilibrium regardless of age, which is the consistency check that the scheme is coherent.
>
> Older history ranks below the line: once `window_end` is ten years back, the same window scores ≈ 0.0274, about a
> quarter of the polling cutoff. Backfill therefore front-loads recent history — where
> reactions are still arriving — while ancient history climbs via `wait` and drains slowly in
> the background.
>
> **`w` is the control** for how aggressive that burst is. Too high starves live detection; too
> low leaves users with long-incomplete coverage. Discovery and backfill share the one
> constant — the `content_age` term alone distinguishes recent finds from ancient ones — so it
> remains the single constant in the system with no principled default (M0).

**Backfill also seeds activity from the newest reaction.** For each item backfill keeps, fetch
only `reactions(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt } }`
and set `last_event_at` to the later of the item's `createdAt` and that timestamp. This is a
scheduling hint only: even a reaction before `enabled_at` makes an old item fresh enough to poll
soon, while `watermark_at` remains `enabled_at`, so that reaction is neither stored nor
notified. Keep `last_checked_at = now`, so backfill creates no immediate polling herd; it merely
puts old but recently active items into the correct age band. Incremental discovery omits the
hint because newly created items are already fresh. If the reaction field returns a partial
error, fall back to the item's `createdAt`.
- **Threads** get the hint inline: one `reactions(first: 1)` per search hit adds only 100
  requests to the page (§6.4).
- **Comments** get no hint: their `last_event_at` is the comment's `createdAt`. Probing inline
  would cost a request for every comment of every thread, nearly all written by others:
  100 threads × 100 comments × `reactions(first: 1)` is ≈ 10 000 requests, ≈ 100 points per
  search page. Nothing is lost, because the row starts at `watermark_at = enabled_at` and its
  first poll fetches every reaction since then. Only that first poll comes later for old
  comments. At the worked example's cutoff (≈ 0.101), a 1-year-old comment is first polled
  after ≈ 28 h and a 10-year-old one after ≈ 7 days. After that, any new reaction resets its
  age.

Two practical notes:

- **One backfill window per category.** Each page is one query over the remaining range, so
  the search cap never forces a split, and the per-query task unit makes the window free to
  schedule: a one-query task always fits whatever budget remains, so granularity
  starvation — a window too coarse to ever fit — cannot arise. A window is split only when its
  search fails (above).
- **Backfill is finite**, so this contention is temporary by nature: once history is covered[reactions-notifier-m1-requirements.md](reactions-notifier-m1-requirements.md)
  the task disappears and the full budget returns to detection.

Until then the source is knowingly incomplete, which the UI must show rather than imply full
coverage (FR-16), and which FR-6 already accounts for: whenever an item turns up, only the
reactions it received after `enabled_at` can notify, so completing a backfill never triggers
a retroactive flood.

#### Task kind B — reaction polling

There are **no tiers and no horizons**. Every tracked item carries a score; the user's `sync` job
sorts by score and works down the queue until the user's budget for this hour is spent.

```
eligible:  last_checked_at ≤ now − D          # minimum re-check delay, D = 120 s
score   =  wait / content_age^P

  wait        = now − last_checked_at    (seconds)
  content_age = now − last_event_at      (seconds)
  last_event_at = max(item createdAt, newest reaction createdAt)
  P           = 0.8                      # sub-linear damping of large ages
```

This is the same `(wait / content_age^P) × value_weight` rule as above, at `value_weight = 1`:
poll tasks are the unit the other kinds are priced against. Items are ranked individually, and
the top ~50 — adjacent in the ordering, so near-identical in score — form the one batched probe
that *is* the task.

**Why the exponent.** With `P = 1` the score asymptotes to 1, and a newly discovered *old*
item approaches that ceiling so slowly (a ten-year-old item needs a decade of `wait`) that
it can sit below the cutoff for years — silent abandonment of old content. Any `P < 1` makes
the score **grow without bound** (`t^(1−P)`), so a neglected item always crosses any cutoff
eventually. That removes the need for a separate deadline or overdue mechanism entirely.

`P` also decides how a fixed budget is split between fresh and old content. Since total demand
is `∫ρ·da / (θ·a^P) ∝ A^(1−P)/(1−P)`, smaller `P` spends more on the tail:

| | interval at 10 y | head penalty @ equal budget (10 y history) | total load, 50 k items |
|---|---|---|---|
| `P = 1` (undamped) | 38 d | 1× (baseline) | ~390 queries/day |
| **`P = 0.8`** | **7.4 d** | **1.65×** | **~640 queries/day** |
| `P = 0.5` (sqrt) | 0.6 d | 8.2× | ~3 200 queries/day |

`P = 0.8` keeps the tail genuinely cheap while leaving fresh-item responsiveness close to the
undamped ideal; `P = 0.5` spends roughly five times as much to poll decade-old content sub-daily,
and pays for it directly out of fresh-item latency.

**Known costs of this choice.** `P = 0.8` is a good operating point but not free:

- **The score is no longer a count.** With `P = 1` it was dimensionless and read as *expected
  unseen reactions*, so "score > 1" meant "probably at least one waiting". At `P = 0.8` the
  score carries units of `time^0.2` and is a **ranking number only** — absolute values mean
  nothing, and the useful "score > 1 ⇒ this item is overdue, the budget is too small"
  diagnostic is lost. Ordering is unaffected (every item scales by the same factor, so the
  ranking is still unit-invariant), but under-provisioning must now be detected from observed
  latency (FR-8) instead of read off the score.
- **`0.8` has no semantic story.** A cap could be justified as a rate floor ("never assume
  below one reaction per 90 days"); an exponent cannot. It is a pure tuning constant,
  calibrated empirically in M0.
- **Slow recovery from neglect.** An unserved item's score grows as `t^0.2`, so doubling it
  takes ~32× the `wait`. If the cutoff rises sharply — a user suddenly tracking far more
  content — long-neglected items climb back slowly. Starvation is still impossible, but
  "eventually" is longer than under linear-in-`wait` damping.
- **Minor query cost.** `POW()` per row in the ordering, and no static index can help, since
  the score depends on `now()`. Not specific to this exponent, but worth measuring at scale.

**Fresh items get frequency, not rank.** In equilibrium *every* served task sits at the budget
cutoff. A day-old item and a ten-year-old item come up for service at
the same score — the day-old one simply returns every ~15 min and the old one every ~7 days.
Freshness preference lives in the interval, not the ranking.

> **On units.** All durations are **seconds**. Ordering is unit-invariant regardless of `P`:
> changing units scales every score by the same `k^(1−P)`, so the ranking is unchanged. What
> unit choice *does* affect is the score's absolute value, which at `P ≠ 1` has no meaning
> anyway (see above). Seconds are chosen for ergonomics: `EXTRACT(EPOCH FROM now() -
> last_checked_at)` is native in Postgres, `D = 120` is a clean integer, and nothing is divided
> by 3600. Precision is a non-issue — a priority ordering only needs approximate comparison,
> so a double is ample.

**The minimum delay `D` is the only floor.** It states the policy directly — "never poll one
item more than once every 2 minutes" — and covers the degenerate case: a user with a single
issue and a full token should not have that issue polled continuously, which would waste their
budget and look abusive from GitHub's side.

Why this shape works:

- **It is a rate estimate.** Reaction arrival decays with content age, so `1/content_age^P`
  approximates the current arrival rate and `wait` is the time over which those reactions could
  have accumulated. The product ranks items by roughly *how much is probably waiting* — the
  right thing to sort by, even though at `P ≠ 1` it is no longer literally a count.
- **Tiers emerge instead of being declared.** In steady state an item is polled when its score
  crosses whatever cutoff the budget affords, so **check interval ≈ T × content_age^P**,
  bounded below by `D`.
- **T is never tuned.** It is not a constant in the code; it is wherever the budget happens to
  cut the sorted queue. More users, more items or a busier token simply move the cutoff.
- **Bootstrap is automatic.** A newly tracked item starts at `last_checked_at = now` (§6.5), so
  its `wait` begins at zero and climbs exactly as it would after any ordinary poll. Incremental
  discovery seeds `last_event_at` from the item's `createdAt`; backfill seeds it from the later
  of that and the newest reaction timestamp, including a pre-subscription reaction used only as
  an activity hint. Its first check therefore falls due at its observed activity age's steady-
  state interval — ~15 min when the newest event was a day ago, ~7.4 d when a ten-year-old item
  has no newer reaction — without a special first-poll scheduling path.
- **No divide-by-zero.** `content_age` is only zero for an item whose last event is *now*; such
  an item is not eligible under `D` anyway, and ordering treats `content_age → 0` as maximum
  priority, which is also the semantically correct answer.
- **Tracking all time is affordable.** The score decays with age, so old items are polled less often,
  and the total cost grows very slowly with history length.

#### Starvation: handled by the score, with no separate mechanism

With `P < 1`, an unserved task's score grows **without bound and monotonically**:

```
score(t) = (t − c) / (t − e)^P        c = last_checked_at, e = last_event_at

as t → ∞:   score(t) ~ t^(1−P)  =  t^0.2   → unbounded
```

At `P = 1` it would instead asymptote to 1 — and worse, a *newly discovered old* item
approaches that ceiling extremely slowly (a ten-year-old item needs a decade of `wait` to
reach 1), so it can sit below the cutoff for years. That is the concrete starvation the
exponent removes.

A neglected task now always crosses any cutoff eventually, whatever the budget.

**No jitter is needed.** Tasks created together — say 50 000 items from one completed backfill
— share a `last_checked_at` and, for similar ages, near-identical scores, so they do come due
together. That is harmless for two independent reasons: the budget governor (§6.4) caps spend
regardless, so a herd cannot cause a spike; and score ordering means genuinely fresh items
still outrank the herd, so it consumes only leftover budget and drains gradually. The one
implementation note is to use a **stable tiebreak** (e.g. `node_id`) so equal-scored tasks are
served in a deterministic order rather than in one that changes arbitrarily from slice to slice.

A possible later refinement is a bounded, short-lived recent-burst boost that multiplies an item's poll score according to the number of genuinely new reactions found in its previous poll, so heavily active items are retried sooner without changing the minimum delay D, budget limits, or the eventual-service guarantee.

Further optional scope filters could limit repository tracking to open issues, items created or updated within the last `x` days, and only the root post of issues and PRs (excluding comments).

Missing tracked items: If an otherwise successful polling query returns no data for an individual tracked item, GRN treats this as a non-fatal per-item outcome. It logs the missing item, advances its polling time without changing its reaction watermark, and continues processing the remaining items. M1 does not attempt to distinguish deletion from temporary inaccessibility and does not tombstone missing items.

**Two-phase fetch — the main cost optimisation:**

1. *Cheap probe.* Batch ~50 items into one aliased GraphQL query requesting only
   `reactions(first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt } }`
   — the single newest reaction timestamp per item. Drill down only where it exceeds the
   stored `watermark_at`. Items with no reactions return an empty `nodes` list and are simply
   skipped; the watermark starts at its type's `enabled_at`, never null, so the first
   reaction an item receives after the user subscribes still registers (§6.5).
2. *Drill-down.* Only for those items, fetch
   `reactions(first: N, orderBy: {field: CREATED_AT, direction: DESC})` and stop at the
   first reaction older than the item watermark (C3). Each reaction selects its `content`,
   `createdAt` and `user { id login }`: the reactor's node id is its identity in
   `reaction_events` (§6.5), and the login only labels it. The item's author is not
   selected here: discovery already stored it in `content` (§6.5), where replays (§6.6) and
   rendering at send time can read it too.

> **Do not use `ReactionGroup.createdAt` for this.** Despite being documented as "identifies
> when the reaction was created", it returns the group's **oldest** reaction, not its newest,
> so it is effectively frozen and detects nothing. Verified Sep 2026 on a high-traffic issue:
> the `THUMBS_UP` group reported `2016-07-04` while `reactions(content: THUMBS_UP, orderBy:
> {field: CREATED_AT, direction: DESC})` returned `2026-09-27`. The newest timestamp is only
> reachable through the ordered `reactions` connection.

One item-level timestamp is deliberately enough: per-emoji timestamps cost four times as much
(eight aliased connections per item — measured at 4 points per 50-item batch against 1) and buy
nothing, because the drill-down is needed for the reactor's identity (FR-5) whichever emoji moved.

**The watermark is held back only at a hot boundary.** `createdAt` has second precision, and
a reaction may become readable only after a poll has stored a newer one — a same-second tie, a
write not yet visible, or skew between the two clocks (§6.2). Its `createdAt` would then not
exceed the stored value, and it would be missed *permanently* — the probe would keep returning the same newest
timestamp. **This is the one place that must not use the `≥` rule of
§6.3.** There the comparison filters a walk that is happening anyway, so admitting ties costs
only a few idempotent upserts; here it *gates* the drill-down, and since `newest ≥ watermark`
holds on every poll (equivalently, `newest > max − 1 s`), an unconditional rewind would drill
down every time and destroy the two-phase saving outright. So the probe compares strictly with
`>` and stores `min(max, probe start − CLOCK_MARGIN)`: a newest reaction older than the margin
is stored exactly, a younger one holds the watermark back and forces exactly one re-check.
That re-check is free — `reaction_events` is keyed
`(node_id, reactor_id, emoji)` and written `ON CONFLICT DO NOTHING`, so re-reading a
boundary reaction yields nothing and notifies no one — and it settles immediately, because
`D` (120 s) exceeds the margin, so by the next poll `max` is older than it and stored exactly.

**Bootstrapping (FR-6): there is no special first poll.** A newly tracked item starts with
`watermark_at = enabled_at` (§6.5) rather than `-infinity`, and every poll then works
identically: the probe drills down only when the newest reaction is younger than the
watermark, so reactions predating the subscription are never stored or notified, while one arriving a minute after it is picked up by the item's very next poll.
FR-6 is therefore satisfied by an initial value, not by a mode.

A consequence worth stating:

- **The freshness signal survives.** The probe returns the newest reaction's `createdAt`
  whatever its age, so `last_event_at` can be seeded with it on the first poll at no extra
  cost, and an old-but-recently-reacted item is still scored as active (§6.3).

Because `reaction_notifications` is per-user and `enabled_at` is per subscription and type, a
second user adding the same repo later gets their own clean start rather than inheriting
the first user's history — and the same holds if public content is ever polled once for
everyone (§6.5), since each user's cutoff is applied at fan-out.

### 6.4 Budget model and pacing

Because each user authorises their own token, capacity scales with the user base —
but that 5 000/hour is **not GRN's alone**.

> GitHub states the limit "is combined with any requests that another GitHub App or OAuth app
> makes on your behalf and any requests that the user makes with a personal access token." So
> GRN shares each user's budget with their own `gh` CLI, their CI, and every other app they
> have authorised — including github-stats-extended's private-access feature.

**Therefore: pace against observed headers, never against assumptions.** Every response
carries `x-ratelimit-limit`, `-used`, `-remaining`, `-reset` and `-resource`; GRN records the
`graphql` bucket per user and derives its allowance from it. Because `used` already includes
everyone else's consumption, GRN automatically yields when the user is busy elsewhere —
no coordination needed.

**Allowance (evaluated before each batch):**

```
elapsed   = 1 − (reset_at − now) / 3600          # fraction of the current window used up
allowance = TARGET × limit × elapsed − used      # TARGET = 0.8
remaining = limit − used                         # derived, not stored (§6.5)

proceed only while  allowance > 0  and  remaining > RESERVE
```

Two properties matter here:

- **Ramped, not front-loaded.** Scaling by `elapsed` spreads spend across the hour instead of
  burning the budget in the first five minutes and then going dark — which would make
  detection latency lumpy and starve the user's own requests early in each window.
- **A hard reserve.** `RESERVE` (≈ 500 points) means GRN never consumes the user's last slice,
  even if the ramp says it could. Given the shared-budget correction above, this is the
  difference between a good citizen and a nuisance.

**Secondary limits** constrain shape rather than volume: 2 000 points/minute for GraphQL
(a non-mutation query costs 1), no more than 100 concurrent requests, and at most 60 s of
GraphQL CPU per 60 s wall-clock. None of these bind at our volumes — but the concurrency
question is settled on other grounds anyway:

**Poll serially: at most one in-flight request per token.** GitHub's own guidance is explicit
— *"To avoid exceeding secondary rate limits, you should make requests serially instead of
concurrently. To achieve this, you can implement a queue system for requests."* GRN already
has that queue (§6.2). Three reasons make this the right default rather than a concession:

- **The governor is only exact when serial.** The allowance above is recomputed from the
  latest observed `used`/`remaining`. With *N* requests in flight, that decision is stale by
  up to *N−1* requests, so `RESERVE` can be overshot by the ones already on the wire. NFR-2
  promises GRN never exhausts a user's budget; serial execution makes that an invariant
  instead of a probability.
- **Parallelism buys throughput the budget forbids.** The ramp permits ≈ 4 000 points/hour
  ≈ 1.1 req/s, while a serial worker at 300–500 ms round-trip sustains 2–3 req/s. Concurrency
  would only allow GRN to *overshoot the ramp between header reads* — the exact
  front-loading the `elapsed` term exists to prevent.
- **It stops cleanly.** On a `403`/`retry-after`, a serial worker halts at once; four in
  flight means three more requests reach GitHub *after* the limit is known — precisely the
  behaviour behind the banning warning quoted in §6.8.

**Scaling is per user, not per request.** The limits are scoped to the token, so the
invariant is *one in-flight request per token*, not per worker — held by giving each user a
single `sync` job (§6.2): the `SKIP LOCKED` queue still processes many users concurrently,
each against their own independent bucket. Serialising within a token therefore costs nothing
in aggregate throughput.

> What it does cost is wall-clock on a single user's queue, which shows up only in backfill
> bursts — low-priority, finite, and silent by construction (FR-6). The cap is configurable
> with a **default of 1**; raising it is an M0 measurement question (§9), not a redesign.

**Cost accounting: none. Spend what the headers say is left.** A single request cannot cost
enough to matter against `RESERVE`, so there is nothing worth predicting:

| Query | Traversals | Cost |
|---|---|---|
| Probe — 50 aliased items × `reactions(first: 1)` (§6.3) | ~51 | **1 point** |
| Drill-down — ≤ 100 items × `reactions(first: N)` | ~101 | **1 point** |
| Incremental discovery — existing category query, with no reaction probe | ~101 | **1 point** |
| Backfill discovery — `search(first: 100)` + inline `timelineItems(itemTypes: [ISSUE_COMMENT], first: 100)` + 100 thread `reactions(first: 1)` probes; no per-comment probe | ~201 | **~2 points; measure** |
| Thread scan — up to 50 aliased threads × `timelineItems(itemTypes: [ISSUE_COMMENT], since:, first: 100)` (§6.3) | ~50 | **1 point** |
| Incremental — a category's passes, three connections aliased side by side (§6.3) | ~3 | **1 point** |
| *GitHub's own worst-case doc example* (3 levels, 5 101 traversals) | 5 101 | 51 points |

Most GRN queries are **1 point**; a 100-item backfill page with the added newest-reaction
connection is expected to be roughly **2 points** — 3 if GitHub counts the `timelineItems`
connections of the `Issue` and `PullRequest` fragments separately. A probe on every inline
comment would make it ≈ 102 points, which is why comments get no probe (§6.3). The
query remains shallow and bounded, but GitHub also enforces resource limits that are
not captured by primary points, so request only one reaction timestamp, maybe tolerate partial field
errors, and assert the measured `rateLimit.cost` in CI. Even GitHub's pathological three-level
example is 51 points — still only ~10 % of a 500-point `RESERVE`.

So the guard is simply:

```
proceed while  allowance > 0  and  remaining > RESERVE      # both read from the last response
```

Worst case, GRN crosses the threshold by the measured cost of the one request in flight —
typically 1 point and roughly 2 for a full backfill page — and stops on the next check.
`RESERVE` already *is* the safety margin, hundreds of times larger than that overshoot.

**Measure instead of predicting.** Include `rateLimit { cost used remaining resetAt }` in
every query. It adds no traversal, so it is free, and `cost` reports what the query *actually*
spent — distinguishing GRN's own consumption from other apps' (§6.4), which a `used` delta
cannot. Log `cost` as a counter (NFR-7) and alarm if it ever exceeds a small bound (say 10).

> That alarm is the real safety property: cost is a function of **query shape**, which is
> static and known at build time. A regression — someone nesting `comments(first: 100)` under
> a 100-result search, turning 1 point into 101 — is therefore catchable by asserting measured
> `cost` in CI, not by estimating at runtime.

**Degradation.** There is no source-class priority: `authored`, `owned_repos` and `repo:`
tasks compete purely on the freshness score (§6.3). Degradation is graceful by construction —
a smaller budget simply moves the queue cutoff, and the oldest, least-likely-to-change items
are the ones that wait.

> The `value_weight` term in the general score is the hook for re-introducing a preference
> (e.g. weighting a user's own content above repos they merely watch) if observed latency ever
> shows it is needed. It is left at a constant for now.

### 6.5 Data model (sketch)

```
users(gh_user_id PK, login, gh_created_at, token_enc, token_nonce, token_status)
        -- gh_user_id = the GraphQL global node id (see content.node_id below for the header
        --   this obliges every request to send). Not the login, which is renameable, and not
        --   databaseId: GitHub's guidance is to persist the node id, and no REST request GRN
        --   makes references a user. It is the `user_id` FK of every other table, and
        --   NFR-3's AAD
        -- login is mutable, and is the literal that `involves:` / `author:` / `commenter:` /
        --   `reviewed-by:` are built from. A stale one fails silently: it returns zero hits,
        --   or — once someone else has claimed the freed name — *their* content. So every
        --   discovery query, backfill windows included, selects `viewer { id login }` (free,
        --   like `rateLimit`), which names the token's owner as of that very request, and on a
        --   mismatch refreshes the stored login. A query that built the login into its search
        --   string then also discards its results, neither deletes its window nor advances its
        --   watermark, and retries under the new login (§6.3). Connection walks start from
        --   `viewer`, never `user(login:)`, so their results do not depend on the login
        -- gh_created_at records account metadata, not the parent-thread backfill lower bound (§6.3)
        -- token_status ∈ {'active','revoked','invalid'}: gates the `sync` claim (§6.2) and
        --   drives FR-17; 'invalid' is NFR-3's undecryptable token

subscriptions(id, user_id)
        -- a subscription source (§3). M1 has exactly one per user — the `authored` source
        --   (§9) — so the columns naming *which* source a row is (kind, target) arrive with
        --   the adapters that read them (deferred, below). The table stays separate from
        --   `subscription_categories` because later there will be multiple categories per
        --   subscription — e.g. `issue` and `discussion`; and separate from `users` because
        --   later there will be multiple subscriptions per user — e.g. `authored` and
        --   `owned_repos`.
        -- the three tables below split a source by unit of work (FR-4d, §6.3): the *category*
        --   is what one discovery query returns, the *type* is what the user switches and
        --   GRN tracks, the *pass* is what carries a watermark. M1 ships all three in a fixed
        --   shape — one category, three types, three passes — because introducing them later
        --   would move columns and re-key backfill_windows: a rewrite, not the additive
        --   migration §9 relies on

subscription_categories(id, subscription_id, category, discovery_started_at,
                        last_checked_at, last_find_at,
                        UNIQUE (subscription_id, category))
        -- category = 'issue' (issues, PRs, issue comments: one `type: ISSUE` query) in M1;
        --   'discussion' (discussions, discussion comments: `type: DISCUSSION`, C9) in M2.
        --   Later types form categories of their own, having routes of their own (§6.3).
        -- a row exists only once the category's discovery has started — the first time any of
        --   its types is on — and is inserted then, with its types, passes and windows
        --   (below). A category never on has no row rather than a row of nulls; once inserted,
        --   the row stays: a category switched off keeps its windows and watermarks, and
        --   resumes from them (§6.3)
        -- discovery_started_at = the moment the category's discovery started. It bounds the
        --   newest backfill window, seeds the pass watermarks (less the overlap margin, C10)
        --   and initialises last_find_at and last_checked_at. It never moves
        -- last_checked_at / last_find_at give the same wait/content_age score as polling;
        --   last_find_at resets whenever a pass finds something new. NOT NULL for the same
        --   reason as tracked_content's (below): a null would make the score and the
        --   `≤ now − D_discovery` filter null, dropping the category from the queue for good.
        --   They are the category's, not each pass's, because a category's passes go out as one
        --   query (§6.3)
        -- Backfill completion, for M2's summary and FR-16's status, is a per-category
        --   NOT EXISTS over backfill_windows and thread_scans — no window left to walk and no
        --   thread left to scan — not a stored column

subscription_types(category_id, content_type, enabled_at,
                   PRIMARY KEY (category_id, content_type))
        -- one row per type in the category, inserted with it: 'issues', 'pull_requests',
        --   'issue_comments' for `issue`; 'discussions', 'discussion_comments' for
        --   `discussion`
        -- enabled_at = the moment the type's coverage started, less CLOCK_MARGIN (§6.2). It initialises every new
        --   tracked_content row's watermark_at for the type, which is the whole of FR-6
        --   (§6.3). A row per type rather than one timestamp per subscription, because types
        --   start independently — by a milestone (discussions, M2) or by the user (FR-4d) —
        --   and widening a timestamp into a jsonb later would be a rewrite, not an addition
        -- enabled_at is compared to reactions' createdAt to decide whether they notify.
        -- null exactly while the type is off, and re-stamped each time it goes back on, so
        --   every return is a fresh silent first sync (FR-6). M1 never writes a null — its
        --   three types are always on — and its queries track only types whose enabled_at
        --   is set; M2 adds the rows of the others, parked (tracked_content.parked, deferred
        --   below). A null cannot leak into polling: tracked_content.watermark_at is NOT
        --   NULL, so un-parking a row whose type is off, or inserting it unparked, fails
        --   loudly rather than silently
        -- switches and discovery workers serialise on one lock per user — the `users` row,
        --   FOR UPDATE / FOR SHARE — not on these rows, because tracked_content is shared by
        --   all of a user's sources (§6.3)
        -- Later, one pass serves two types (reviews, §6.3) and some types have no pass
        --   (releases, C11), so this table can't be merged with subscription_passes.

subscription_passes(category_id, pass, watermark,
                    PRIMARY KEY (category_id, pass))
        -- one row per incremental pass: 'issues', 'pull_requests', 'issue_comments' for
        --   `issue` (M1); 'discussions', 'discussion_comments' for `discussion` (M2). A pass
        --   is not a type: the later reviews pass serves two (§6.3)
        -- watermark = the sort key's value at the newest item of the pass's last completed
        --   walk (§6.3). The passes do not share a sort key — some order by CREATED_AT, some
        --   by UPDATED_AT, the discussion-comment pass by the search `sort:` field — hence a
        --   row each.
        -- inserted when the category's discovery starts, seeded with discovery_started_at
        --   less the overlap margin (C10). The later reviews pass keeps a search
        --   `updated_at` here too
        -- the later commit-comment pass orders by `databaseId` (C12): it adds a
        --   `watermark_id bigint`, relaxing the NOT NULL into a CHECK that exactly one of
        --   the two is set, and its row is inserted once the seeding probe returns (§6.3).
        --   Releases have no row here — they run per repository, so their CREATED_AT
        --   watermarks live in the deferred `target_passes` (C11, §6.3)

-- backfill progress as the date ranges still to walk, per category; durable,
-- idempotent, cursor-free. Search-driven categories only: the release walk has no date windows,
-- because its unit of progress is the repository, tracked in the deferred `discovery_targets`
-- table (C11, §6.3)
backfill_windows(category_id, window_start, window_end, window_created_at,
                 PRIMARY KEY (category_id, window_start))
        -- a row is a window still to walk. A category's one window is inserted when its
        --   discovery starts, and deleted once all its hits are read (§6.3): windows
        --   are not re-walked, so a walked one is never needed again. Nor does a window being
        --   walked need a marker, as only the worker holding the user's `sync` job can pick it
        --   (§6.2, §6.4); an interrupted walk leaves the row, and the window resumes at its
        --   current window_end
        -- the walk is newest-first (`sort:created-desc`): window_end moves back to the
        --   createdAt of the last (oldest) hit stored, in the same transaction as that page's
        --   upserts (§6.3). window_start never moves, so the key is stable
        -- more rows arise only from a split — a window whose search times out or fails for a
        --   reason other than rate limits or authentication is replaced by its two halves in
        --   one transaction, which inherit its window_created_at, keeping `wait` a common factor
        --   within the category (§6.3) — or from the livelock guard handing a burst to
        --   backfill. A category's windows never overlap
        -- a window runs its category's one query — `type: ISSUE` for `issue` — and keeps every
        --   type the query returns, switched on or not (§6.3), so it is fetched and completed
        --   once for all of them. The disjoint `type: DISCUSSION` query (C9) is the
        --   `discussion` category's, whose window completes independently
        -- the window reaches up to the category's discovery_started_at, which less the overlap
        --   margin (§6.3, C10) also seeds its pass watermarks, so backfill and
        --   incremental discovery overlap instead of leaving a gap
        -- window_created_at drives the `wait` term, and window_end the `content_age` term, in
        --   the backfill score (§6.3)

thread_scans(category_id, thread_node_id, since_at, thread_created_at, scan_created_at,
             PRIMARY KEY (category_id, thread_node_id))
        -- a row is an issue or PR whose comments did not fit the inline page of its window's
        --   search page (§6.3 "Long threads"), or of a comment catch-up's. Inserted in the
        --   same transaction as that page's upserts; deleted after the thread's last comment
        --   page is stored
        -- on conflict, keep the earlier since_at: a catch-up can hit a thread already queued,
        --   and neither scan's unread range may be skipped (§6.3)
        -- since_at = the createdAt of the last comment stored, advanced in the same
        --   transaction as each page's upserts. The next page queries
        --   timelineItems(itemTypes: [ISSUE_COMMENT], since: since_at − 1 s): an intrinsic
        --   value, not a stored cursor
        -- thread_created_at gives the scan's content_age, scan_created_at its wait (§6.3)
        -- like windows, scans need no lease marker: only the worker holding the user's
        --   `sync` job picks them (§6.2, §6.4)

comment_catchups(category_id, updated_since, window_end, catchup_created_at,
                 PRIMARY KEY (category_id, updated_since))
        -- a row is a burst of comment activity the `issue_comments` pass handed off through
        --   its livelock guard (§6.3 "Comment catch-ups"); inserted in the same transaction
        --   that advances the pass's watermark, with updated_since = the old watermark and
        --   window_end = now; deleted once all its search pages are stored
        -- window_end moves back to the oldest hit's createdAt per page, as in a window;
        --   updated_since never moves, so the key is stable
        -- eligible only once now ≥ catchup_created_at + the overlap margin (C10).
        --   catchup_created_at gives its wait, updated_since its content_age (§6.3)
        -- a category's catch-ups may overlap; they don't count toward backfill completion

notification_channels(id, user_id, kind, target, disabled_at, comment_count)
        -- kind ∈ {'github_issue'} in M1; 'atom','webhook','inapp' in M2; 'email' later
        -- for 'github_issue': target = "owner/repo#number" of the inbox issue, rolled over
        --   to a new issue when the thread grows (§6.7). NULL from the sign-in that inserts
        --   the row until the dispatcher has opened the first issue
        -- comment_count = comments the dispatcher has posted to the current target; +1 in
        --   the transaction that deletes a posted comment's job, reset to 0 when the target
        --   moves. Reaching N queues the rollover in that same transaction (§6.7)
        -- at most one 'github_issue' channel per user is active — UNIQUE (user_id) WHERE
        --   kind = 'github_issue' AND disabled_at IS NULL — so concurrent sign-ins open one
        --   inbox, and a disabled channel lets the next sign-in open a new one (§6.7)
        -- M1 has disabled_at, but permanent delivery failure deletes jobs instead (§6.8)

-- global content metadata, shared across users
content(node_id PK, type, repo_full_name, url, title, author_id, author_login)
        -- node_id = the GraphQL global node id, and the anchor of tracked_content,
        --   reaction_events, reaction_notifications and the batched node(id:) probe (§6.3).
        --   Every request must send `X-Github-Next-Global-ID: 1`, or GitHub returns the
        --   legacy format for anything created before ~2022
        -- repo_full_name and url go stale on a repo rename or transfer; node_id does not, so
        --   polling is unaffected and both are display data (FR-15). Exception: FR-11's
        --   repo/org filters (M2) match on the name, so a renamed or transferred repo stops
        --   matching them. Accepted as rare; should it ever matter, compare node ids instead
        -- author_id = the author's GraphQL global node id, set at discovery, which selects
        --   `author { login ... on Node { id } }` on every item it returns — objects, not
        --   connections, so free (§6.4). Stored rather than fetched at poll time because
        --   replays (§6.6) and rendering at send time read only the database. FR-11's author
        --   filter (M2) compares it with the user's gh_user_id, so a rename on either side
        --   cannot break it. Nullable: a deleted account's content has no author ("ghost"),
        --   which the filter treats as "not the user". `author` is the `Actor` interface,
        --   so the `... on Node` fragment is required to reach a bot's or App's id
        -- author_login = the login as of discovery, display data only (FR-15), like
        --   reaction_events.reactor_login: it goes stale on a rename, which is accepted.

-- per-user polling state; drives the score in §6.3
tracked_content(user_id, node_id,
                last_checked_at default now(), last_event_at,
                watermark_at,
                PRIMARY KEY (user_id, node_id))
        -- a row exists for every item the user's sources have found, whatever FR-4d's
        --   switches say. From M2, one whose type is off in every source that matched it is
        --   parked (deferred, below): kept, with its last_event_at, but never polled.
        --   Switching a type parks or un-parks rows (§6.3), so the poller never reads the
        --   switches themselves
        -- watermark_at = newest reaction createdAt observed, but never later than the probe's
        --   start less CLOCK_MARGIN (hot boundary, §6.3); the cheap probe
        --   drills down strictly when the item's newest createdAt exceeds it — `>`, never
        --   the `≥` used by the walks, which here would fire on every poll
        --   **Initialised to its type's enabled_at** as the row starts being polled — on
        --   insert or on un-parking — which is the entirety of FR-6: reactions older than it
        --   are never stored or notified, and no first-poll special case exists
        --   (§6.3)
        -- last_event_at = max(the item's createdAt, the newest reaction createdAt known at
        --   insertion or polling); a new reaction resets it. Backfill fetches the newest
        --   reaction timestamp for threads only — comments start at their createdAt
        --   (§6.3) — and uses it as an activity hint even when it predates enabled_at;
        --   watermark_at still enforces FR-6, so such a reaction is not stored or notified.
        --   Incremental discovery uses createdAt because a newly created item is already fresh.
        --   Only discovery inserts rows, so createdAt is taken from that response and stored
        --   nowhere else.
        -- index on (user_id, last_checked_at) including last_event_at: it serves the
        --   `last_checked_at ≤ now − D` eligibility filter and keeps the score computable
        --   mostly without a heap fetch: Postgres still reads pages changed since the last
        --   vacuum, and every poll updates its row.
        --   "index on .. include" is a Postgres feature that stores the included columns in the 
        --   index leaf.

-- observed GitHub budget per user, refreshed from response headers (§6.4)
rate_limit_state(user_id PK, limit_, used, reset_at)
        -- GRN only stores the `graphql` bucket here, so no need to differentiate buckets.

content_sources(user_id, node_id, subscription_id,
                PRIMARY KEY (user_id, node_id, subscription_id))
        -- a pure set: which sources matched an item, for FR-5's "which source(s)" and
        --   FR-15's labelling. No found_at — FR-6 silence compares each reaction's own
        --   createdAt with its type's enabled_at, so when GRN found the item does not matter
        -- written for every type a category's query returns, switched on or not: it is how
        --   switching a type finds the source's rows in tracked_content to park or un-park,
        --   without a GitHub query (§6.3)

-- global observed facts
reaction_events(node_id, reactor_id, emoji, reacted_at, reactor_login,
                PRIMARY KEY (node_id, reactor_id, emoji))
        -- reactor_id = the reactor's GraphQL global node id, from the drill-down's
        --   `user { id login }` (§6.3), for the reason users.gh_user_id is one.
        -- reactor_login = the login as of detection, display data only (FR-15), like
        --   content.author_login
        -- `Reaction.user` is nullable in the schema. A reaction without one can be neither
        --   keyed nor attributed, so the poll logs and skips it rather than failing its
        --   transaction on the key

-- per-user "has this user been told?" — the FR-7 anchor
reaction_notifications(user_id, node_id, reactor_id, emoji, outcome,
                       PRIMARY KEY (user_id, node_id, reactor_id, emoji))
        -- outcome ∈ {'queued','delivered'}.
        -- no decided_at: FR-8's latency is logged, not stored

jobs(id, kind, user_id, payload jsonb, run_at, locked_by, locked_at, attempts)
        -- the work queue (§6.2). kind ∈ {'sync','deliver'} in M1:
        --   'sync': one per user, inserted at signup and kept — UNIQUE (user_id) WHERE
        --   kind = 'sync' — which is what holds one request in flight per token (§6.4)
        --   'deliver': one per message, deleted once posted; at most one per user is a
        --   digest, open or rendered, so a user's digests cannot overtake each other (§6.6)
        -- every kind but 'sync' runs on the machine account, so at most one such job is
        --   leased at a time — UNIQUE ((true)) WHERE kind <> 'sync' AND locked_by IS NOT NULL,
        --   on a constant key — which makes the dispatcher global (§6.8)
        -- payload, by kind:
        --   'sync': NULL — all its progress lives in the tables it works on (§6.3)
        --   'deliver': a digest is {"digest": true, "state": "open"} while it collects
        --   reactions, then "state": "rendered" with a "body", the markdown it posts (§6.6).
        --   One-off messages and inbox openings are inserted rendered. An opening — the
        --   user's first inbox issue, queued at sign-in, or a rollover — also carries the
        --   new issue's "title", which makes the dispatcher open that issue instead of
        --   commenting, then point the user's channel at it (§6.7)
        -- run_at = not before, and a claim takes the oldest first — after a new user's inbox
        --   opening, for 'deliver' (§6.8). It holds only what no other table records — when
        --   a 'sync' job's last slice ended, backoff, a retry-after, a deliver job's batching
        --   window — never when a 'sync' job is due, which the claim derives from
        --   token_status and rate_limit_state (§6.2), nor whether a user's inbox issue exists
        --   yet, which notification_channels records, nor a pause of the machine account,
        --   which dispatch_bucket records (below)
        -- locked_by = a fresh uuid per claim, the lease's fencing token; locked_at = the
        --   lease's last renewal; attempts counts claims, so a dead worker counts too (§6.2)
        -- also M1's outbox: a 'deliver' job carries one message, rendered when it is first
        --   sent, and its id — a uuid — is the comment's idempotency marker (§6.6, §6.8).
        --   The outbox table itself is deferred (below)

-- the machine account's token bucket (§6.8): one row, because one identity makes every write,
-- and a row rather than a worker's memory, because the dispatcher changes hands with every job
dispatch_bucket(level, level_at)
        -- level = the tokens it holds at level_at. It refills at the dispatch rate up to its
        --   capacity, so now it holds least(capacity, level + rate × (now − level_at))
        -- each write takes a token — storing that level less one, with level_at = now — in
        --   the transaction that renews its lease right before posting (§6.2)
        -- a pause stores level = 1 with level_at = the pause's end: a level_at in the future,
        --   so the bucket holds less than a token until then (§6.8)
        -- the 'deliver' claim requires a token and a second since level_at (§6.2), so the
        --   pacing, the ≥ 1 s gap and every pause bind whichever worker claims next
```

**Deferred to their milestone.** Everything below but the outbox (see its row) is a pure
`ADD COLUMN` / `CREATE TABLE` with a default — no backfill, and no query M1 ships has to
change — so it arrives with the feature that first reads it rather than sitting unused from
the start.

| Deferred | Arrives | For |
|---|---|---|
| `subscriptions.kind`, `.target` | M2 | Naming *which* source a row is (§3). M1 ships one adapter, so every row would read `('authored', null)`. Which types a source covers needs no column: its adapter defines them |
| `subscriptions.enabled` | M2 | Pausing a source without deleting it. The two are **not** equivalent: deleting drops the watermarks and backfill state, so a re-add starts a fresh silent first sync (FR-6) and swallows every reaction that arrived while it was away. M1 has one source and no control plane to pause it from — `/pause` is M2 (§6.7) |
| `subscription_categories.enabled`, `subscription_types.enabled` | M2 | FR-4d's switches: the category config's master switch and each type's own. They record the user's choice and `enabled_at` its effect — set while both switches are on, null otherwise — so turning a category off and on again restores the types the user had chosen. A category that has never been on has no rows to hold them, so it can be configured only from its first switch-on, which inserts the rows with the user's choices; until then the settings UI shows the adapter's defaults. M1 has no settings UI, and its three types are always on |
| `tracked_content.parked` | M2 | FR-4d's switches, per item (§6.3): a parked row is kept but never polled, so a type switched off and on again keeps each item's `last_event_at` and per-item state such as a mute. The poller filters on it, and its index becomes partial. Discovery inserts the rows of a type that is off parked, with `watermark_at = now()` as a placeholder nothing reads; un-parking sets it to the type's `enabled_at`, and `last_checked_at` to now. Defaults to false: M1's three types are always on, so nothing is ever parked |
| `users.tier`, `users.scopes` | M2 | The private tier and its upgrade/downgrade path (FR-2). With one tier both are constants |
| `users.stopped_at` | M2 | FR-3a's `/stop` (§6.7): when the user sent it, null while GRN works for them, cleared by `/start`. The `sync` claim adds `stopped_at IS NULL` beside `token_status = 'active'` (§6.2), and while it is set the dispatcher makes no write for the user but the closing of their inbox. Nothing else records a stop, so a resumed account picks up where it stopped. M1 has no `/stop`: unwatching the inbox issue silences GRN, and deleting the account (FR-3) stops it |
| `users.gh_database_id` | M2 | The webhook route's key to a command's author (§6.7). A webhook payload names a comment's author by this REST id; its node id may be in the legacy format (C13), and the login is refreshed only by a discovery query (above), which a stopped user does not get. Nullable, so no backfill: a sign-in sets it, and so does the next discovery query of each user who signed up in M1, selecting it with `viewer { id login }` for free |
| `filters jsonb` on `users`, `subscriptions`, `subscription_categories` and `subscription_types` | M2 | FR-11's global, per-source, per-category and per-type filters, a type inheriting its category's unless it sets its own (FR-4d). Like the switches, per-category and per-type filters can be set only from the category's first switch-on. M1 includes self/bot reactions and implements no configurable filter. Note FR-11 asks for no per-channel filters — a `filters` column on `notification_channels` is not a requirement and is not planned |
| `tracked_content.muted_at` | M2 | FR-11's single-thread mute, written by the `/mute` control-plane command (§6.7). A muted item is still polled and its reactions still recorded; the filter stage drops them, so muting touches no other table |
| `rate_limit_state.observed_at` | M2 | FR-16's "last poll" on the status page (§9). M1 has no status page, and the rollover rule and `elapsed` need only `reset_at` (§6.2, §6.4) |
| `notification_channels.cadence` | M2 | FR-10's per-channel delivery frequency — instant, hourly, daily, weekly or off — which the notifier turns into the outbox's `scheduled_for` (§6.6). M1 delivers near-instant batches only (§6.6, §9) and has neither a settings UI nor `/daily` (§6.7) to change that, so its cadence is a constant. Arrives with M2's remaining cadences, defaulting to `instant` — M1's behaviour |
| `notification_channels.secret` | M2 | Signing outgoing webhook deliveries (NFR-5) |
| `notification_channels.verified_at` | M4 | E-mail double opt-in (FR-14). The GitHub-native channel needs none — signing in *is* the opt-in (FR-14, §6.7) |
| `outbox` table | M2 | Per-channel pending state for FR-10's cadences (§6.6): `outbox(id, user_id, channel_id, payload jsonb, scheduled_for, state, attempts, last_error, delivered_at)`, a row per channel and cadence window. M1 has one channel and one cadence, so `reaction_notifications.outcome` holds what is pending and each digest goes out as a `deliver` job. M1 thus gives up only `last_error` and `delivered_at`, which no M1 reader needs — FR-16's status page is M2 — and a dead-letter state, which is M3. The one deferral that is **not** additive: M2 moves the pending state out of `reaction_notifications` and reworks the notifier — which per-channel cadences would force anyway |
| `discovery_targets`, `target_passes` tables | M2 | Per-repository discovery state (below) |

`discovery_targets` is the one worth spelling out now, because M1 must not foreclose it:

```
discovery_targets(id, category_id, repo_full_name,
                  last_checked_at, last_find_at, backfill_done_at,
                  UNIQUE (category_id, repo_full_name))
target_passes(target_id, pass, watermark not null,
              PRIMARY KEY (target_id, pass))
```

It is the second level of the one discovery rule (§6.3), and only a source that *fans out*
needs it: `owned_repos` as its walk finds repositories, and the release pass as it re-lists
candidates (C11). `authored` — the sole M1 adapter — runs user-wide passes, and `repo:` is
already a single repository, so its category rows are their own targets; hence nothing in M1
reads these tables. Their columns are deliberately those of `subscription_categories` and
`subscription_passes`, because it is the same rule one level down: finding something new sets
`last_find_at = now`, which re-prioritises that repository *and* marks the parent category fresh.
A new row starts at `last_find_at = now`, so a newly found repository is walked promptly and
relaxes only if it proves quiet. It is also where the release walk's per-repository
`CREATED_AT` watermark and completion flag live — "the repository as the unit of progress"
(C11, §6.3) has no date windows, and one watermark per category cannot hold a set of
repositories. Keyed by category, a target needs a single `backfill_done_at` rather than one per
type; it records that per-repository progress for FR-6's summary and FR-16's status, the same
role `backfill_windows` plays for the search-driven categories. The FR-6 *silence* test reads
neither, so nothing outside these two tables changes when they land.

**Absent rather than deferred.** Three things are *rejected*, not postponed, and should not be
read as gaps to fill later: a per-user quota column (the budget policy is global, NFR-2, and
the allowance comes from live headers, §6.4), a `sync_cursors` table (§6.3), and a per-item
reaction count vector.

**Why the observed fact and the notification decision are separate tables.**
Once several users can watch the same repo, the same reaction is relevant to several people.
A single global dedup key would let the first user's poll consume the event and silently
starve everyone else. So `reaction_events` records *what happened* (once, globally) and
`reaction_notifications` records *who has been told* (once per user) — both written with
`ON CONFLICT DO NOTHING RETURNING *`, so only genuinely new rows flow onward (FR-7).
`content_sources` is a set, so an item matched by both `authored` and `owned_repos`
is still tracked and notified exactly once.

> **Forward-looking:** because `content` and `reaction_events` are already global, polling of
> *public* content can later be shared across all users watching it — a large efficiency win
> that this schema permits without migration. Private content must always stay per-user.

### 6.6 Notification pipeline

```
new reaction_events ──▶ fan out to users via content_sources, from each source's enabled_at
                        for the item's type (none while the type is off, FR-4d)
                   ──▶ filter (emoji/repo/type/author/self/bot/mute; global, per-source,
                               per-category and per-type)
                   ──▶ insert into reaction_notifications (ON CONFLICT DO NOTHING)
                       — drops anything already handled
                   ──▶ group by (user, channel, cadence window): open the window's outbox row
                       (M2; in M1 the user's digest job) unless they have one already
                   ──▶ at the window's end: render (template per channel kind)
                   ──▶ dispatcher (run_at order, retry/backoff/DLQ)
```

**Late discovery replays.** Only *new* `reaction_events` fan out, so a user whose discovery
finds an item *after* another user's poll recorded a reaction on it would never be told: their
own poll's insert of it conflicts, and nothing flows onward — although the reaction postdates
their `enabled_at` (FR-6). So inserting a `content_sources` row also replays the item's
`reaction_events` with `reacted_at ≥` that source's `enabled_at` for the item's type through
the pipeline above; `reaction_notifications` keeps this idempotent. That is why `delivered`
rows are kept, not deleted: when a user's second source finds an item, its replay re-offers
reactions the first already delivered. The replay first matters in M2: in M1, `authored`
gives each item a single tracking user. The poll's insert-and-fan-out and the replay each run
in one transaction and serialise on the item's `content` row — the poll shared, the replay
exclusively (`FOR SHARE` / `FOR UPDATE`) — so whichever goes second sees the other's row.

The insert into `reaction_notifications` happens **after** filtering, so a filtered reaction
leaves no row: FR-7 needs none, since a reaction never sent cannot be sent twice. The price
is that a replay (above) re-checks the reactions it finds against the filters in force at
that moment, so a filter loosened in between can let one through late.

M1 implements no self/bot filter: both are included (FR-12). **Configurable** filters are M2
(FR-11). A future self-exclusion should compare node IDs, not logins, to survive renames.

**Delivery without an outbox in M1.** M1 has one channel and one cadence (§9): near-instant,
batched per user. A user's pending reactions are their `queued` rows in
`reaction_notifications`, and a single **digest** — a `deliver` job (§6.5) — stands for them all:

- **Opened by the first reaction.** Every transaction that inserts a `queued` row — the poll's
  fan-out and the replay above — also opens the user's digest, due 3 min later, unless they
  have one already, open or rendered. Later reactions join an open one without moving
  `run_at`, so even a steady stream goes out within the window — as one message rather than
  many. While it is rendered, they stay `queued` for its successor (below).
- **Rendered when sent.** When the dispatcher reaches the job, one transaction closes it, marks
  the user's `queued` rows `delivered`, renders them into the job's payload and commits — all
  before the first attempt. A retry thus re-posts the same body under the same marker (§6.8),
  and the job's `attempts` and `run_at` carry the backoff.
- **One digest per user, so none overtakes another.** A rendered digest stays the user's only
  one through its retries. Were a new one opened beside it, the older one's backoff (§6.8) or
  a reaper's rescue (§6.2) could push its `run_at` past the newer one's, and the user would
  get their reactions out of order. The price: while a digest retries, newer reactions wait.
- **No reaction is stranded.** Both sides lock the user's digest — the insert by upserting it,
  the dispatcher by closing it before reading the queue and by deleting it once posted — so
  whichever goes second sees the other's write: a reaction committed before the close is
  rendered; one committed between close and delete stays `queued` for the successor that the
  deleting transaction opens, due at once; and one committed after the delete opens a new
  digest. A digest removed for good instead — a permanent failure (§6.8), M3's dead letter —
  opens its successor the same way.

```sql
CREATE UNIQUE INDEX ON jobs (user_id) WHERE kind = 'deliver' AND payload->>'digest' = 'true';

-- with every insert of a 'queued' row:
INSERT INTO jobs (kind, user_id, payload, run_at)
VALUES ('deliver', $user, '{"digest": true, "state": "open"}', now() + interval '3 minutes')
  ON CONFLICT (user_id) WHERE kind = 'deliver' AND payload->>'digest' = 'true'
  DO UPDATE SET run_at = jobs.run_at;           -- changes nothing, but locks the digest

-- rendering, in one transaction after the lease check (§6.2): close first, then drain
UPDATE jobs SET payload = payload || '{"state": "rendered"}' WHERE id = $job;
UPDATE reaction_notifications SET outcome = 'delivered'
WHERE user_id = $user AND outcome = 'queued'
  RETURNING *;                                  -- render these into the payload, then COMMIT

-- finishing, in the transaction that deletes the digest once posted (§6.2)
DELETE FROM jobs WHERE id = $job;
INSERT INTO jobs (kind, user_id, payload, run_at)
SELECT 'deliver', $user, '{"digest": true, "state": "open"}', now()
WHERE EXISTS (SELECT 1 FROM reaction_notifications
              WHERE user_id = $user AND outcome = 'queued');   -- the successor
```

Rendering when sent is what makes the channel self-limiting: under load a job waits longer in
the dispatcher's queue and so carries more, which spaces each user's messages as far apart as
the ceiling requires (§6.7, §6.8). One-off messages — FR-17's notice in M1, completion
summaries only from M2 — are
`deliver` jobs too, but not digests: rendered by whatever creates them, they neither
block nor join a batch. The noise of near-instant delivery is accepted for M1; users can
choose longer cadences from M2 (FR-10).

From M2 that no longer suffices: cadences are per channel, and one `queued` state per user
cannot feed an instant and a weekly-digest channel at once. M2 therefore moves the pending
state from `reaction_notifications` to the outbox (deferred, §6.5): a row per channel and
cadence window, opened the same way and `scheduled_for` its end, so both channels still
share one detection pass. This reworks the M1 notifier rather than extending it.

### 6.7 GitHub-native delivery (primary channel)

**Idea.** Instead of building an e-mail stack, deliver notifications *as GitHub issue comments*.
The user is subscribed to the issue, so **GitHub's own notification infrastructure** does the
delivery — web, e-mail, and mobile push — already configured to each user's taste. GRN opens
one such issue per user in its inbox repo when they sign in, and posts digest comments to it.

This is the strongest channel available to us, for a reason that is easy to undersell:
**the subscription act and the identity proof are the same action.** The OAuth sign-in
(FR-1) proves the GitHub identity and records consent — its page says that GRN will open a
public inbox issue for the user — and GRN then creates that delivery endpoint itself, with no
second step for the user (Mechanics, below). That deletes an entire category of work —
provider contracts, sending domain, SPF/DKIM/DMARC, double opt-in (FR-14), bounce handling,
unsubscribe plumbing, spam-reputation management — and the per-message cost goes to zero.
Unsubscribe is native (unwatch the thread), and from M2 one reply, `/stop`, stops GRN itself
(FR-3a); history is a searchable, rendered thread.

#### Design: shared inbox repo + machine account

GRN owns one public **inbox repository**. A dedicated **machine account** opens one issue
there per user, @mentioning them, which subscribes them to it, and posts digest comments to
that issue; GitHub notifies the user.

Two mechanical points force this shape:

- **The poster must not be the user.** GitHub does not notify you about your own actions, so
  posting the digest with the user's own OAuth token would be silent — and would spend the
  user's content-creation quota. Delivery therefore needs a separate identity, which opens the
  inbox issue too: opening it with the user's token would need the `public_repo` scope — write
  access to every public repository the user can push to — which the public tier does not
  request (FR-2).
- **Reading and delivering are separate concerns.** FR-1 closes the GitHub App route for
  *reading*, but not for *writing to a single repo*. That keeps a genuine escape hatch open
  (see below) at no cost today.

#### Accepted limits (deliberately deferred)

**Throughput ceiling.** Verified secondary limits: *no more than 80 content-generating
requests per minute and no more than 500 per hour*, counting web UI and API together.
With one machine account that ceiling is **service-wide** — but it limits how often each user
hears from GRN, not how many users it can serve. Each user has at most one batch collecting
reactions, and the dispatcher serves batches in `run_at` order (§6.6, §6.8), so under load
each batch waits longer and carries more:

| Users with pending reactions | Each user's messages arrive about every (at 500/h) |
|---|---|
| up to 25 | 3 min — the batching window (§6.6) |
| 1 000 | 2 h |
| 10 000 | 20 h |

Ample runway for a new project, so **accepted for now**. It degrades gracefully — messages
grow later and fuller, and none is dropped — but for *everyone at once*, so the governor and
alerting in §6.4 must cover the delivery path too, not just polling: the delivery wait is the
alarm (§6.8). The dispatch rate is set a little below 500/h (§6.8), so real intervals are
slightly longer. Opening each new user's inbox costs one write more, once, and from M2 `/stop`
and `/start` one each (Mechanics, below): nothing in steady state. But openings go first
(§6.8), so a burst of sign-ups — at launch, say — holds everyone's messages back until the new
inboxes are open: a thousand sign-ups take about two hours.

#### Risks

- **Privacy / aggregation. DEFERRED by decision.** A public inbox aggregates the user's
  reaction history, the service's user list, and — more sensitively — *third parties'*
  reaction behaviour into a searchable index. Individual reactions are already public, but
  compiling them is a different posture, and AUP §3 forbids "posting another person's
  personal information without consent". **Planned mitigation:** a public opt-out list where
  any individual can request never to be tracked or named by GRN; their reactions are then
  dropped or rendered anonymously ("someone reacted"). The list holds node ids, resolved
  from the login when a request is made and matched against `reactor_id` (§6.5), so an
  entry survives a rename and does not pass to whoever claims the old login. Until that
  ships, private-repo content
  must never be written to the inbox (NFR-4).
- **Acceptable Use.** AUP §4 prohibits "excessive automated bulk activity" and placing
  "undue burden on our servers through automated means"; AUP §2 prohibits interacting with
  platform features in ways that "repeatedly disrupt the experience of other users".
  Solicited, self-only notifications are a defensible reading, but thousands of daily bot
  comments in one public repo is the weakest version of that argument — and M1's near-instant
  batching (§6.6) reaches the dispatcher's full rate once a few dozen users have reactions
  pending, up to 12 000 comments a day at 500/h. Opening each inbox for its user adds a
  pattern of its own: from outside, a bot opening issues that each @mention a different account
  looks like mention spam. Every mention is solicited — the user signed in to ask for it — but,
  unlike an issue the user had opened, the thread does not show that, so each inbox issue's
  body says so — and, from M2, that replying `/stop` ends it. Mitigations: a dispatch rate
  that is one setting to turn down should GitHub object (§6.8), longer cadences for users who
  want them from M2 (FR-10), and a proactive support conversation with GitHub before scaling.

#### Escape hatches, in preference order

1. **Longer default cadence** and a per-user daily notification cap.
2. **Move heavy users to Atom or outgoing webhook** — neither costs content-creation quota.
3. **Optional GitHub App for delivery only** — a user installs it on *their own* repo (which
   may be private) purely as a delivery target; reading still goes through OAuth. Gives
   per-installation content quota and solves the privacy problem for anyone who opts in.
   This is the real long-term answer if the ceiling ever binds.
   **Not an option:** sharding across several machine accounts. GitHub's Terms §B3 allow
   *"no more than one free machine account in addition to your free Personal Account"*.

#### Issues or Discussions?

**Issues.** The comparison is closer than the others in this document, and it is a cheap
decision to revisit.

| | **Issues** | **Discussions** |
|---|---|---|
| Notification behaviour | Most battle-tested path on the platform | Almost certainly fine, but less universally exercised |
| API | REST **and** GraphQL | **GraphQL only** (`addDiscussionComment`) |
| Global search noise | Appears in everyone's `is:issue` searches | Separate namespace, quieter |
| Semantic fit | A notification feed is not a bug | Slightly better |

Reliability dominates: the product's entire promise is that a notification arrives, so the
most-exercised delivery path wins over a mild semantic improvement. REST availability
reinforces it.

**The main argument for Discussions — not polluting global issue search — stands, because GRN
leaves inbox issues open.** Each one shows in `is:open` searches, among the open issues that
mention its user, and in the repo's open-issue count. Closing it would hide it, but the whole
channel would then rest on closed issues still notifying their subscribers, which M0 would
first have to confirm, and every close would cost a write. So GRN closes one only on `/stop`
(M2), when it stops posting there (Mechanics, below). The noise is accepted.

#### Mechanics

- **Open the inbox at sign-in.** Every sign-in tries to insert the user's `github_issue`
  channel, with no target yet, together with a rendered `deliver` job that opens the issue
  (§6.5). The unique index on active channels lets this succeed only for a user who has none —
  a new user, or one whose channel was disabled (§6.8) — so concurrent sign-ins open one inbox.
  The issue's body @mentions the user, which subscribes them just as authorship would: *"when
  someone @mentions your username, you are participating in a conversation. By default, you
  are automatically subscribed to a conversation when you participate in it."*
  ([GitHub docs](https://docs.github.com/en/subscriptions-and-notifications/get-started/configuring-notifications#participating-in-conversations))
  Assigning them is no alternative: GitHub only lets an issue be assigned to people who have
  commented on it or can write to the repository. The opening is the user's first
  notification, so it shows the channel works before any reaction arrives; until it is done,
  none of their other `deliver` jobs is due (§6.2). And it goes before everyone else's
  (§6.8): having just signed in, the user is waiting for it.
- **Mention no one else.** The @mention that subscribes a user to their inbox (above) works on
  anyone: were FR-15's *@octocat* a live mention, it would notify them, and so would every
  later digest in that inbox — a stranger enrolled in someone else's feed, and the mention spam
  the AUP risk above warns of. So GRN's one live mention is of a user, in the body of their own
  inbox issue. Everyone else a digest names — authors, reactors — gets a zero-width space after
  the `@` of their login, which then reads as a mention but is none, and a link to their
  profile. A code span would not do: a user's e-mail reply quotes the digest as plain text,
  where `@octocat` would be live again — Dependabot's reason for the same space in the names
  its pull requests quote
  ([source](https://github.com/dependabot/dependabot-core/blob/main/common/lib/dependabot/pull_request_creator/message_builder/link_and_mention_sanitizer.rb)).
- **Mark no thread it links to.** A link to an issue, pull request or discussion — or to a
  comment in one — adds a *"mentioned this"* event to that thread's timeline
  ([GitHub docs](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#cross-referenced)),
  and a digest links every item it reports. Each would mark the threads it covers, publicly
  and in the machine account's name, pointing everyone there to whose inbox it went, and
  cluttering popular threads. So the renderer links through `redirect.github.com`, which
  leads to the same page but is no reference, as Dependabot and Renovate do in the pull
  requests they open
  ([source](https://github.com/renovatebot/renovate/blob/main/lib/modules/platform/github/massage-markdown-links.ts)).
  Text a digest quotes — titles, which anyone can write — may hold mentions and references of
  its own, so it goes in escaped as plain text, with a zero-width space breaking every `@` and
  every issue reference (`#123`, `GH-123`, `owner/repo#123`), and every thread URL redirected.
  Even a bare `#123` needs it: in the inbox repo, it would mark another user's inbox. The one
  link left direct is a new inbox issue's to the one before it (below), whose mark points the
  old inbox to the new.
- **Edits do not notify.** Updating an existing comment is silent, so each digest must be a
  *new* comment. Threads therefore grow without bound — roll over to a fresh inbox issue
  every N comments, opened the same way (above), and link the previous one. The dispatcher
  counts the comments it posts to the channel's current target (`comment_count`, §6.5). When
  the count reaches N, the transaction that deletes the posted comment's job also queues the
  rollover's opening, which resets the count when it points the channel at the new issue.
  Opening an issue
  also costs content-creation budget, so inboxes and rollovers count against the ceiling above.
- **Do not lock the inbox issue.** Locking blocks comments from anyone without write access,
  which would also block *the user* and kill the `/`-command control plane below — `/start`
  included, which a stopped user sends in their closed inbox. Leave it unlocked: a command
  acts only on its author's own account (below), so a stranger's comment can do no harm.
  Stray third-party comments in a personal inbox thread are unlikely and harmless; losing the
  control plane is not.
- **Free control plane** (M2). A webhook on the inbox repo delivers `issue_comment` events to
  a web app route (§6.2), so a user can reply with a command — `/stop` and `/start` (below),
  `/mute`, `/daily`, `/pause` — and have it take effect: a bidirectional interface at no extra
  cost. The route checks each delivery's signature, ignores everything but a new comment
  holding a command — GRN's own digests arrive too — and applies the command to its author's
  own account, whichever thread it is posted in, so a stranger's `/stop` stops no one but
  themselves. It finds the author by the REST id the payload names them by, which GRN keeps
  for this (`gh_database_id`, §6.5), so it makes no request of its own. *"GitHub does not
  automatically redeliver failed webhook deliveries"*, and a response slower than 10 seconds
  counts as failed
  ([GitHub docs](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)),
  so the route does one short transaction and nothing more, and repeating a command does no
  harm: a user whose `/stop` was lost sees GRN carry on, and sends it again. M3 adds a sweep
  that redelivers failed deliveries through the REST API.
- **Stop on `/stop`** (M2, FR-3a). Leaving takes a signal GRN can see, and neither native one
  will do. Unwatching the issue is invisible to GRN: seeing a user's subscriptions takes the
  `notifications` scope ([GitHub docs](https://docs.github.com/en/rest/activity/notifications)),
  which the public tier does not request (FR-2), so GRN would go on polling and posting,
  unread. Closing the issue is not the user's to do: only its author, or someone with triage
  access to the repository, can close an issue
  ([GitHub docs](https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization)).
  So the user replies `/stop`, and the route's transaction sets their `stopped_at` (§6.5),
  after which the dispatcher makes no write for them but the closing below; releases their
  `sync` job's lease as a slice's end would, so its worker's next commit fails and polling
  stops there (§6.2); and queues the closing of the issue their channel targets — the stop's
  one visible sign. The closing names that issue rather than reading the channel when it
  runs, by which time a `/start` may have pointed the channel at a new one. A post already
  under way may still land; no other does. Nothing is discarded — token, watermarks, pending
  reactions and channel all stay — and since the channel stays active, a sign-in changes
  nothing for a stopped user, who can therefore sign in to delete their account (FR-3)
  without resuming it. A `/stop` from a user who is stopped already, or whose first inbox is
  not open yet, queues no closing.
- **Resume on `/start`** (M2). It clears `stopped_at` and, unless an opening of the user's
  inbox is already pending, queues one — of a new issue that links the previous one, as a
  rollover does, so its @mention subscribes the user afresh even if they had unwatched the
  old one. A user whose channel was disabled meanwhile gets a new one first, as at sign-in.
  Polling resumes where it stopped, so reactions that arrived meanwhile are not lost: they
  reach the user in the new issue, since from M2 a user's messages wait for any pending
  opening of their inbox, not just their first (§6.2). From a user who is not stopped,
  `/start` does nothing.

**Position:** flagship channel and the only M1 channel, with Atom as the zero-friction
fallback from M2 and e-mail deferred indefinitely. It stays behind the channel adapter
interface (§6.6), so it is a strong *default*, not a lock-in.

### 6.8 Delivery retry and pacing

Content creation needs a **different** retry discipline from the read path. The existing
`retryer.ts` rotates PATs and retries freely — both wrong for mutations. GitHub warns that
*"continuing to make requests while you are rate limited may result in the banning of your
integration"*, so this path must be conservative by construction.

**Pacing** (following GitHub's documented best practices):

- Deliver **serially, never concurrently** — one global dispatcher for the machine account,
  since all users share its quota. The queue enforces it: only one `deliver` job can be leased
  at a time (§6.5), so a second dispatcher's claim fails and it exits. Polling is serial per
  token too (§6.4), so the rule is uniform; the difference is *scope*: delivery serialises
  across the whole service, because one identity carries every user's writes, whereas polling
  serialises only within a user.
- Wait **≥ 1 s between mutative requests**, timed from the token bucket's last take (below),
  so that the gap holds across workers.
- Enforce the 80/min and 500/hour ceilings with a token bucket and stop *before* hitting them,
  rather than discovering them through errors — there is **no API to query secondary
  rate-limit status**, so it cannot be checked proactively any other way. The bucket is a row
  (§6.5), not a worker's memory, since the dispatcher changes hands with every job (§6.2).
  Set its rate **close to 500/h — 480/h, say** — once M0 has confirmed it (§9). The bucket
  counts every write it lets through, failed ones included, so the margin need only cover what
  it cannot see. One is writes made as the machine account by anything but the dispatcher — so
  there are none, not even in the web UI, which the ceiling counts too. The other is GitHub's
  discretion: the ceiling holds *"in general"*, and *"some endpoints have lower content
  creation limits"*, unnamed
  ([GitHub docs](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits)).
  Whether opening an issue is one, M0 measures; if it is, openings need a slower bucket of
  their own, since a burst of sign-ups sends them back to back (below). The bucket's capacity
  — the burst it allows after a lull — counts against the same hour. A hit then costs a pause and nothing more —
  the table below honours it, and GitHub's ban warning concerns requests made *while* limited
  — but it shows the bucket is wrong, so each one alerts, and the rate comes down if they
  recur. Under load the dispatcher runs at that rate around the clock (below), so the rate,
  not the number of users, bounds the machine account's volume: it is the dial to turn down
  should GitHub object to it (§6.7).

**Order: a new user's inbox first, then strictly by `run_at`.** Each user has at most one
digest, collecting reactions or awaiting a retry (§6.6), so the backlog never holds more than
one per user, and serving it in `run_at` order turns overload into a round-robin: a user's
messages arrive about every *users with pending reactions ÷ dispatch rate* (§6.7), each
carrying everything that arrived since the last. The system finds that equilibrium by itself —
latency grows with load, but nothing is dropped and no user is starved. Opening a new user's
inbox (§6.7) jumps that queue, because it is the one write a user actively waits for: they
have just signed in, and see nothing of GRN until it lands, whereas digests arrive
unannounced. It happens once per
user, so it holds the others back little, except in a burst of sign-ups (§6.7). The claim
recognises it by the user's channel having no target yet — a new user, or one whose channel
was disabled (§6.7) — when the opening is the user's only due job (§6.2). Every other write
keeps its turn: nobody waits for a rollover, and if `/start`'s new issue (M2) went first, a
user could take over the dispatcher at will by alternating `/stop` and `/start`. So under load
those open later, and from M2 a stopped user's inbox closes later too, though the stop itself
takes effect at once.

- **The wait is the capacity signal.** Log each batch's wait, from its `run_at` to its
  rendering, as FR-8 logs detection latency; a rising wait is what calls for the escape
  hatches (§6.7).
- **Bodies are capped.** A batch grows with its wait, but a comment body holds at most
  65 536 characters, so the renderer truncates ("…and 12 more items").

**Retry classification:**

| Condition | Action |
|---|---|
| `403`/`429` with `retry-after` | Pause exactly that many seconds; never retry sooner |
| `403`/`429` with `x-ratelimit-remaining: 0` | Pause until `x-ratelimit-reset` (UTC epoch seconds, GitHub's clock) plus `CLOCK_MARGIN` (§6.2) |
| `403`/`429`, neither header | Wait ≥ 60 s, then exponential backoff; dead-letter after N attempts (M3; until then, an alert) |
| `5xx` / network / timeout | Exponential backoff, on a budget separate from rate-limit retries |
| `404` (issue deleted), `410`, `403` without access | **Permanent** — no retry; disable the channel and flag the user (FR-17) |

A pause stops the whole dispatcher, not just the job — it is the machine account that is
limited. The lease cannot do that: it keeps a second dispatcher out only while the job is
held, and no worker sleeps holding a lease (§6.2), so the next cron run would claim the next
due job and post straight into the limit. The token bucket does it instead: the transaction
that releases the job also empties the bucket until the pause ends (§6.5), and since the
`deliver` claim requires a token, no worker can claim any `deliver` job until then. The job
keeps its `run_at`, and so its place in line: the pause is the account's, not the job's.

**Idempotency is mandatory.** A timeout may mean the comment *was* posted. Every comment body —
and the body of every issue the dispatcher opens (§6.7) — therefore embeds a hidden marker
`<!-- grn:{uuid} -->` — the id of the `deliver` job (M1) or outbox row (M2) carrying it, whose
body never changes between attempts (§6.6). Before re-posting after an ambiguous failure, the
dispatcher lists recent comments on the target issue — or, for a job that opens an issue, the
inbox repo's newest issues — and skips if the marker is already there; a skipped opening still
points the user's channel at the issue it found. M2's closings (§6.7) need no marker: closing
an issue twice leaves it closed. Any attempt after the first counts as ambiguous — including
one resuming a job whose worker died mid-post (§6.2) — and the dispatcher re-checks its lease
right before posting. Without this, retries double-post — the most visible possible bug in a
notification product.

M1's implementation still checks only one page of 100: this does **not** satisfy the
idempotency guarantee when a marker falls beyond that page. Reconciliation must remain
indeterminate until the relevant range has been exhausted. It runs whenever the job has a
recorded `attempted_at`, including a crash after a successful POST but before database commit.
Mutation requests now refuse automatic redirects, and creation completion requires `201`
plus a valid issue number or comment ID; malformed successes remain ambiguous.

---

## 7. Relationship to github-stats-extended

### 7.1 Why a separate project first

- **Different workload shape.** github-stats-extended is a stateless, cache-heavy,
  sub-second SVG renderer. GRN is a stateful background job system with outbound delivery.
  Co-deploying them puts a high-traffic, stable service at risk from a young one.
- **Different failure/latency budgets** and different on-call characteristics.
- **Independent release cadence** while GRN's model is still moving.

### 7.2 Why they should share code anyway

They overlap almost perfectly on the *GitHub-plumbing* layer, and GRN needs exactly the
pieces github-stats-extended already has battle-tested.

The shared code is **one package**.

| Shared code | Comes from today | Notes |
|---|---|---|
| OAuth |   `apps/backend/src/users.js` + user parts of `database.js` | OAuth exchange, `user_key`, private/downgrade tiers. Reused essentially as-is (GRN is an OAuth App too, FR-1). **One generalisation:** encryption-at-rest (NFR-3), worth backporting. |
| GitHub client | `packages/core/src/common/retryer.ts`, `http.ts`, `graphql/` + codegen script | PAT rotation, rate-limit/transient retry, typed GraphQL. **Two generalisations:** a *per-user-token* mode (a small extension of the existing `pat` override), and a **separate mutation-safe retry path** — the current retryer rotates tokens and retries freely, which is correct for reads and unsafe for content creation (§6.8). |
| Platform | `common/config.ts`, `log.ts`, `error.ts` | Config, logger, `CustomError`. |
| Database | `apps/backend/src/common/database.js` | Pool + **real migrations** (current code uses ad-hoc `CREATE TABLE IF NOT EXISTS` + 42P01 retry; GRN's schema is too big for that). |
| Web shell | `apps/frontend` Astro/Starlight setup, theme, docs conventions | Docs + settings UI shell. |
| Repo tooling | eslint/prettier/tsconfig.base/turbo/vitest/knip/husky | Copy first, extract later. |

**Not shared:** cards, themes, I18n, WakaTime, rank calculation — all stats-specific.

### 7.3 Convergence path

1. **Phase 0 — mirror.** New repo, same monorepo layout and toolchain (NFR-8).
   Copy the reusable modules verbatim into `packages/`, keeping their public API unchanged
   and **forbidding app-specific imports** in that package (enforced by an eslint
   `import-x/no-restricted-paths` rule + knip). This makes later extraction mechanical.
2. **Phase 1 — diverge deliberately.** Improve the copies where GRN needs more
   (token encryption, migrations, per-user tokens), keeping the changes backport-shaped.
3. **Phase 2 — extract.** Once GRN's requirements are stable, publish the shared package
   from one repo (likely github-stats-extended, which already publishes
   `@stats-organization/github-readme-stats-core` to npm) and consume them in the other.
4. **Phase 3 — graduate into `stats-organization`.** Fold GRN in (as its own repo, or as
   `apps/reactions-*` in the monorepo), keeping **separate deployments**.

#### Organisational path: separate during beta, joined long-term

GRN should end up under `stats-organization` — shared code, shared audience, shared
maintainer overhead, and above all **borrowed trust**: asking strangers for an OAuth token is
far easier under the org that succeeded github-readme-stats than from an unknown account.

But it should **not** start there, and the reason is sharper than "it's immature":

> **Reputational firewall.** github-stats-extended is load-bearing infrastructure — thousands
> of other people's READMEs render from it. GRN deliberately operates near two policy edges
> (AUP bulk-activity exposure from the inbox repo, and the aggregation-privacy question, both
> §6.7). If GitHub ever takes enforcement action against the machine account or the inbox repo,
> that blast radius must not touch the org whose uptime other people depend on.

So: **own product name, own org (or account) for beta, migrate once the risk is retired.**
Repo transfers are cheap and GitHub redirects the old URLs, so this costs little.

**Graduation criteria** — otherwise "later" never arrives:

1. The AUP question is settled: either GitHub has been consulted and is comfortable, or
   delivery has moved to a mechanism that does not carry the risk (escape hatch 3, §6.7).
2. The reactor opt-out (FR-9b) has shipped, closing the privacy gap.
3. Delivery has run at a meaningful volume for several months with no enforcement contact.
4. Phase 2 extraction is done, so the move is a real consolidation rather than a rename.

Two practical notes:

- **The org name is a poor umbrella for a second product.** `stats-organization` says "stats";
  a reactions notifier is not stats. Either accept a slightly odd fit, or plan an org rename
  (GitHub redirects, so the cost is URL churn, not breakage).
- **Machine-account budgeting is a cross-project constraint.** GitHub's Terms §B3 allow one
  person or entity *one* free machine account. github-stats-extended already runs on a pool of
  donated `PAT_n` tokens, so check what identities those belong to before assuming GRN's inbox
  bot can have a free machine account of its own — it may need a paid or separately-owned one.

> Phase 0 is the part to get right now — new repo, reusable modules copied into `packages/`,
> app-specific imports forbidden by lint. Extraction (Phase 2) happens once GRN is stable.

---

## 8. Key risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Stored cursors silently expire or shift**, so a resumed walk skips content | Items never discovered → their reactions never notify | Cursors only within a pass; value watermarks + date windows across passes (§6.3) |
| **Unstable pagination silently skips content** — comment connections sort by `UPDATED_AT` at best, and `user.repositoryDiscussionComments` / `discussion.comments` not at all, so an edit mid-walk shifts the list | Items never discovered, so their reactions never notify | Reach comments via their parent thread, enumerated with `search` + `sort:created` date windows, which *is* stably ordered (C9); drift detection (§6.3) |
| **`user.commitComments`' order is observed, not documented** (C12) — if GitHub changes it, the newest-first walk stops too early | New commit comments found late, by the next full walk | M0 re-check; a page out of `databaseId` order triggers a big warning |
| **`search(type: DISCUSSION)` is the only route to discussion comments** — their connection cannot be ordered at all, so there is no connection-based fallback (C7/C9) | Discussion-comment coverage silently incomplete, with no second path to catch it | Verify `sort:`, `created:` ranges and `commenter:`/`involves:` on `type: DISCUSSION` in M0 before committing; if search proves unreliable, fall back to per-repo `repository.discussions` walks (`CREATED_AT`-ordered) at much higher cost |
| **Search index lags the database** (confirmed, C10) — an item becomes searchable only after a search-driven pass has moved its watermark past it | Items never discovered, so their reactions never notify | Search-driven passes re-scan an overlap margin behind the watermark, sized from the lag measured in M0; an item indexed later still is found only once it changes again (§6.3) |
| **The full-page assumption over-values sparse queries** — scoring treats every query as returning a full page, but a quiet incremental pass returns nothing and a thin backfill window a handful of hits | Discovery and backfill out-rank polling more than intended, so live detection lags | The `1/content_age^P` term is measured, not assumed, so an unproductive source sinks on its own; `w` calibrated in M0 against observed latency (FR-8) |
| **Freshness misjudges a source** — one find resets `content_age` fully, so a moderately active source can be over- or under-polled | Discovery too rare (late notifications) or too frequent (wasted budget) | `D_discovery` floor and `content_age^P` damping bound both errors; `w` and `P` calibrated in M0 |
| **`w` mis-calibrated** — it sets how hard backfill and discovery compete with live polling | Too high starves fresh detection during backfill bursts; too low leaves coverage incomplete for weeks | Calibrate in M0; backfill is finite so errors are self-limiting; observed latency (FR-8) as the alarm |
| **`P` mis-calibrated** — the exponent has no semantic meaning, so a wrong value is not self-evident | Budget skewed toward stale or fresh content; under-provisioning no longer readable from the score | Calibrate in M0 against real reaction-arrival data; rely on observed latency (FR-8) as the alarm |
| **Herd of equally-scored tasks** — items created together share a `last_checked_at` and come due at once | Old work briefly crowds the queue | Harmless by construction: the budget governor caps spend and fresher items outrank the herd, so it drains on leftover capacity (§6.3) |
| **Queue dilution:** a user tracking huge busy repos crowds out their own older content, since all tasks compete purely on freshness | Latency degrades for the notifications the user probably cares about most | Per-type switches (FR-4d), which take a type out of the poll queue, though not out of discovery; observed-latency reporting (FR-8) as the alarm; `value_weight` available if it proves necessary (§6.4) |
| **GRN and the user's own tooling starve each other** on the shared 5 000/h budget | Broken CI or missed reactions | Pace on observed headers + hard `RESERVE`; never assume the budget is ours (§6.4) |
| **Notification volume from busy repos** overwhelms the user | Users disable everything | User-chosen cadences (FR-10), arriving in M2 with the repo sources themselves; per-source thresholds, "top reactions only" mode |
| Polling misses reactions added and removed between polls | Silent data loss | Largely closed: an addition always advances the newest-reaction timestamp, so no removal can mask it (§6.3); holding the watermark back by `CLOCK_MARGIN` at a hot boundary covers same-second ties and late-readable reactions. Only *removals* go undetected, which is deferred (§3) |
| **Clock skew against GitHub** — GRN's `now()` vs GitHub's `createdAt` / `x-ratelimit-reset` | Reactions just after subscribing silenced; a hot-boundary reaction missed; a rate-limit wait ending early | One `CLOCK_MARGIN` (10 s) applied wherever the clocks meet; `Date`-header offset logged and alarmed above 2 s (§6.2) |
| A user with 50 k+ tracked items | Quota/compute pressure | Largely dissolved: at a given item density, polling demand grows only as A^(1−P) = A^0.2 with history length (§6.3); budget cutoff absorbs the rest |
| Token revocation / OAuth scope changes | Silent stop | Revocation detection + FR-17 notification |
| **GitHub-native channel hits the 500 content-creations/hour ceiling** | Every user's messages arrive further apart — **service-wide**, for everyone at once | Self-limiting: one collecting batch per user, served in `run_at` order, so batches grow instead of delivery failing (§6.7, §6.8); token bucket stops short of the limit; delivery wait alarmed; escape hatches ranked and ready |
| **Retry after an ambiguous failure double-posts a digest** | Most visible possible bug in a notification product | Hidden per-message `grn:{uuid}` marker + pre-send existence check (§6.8) |
| **Aggressive retrying gets the integration banned** | Total delivery outage | Strict `retry-after` / `x-ratelimit-reset` compliance (the latter plus `CLOCK_MARGIN`), serial delivery, ≥1 s between mutations — all held in a token bucket the `deliver` claim reads, so a pause binds every worker, not just the one that hit the limit (§6.8) |
| **A `/stop` is lost** (M2) — GitHub does not redeliver a failed webhook delivery | GRN goes on polling and posting for a user who asked it to stop | The route does one short transaction; the user sees GRN carry on, and repeating `/stop` is harmless; M3 sweep redelivers failed deliveries (§6.7) |
| **Inbox repo flagged as automated bulk activity under AUP §4**, or its @mentions as spam | Channel dies for everyone at once | Conservative pacing, with a dispatch rate that is one setting to turn down (§6.8), each inbox issue stating that its user's sign-in asked for it and, from M2, that `/stop` ends it, digests that mention no one else and mark no thread they link (§6.7), Atom fallback kept live |
| **Public inbox aggregates third-party reaction history** | Privacy harm, AUP §3 exposure | **Deliberately deferred**; opt-out list planned (FR-9b); never carries private-repo content |
| **A token carries `repo` though GRN never asks for it** — scopes a user once granted stick to later sign-ins, and anyone can craft an authorize URL with GRN's public `client_id` | Private-repo content posted to the public inbox | Sign-in rejects any token whose granted `scope` is not empty, deletes the grant and restarts the no-scope flow (FR-2a) |
| E-mail deliverability / spam classification | Users don't get notified | Largely sidestepped by §6.7; if e-mail ships: double opt-in, SPF/DKIM/DMARC, list-unsubscribe |
| **Watching repos you don't own reads as surveillance** | Trust/PR problem | Public data only, access re-validated (FR-4c), never expose anything the user can't already see on github.com |
| GitHub adds a reaction webhook later | Rework | Poller sits behind an interface; a webhook source becomes an additional *producer* of `reaction_events` |
| Vercel function time limits vs. long sweeps | Stuck jobs | Small resumable job units + watermark/date-window progress; leases renewed with every commit, and a reaper that frees a dead worker's job within ~16 min (§6.2); workers portable to a container (§6.2) |
| **Fully-configurable sources inflate M1** | Never ships | Sources ship in order (§9), and the columns naming them ship with their adapter (§6.5); UI exposes only shipped ones |

---

## 9. Roadmap

Source *adapters* ship in increasing order of cost and risk, and so does the state that
describes them: M1 stores one implicit `authored` subscription per user, with one category whose
three types are always on, and the columns naming a source — `kind`, `target` — arrive with
the adapters that read them. The same holds for access tiers, filters, the per-type switches
(FR-4d) and per-repository discovery state: each is a purely additive migration (§6.5). The
one staged change that is not additive is M2's outbox, which moves pending notification state
out of `reaction_notifications` and reworks the notifier (§6.5, §6.6). The UI only offers
sources that are implemented.

- **M0 — Spike (1–2 wks).** Prove the two-phase polling query against a real account **and against
  one large repo**; confirm every query shape measures `rateLimit { cost }` <= 2 and pin that
  as a CI assertion (§6.4); assert alongside it that every request sends
  `X-Github-Next-Global-ID: 1`, so no legacy-format node id is ever stored (C13, §6.5);
  measure the latency the budget-driven queue
  achieves. **Record serial-poll wall-clock** — confirm that one in-flight request per token
  still saturates the ramp (§6.4); the concurrency cap stays at its default of 1 unless this
  measurement shows otherwise. Calibrate `D`, `D_discovery`, `P`, `w`, `TARGET`, `RESERVE`
  and `CLOCK_MARGIN` (§6.2–6.4) against real data — `w`, which balances discovery against
  polling, is the one knob with no principled default. **Confirm the `search` rate-limit
    behaviour** for date-windowed backfill, **and that a lifetime-wide
    `involves:USER created:A..B sort:created-desc` search returns without timing out for a heavy
    account** — this decides whether backfill ever needs to split its one window (§6.3), **and verify that `type: DISCUSSION`
  honours `sort:created`/`sort:updated`, `created:` ranges and `commenter:`/`involves:` in
  practice** (C9), including whether `commenter:`/`involves:` match a discussion in which the
  user only posted a threaded reply — discussion-comment coverage has no connection-based
  fallback and rests entirely on that route. **Measure how large the search indexing lag is**
  (C10 confirms it exists), which sizes the overlap margin for search-driven passes (§6.3).
  **Re-check that `user.commitComments` still returns ascending `databaseId` order** (C12).
  **Confirm that `timelineItems(itemTypes: [ISSUE_COMMENT], since:)` filters, and orders, by
  the comment's `createdAt`** — not its `updatedAt` — and measure its cost; thread scans rely
  on it (§6.3).
  **Confirm that `commenter:USER updated:>=A created:<=B sort:created-desc` returns every
  thread where the user commented after `A`**, and that a new comment shows up in its thread's
  indexed `updated_at` within the overlap margin; comment catch-ups rely on it (§6.3).
  **Measure real content-creation throughput** for the machine account against the 80/min
  and 500/hour ceilings, including the issues it opens, inboxes and rollovers, and whether
  opening an issue has a lower ceiling of its own — it sets the dispatch rate (§6.8).
  **Confirm that an inbox issue the machine account opens subscribes
  the @mentioned user to its later comments**, on the web and by e-mail (§6.7). **Confirm
  that a digest notifies no one else and marks none of the threads it links or quotes**, nor
  does a user's e-mail reply quoting it (§6.7).
  *Go/no-go for repo-scoped sources and for the GitHub-native channel.*
- **M1 — MVP.** OAuth App (public tier only, its empty scope enforced at sign-in, FR-2a),
  **`authored` adapter only** (issues, PRs and issue/PR comments) on the minimal schema it needs (§6.5),
  budget-driven priority queue, **GitHub-native
  inbox as the only channel**, opened by GRN at sign-in (§6.7), near-instant batched delivery
  (§6.6), no backfill summary, paced dispatcher (remaining idempotency gap in §6.8), account deletion.
  Single-user alpha. Should M0 rule out the GitHub-native channel, Atom moves up from M2 to
  replace it.
- **M2 — Beta.** `owned_repos` and `repo:` adapters; per-type configuration with a category
  config (FR-4d); discussions and discussion comments as a second category (all sources; existing
  subscriptions get a silent first sync for them, FR-6), remaining cadences, filters, Atom feed, outgoing webhooks, in-app
  inbox, `/`-command control plane with `/stop` and `/start` (FR-3a), private tier
  (FR-2, Atom/webhook only), status page. After discovery phase,
  post a summary of all reactions the user ever got.
- **M3 — Hardening.** Quota governor tuning, DLQ, observability, a sweep redelivering failed
  webhook deliveries (§6.7), **reactor opt-out list (FR-9b)**, public launch.
- **M4 — Convergence.** Phase 2 package extraction (§7.3), shared polling of public content (§6.5).
  Optional GitHub-App-for-delivery and e-mail only if demand or the quota ceiling forces it.

---

## 10. Key decisions

1. **Package boundary.** New repo; copy reusable modules into `packages/` with a lint rule
   forbidding app-specific imports; extract properly later (§7.3 Phase 0 → Phase 2).
2. **Primary channel.** GitHub-native delivery via issue comments in a shared public inbox
   repo, posted by a machine account (§6.7) — mandatory, and the only channel in M1 — with
   Atom as the zero-friction fallback from M2 and e-mail deferred. The machine account also
   opens each user's inbox issue at sign-in, @mentioning them, so joining takes no step beyond
   OAuth and no write scope (§6.7). From M2, leaving takes one reply, `/stop`, which — unlike
   unwatching — GRN can see: it stops all activity for the account and closes the issue,
   discarding nothing, and `/start` resumes it (FR-3a). The throughput ceiling is absorbed by
   batching — under load, each user's messages arrive further apart (§6.7) — with ranked
   escape hatches behind it; public-aggregation privacy is **knowingly deferred**, with FR-9b
   as the mitigation.
3. **Hosting.** Vercel on the **Pro plan**, scheduled with Vercel Cron (once-per-minute) and
   300–800 s functions. Work is sliced — each user's one `sync` job is released after every
   slice and stays due while their budget has room — so no invocation depends on finishing a
   user's queue; jobs are leased, so the cron's reaper frees a killed invocation's job within
   ~16 min (§6.2).
4. **Scope of "their content".** Fully configurable subscription sources — `authored`,
   `owned_repos`, and named `repo:` watches — as the long-term shape, with the adapters *and*
   the columns naming them shipped in stages (§3, §9, §6.5). M1 stores one implicit
   `authored` source per user.
5. **Token reuse: none.** Strictly **separate tokens and separate OAuth apps**. Consent must
   be per-purpose: authorising a card renderer is not authorising a service that walks your
   whole comment history and posts publicly on your behalf. Separate tokens also give
   independent revocation, independent scopes (GRN will want `repo` later, FR-2; the card
   renderer should not), a smaller blast radius on leak, and a clean FR-3 deletion that cannot
   break the other service. Note that sharing a token would *not* save rate limit, because
   GitHub pools the 5 000/h across every app acting on the user's behalf regardless (§6.4) —
   the two services compete for that budget either way, and GRN's `RESERVE` must account for it.
6. **Naming / branding.** Distinct product name; separate org/account for beta as a
   reputational firewall; migrate into `stats-organization` once the graduation criteria in
   §7.3 are met.
7. **Polling concurrency: none.** One in-flight GitHub request **per token**, following
   GitHub's documented "avoid concurrent requests" guidance. This is not a throughput
   concession — the hourly budget ramp (§6.4) permits a lower request rate than a single
   serial worker already sustains, so concurrency could only overshoot the ramp between
   header reads, blur the `RESERVE` guard that NFR-2 depends on, and leave requests on the
   wire after a `403`. Scaling comes from processing many users in parallel, each against
   their own independent bucket. Reviewed in M0 (§9); default stays 1.
8. **Content-type configuration: discover per category, track per type.** Users configure each
   content type separately — a switch and FR-11's filters — and a category config controls a
   category's types together (FR-4d). The category, not the type, is the unit of discovery: the
   types one query returns share one window set and one set of incremental passes, sent as one
   query, and every type the query returns is kept whatever the switches say. The switches
   only park and un-park `tracked_content` rows, so switching a type is a database update with
   no GitHub query, and per-type window sets — with logic to merge them — never arise. The
   cost: discovery cannot narrow its queries when a type is off, and GRN keeps metadata and
   parked rows for types that are off (§6.3, §6.5).

## 11. Open Points

* Backfill has to read every comment of every discussion found. Nesting `replies(first: 100)` under `comments(first: 100)` costs ≈ 101 points even without probes, and `Discussion` has no `timelineItems` and no date filter, so a long discussion cannot be resumed like an issue thread scan without a stored cursor. Decide how discussion comments and replies are paged and resumed.
* Backfill will eventually crowd out polling. A window's score grows with wait and is never reset, because windows are only deleted. Poll tasks reset on every check. So every remaining window ends up above the cutoff: a 10-year-old window crosses it after about 3.7 days. The claim that backfill is "≈1.7×, not enough to monopolise" only holds early on.
* The shared watermark_at can lose reactions when several sources track one item (M2). tracked_content is per user, but enabled_at is per source and type.
  * Case 1: source B was enabled later but finds the item first. The watermark becomes B's enabled_at, so reactions after source A's earlier enabled_at are never fetched. The replay can't recover them because they were never recorded.
  * Case 2: switching a type on "sets watermark_at = enabled_at". If that also touches rows another source is actively polling, unpolled reactions are skipped.
  * Fix: only parked rows should be touched, and the watermark should be the minimum across sources.
* The livelock guard can't hand the issue-comment pass to backfill. That pass is ordered by UPDATED_AT, and the backfill windows are by thread creation date, so they can't take over a burst of comments on old threads. Proposed fix, confirm in review: the comment catch-up (§6.3 "Comment catch-ups").
* Each polling worker computes scores for all rows of its user about once per second. This causes high DB load. Instead let the worker fetch the top N rows by score and then work through them in the current slice.
* Possible lock-order deadlocks. Replay takes FOR UPDATE and fan-out takes FOR SHARE on many content rows across different users' transactions. No ordering rule (e.g. by node_id) is specified.
* Display metadata in content goes stale after edits and renames. Every upsert into content is ON CONFLICT DO NOTHING, so the first write wins. A later re-read discards the current title, repo_full_name, url and author_login it brings: the issue-comment pass re-reads edited comments (ordered by UPDATED_AT), and backfill re-reads boundary hits. Nothing else refreshes them, because the probe and drill-down fetch only reactions. Digests therefore show old titles, old repo names and old logins, and link to the old URL. That URL depends on GitHub's rename redirect. If an old repo name or login is later reused, the link opens unrelated content or a stranger's profile. This weakens §6.7's aim of not pointing at other people's threads. The schema notes (§6.5 content) accept the staleness of repo_full_name, url and author_login but not the stale title. They also do not cover a reused old name, or that fresh values are fetched and then thrown away.
* The global lease index is too broad. UNIQUE … WHERE kind <> 'sync' would also globally serialise M2 command jobs and M4 shared polling behind the dispatcher. It should be kind = 'deliver'.