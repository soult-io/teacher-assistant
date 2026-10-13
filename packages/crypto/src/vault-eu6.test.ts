// EU-6 (TEACH-66) — the device-vault crypto (device-enrollment-spec rev 2.4 DN-1, §3.1,
// §11 EU-6): the Tier P and Tier W KEKs, the passphrase rule, the Argon2id cost floor,
// the one-wrap vault, the grant AEAD at rest, the zeroized-signing-key refusal and the
// WebCrypto-Ed25519 ↔ libsodium interop. The app-side vault (IndexedDB, passkey, auto-
// lock) is tested in apps/pwa/src/device; the gating FERPA copies live in
// tools/ferpa-guard/test/ferpa-teach66.test.ts.

import _sodium from "libsodium-wrappers-sumo";
import { beforeAll, describe, expect, it } from "vitest";
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
  type VaultBinding,
  zeroizeVaultSecrets,
} from "./index.js";

beforeAll(async () => {
  await sodiumReady();
});

function bindingFor(
  pub: { signPk: Uint8Array; boxPk: Uint8Array },
  tier: VaultBinding["tier"],
): VaultBinding {
  return { tier, signPk: pub.signPk, boxPk: pub.boxPk };
}

describe("passphrase rule (DN-1)", () => {
  it.each([
    ["123456", false], // a 6-digit PIN
    ["abcdefgh", false], // letters only
    ["12345678", false], // 8 digits is not 10
    ["abc123", false], // too short
    ["123456789", false], // 9 digits
    ["abcd1234", true],
    ["0123456789", true],
    ["blue7kites", true],
    ["Blue 7 kites!", true],
  ])("%s → %s", (passphrase, ok) => {
    expect(isAcceptablePassphrase(passphrase)).toBe(ok);
  });
});

