// The slice of a Postgres client the relay needs. `pg.Pool` is adapted by
// poolClient(); PGlite (in-process Postgres, used by tests) satisfies it as is.

import type pg from "pg";

export interface SqlClient {
  query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  /** Run a parameterless multi-statement script as one implicit transaction. */
  exec(script: string): Promise<unknown>;
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
  };
}
