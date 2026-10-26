// FERPA-guard — TEACH-73 (EU-7) HARD conditions (device-enrollment-spec rev 2.5 §11 EU-7,
// rev 2.3/2.4 §13 additions, rev 2.5 DN-1a additions, EU-6 carry-forward):
//   1. The master tag is registered as kind `master` at F1.
//   2. `mode: "recovery"` never mints an MK.
//   3. The synthetic seed (and the throwaway identity) run only on a QA/synthetic build.
//   4. The paper code must be confirmed before setup counts as finished.
//   5. The passkey display name is the device name, chosen before create() (DN-1a label).
//   6. Master-doc maps follow §3.3; device names never reach a relay body.
//   7. C6: the recovery code goes on paper only, never into Bitwarden; no copy, no print.
//   8. A-8: setupStage holds only stage, mode and when; neither code is ever persisted.
//   9. C4: BE/BS stay in the local DeviceRecord. C10: no passphrase box is focused on load.
//  10. EU-6 carry-forward: the App's lock also locks the device.
// Static checks on the app source (the PWA is not a dependency of this suite); the
// behaviour is proven in apps/pwa (device/first-setup.test.ts end to end against the real
// relay, app/setup/SetupFlow.test.tsx, App.setup.test.tsx).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const pwaSrc = join(repoRoot, "apps", "pwa", "src");

function source(...parts: string[]): string {
  return readFileSync(join(pwaSrc, ...parts), "utf8");
}

