-- GRN database schema.
--
-- Creates everything GRN needs in an empty database. It is applied by hand, e.g.:
--
--   psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 -f packages/core/sql/schema.sql
--
-- The M1 data model is described in reactions-notifier-m1-requirements.md §13. All ids are
-- GraphQL global node ids in the new format, unless stated otherwise. All timestamps come from
-- Postgres now(), unless they are GitHub values.

BEGIN;

CREATE TABLE users (
  gh_user_id    text PRIMARY KEY,  -- the FK target of every per-user table, and NFR-3's AAD
  login         text NOT NULL,     -- mutable; refreshed from viewer { id login }
  gh_created_at timestamptz NOT NULL,
  token_enc     text NOT NULL,     -- gse.v1.<iv>.<auth tag>.<ciphertext> (NFR-3)
  token_status  text NOT NULL DEFAULT 'active'
                CHECK (token_status IN ('active', 'revoked', 'invalid'))
);

-- Exactly one per user in M1: the implicit `authored` source.
CREATE TABLE subscriptions (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES users ON DELETE CASCADE
);
CREATE INDEX subscriptions_user_id ON subscriptions (user_id);

-- category = 'issue' only in M1. discovery_started_at never moves.
CREATE TABLE subscription_categories (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id      bigint NOT NULL REFERENCES subscriptions ON DELETE CASCADE,
  category             text NOT NULL,
  discovery_started_at timestamptz NOT NULL,
  last_checked_at      timestamptz NOT NULL,
  last_find_at         timestamptz NOT NULL,
  UNIQUE (subscription_id, category)
);

-- content_type ∈ {'Issue', 'PullRequest', 'IssueComment'} (GraphQL __typename, as content.type).
-- enabled_at = now − CLOCK_MARGIN. M1 never writes a null; from M2, null means "type is off".
CREATE TABLE subscription_types (
  category_id  bigint NOT NULL REFERENCES subscription_categories ON DELETE CASCADE,
  content_type text NOT NULL,
  enabled_at   timestamptz,
  PRIMARY KEY (category_id, content_type)
);

-- pass ∈ {'Issue', 'PullRequest', 'IssueComment'} in M1. watermark is the pass's sort key value.
CREATE TABLE subscription_passes (
  category_id bigint NOT NULL REFERENCES subscription_categories ON DELETE CASCADE,
  pass        text NOT NULL,
  watermark   timestamptz NOT NULL,
  PRIMARY KEY (category_id, pass)
);

-- A row is a date range still to walk, newest-first: window_end moves back, window_start stays.
CREATE TABLE backfill_windows (
  category_id       bigint NOT NULL REFERENCES subscription_categories ON DELETE CASCADE,
  window_start      timestamptz NOT NULL,
  window_end        timestamptz NOT NULL,
  window_created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id, window_start)
);

-- A row is a thread whose comments didn't fit the inline page. Inserted ON CONFLICT DO NOTHING.
CREATE TABLE thread_scans (
  category_id       bigint NOT NULL REFERENCES subscription_categories ON DELETE CASCADE,
  thread_node_id    text NOT NULL,
  since_at          timestamptz NOT NULL,
  thread_created_at timestamptz NOT NULL,
  scan_created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category_id, thread_node_id)
);

-- kind = 'github_issue'; target = "owner/repo#number", or NULL until the inbox is opened.
CREATE TABLE notification_channels (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users ON DELETE CASCADE,
  kind        text NOT NULL,
  target      text,
  disabled_at timestamptz
);
CREATE UNIQUE INDEX notification_channels_one_github_issue
  ON notification_channels (user_id) WHERE kind = 'github_issue' AND disabled_at IS NULL;

-- Global. type ∈ {'Issue', 'PullRequest', 'IssueComment'} (GraphQL __typename).
-- author_id and author_login are null for a deleted ("ghost") author.
CREATE TABLE content (
  node_id        text PRIMARY KEY,
  type           text NOT NULL,
  repo_full_name text NOT NULL,
  url            text NOT NULL,
  title          text NOT NULL,
  author_id      text,
  author_login   text
);

