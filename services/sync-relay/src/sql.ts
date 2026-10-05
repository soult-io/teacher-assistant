// The slice of a Postgres client the relay needs. `pg.Pool` is adapted by
// poolClient(); PGlite (in-process Postgres, used by tests) satisfies it as is.

import type pg from "pg";

export interface SqlQuery {
  query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface SqlClient extends SqlQuery {
  /** Run a parameterless multi-statement script as one implicit transaction. */
  exec(script: string): Promise<unknown>;
  /** Run `fn` in one transaction on one connection: commit on return, roll back on throw. */
  transaction<T>(fn: (tx: SqlQuery) => Promise<T>): Promise<T>;
}

/** The string `code` of an error (a pg SQLSTATE or a Node errno like ECONNREFUSED). */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function poolClient(pool: pg.Pool): SqlClient {
  return {
    query: async <R>(text: string, params?: unknown[]) => {
      const res = await pool.query(text, params);
      return { rows: res.rows as R[] };
    },
    exec: (script) => pool.query(script),
    transaction: async <T>(fn: (tx: SqlQuery) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query("BEGIN");
        const result = await fn({
          query: async <R>(text: string, params?: unknown[]) => {
            const res = await client.query(text, params);
            return { rows: res.rows as R[] };
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (err) {
        // A connection that cannot even roll back is discarded, not pooled.
        await client.query("ROLLBACK").catch(() => {
          broken = true;
        });
        throw err;
      } finally {
        client.release(broken);
      }
    },
  };
}