/** Code only: drop // line comments, so a check never matches the explaining prose. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/** Every non-test .ts/.tsx file under the PWA source (recursive, test helpers excluded). */
function productionSources(dir: string = pwaSrc): { path: string; text: string }[] {
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

/** The text of a method or function from its signature to the next blank-line-separated member. */
function member(text: string, signature: string): string {
  const start = text.indexOf(signature);
  expect(start, signature).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n\n", start);
  return end < 0 ? text.slice(start) : text.slice(start, end);
}

describe("TEACH-73 HARD — the master tag and the MK", () => {
  it("F1 self-grants the master tag with kind `master` (and the period tag as `period`)", () => {
    const firstDevice = code(source("data", "first-device.ts"));
    expect(firstDevice).toContain('{ tag: keyring.masterScopeTag, kind: "master" }');
    expect(firstDevice).toContain('{ tag: active.scopeTag, kind: "period" }');
  });

  it("only finish() mints, and only after the relay said `first`", () => {
    const setup = code(source("device", "first-setup.ts"));
    const finish = member(setup, "async finish(): Promise<void> {");
    const guard = finish.indexOf('stage?.mode !== "first"');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(finish.indexOf("mintFirstDeviceGrant("));
    // No other production file mints a master key or a first-device grant.
    for (const { path, text } of productionSources()) {
      const body = code(text);
      if (path.endsWith(join("data", "first-device.ts"))) {
        expect(body.match(/generateMasterKey\(/g)).toHaveLength(1);
        continue;
      }
      expect(body, path).not.toContain("generateMasterKey(");
      if (!path.endsWith(join("device", "first-setup.ts"))) {
        expect(body, path).not.toContain("mintFirstDeviceGrant(");
      }
    }
  });

  it("the session never mints keys or doc ids on unlock (a reload reopens the same streams)", () => {
    const session = code(source("data", "session.ts"));
    expect(session).not.toMatch(/generateMasterKey|generatePeriodKey|newOpaqueId|newScopeTag/);
    expect(session).toContain("vault.grant.masterDocId");
  });
});

describe("TEACH-73 HARD — synthetic data only on a QA/synthetic build", () => {
  it("the seed is reachable only from first setup, behind the synthetic input", () => {
    for (const { path, text } of productionSources()) {
      if (/synthetic-seed\.ts$/.test(path)) {
        continue;
      }
      const imports = /from "\.\/synthetic-seed\.js"|from "\.\.\/data\/synthetic-seed\.js"/.test(
        text,
      );
      expect(imports, path).toBe(path.endsWith(join("data", "first-device.ts")));
    }
    const firstDevice = code(source("data", "first-device.ts"));
    expect(firstDevice).toContain("input.synthetic ? buildSyntheticSeed(input.now) : null");
  });

  it('the build flag is VITE_TA_SYNTHETIC === "1", and the app passes it to setup and the session', () => {
    expect(code(source("build-flags.ts"))).toContain('import.meta.env.VITE_TA_SYNTHETIC === "1"');
    const app = code(source("App.tsx"));
    expect(app).toContain("synthetic = isSyntheticBuild()");
    expect(app).toContain("inProcessPara: synthetic");
    expect(app).toContain("browserDevicePort({ synthetic })");
  });

  it("the in-process para device and its throwaway identity exist only when inProcessPara is set", () => {
    const session = code(source("data", "session.ts"));
    expect(session).toContain("options.inProcessPara === true && active !== null");
  });
});

describe("TEACH-73 HARD — the paper recovery code", () => {
  it("setup is `done` only after the re-typed groups match", () => {
    const setup = code(source("device", "first-setup.ts"));
    expect(setup.match(/#writeStage\("done"/g)).toHaveLength(1);
    const confirm = member(setup, "async confirmRecoveryCode(typed: string): Promise<boolean> {");
    expect(confirm.indexOf("!== expected")).toBeLessThan(confirm.indexOf('#writeStage("done"'));
  });

  it("the code is shown only after the relay acknowledged the wrap (A-2)", () => {
    const setup = code(source("device", "first-setup.ts"));
    const issue = member(setup, "async issueRecoveryCode(): Promise<string> {");
    expect(issue.indexOf("recovery_pending")).toBeLessThan(issue.indexOf("putRecoveryWrap("));
    expect(issue.indexOf('!== "ok"')).toBeLessThan(issue.indexOf("this.#recoveryCode = code"));
  });

  it("C6 copy: paper only, never Bitwarden or a password manager; no copy or print control", () => {
    const screen = source("app", "setup", "RecoveryCode.tsx");
    expect(screen).toContain("Write it on paper.");
    expect(screen).toContain("Don't save it in Bitwarden or any password manager.");
    for (const { path, text } of productionSources(join(pwaSrc, "app", "setup"))) {
      expect(text, path).not.toMatch(/clipboard|window\.print|execCommand/);
    }
  });
});

describe("TEACH-73 HARD — nothing secret at rest (A-8)", () => {
  it("setupStage holds only stage, mode and when it was written", () => {
    const store = code(source("device", "device-store.ts"));
    const stage = member(store, "export interface SetupStage {");
    const fields = [...stage.matchAll(/readonly (\w+)\??:/g)].map((m) => m[1]);
    expect(fields).toEqual(["stage", "mode", "at"]);
  });

  it("first setup writes only the stage and the enrolled flag to the device record", () => {
    const setup = code(source("device", "first-setup.ts"));
    const write = member(setup, "async #recordStage(");
    expect(write).toContain("setupStage: next");
    expect(write).not.toMatch(/code|label|passphrase/i);
    expect(setup.match(/store\.update\(/g)).toHaveLength(1);
  });

  it("no setup or device module touches web storage, logs, or the network directly", () => {
    const dirs = [join(pwaSrc, "device"), join(pwaSrc, "app", "setup")];
    for (const dir of dirs) {
      for (const { path, text } of productionSources(dir)) {
        expect(text, path).not.toMatch(/localStorage|sessionStorage|console\.|\bfetch\(/);
      }
    }
  });
});

describe("TEACH-73 HARD — passkey label, C1, C4, C10", () => {
  it("the passkey is created under the device's name, which must be chosen first", () => {
    const setup = code(source("device", "first-setup.ts"));
    const create = member(setup, "async createPasskey(): Promise<VaultTier> {");
    expect(create.indexOf("this.#label === undefined")).toBeLessThan(create.indexOf("probeTier("));
    expect(create).toContain("passkeyDisplayName(this.#label");
    const prf = code(source("device", "passkey-prf.ts"));
    expect(prf).toContain("name: displayName,");
    expect(prf).not.toContain("authenticatorAttachment");
  });

  it("C1: get() allows exactly one credential, this device's", () => {
    const prf = code(source("device", "passkey-prf.ts"));
    expect(prf).toContain(
      'allowCredentials: [{ type: "public-key", id: new Uint8Array(credentialId) }],',
    );
  });

  it("C4: BE/BS are named only by the passkey port, the vault and the local record", () => {
    const allowed = ["passkey-prf.ts", "vault.ts", "device-store.ts"];
    for (const { path, text } of productionSources()) {
      if (allowed.some((name) => path.endsWith(join("device", name)))) {
        continue;
      }
      expect(code(text), path).not.toMatch(/credFlags|backupEligible|backedUp/);
    }
  });

  it("device names travel only inside the MK-encrypted master doc, never in a control body", () => {
    const control = code(source("device", "control-client.ts"));
    expect(control).toContain("{ code }");
    expect(control).toContain("{ blob }");
    expect(control).toContain("scopes: scopes.map(({ tag, kind }) => ({ tag, kind }))");
    expect(control).not.toMatch(/label|displayName/);
    const manifest = code(source("data", "manifest.ts"));
    expect(manifest).toContain('const DEVICES = "devices";');
    expect(manifest).toContain('const STREAMS = "streams";');
    expect(manifest).toContain('const PERIOD_KEYS = "period_keys";');
  });

  it("C10: no passphrase box is focused on load", () => {
    for (const file of [
      ["app", "LockScreen.tsx"],
      ["app", "setup", "PassphraseStep.tsx"],
    ]) {
      const text = code(source(...file));
      expect(text, file.join("/")).not.toMatch(/autoFocus|\.focus\(/);
    }
  });
});

describe("TEACH-73 HARD — EU-6 carry-forward: the App's lock locks the device", () => {
  it("lock() locks both sessions, then the device, and drops all of them", () => {
    const app = source("App.tsx");
    const lock = app.slice(app.indexOf("const lock = useCallback("));
    const body = lock.slice(0, lock.indexOf("}, []);"));
    expect(body).toContain("heldDevice?.lock();");
    expect(body).toContain("deviceRef.current = null;");
    expect(body).toContain("setupRef.current?.discardRecoveryCode();");
  });

  it("the session signs with the unlocked device's identity", () => {
    const port = code(source("device", "device-port.ts"));
    expect(port).toContain("signer: device, boxKeypair: device.boxKeypair()");
  });
});

describe("TEACH-73 FERPA re-gate — B1, B2, B3", () => {
  it("B1: once the vault is sealed, the App holds the setup's device under auto-lock and Lock", () => {
    const app = code(source("App.tsx"));
    const handOff = app.slice(app.indexOf("onVaultSealed={(handle) => {"));
    expect(handOff.slice(0, 300)).toContain("deviceRef.current = handle;");
    expect(handOff.slice(0, 300)).toContain("setDeviceOpen(true);");
    const hook = code(source("app", "setup", "useFirstSetup.ts"));
    expect(hook.match(/options\.onVaultSealed\(\);/g)).toHaveLength(2); // Tier P and Tier W
  });

  it("B2: only a definitive 404 from the list probe means 'not an owner' (A-1)", () => {
    const control = code(source("device", "control-client.ts"));
    const list = member(control, "async listDevices(): Promise<ListOutcome> {");
    expect(list).toContain("res?.status === 404");
    expect(list.indexOf("res?.status === 404")).toBeLessThan(list.indexOf('kind: "not_found"'));
    expect(list.match(/kind: "not_found"/g)).toHaveLength(1);
  });

  it("B3: an unreadable status after unlock locks the device and never opens the session", () => {
    const app = code(source("App.tsx"));
    const unlock = app.slice(app.indexOf("const afterUnlock = useCallback("));
    const failClosed = unlock.indexOf('status === null || status.kind === "none"');
    expect(failClosed).toBeGreaterThanOrEqual(0);
    expect(failClosed).toBeLessThan(unlock.indexOf("await openSession(handle);"));
    expect(unlock.slice(failClosed, failClosed + 400)).toContain("handle.lock();");
  });
});
