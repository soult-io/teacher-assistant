// TEACH-58 (EU-2): the operator CLI. Run in-process with injected io. HARD
// conditions (device-enrollment spec §5.7, §11 EU-2): exec-only and TTY-only,
// and neither the code nor its hash ever reaches a log — including on a forced
// duplicate issueOwnerCode, where Postgres puts the hash in err.detail.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AdminIo, ISSUE_OWNER_CODE, runAdmin } from "./admin.js";
import { buildApp } from "./app.js";
import { migrate } from "./migrations.js";
import { formatOwnerCode, newOwnerCode, ownerCodeHash } from "./owner-code.js";
import { PostgresRelayStore } from "./postgres-store.js";
import { sodiumReady } from "./sodium-verify.js";
import { InMemoryRelayStore, type RelayStore } from "./store.js";

beforeAll(async () => {
  await sodiumReady();
});

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) {
    rmSync(d, { recursive: true, force: true });
  }
});

function sink() {
  const chunks: string[] = [];
  return { chunks, text: () => chunks.join(""), write: (t: string) => void chunks.push(t) };
}

/** Exec'd on a terminal over `store`, with fixed code + clock unless overridden. */
function io(store: RelayStore, overrides: Partial<AdminIo> = {}) {
  const stdout = sink();
  const stderr = sink();
  let opened = 0;
  let closed = 0;
  const value: AdminIo = {
    argv: [ISSUE_OWNER_CODE],
    stdout,
    stderr,
    isTTY: true,
    stdoutIsContainerLog: false,
    openStore: async () => {
      opened += 1;
      return {
        store,
        close: async () => {
          closed += 1;
        },
      };
    },
    now: () => new Date("2026-10-08T12:00:00Z"),
    ...overrides,
  };
  return { value, stdout, stderr, counts: () => ({ opened, closed }) };
}

describe("TEACH-58 — operator CLI: where it may run", () => {
  it("refuses unless stdout is a TTY, without opening the store or minting a code", async () => {
    let minted = 0;
    const t = io(new InMemoryRelayStore(), {
      isTTY: false,
      newCode: () => {
        minted += 1;
        return newOwnerCode();
      },
    });
    expect(await runAdmin(t.value)).toBe(2);
    expect(t.stdout.text()).toBe("");
    expect(t.stderr.text()).toContain("docker exec -it");
    expect(t.counts().opened).toBe(0);
    expect(minted).toBe(0);
  });

  it("refuses a one-shot service with a TTY: stdout is the container log", async () => {
    const t = io(new InMemoryRelayStore(), { stdoutIsContainerLog: true });
    expect(await runAdmin(t.value)).toBe(2);
    expect(t.stdout.text()).toBe("");
    expect(t.counts().opened).toBe(0);
  });

  it("an unknown or extra argument prints usage only", async () => {
    for (const argv of [[], ["issue"], [ISSUE_OWNER_CODE, "--ttl"]]) {
      const t = io(new InMemoryRelayStore(), { argv });
      expect(await runAdmin(t.value)).toBe(64);
      expect(t.stdout.text()).toBe("");
      expect(t.counts().opened).toBe(0);
    }
  });

  it("the image never runs it as the container command", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    const cmds = dockerfile.split("\n").filter((l) => /^(CMD|ENTRYPOINT)\b/.test(l));
    expect(cmds).toEqual(['CMD ["node", "dist/index.js"]']);
  });
});

