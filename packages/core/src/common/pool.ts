import type { Pool } from "pg";

/** Shared connection pool, or `null` when `POSTGRES_URL` is not configured. */
export let pool: Pool | null = null;
if (process.env["POSTGRES_URL"]) {
  const { Pool } = await import("pg");
  pool = new Pool({
    connectionString: process.env["POSTGRES_URL"],
  });
}