-- Per user. watermark_at starts at the type's enabled_at, which is the whole of FR-6.
CREATE TABLE tracked_content (
  user_id         text NOT NULL REFERENCES users ON DELETE CASCADE,
  node_id         text NOT NULL REFERENCES content,
  last_checked_at timestamptz NOT NULL DEFAULT now(),
  last_event_at   timestamptz NOT NULL,
  watermark_at    timestamptz NOT NULL,
  PRIMARY KEY (user_id, node_id)
);
CREATE INDEX tracked_content_due
  ON tracked_content (user_id, last_checked_at) INCLUDE (last_event_at);

-- The graphql bucket only, overwritten from the headers of every response.
CREATE TABLE rate_limit_state (
  user_id  text PRIMARY KEY REFERENCES users ON DELETE CASCADE,
  limit_   integer NOT NULL,
  used     integer NOT NULL,
  reset_at timestamptz NOT NULL
);

-- A set: which sources matched an item.
CREATE TABLE content_sources (
  user_id         text NOT NULL REFERENCES users ON DELETE CASCADE,
  node_id         text NOT NULL REFERENCES content,
  subscription_id bigint NOT NULL REFERENCES subscriptions ON DELETE CASCADE,
  PRIMARY KEY (user_id, node_id, subscription_id)
);

-- Global observed facts. reactor_login is display data as of detection.
CREATE TABLE reaction_events (
  node_id       text NOT NULL REFERENCES content,
  reactor_id    text NOT NULL,
  emoji         text NOT NULL,
  reacted_at    timestamptz NOT NULL,
  reactor_login text NOT NULL,
  PRIMARY KEY (node_id, reactor_id, emoji)
);

-- Per user: "has this user been told?" (FR-7). Delivered rows are kept.
CREATE TABLE reaction_notifications (
  user_id    text NOT NULL REFERENCES users ON DELETE CASCADE,
  node_id    text NOT NULL,
  reactor_id text NOT NULL,
  emoji      text NOT NULL,
  outcome    text NOT NULL DEFAULT 'queued' CHECK (outcome IN ('queued', 'delivered')),
  PRIMARY KEY (user_id, node_id, reactor_id, emoji),
  FOREIGN KEY (node_id, reactor_id, emoji) REFERENCES reaction_events
);

-- The work queue. kind ∈ {'sync', 'deliver'} in M1.
-- payload: NULL for 'sync'. For 'deliver': a digest {"digest": true, "state": "open" | "rendered",
--   "body": …}, a one-off {"body": …}, or an inbox opening {"title": …, "body": …}.
-- locked_by is a fresh uuid per claim (the fencing token); locked_at is the last renewal;
-- attempts counts claims.
CREATE TABLE jobs (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind      text NOT NULL,
  user_id   text NOT NULL REFERENCES users ON DELETE CASCADE,
  payload   jsonb,
  run_at    timestamptz NOT NULL DEFAULT now(),
  locked_by uuid,
  locked_at timestamptz,
  attempts  integer NOT NULL DEFAULT 0
);
CREATE INDEX jobs_user_id ON jobs (user_id);
CREATE INDEX jobs_due ON jobs (kind, run_at) WHERE locked_by IS NULL;
-- One sync job per user: one in-flight request per user token.
CREATE UNIQUE INDEX jobs_one_sync_per_user ON jobs (user_id) WHERE kind = 'sync';
-- One leased deliver job at a time: whichever worker holds it is the dispatcher.
CREATE UNIQUE INDEX jobs_one_deliver_lease
  ON jobs ((true)) WHERE kind = 'deliver' AND locked_by IS NOT NULL;
-- One digest per user, open or rendered.
CREATE UNIQUE INDEX jobs_one_digest_per_user
  ON jobs (user_id) WHERE kind = 'deliver' AND payload->>'digest' = 'true';

-- The machine account's token bucket: exactly one row. It holds
-- least(capacity, level + rate × (now − level_at)); a pause sets level_at in the future.
CREATE TABLE dispatch_bucket (
  level    double precision NOT NULL,
  level_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX dispatch_bucket_one_row ON dispatch_bucket ((true));
INSERT INTO dispatch_bucket (level, level_at) VALUES (1, now());

COMMIT;