describe("TEACH-58 — operator CLI: issuing", () => {
  it("prints the code once, stores only its hash with a 24 h expiry, and the code redeems", async () => {
    const issued: { hash: string; expiresAt: Date }[] = [];
    const store = new InMemoryRelayStore({ now: () => new Date("2026-10-08T12:00:00Z") });
    const spy = Object.assign(store, {
      issueOwnerCode: async (hash: string, expiresAt: Date) => {
        issued.push({ hash, expiresAt });
        return InMemoryRelayStore.prototype.issueOwnerCode.call(store, hash, expiresAt);
      },
    });
    const code = newOwnerCode();
    const t = io(spy, { newCode: () => code });
    expect(await runAdmin(t.value)).toBe(0);
    expect(t.stdout.text()).toContain(formatOwnerCode(code));
    expect(t.stdout.text()).not.toContain(ownerCodeHash(code));
    expect(t.stderr.text()).toBe("");
    expect(issued).toEqual([
      { hash: ownerCodeHash(code), expiresAt: new Date("2026-10-09T12:00:00Z") },
    ]);
    expect(t.counts()).toEqual({ opened: 1, closed: 1 });
    expect(await store.redeemOwnerCode(ownerCodeHash(code) as string, "dev-A")).toBe("first");
  });

  it("forced duplicate on real Postgres: neither the code nor the hash leaves the CLI or reaches the app log", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relay-admin-"));
    dirs.push(dir);
    const db = await PGlite.create(dir);
    await migrate(db);
    const store = new PostgresRelayStore(db);
    const code = newOwnerCode();
    const hash = ownerCodeHash(code) as string;
    await store.issueOwnerCode(hash, new Date("2026-10-09T12:00:00Z"));

    // Prove the premise: the database's own error for this insert carries the hash.
    const err = await store.issueOwnerCode(hash, new Date()).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe("23505");
    expect(JSON.stringify({ ...(err as object), message: (err as Error).message })).toContain(hash);

    const lines: string[] = [];
    const app = buildApp(store, { logStream: { write: (l) => void lines.push(l) } });
    const t = io(store, { newCode: () => code });
    expect(await runAdmin(t.value)).toBe(1);
    expect(t.stderr.text()).toBe(`${ISSUE_OWNER_CODE} failed (SQLSTATE 23505)\n`);
    expect(t.stdout.text()).toBe("");
    expect(t.counts()).toEqual({ opened: 1, closed: 1 });

    // Drive the app with the code in a redeem body (unsigned: 401) and a 5xx.
    await app.inject({
      method: "POST",
      url: "/sync/enroll/redeem",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ code: formatOwnerCode(code) }),
    });
    app.log.error({ err }, "request failed");
    const all = `${lines.join("\n")}${t.stdout.text()}${t.stderr.text()}`;
    for (const secret of [code, formatOwnerCode(code), hash]) {
      expect(all).not.toContain(secret);
    }
    await app.close();
    await db.close();
  });

  it("any store failure prints only a SQLSTATE or an error class", async () => {
    const code = newOwnerCode();
    const hash = ownerCodeHash(code) as string;
    for (const [thrown, expected] of [
      [
        Object.assign(new Error(`dup ${hash}`), { code: "23505", detail: `(${hash})` }),
        "SQLSTATE 23505",
      ],
      [Object.assign(new Error(`connect ${hash}`), { code: "ECONNREFUSED" }), "Error"],
      [Object.assign(new Error(`pipe ${hash}`), { code: "EPIPE" }), "Error"], // 5 letters, not a SQLSTATE
      [new TypeError(`bad ${code}`), "TypeError"],
    ] as const) {
      const failing = Object.assign(new InMemoryRelayStore(), {
        issueOwnerCode: () => Promise.reject(thrown),
      });
      const t = io(failing, { newCode: () => code });
      expect(await runAdmin(t.value)).toBe(1);
      expect(t.stderr.text()).toBe(`${ISSUE_OWNER_CODE} failed (${expected})\n`);
      expect(`${t.stdout.text()}${t.stderr.text()}`).not.toContain(hash);
      expect(`${t.stdout.text()}${t.stderr.text()}`).not.toContain(code);
      expect(t.counts().closed).toBe(1);
    }
  });

  it("a store that cannot be opened (e.g. the in-memory config) fails without a code", async () => {
    const t = io(new InMemoryRelayStore(), {
      openStore: () => Promise.reject(new Error("the in-memory store cannot hold an owner code")),
    });
    expect(await runAdmin(t.value)).toBe(1);
    expect(t.stdout.text()).toBe("");
    expect(t.stderr.text()).toBe(`${ISSUE_OWNER_CODE} failed (Error)\n`);
  });
});
