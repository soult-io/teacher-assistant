// sync-relay (M2) entrypoint. Selects the store from configuration (config.ts),
// and binds 0.0.0.0 so the Lexington NPM can reach it by container name;
// host/public exposure is controlled at the compose + NPM layer (loopback bind +
// reverse proxy, posture B), never in the app. The server only ever holds
// ciphertext.
//
// With DB_HOST set the relay connects to Postgres, applies migrations, and only
// then opens the port. If the database is configured but unreachable, startup
// fails and the process exits non-zero (fail closed): it never falls back to
// the in-memory store.

import { readFileSync } from "node:fs";
import pg from "pg";
import { buildApp } from "./app.js";
import { listeningMessage } from "./logging.js";
import { loadStoreConfig, loadTrustProxy, type StoreConfig } from "./config.js";
import { migrate } from "./migrations.js";
import { PostgresRelayStore } from "./postgres-store.js";
import { sodiumReady } from "./sodium-verify.js";
import { errorCode, poolClient } from "./sql.js";
import { InMemoryRelayStore, type RelayStore } from "./store.js";

const PORT = Number(process.env.SYNC_RELAY_PORT ?? process.env.PORT ?? 8931);

/**
 * Name, code and message of a startup error. Startup runs before any request, so
 * no student payload can be in it; pg never puts the password in a message.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) {
    return "unknown error";
  }
  const code = errorCode(err);
  return `${err.name}${code === undefined ? "" : ` (${code})`}: ${err.message}`;
}

async function openStore(): Promise<{
  store: RelayStore;
  kind: StoreConfig["kind"];
  close: () => Promise<void>;
}> {
  const config = loadStoreConfig(process.env, (path) => readFileSync(path, "utf8"));
  if (config.kind === "memory") {
    return { store: new InMemoryRelayStore(), kind: "memory", close: async () => {} };
  }
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 10,
    connectionTimeoutMillis: 5_000,
    // A hung database fails the request (503) instead of holding it; the server
    // also cancels the statement, so a timed-out write is less likely to land late.
    query_timeout: 10_000,
    statement_timeout: 10_000,
  });
  // An idle client's connection dropping must not crash the process; the next
  // query reconnects or fails its request (503). Log the code only.
  pool.on("error", (err) => {
    console.error(`sync-relay: idle database connection error (${errorCode(err) ?? err.name})`);
  });
  try {
    const sql = poolClient(pool);
    await migrate(sql); // first query: proves the database is reachable
    return { store: new PostgresRelayStore(sql), kind: "postgres", close: () => pool.end() };
  } catch (err) {
    await pool.end().catch(() => {});
    throw err;
  }
}

async function main(): Promise<void> {
  // TRUST_PROXY first: a production relay without it exits 1 before touching the database.
  const trustProxy = loadTrustProxy(process.env);
  await sodiumReady();
  const { store, kind, close } = await openStore();
  // Expired pairing sessions and owner codes go before the port opens (spec §5.1).
  await store.sweepExpired();
  const app = buildApp(store, trustProxy === undefined ? {} : { trustProxy });
  app.addHook("onClose", close);
  const addr = await app.listen({ host: "0.0.0.0", port: PORT });
  app.log.info(listeningMessage(addr, kind));
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

main().catch((err: unknown) => {
  // Identity-clean: the relay never sees student payload.
  console.error(`sync-relay failed to start: ${describeError(err)}`);
  process.exit(1);
});
