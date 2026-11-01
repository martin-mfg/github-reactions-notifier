import type { Pool } from "pg";

import { logger } from "./log.js";

/** Shared connection pool, or `null` when `POSTGRES_URL` is not configured. */
export let pool: Pool | null = null;
if (process.env["POSTGRES_URL"]) {
  const { Pool } = await import("pg");
  pool = new Pool({
    connectionString: process.env["POSTGRES_URL"],
  });
  pool.on("error", (error) => {
    // pg removes the failed idle client; subsequent checkouts can reconnect.
    logger.error("database pool: idle client disconnected", { error });
  });
}

/**
 * Runs a bounded health probe outside the shared pool, closing its connection even on timeout.
 *
 * @param connectionString Database URL.
 * @param timeoutMs Total time allowed for connection acquisition and the query.
 */
export const checkDatabaseConnection = async (
  connectionString: string,
  timeoutMs: number,
): Promise<void> => {
  const { Client } = await import("pg");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
  });
  client.on("error", (error) => {
    logger.warn("health check: database connection error", { error });
  });
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        await client.connect();
        await client.query("SELECT 1");
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error("health check: database timeout"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    await client.end();
  }
};
