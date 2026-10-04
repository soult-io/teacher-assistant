import { describe, expect, it } from "vitest";
import { ConfigError, loadStoreConfig } from "./config.js";

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
