// FERPA-guard — TEACH-66 (EU-6) HARD conditions (device-enrollment-spec rev 2.4 §11 EU-6,
// rev 2.1 N1/N2, rev 2.2 EU-5 carry-forward, rev 2.3 A-3/A-10):
//   1. Tier W: KEK = HMAC(Kdev non-extractable, Argon2id(passphrase, salt, ≥ MODERATE)),
//      one wrap, no stored intermediate; the KEK cannot be derived without Kdev.
//   2. Passphrase rule: 8+ with letters and digits, or 10+ digits; no 6-digit PIN.
//   3. Tier P: UV required on create and get; PRF missing fails closed, never Tier W.
//   4. Vault bytes and the stored grant contain no raw key; the grant is AEAD at rest.
//   5. signSk lives only inside the vault; Kdev is the only non-extractable key at rest;
//      a zeroized (locked) signing key can never sign.
//   6. Auto-lock: idle ≤ 15 min, hidden ≤ 5 min, wall-clock check on resume, the warning
//      never extends the timer; lock destroys every keyring, para included.
//   7. hasScope is not proof of unlock; the RelayClient signs with the device identity.
//   8. A-3: iOS standalone-only setup; navigator.storage.persist() at setup.
// Behavioural proofs against the real crypto layer, plus static checks on the app source
// (the PWA is not a dependency of this suite; its behaviour is tested in apps/pwa).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveTierPKek,
  deriveTierWKek,
  generateKdev,
  generateSigningKeypair,
  generateVaultSecrets,
  isAcceptablePassphrase,
  KeyringDestroyedError,
  newVaultSalt,
  openGrantAtRest,
  openVault,
  PASSPHRASE_ARGON2,
  sealGrantAtRest,
  sealVault,
  sign,
  sodiumReady,
  stretchPassphrase,
  toBase64,
  utf8,
  VaultOpenError,
} from "@teacher-assistant/crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { containsBytes } from "./bytes.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pwaSrc = join(repoRoot, "apps", "pwa", "src");
const deviceDir = join(pwaSrc, "device");

function source(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

/** Every non-test .ts/.tsx file under a directory (recursive). */
function productionSources(dir: string): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test") {
        out.push(...productionSources(path));
      }
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push({ path, text: readFileSync(path, "utf8") });
    }
  }
  return out;
}

/** The body of a named function in a source file (up to the next top-level declaration). */
function functionBody(text: string, name: string): string {
  const start = text.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThanOrEqual(0);
  // Stop before the next top-level declaration AND its leading doc comment.
  const next = text
    .slice(start + 1)
    .search(/\n(\/\*\*[\s\S]*?\*\/\n)?(export )?(async )?(function|class|const|let) /);
  return next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
}

// libsodium MODERATE (crypto_pwhash_OPSLIMIT_MODERATE / MEMLIMIT_MODERATE).
const MODERATE_OPS = 3;
const MODERATE_MEM = 256 * 1024 * 1024;

beforeAll(async () => {
  await sodiumReady();
});

