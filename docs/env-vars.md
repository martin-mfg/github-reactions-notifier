### Environment variables (backend)

| Variable                | Purpose                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_URL`          | Postgres connection string.                                                                                                                                                             |
| `OAUTH_CLIENT_ID`       | GRN's own GitHub OAuth App.                                                                                                                                                             |
| `OAUTH_CLIENT_SECRET`   | Its client secret.                                                                                                                                                                      |
| `OAUTH_REDIRECT_URI`    | Its callback URL: `<site>/api/oauth/callback`.                                                                                                                                          |
| `TOKEN_ENCRYPTION_KEY`  | Encrypts stored user tokens (AES-256-GCM): 32 bytes as hex or base64. Comma-separate several keys to rotate; the first encrypts, all decrypt. Generate one with `openssl rand -hex 32`. |
| `PAT_1`, `PAT_2`, ...   | Personal access tokens for the GitHub client.                                                                                                                                           |
| `MACHINE_ACCOUNT_TOKEN` | Token of the machine account that opens the inboxes and posts every comment (§11). It needs write access to issues in `INBOX_REPO`.                                                     |
| `INBOX_REPO`            | The repo holding the inbox issues, as `owner/repo`.                                                                                                                                     |
| `CRON_SECRET`           | Authorizes calls to `/api/cron`, sent as `Authorization: Bearer <secret>`. Without it, every call is refused. Vercel Cron sends it automatically.                                       |
| `PORT`                  | Port to listen on: 80 in Docker, else 9000.                                                                                                                                             |
