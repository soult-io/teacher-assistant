import { describe, expect, it } from "vitest";
import { ConfigError, loadStoreConfig, loadTrustProxy } from "./config.js";

const DB_ENV = {
  DB_HOST: "qa-db",
  DB_PORT: "5432",
  DB_NAME: "teacher_assistant_qa",
  DB_USER: "teacher_assistant_qa",
  SECRETS_DIR: "/run/secrets",
};

function secrets(files: Record<string, string>) {
  return (path: string): string => {
    const v = files[path];
    if (v === undefined) {
      throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
    }
    return v;
  };
}

const PW = secrets({ "/run/secrets/db-password": "s3cret\n" });

describe("loadStoreConfig", () => {
  it("no DB_HOST outside production → in-memory", () => {
    expect(loadStoreConfig({}, PW)).toEqual({ kind: "memory" });
    expect(loadStoreConfig({ NODE_ENV: "development" }, PW)).toEqual({ kind: "memory" });
  });

  it("no DB_HOST in production → fails closed", () => {
    expect(() => loadStoreConfig({ NODE_ENV: "production" }, PW)).toThrow(ConfigError);
  });

  it("DB_* + password file → postgres, password read from the file (one newline stripped)", () => {
    expect(loadStoreConfig({ ...DB_ENV, NODE_ENV: "production" }, PW)).toEqual({
      kind: "postgres",
      host: "qa-db",
      port: 5432,
      database: "teacher_assistant_qa",
      user: "teacher_assistant_qa",
      password: "s3cret",
    });
  });

  it("SECRETS_DIR defaults to /run/secrets and tolerates a trailing slash", () => {
    const { SECRETS_DIR: _, ...noDir } = DB_ENV;
    expect(loadStoreConfig(noDir, PW)).toMatchObject({ kind: "postgres", password: "s3cret" });
    const custom = secrets({ "/secrets/db-password": "pw" });
    expect(loadStoreConfig({ ...DB_ENV, SECRETS_DIR: "/secrets/" }, custom)).toMatchObject({
      password: "pw",
    });
  });

  it("DB_PORT defaults to 5432; a bad port fails", () => {
    const { DB_PORT: _, ...noPort } = DB_ENV;
    expect(loadStoreConfig(noPort, PW)).toMatchObject({ port: 5432 });
    for (const bad of ["0", "65536", "54x", "1.5"]) {
      expect(() => loadStoreConfig({ ...DB_ENV, DB_PORT: bad }, PW)).toThrow(ConfigError);
    }
  });

  it.each(["DB_NAME", "DB_USER"])("DB_HOST set but %s missing → fails closed", (key) => {
    expect(() => loadStoreConfig({ ...DB_ENV, [key]: "" }, PW)).toThrow(
      new ConfigError(`${key} is required when DB_HOST is set`),
    );
  });

  it("an unreadable or empty password file fails closed — never falls back to memory", () => {
    expect(() => loadStoreConfig(DB_ENV, secrets({}))).toThrow(ConfigError);
    expect(() => loadStoreConfig(DB_ENV, secrets({ "/run/secrets/db-password": "\n" }))).toThrow(
      /is empty/,
    );
  });

  it("error messages never contain the password", () => {
    const pw = secrets({ "/run/secrets/db-password": "hunter2-secret" });
    try {
      loadStoreConfig({ ...DB_ENV, DB_NAME: "" }, pw);
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("hunter2");
    }
  });
});

describe("loadTrustProxy (TEACH-55)", () => {
  it("unset outside production → no proxy trusted", () => {
    expect(loadTrustProxy({})).toBeUndefined();
    expect(loadTrustProxy({ NODE_ENV: "development" })).toBeUndefined();
  });

  it("unset in production → fails closed", () => {
    expect(() => loadTrustProxy({ NODE_ENV: "production" })).toThrow(ConfigError);
  });

  it("an explicit CIDR list → the list, trimmed", () => {
    expect(loadTrustProxy({ NODE_ENV: "production", TRUST_PROXY: "172.18.0.0/16" })).toEqual([
      "172.18.0.0/16",
    ]);
    expect(loadTrustProxy({ TRUST_PROXY: " 172.18.0.0/16 , 10.0.0.5 ,fd00::/16, ::1" })).toEqual([
      "172.18.0.0/16",
      "10.0.0.5",
      "fd00::/16",
      "::1",
    ]);
    expect(loadTrustProxy({ TRUST_PROXY: "fd00::/112,fd00::1/128" })).toEqual([
      "fd00::/112",
      "fd00::1/128",
    ]);
    expect(loadTrustProxy({ TRUST_PROXY: "10.0.0.0/8,172.18.0.15/32" })).toEqual([
      "10.0.0.0/8",
      "172.18.0.15/32",
    ]);
  });

  it.each([
    "",
    "  ",
    "true",
    "TRUE",
    "*",
    "false",
    "1",
    "loopback",
    "uniquelocal",
    "0.0.0.0/0",
    "::/0",
    "172.18.0.0/33",
    "fd00::/129",
    "172.18.0.0/",
    "172.18.0.0/16,",
    "172.18.0.0/16,*",
    "172.18.0.0/16, true",
    "300.1.1.1/8",
    "172.18.0.0/016",
    // short ranges that add up to trust-all
    "0.0.0.0/1,128.0.0.0/1",
    "10.0.0.0/7",
    "::/1,8000::/1",
    "fd00::/15",
    // IPv6 ranges over IPv4-mapped / IPv4-compatible space (match IPv4 peers)
    "::ffff:0:0/96",
    "::/80",
    "::ffff:ac12:0/112",
    "::/96",
    "::ffff:ac12:f/128",
    // a zone id is not a network
    "fe80::1%eth0/64",
    "fe80::1%eth0",
  ])("rejects TRUST_PROXY=%j (never trust-all, never a name or hop count)", (raw) => {
    for (const NODE_ENV of ["production", "development"]) {
      expect(() => loadTrustProxy({ NODE_ENV, TRUST_PROXY: raw })).toThrow(ConfigError);
    }
  });

  it("error messages do not echo the value", () => {
    try {
      loadTrustProxy({ TRUST_PROXY: "SENTINEL-not-a-cidr" });
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain("SENTINEL");
    }
  });
});
