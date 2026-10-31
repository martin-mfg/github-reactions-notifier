import { readFile } from "node:fs/promises";

import { PGlite } from "@electric-sql/pglite";

import type { Database, Queryable } from "../src/db.ts";

const schemaUrl = new URL(
  "../../../packages/core/sql/schema.sql",
  import.meta.url,
);

export interface TestDatabase {
  db: Database;
  /** Empties every table and resets the dispatch bucket to the schema's initial row. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * An in-process Postgres (PGlite) with GRN's schema applied. It has a single connection, so
 * `connect()` hands out that one connection to one holder at a time.
 *
 * @returns The database and its housekeeping.
 */
export const createTestDatabase = async (): Promise<TestDatabase> => {
  const pg = new PGlite();
  await pg.exec(await readFile(schemaUrl, "utf8"));

  // PGlite's rows are untyped; the cast gives them the caller's row type, as `pg` does.
  const query = (async (text: string, values?: Array<unknown>) => {
    const result = await pg.query(text, values);
    return {
      rows: result.rows,
      rowCount: Math.max(result.affectedRows ?? 0, result.rows.length),
    };
  }) as Queryable["query"];

  // One connection: `connect()` waits until the previous holder releases it, so concurrent
  // transactions run one after the other instead of interleaving on the shared session.
  let released: Promise<void> = Promise.resolve();
  const connect = async () => {
    const previous = released;
    let release!: () => void;
    released = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    return {
      query,
      release: () => {
        release();
      },
    };
  };

  return {
    db: { query, connect },
    reset: async () => {
      await pg.exec(`
        TRUNCATE users, content, dispatch_bucket CASCADE;
        INSERT INTO dispatch_bucket (level, level_at) VALUES (1, now() - interval '1 hour');
      `);
    },
    close: () => pg.close(),
  };
};
