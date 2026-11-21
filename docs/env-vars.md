### Environment variables (backend)

| Variable                | Purpose                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_URL`          | Postgres connection string.                                                                                                                                                             |
| `OAUTH_CLIENT_ID`       | GRN's own GitHub OAuth App.                                                                                                                                                             |
| `OAUTH_CLIENT_SECRET`   | Its client secret.                                                                                                                                                                      |
| `OAUTH_REDIRECT_URI`    | Its callback URL: `<site>/api/oauth/callback`.                                                                                                                                          |
| `TOKEN_ENCRYPTION_KEY`  | Encrypts stored user tokens (AES-256-GCM): 32 bytes as hex or base64. Comma-separate several keys to rotate; the first encrypts, all decrypt. Generate one with `openssl rand -hex 32`. |
| `MACHINE_ACCOUNT_TOKEN` | Token of the machine account that opens the inboxes and posts every comment (§11). It needs write access to issues in `INBOX_REPO`.                                                     |
| `INBOX_REPO`            | The repo holding the inbox issues, as `owner/repo`.                                                                                                                                     |
| `PORT`                  | Port to listen on: 8080 in Docker, else 9000.                                                                                                                                           |
