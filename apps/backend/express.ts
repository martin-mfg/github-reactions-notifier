import { app } from "./app.ts";

const port = process.env["PORT"] ?? 9000;
const server = app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const shutdown = (signal: string): void => {
  console.log(`${signal} received. Shutting down gracefully.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 20_000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
