// Operator CLI — the admin plane (device-enrollment spec DN-3, §5.7, H-OFF).
//
//   docker exec -it <relay container> node dist/admin.js issue-owner-code
//
// Prints a one-time owner code to ITS OWN terminal and stores only the code's
// SHA-256 (expiry 24 h). It is never an HTTP route, and it must never run as a
// compose one-shot service or a container command: that process's stdout IS the
// container log, so the code would land in `docker logs` and any log shipper.
// So it refuses unless stdout is a TTY AND is not the stdout of the container's
// PID 1 (a one-shot service with `tty: true` passes the first check, not the
// second). It never uses the app logger, and on any failure it prints only an
// error class or SQLSTATE — never err.message or err.detail (a duplicate insert's
// detail contains the hash).

import { fstatSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadStoreConfig } from "./config.js";
import { formatOwnerCode, newOwnerCode, OWNER_CODE_TTL_MS, ownerCodeHash } from "./owner-code.js";
import { PostgresRelayStore } from "./postgres-store.js";
import { errorCode, poolClient } from "./sql.js";
import type { RelayStore } from "./store.js";

export const ISSUE_OWNER_CODE = "issue-owner-code";

interface AdminStore {
  readonly store: Pick<RelayStore, "issueOwnerCode">;
  close(): Promise<void>;
}

/** Everything the CLI touches, injected so tests run it in-process. */
export interface AdminIo {
  readonly argv: readonly string[];
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  /** stdout is a terminal. */
  readonly isTTY: boolean;
  /** stdout is the container's own log (PID 1's stdout): the one-shot-service case. */
  readonly stdoutIsContainerLog: boolean;
  readonly openStore: () => Promise<AdminStore>;
  readonly now?: () => Date;
  readonly newCode?: () => string;
}

const USAGE = `usage: node dist/admin.js ${ISSUE_OWNER_CODE}\n`;
const NOT_EXEC = `${ISSUE_OWNER_CODE}: refused. Run it only by exec into the running relay, on a terminal:\n  docker exec -it <relay container> node dist/admin.js ${ISSUE_OWNER_CODE}\n(stdout must be a TTY and must not be the container log)\n`;

/** An error reduced to a SQLSTATE or its class name; never its message or detail. */
function describeFailure(err: unknown): string {
  const code = errorCode(err);
  // A SQLSTATE class never starts with E; Node errnos (EPERM, EPIPE) do.
  if (code !== undefined && /^[0-9A-DF-Z][0-9A-Z]{4}$/.test(code)) {
    return `SQLSTATE ${code}`;
  }
  return err instanceof Error ? err.name : "unknown error";
}

/** Run the CLI; returns the process exit code. */
export async function runAdmin(io: AdminIo): Promise<number> {
  if (io.argv.length !== 1 || io.argv[0] !== ISSUE_OWNER_CODE) {
    io.stderr.write(USAGE);
    return 64;
  }
  if (!io.isTTY || io.stdoutIsContainerLog) {
    io.stderr.write(NOT_EXEC);
    return 2;
  }
  const code = (io.newCode ?? newOwnerCode)();
  const hash = ownerCodeHash(code);
  if (hash === undefined) {
    io.stderr.write(`${ISSUE_OWNER_CODE} failed (malformed code)\n`);
    return 1;
  }
  const expiresAt = new Date((io.now ?? (() => new Date()))().getTime() + OWNER_CODE_TTL_MS);
  let opened: AdminStore | undefined;
  try {
    opened = await io.openStore();
    await opened.store.issueOwnerCode(hash, expiresAt);
  } catch (err) {
    io.stderr.write(`${ISSUE_OWNER_CODE} failed (${describeFailure(err)})\n`);
    return 1;
  } finally {
    await opened?.close().catch(() => {});
  }
  io.stdout.write(
    `Owner code (shown once; single use; give it to the teacher out of band):\n\n  ${formatOwnerCode(code)}\n\nExpires ${expiresAt.toISOString()}\n`,
  );
  return 0;
}

/**
 * True when fd 1 is PID 1's stdout — the container log — or when that cannot be
 * determined (fail closed). Under `docker exec -it` fd 1 is the exec's own pty.
 */
function stdoutIsContainerLog(): boolean {
  if (process.pid === 1) {
    return true;
  }
  try {
    const mine = fstatSync(1);
    const pid1 = statSync("/proc/1/fd/1");
    return mine.dev === pid1.dev && mine.ino === pid1.ino;
  } catch {
    return true;
  }
}

/** The relay's own Postgres store, from the container's configuration. Never in-memory. */
async function openPostgresStore(): Promise<{
  store: PostgresRelayStore;
  close(): Promise<void>;
}> {
  const config = loadStoreConfig(process.env, (path) => readFileSync(path, "utf8"));
  if (config.kind !== "postgres") {
    throw new Error("the in-memory store cannot hold an owner code for the relay");
  }
  const pool = new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 1,
    connectionTimeoutMillis: 5_000,
    query_timeout: 10_000,
  });
  // An unhandled pool error would crash with its message; the failure path reports the code only.
  pool.on("error", () => {});
  return { store: new PostgresRelayStore(poolClient(pool)), close: () => pool.end() };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await runAdmin({
    argv: process.argv.slice(2),
    stdout: process.stdout,
    stderr: process.stderr,
    isTTY: process.stdout.isTTY === true,
    stdoutIsContainerLog: stdoutIsContainerLog(),
    openStore: openPostgresStore,
  });
}
