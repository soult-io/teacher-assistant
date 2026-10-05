// Store + trusted-proxy selection from the environment. Pure (env + secret reader injected) so
// every branch is unit-tested; index.ts does the I/O.
//
// Fail closed:
//   - DB_HOST set            → Postgres. DB_NAME, DB_USER and the db-password
//                              secret FILE are then required; anything missing or
//                              unreadable throws — never a silent in-memory fallback.
//   - DB_HOST unset, NODE_ENV=production → throws. A production relay must not
//                              run on a store that a restart wipes.
//   - otherwise              → in-memory (tests, local development).
// The password is read from a file under SECRETS_DIR, never from the environment
// (compose-hardening). Error messages name variables and paths, never values.

import { BlockList, isIP } from "node:net";

export type StoreConfig =
  | { readonly kind: "memory" }
  | {
      readonly kind: "postgres";
      readonly host: string;
      readonly port: number;
      readonly database: string;
      readonly user: string;
      readonly password: string;
    };

export type Env = Readonly<Record<string, string | undefined>>;

const DEFAULT_SECRETS_DIR = "/run/secrets";
const DB_PASSWORD_FILE = "db-password";

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) {
    throw new ConfigError(`${key} is required when DB_HOST is set`);
  }
  return value;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return 5432;
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError("DB_PORT must be an integer in 1-65535");
  }
  return port;
}

export function loadStoreConfig(env: Env, readSecret: (path: string) => string): StoreConfig {
  const host = env["DB_HOST"]?.trim();
  if (!host) {
    if (env["NODE_ENV"] === "production") {
      throw new ConfigError("DB_HOST is required in production (in-memory store is not durable)");
    }
    return { kind: "memory" };
  }
  const secretsDir = env["SECRETS_DIR"]?.trim() || DEFAULT_SECRETS_DIR;
  const passwordPath = `${secretsDir.replace(/\/+$/, "")}/${DB_PASSWORD_FILE}`;
  let password: string;
  try {
    // Strip ONE trailing newline (what `echo`/editors add); keep anything else verbatim.
    password = readSecret(passwordPath).replace(/\r?\n$/, "");
  } catch {
    throw new ConfigError(`cannot read the database password file ${passwordPath}`);
  }
  if (password === "") {
    throw new ConfigError(`the database password file ${passwordPath} is empty`);
  }
  return {
    kind: "postgres",
    host,
    port: parsePort(env["DB_PORT"]),
    database: required(env, "DB_NAME"),
    user: required(env, "DB_USER"),
    password,
  };
}

/**
 * TEACH-55: the peers whose X-Forwarded-For is believed, from TRUST_PROXY — a
 * comma-separated list of IPs/CIDRs (the proxy-web network). Fail closed:
 *   - unset, NODE_ENV=production → throws. Behind the NPM every client would
 *     otherwise share the proxy's IP, so the per-IP rate limit is one global one.
 *   - unset otherwise            → undefined (no proxy trusted; tests, local dev).
 *   - set                        → every entry must be a literal IP or IP/prefix
 *     with a prefix of at least /8 (IPv4) or /16 (IPv6). `true`, `*`, empty
 *     entries, hop counts, proxy-addr names (`loopback`, …), /0 and IPv6 ranges
 *     over IPv4-mapped space are refused: trust-all is never configurable.
 */
export function loadTrustProxy(env: Env): string[] | undefined {
  const raw = env["TRUST_PROXY"];
  if (raw === undefined) {
    if (env["NODE_ENV"] === "production") {
      throw new ConfigError("TRUST_PROXY is required in production (the proxy-web CIDR)");
    }
    return undefined;
  }
  const entries = raw.split(",").map((e) => e.trim());
  if (!entries.every(isTrustedProxyEntry)) {
    throw new ConfigError(
      "TRUST_PROXY must be a comma-separated list of IPs or CIDRs (min /8 IPv4, /16 IPv6)",
    );
  }
  return entries;
}

/** Narrowest-allowed prefixes: a few short ranges must not add up to trust-all. */
const MIN_PREFIX = { 4: 8, 6: 16 } as const;

/** IPv4-compatible (::/96) and IPv4-mapped (::ffff:0:0/96) space: a range here trusts IPv4 peers. */
const IPV4_IN_IPV6 = ["::", "::ffff:0:0"] as const;

/** True if the IPv6 range addr/prefix overlaps an IPv4-in-IPv6 /96. */
function overlapsIpv4Space(addr: string, prefix: number): boolean {
  return IPV4_IN_IPV6.some((net) => {
    const range = new BlockList();
    const space = new BlockList();
    range.addSubnet(addr, prefix, "ipv6");
    space.addSubnet(net, 96, "ipv6");
    // Two prefix ranges overlap iff one contains the other's base address.
    return prefix <= 96 ? range.check(net, "ipv6") : space.check(addr, "ipv6");
  });
}

/**
 * A literal IP, or IP/prefix with no leading zeros and a prefix of at least
 * /8 (IPv4) or /16 (IPv6). An IPv6 range may not cover IPv4-mapped or
 * IPv4-compatible space (proxy-addr matches IPv4 peers against it).
 */
export function isTrustedProxyEntry(entry: string): boolean {
  const slash = entry.indexOf("/");
  const addr = slash === -1 ? entry : entry.slice(0, slash);
  const family = isIP(addr);
  if (family !== 4 && family !== 6) {
    return false;
  }
  if (slash === -1) {
    return true;
  }
  const raw = entry.slice(slash + 1);
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) {
    return false;
  }
  const prefix = Number(raw);
  if (prefix < MIN_PREFIX[family] || prefix > (family === 4 ? 32 : 128)) {
    return false;
  }
  return family === 4 || !overlapsIpv4Space(addr, prefix);
}
