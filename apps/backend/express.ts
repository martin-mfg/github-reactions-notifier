import { app } from "./app.ts";
import { defaultConfig } from "./src/config.ts";
import { startSchedulerFromEnv } from "./src/cron.ts";

const port = process.env["PORT"] ?? 9000;
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
const scheduler = startSchedulerFromEnv();

// Workers finish their current job first. If that takes longer than this, the job's lease
// expires and a later cron run releases it. fly.toml's `kill_timeout` must exceed this.
const shutdownTimeoutMs = (defaultConfig.requestTimeoutSeconds + 30) * 1000;

const shutdown = (signal: string): void => {
  console.log(`${signal} received. Shutting down gracefully.`);
  setTimeout(() => process.exit(1), shutdownTimeoutMs).unref();
  void Promise.all([
    new Promise((resolve) => server.close(resolve)),
    scheduler?.stop(),
  ]).then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