describe("Argon2id parameters", () => {
  it("are at least libsodium MODERATE and use Argon2id13", () => {
    const sodium = _sodium;
    expect(PASSPHRASE_ARGON2.opsLimit()).toBeGreaterThanOrEqual(
      sodium.crypto_pwhash_OPSLIMIT_MODERATE,
    );
    expect(PASSPHRASE_ARGON2.memLimit()).toBeGreaterThanOrEqual(
      sodium.crypto_pwhash_MEMLIMIT_MODERATE,
    );
    expect(PASSPHRASE_ARGON2.alg()).toBe(sodium.crypto_pwhash_ALG_ARGON2ID13);
  });

  it("stretchPassphrase equals crypto_pwhash at those parameters", () => {
    const salt = newVaultSalt();
    expect(salt.length).toBe(16);
    const expected = _sodium.crypto_pwhash(
      32,
      utf8("abcd1234"),
      salt,
      _sodium.crypto_pwhash_OPSLIMIT_MODERATE,
      _sodium.crypto_pwhash_MEMLIMIT_MODERATE,
      _sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    expect(toBase64(stretchPassphrase("abcd1234", salt))).toBe(toBase64(expected));
  });

  it("refuses a passphrase that breaks the rule before stretching", () => {
    expect(() => stretchPassphrase("123456", newVaultSalt())).toThrow(/passphrase/);
  });
});

describe("Tier P KEK", () => {
  it("is keyed BLAKE2b-256 with the PRF output as key and the label as message", () => {
    const prf = new Uint8Array(32).fill(7);
    const expected = _sodium.crypto_generichash(32, utf8("ta-vault-kek-v1"), prf);
    expect(toBase64(deriveTierPKek(prf))).toBe(toBase64(expected));
  });

  it("refuses a PRF output that is not 32 bytes (fail closed)", () => {
    expect(() => deriveTierPKek(new Uint8Array(0))).toThrow();
    expect(() => deriveTierPKek(new Uint8Array(16))).toThrow();
  });
});

describe("Tier W KEK = HMAC-SHA-256(Kdev, Argon2id(passphrase, salt))", () => {
  it("Kdev is a non-extractable HMAC key that cannot be exported", async () => {
    const kdev = await generateKdev();
    expect(kdev.extractable).toBe(false);
    expect(kdev.algorithm.name).toBe("HMAC");
    expect(kdev.usages).toEqual(["sign"]);
    await expect(crypto.subtle.exportKey("raw", kdev)).rejects.toThrow();
  });

  it("matches an independent HMAC over the Argon2id output", async () => {
    const kdev = await generateKdev();
    const salt = newVaultSalt();
    const stretched = stretchPassphrase("abcd1234", salt);
    const hmac = new Uint8Array(
      await crypto.subtle.sign("HMAC", kdev, new Uint8Array(stretched).buffer),
    );
    expect(toBase64(await deriveTierWKek(kdev, "abcd1234", salt))).toBe(toBase64(hmac));
  });

  it("cannot be derived without Kdev: another Kdev, or the bare Argon2id output, fails to open", async () => {
    const generated = generateVaultSecrets();
    const binding = bindingFor(generated, "passphrase");
    const kdev = await generateKdev();
    const salt = newVaultSalt();
    const vault = sealVault(
      await deriveTierWKek(kdev, "abcd1234", salt),
      generated.secrets,
      binding,
    );

    const otherKdev = await generateKdev();
    expect(() => openVault(stretchPassphrase("abcd1234", salt), vault, binding)).toThrow(
      VaultOpenError,
    );
    const wrongKek = await deriveTierWKek(otherKdev, "abcd1234", salt);
    expect(() => openVault(wrongKek, vault, binding)).toThrow(VaultOpenError);
    const rightKek = await deriveTierWKek(kdev, "abcd1234", salt);
    expect(toBase64(openVault(rightKek, vault, binding).signSk)).toBe(
      toBase64(generated.secrets.signSk),
    );
  });
});

describe("the vault: one AEAD wrap, bound to the device's public keys and tier", () => {
  it("round-trips and contains no raw secret", () => {
    const generated = generateVaultSecrets();
    const kek = new Uint8Array(32).fill(3);
    const binding = bindingFor(generated, "prf");
    const vault = sealVault(kek, generated.secrets, binding);
    const opened = openVault(kek, vault, binding);
    expect(toBase64(opened.signSk)).toBe(toBase64(generated.secrets.signSk));
    expect(toBase64(opened.boxSk)).toBe(toBase64(generated.secrets.boxSk));
    expect(toBase64(opened.recordKey)).toBe(toBase64(generated.secrets.recordKey));
    const text = toBase64(vault);
    for (const secret of [
      generated.secrets.signSk,
      generated.secrets.boxSk,
      generated.secrets.recordKey,
      kek,
    ]) {
      expect(text).not.toContain(toBase64(secret));
    }
  });

  it("refuses a vault moved to another tier or another device's keys", () => {
    const a = generateVaultSecrets();
    const b = generateVaultSecrets();
    const kek = new Uint8Array(32).fill(4);
    const vault = sealVault(kek, a.secrets, bindingFor(a, "prf"));
    expect(() => openVault(kek, vault, bindingFor(a, "passphrase"))).toThrow(VaultOpenError);
    expect(() => openVault(kek, vault, bindingFor(b, "prf"))).toThrow(VaultOpenError);
  });

  it("the signing secret matches the public identity (libsodium sk = seed ‖ pk)", () => {
    const generated = generateVaultSecrets();
    expect(toBase64(generated.secrets.signSk.subarray(32))).toBe(toBase64(generated.signPk));
    const msg = utf8("relay request");
    const sig = sign(msg, generated.secrets.signSk);
    expect(_sodium.crypto_sign_verify_detached(sig, msg, generated.signPk)).toBe(true);
  });

  it("zeroizeVaultSecrets zeroes every buffer", () => {
    const { secrets } = generateVaultSecrets();
    zeroizeVaultSecrets(secrets);
    for (const buf of [secrets.signSk, secrets.boxSk, secrets.recordKey]) {
      expect(buf.every((b) => b === 0)).toBe(true);
    }
  });
});

describe("the grant at rest is AEAD under the vault's record key", () => {
  it("round-trips, hides the grant text, and is bound to the device", () => {
    const a = generateVaultSecrets();
    const b = generateVaultSecrets();
    const grant = utf8(JSON.stringify({ wrappedMasterKeyB64: "x", masterScopeTag: "t" }));
    const sealed = sealGrantAtRest(a.secrets.recordKey, a.signPk, grant);
    expect(new TextDecoder().decode(sealed)).not.toContain("wrappedMasterKeyB64");
    expect(new TextDecoder().decode(openGrantAtRest(a.secrets.recordKey, a.signPk, sealed))).toBe(
      new TextDecoder().decode(grant),
    );
    expect(() => openGrantAtRest(a.secrets.recordKey, b.signPk, sealed)).toThrow(VaultOpenError);
    expect(() => openGrantAtRest(b.secrets.recordKey, a.signPk, sealed)).toThrow(VaultOpenError);
  });
});

describe("a zeroized signing key can never sign", () => {
  it("sign() throws KeyringDestroyedError on an all-zero private key", () => {
    const kp = generateSigningKeypair();
    kp.privateKey.fill(0);
    expect(() => sign(utf8("m"), kp.privateKey)).toThrow(KeyringDestroyedError);
  });
});

describe("WebCrypto Ed25519 ↔ libsodium", () => {
  it("a libsodium signature verifies with WebCrypto", async () => {
    const kp = generateSigningKeypair();
    const msg = utf8("canonical request");
    const sig = sign(msg, kp.privateKey);
    const pub = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(kp.publicKey).buffer,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        pub,
        new Uint8Array(sig).buffer,
        msg.buffer as ArrayBuffer,
      ),
    ).toBe(true);
  });

  it("a WebCrypto signature verifies with libsodium", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const msg = utf8("canonical request");
    const sig = new Uint8Array(
      await crypto.subtle.sign("Ed25519", pair.privateKey, msg.buffer as ArrayBuffer),
    );
    const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    expect(_sodium.crypto_sign_verify_detached(sig, msg, pub)).toBe(true);
    expect(_sodium.crypto_sign_verify_detached(sig, utf8("other"), pub)).toBe(false);
  });
});
