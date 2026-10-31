# GitHub Reactions Notifier

Notifies you about reactions to your GitHub issues, pull requests and comments.

The requirements live in [reactions-notifier-m1-requirements.md](reactions-notifier-m1-requirements.md).

## Layout

| Path            | Contents                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/backend`  | Express server (`express.ts`) serving the handlers under `api/` and the built frontend. GRN's own logic: `src/`.   |
| `apps/frontend` | Static Astro site (React + Starlight docs).                                                                        |
| `packages/core` | Code adapted from [github-stats-extended](https://github.com/stats-organization/github-stats-extended), see below. |

`apps/backend/src` holds GRN-specific code:

| Path                       | Contents                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `config.ts`                | Tunables from requirements §14, with their defaults.                                                                                                         |
| `db.ts`                    | The minimal database interface GRN's code runs on (`pg`'s `Pool` satisfies it); transactions.                                                                |
| `jobs/queue.ts`            | The Postgres job queue: due rules, claim, lease renewal and fencing, release, and the reaper.                                                                |
| `oauth.ts`                 | The OAuth flows behind `/api/login`, `/api/delete-account` and `/api/oauth/callback`: sign-in, the no-scope check (FR-2a), and deletion.                     |
| `users/accounts.ts`        | The signup and returning-user sign-in transaction, reading a stored token, and account deletion (FR-3).                                                      |
| `github/budget.ts`         | The rate-limit guard (§8) and storing each response's rate-limit headers.                                                                                    |
| `github/syncClient.ts`     | Sends a `sync` job's queries with the user's token (guard, timeout, cost alarm, §12's unexpected responses) and settles its failures, incl. a `401` (FR-17). |
| `github/writes.ts`         | Sends the machine account's writes on the mutation-safe path and classifies them by §12's table.                                                             |
| `discovery/store.ts`       | Upserts discovered items into `content`, `content_sources` and `tracked_content`.                                                                            |
| `discovery/incremental.ts` | The `authored` source's incremental discovery (§9.2): its three passes in one query, the watermark rules, and the overflow check.                            |
| `inbox/opening.ts`         | Renders the issue that opens a user's inbox.                                                                                                                 |
| `inbox/notices.ts`         | Renders one-off notices, such as FR-17's.                                                                                                                    |

`@grn/core` is meant to be shared with github-stats-extended later, so its files keep the source repo's layout:

| Path             | Contents                                                                                                                                                                                            |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/common`     | Config, logging, errors, the GitHub GraphQL retryer (PAT rotation, or one user's token) and HTTP helpers, the mutation-safe request path, response classification, Postgres pool, token encryption. |
| `src/graphql`    | Typed GraphQL documents and their generated types.                                                                                                                                                  |
| `src/users.ts`   | GitHub OAuth code exchange and grant deletion.                                                                                                                                                      |
| `sql/schema.sql` | The database schema.                                                                                                                                                                                |

Code in `packages/` must never import from `apps/`.

## Setup

Requires Node 24 and pnpm (see `packageManager` in `package.json`).

```sh
pnpm install
cp apps/backend/.env.example apps/backend/.env   # then fill it in
```

### Database

The schema is applied by hand, not by the app. Run it against an empty database:

```sh
psql "$POSTGRES_URL" -v ON_ERROR_STOP=1 -f packages/core/sql/schema.sql
```

Tests need no database server: they apply `schema.sql` to an in-process Postgres ([PGlite](https://pglite.dev)).

### Environment variables (backend)

| Variable               | Purpose                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_URL`         | Postgres connection string.                                                                                                                                                             |
| `OAUTH_CLIENT_ID`      | GRN's own GitHub OAuth App.                                                                                                                                                             |
| `OAUTH_CLIENT_SECRET`  | Its client secret.                                                                                                                                                                      |
| `OAUTH_REDIRECT_URI`   | Its callback URL: `<site>/api/oauth/callback`.                                                                                                                                          |
| `TOKEN_ENCRYPTION_KEY` | Encrypts stored user tokens (AES-256-GCM): 32 bytes as hex or base64. Comma-separate several keys to rotate; the first encrypts, all decrypt. Generate one with `openssl rand -hex 32`. |
| `PAT_1`, `PAT_2`, ...  | Personal access tokens for the GitHub client.                                                                                                                                           |
| `PORT`                 | Port to listen on: 80 in Docker, else 9000.                                                                                                                                             |

## Commands

| Command             | Does                                                  |
| ------------------- | ----------------------------------------------------- |
| `pnpm dev:backend`  | Serves the API (and the built frontend) on port 9000. |
| `pnpm dev:frontend` | Astro dev server; proxies `/api` to the backend.      |
| `pnpm test`         | Runs all tests.                                       |
| `pnpm lint`         | ESLint in every workspace.                            |
| `pnpm lint:knip`    | Unused files, exports and dependencies.               |
| `pnpm typecheck`    | TypeScript in every workspace.                        |
| `pnpm format`       | Prettier.                                             |

After editing a `.graphql` file under `packages/core/src/graphql/queries`, regenerate its types:

```sh
pnpm --filter ./packages/core run generate-graphql-types
```

## Deployment

The app is deployed as a Docker image, which Vercel runs from `Dockerfile.vercel`: one container runs the backend, which also serves the built frontend.
Every release publishes a multi-platform image (amd64/arm64) to the GitHub Container Registry (`.github/workflows/release.yml`).

```sh
docker run -d -p 9000:80 --env-file apps/backend/.env ghcr.io/martin-mfg/github-reactions-notifier:latest
```

The instance is then available at `http://localhost:9000`. To build the image yourself, run `docker build -f Dockerfile.vercel .` from the repository root.