describe("TEACH-66 HARD — Tier W KEK", () => {
  it("Argon2id runs at ≥ MODERATE", () => {
    expect(PASSPHRASE_ARGON2.opsLimit()).toBeGreaterThanOrEqual(MODERATE_OPS);
    expect(PASSPHRASE_ARGON2.memLimit()).toBeGreaterThanOrEqual(MODERATE_MEM);
  });

  it("Kdev is non-extractable, and without it the vault never opens", async () => {
    const kdev = await generateKdev();
    expect(kdev.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", kdev)).rejects.toThrow();
    const generated = generateVaultSecrets();
    const binding = {
      tier: "passphrase" as const,
      signPk: generated.signPk,
      boxPk: generated.boxPk,
    };
    const salt = newVaultSalt();
    const kek = await deriveTierWKek(kdev, "abcd1234", salt);
    const vault = sealVault(kek, generated.secrets, binding);
    // The Argon2id output alone (what an off-device attacker could brute-force) is not the KEK.
    expect(() => openVault(stretchPassphrase("abcd1234", salt), vault, binding)).toThrow(
      VaultOpenError,
    );
    // Another browser profile's Kdev with the right passphrase does not open it either.
    const elsewhere = await deriveTierWKek(await generateKdev(), "abcd1234", salt);
    expect(() => openVault(elsewhere, vault, binding)).toThrow(VaultOpenError);
    // One wrap: the vault bytes contain no secret and no intermediate.
    for (const secret of [
      kek,
      stretchPassphrase("abcd1234", salt),
      generated.secrets.signSk,
      generated.secrets.boxSk,
      generated.secrets.recordKey,
    ]) {
      expect(containsBytes(vault, secret)).toBe(false);
    }
  });

  it("the stored record shape has no intermediate field", () => {
    const store = source(deviceDir, "device-store.ts");
    const shape = store.slice(store.indexOf("export interface DeviceRecord"));
    // Top-level fields only (two-space indent), not the nested unlockFailures shape.
    const fields = shape.slice(0, shape.indexOf("\n}")).match(/^ {2}readonly (\w+)\??:/gm) ?? [];
    expect(fields.map((f) => f.replace(/^ {2}readonly |\??:/g, "")).sort()).toEqual(
      [
        "boxPk",
        "credentialId",
        "enrolled",
        "grant",
        "kdev",
        "pwSalt",
        "role",
        "signPk",
        "tier",
        "unlockFailures",
        "vault",
        "version",
      ].sort(),
    );
  });
});

describe("TEACH-66 HARD — passphrase rule", () => {
  it("rejects a 6-digit PIN and abcdefgh; accepts abcd1234 and 0123456789", () => {
    expect(isAcceptablePassphrase("123456")).toBe(false);
    expect(isAcceptablePassphrase("abcdefgh")).toBe(false);
    expect(isAcceptablePassphrase("abcd1234")).toBe(true);
    expect(isAcceptablePassphrase("0123456789")).toBe(true);
  });

  it("the passphrase never reaches the network, storage or a log from the device module", () => {
    for (const { path, text } of productionSources(deviceDir)) {
      expect(text, path).not.toMatch(/\bfetch\(|localStorage|sessionStorage|console\./);
    }
  });
});

describe("TEACH-66 HARD — Tier P", () => {
  it("UV is required on both create() and get(), and never weakened", () => {
    // Code only: the header comment also names the option.
    const prf = source(deviceDir, "passkey-prf.ts")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(prf.match(/userVerification: "required"/g)).toHaveLength(2);
    expect(prf).not.toMatch(/userVerification: "(preferred|discouraged)"/);
    expect(prf).toContain("UV_FLAG"); // the UV bit is checked on the assertion as well
  });

  it("the Tier P unlock path never consults a passphrase or Kdev (no fallback to Tier W)", () => {
    const body = functionBody(source(deviceDir, "vault.ts"), "openTierP");
    expect(body).not.toMatch(/passphrase|kdev|deriveTierWKek/i);
    expect(body).toContain("DeviceCannotUnlockError");
  });

  it("a missing or zero PRF output never yields a KEK", () => {
    expect(() => deriveTierPKek(new Uint8Array(0))).toThrow();
    expect(() => deriveTierPKek(new Uint8Array(32))).toThrow();
  });
});

describe("TEACH-66 HARD — the grant at rest", () => {
  it("is AEAD under the vault's record key and bound to the device", () => {
    const a = generateVaultSecrets();
    const b = generateVaultSecrets();
    const wrapped = new Uint8Array(80).fill(9);
    const grant = utf8(
      JSON.stringify({ role: "teacher", grant: { wrappedMasterKeyB64: toBase64(wrapped) } }),
    );
    const sealed = sealGrantAtRest(a.secrets.recordKey, a.signPk, grant);
    expect(containsBytes(sealed, utf8(toBase64(wrapped)))).toBe(false);
    expect(() => openGrantAtRest(a.secrets.recordKey, b.signPk, sealed)).toThrow(VaultOpenError);
  });
});

describe("TEACH-66 HARD — signSk only in the vault; no signing while locked (N1)", () => {
  it("a zeroized signing key throws instead of signing", () => {
    const kp = generateSigningKeypair();
    kp.privateKey.fill(0);
    expect(() => sign(utf8("control request"), kp.privateKey)).toThrow(KeyringDestroyedError);
  });

  it("no WebCrypto key other than Kdev is created or imported for the device", () => {
    const vault = source(repoRoot, "packages", "crypto", "src", "vault.ts");
    expect(vault.match(/crypto\.subtle\.generateKey\(/g)).toHaveLength(1);
    expect(vault).toMatch(/generateKey\(\{ name: "HMAC"[^)]*\}, false,/);
    for (const { path, text } of productionSources(deviceDir)) {
      expect(text, path).not.toMatch(/subtle\.(importKey|generateKey|unwrapKey)\(/);
    }
  });

  it("the RelayClient signs through the device signer, not a fresh keypair per engine", () => {
    const session = source(pwaSrc, "data", "session.ts");
    expect(session).toContain("readonly device?: RequestSigner;");
    expect(functionBody(session, "relayFor")).not.toContain("generateSigningKeypair");
    expect(session).not.toMatch(/signingKeypair:/);
  });

  it("the unlocked device's locked state is explicit, and hasScope is never an unlock check", () => {
    for (const { path, text } of productionSources(pwaSrc)) {
      expect(text, path).not.toContain("hasScope(");
    }
    expect(source(deviceDir, "vault.ts")).toContain("DeviceLockedError");
  });
});

describe("TEACH-66 HARD — auto-lock (N2, A-10)", () => {
  const autoLock = source(deviceDir, "auto-lock.ts");

  it("ceilings are 15 min idle and 5 min hidden; defaults 10 and 2", () => {
    expect(autoLock).toContain("IDLE_CEILING_MS = 15 * MINUTE");
    expect(autoLock).toContain("HIDDEN_CEILING_MS = 5 * MINUTE");
    expect(autoLock).toContain("IDLE_DEFAULT_MS = 10 * MINUTE");
    expect(autoLock).toContain("HIDDEN_DEFAULT_MS = 2 * MINUTE");
  });

  it("the warning handler never touches the last-input time", () => {
    const warn = autoLock.slice(
      autoLock.indexOf("#onWarnDue = "),
      autoLock.indexOf("#onIdleDue = "),
    );
    expect(warn).not.toContain("#lastInput =");
  });

  it("resume compares the wall clock with the hidden timestamp", () => {
    const resume = autoLock.slice(autoLock.indexOf("#onVisibility = "));
    expect(resume).toMatch(/now - hiddenAt >= this\.hiddenMs/);
    expect(resume).toMatch(/now - this\.#lastInput >= this\.idleMs/);
  });

  it("the app's lock destroys BOTH sessions (para included) and drops them synchronously", () => {
    const app = source(pwaSrc, "App.tsx");
    const lock = app.slice(app.indexOf("const lock = useCallback("));
    const body = lock.slice(0, lock.indexOf("}, []);"));
    expect(body).toContain("held?.teacher.lock();");
    expect(body).toContain("held?.para.lock();");
    expect(body).toContain("flushSync(");
    expect(body).toContain("setSessions(null);");
  });

  it("session lock destroys the keyring and zeroizes the in-process para box key", () => {
    const session = source(pwaSrc, "data", "session.ts");
    expect(session).toContain("keyring.destroy();");
    expect(session).toContain("paraKeyring.destroy();");
    expect(session).toContain("issuing.destroy();");
  });
});

describe("TEACH-66 HARD — A-3 setup gates", () => {
  it("setup refuses iOS outside the Home Screen app and requests persistent storage", () => {
    const create = functionBody(source(deviceDir, "vault.ts"), "createDeviceVault");
    const gate = create.indexOf("isIosOutsideHomeScreen(");
    expect(gate).toBeGreaterThanOrEqual(0);
    expect(gate).toBeLessThan(create.indexOf("store.create("));
    expect(create).toContain("SetupNeedsHomeScreenError");
    expect(create).toContain("requestPersistentStorage(");
    expect(source(deviceDir, "platform.ts")).toContain("(display-mode: standalone)");
  });
});
