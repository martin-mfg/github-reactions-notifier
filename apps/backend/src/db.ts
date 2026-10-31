interface QueryResult<R> {
  rows: Array<R>;
  rowCount: number | null;
}

/** Anything that runs a query: a pool, or a client inside a transaction. */
export interface Queryable {
  query<R extends object = Record<string, unknown>>(
    text: string,
    values?: Array<unknown>,
  ): Promise<QueryResult<R>>;
}

interface Client extends Queryable {
  release(error?: Error | boolean): void;
}

/** A connection pool, such as `pg`'s `Pool`. */
export interface Database extends Queryable {
  connect(): Promise<Client>;
}

/**
 * Runs `fn` in a transaction on a dedicated connection: commits if it resolves, rolls back
 * if it throws.
 *
 * @param db The pool to take a connection from.
 * @param fn Work to run inside the transaction.
 * @returns Whatever `fn` returns.
 */
export const withTransaction = async <T>(
  db: Database,
  fn: (client: Queryable) => Promise<T>,
): Promise<T> => {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    client.release();
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (rollbackError) {
      // A connection that can't roll back is broken: destroy it instead of reusing it.
      client.release(rollbackError instanceof Error ? rollbackError : true);
    }
    throw error;
  }
};
