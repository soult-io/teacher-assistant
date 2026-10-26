// First setup on the first teacher device — F1 (device-enrollment-spec rev 2.5 §4.1, §13
// A-1/A-2/A-8, §11 EU-7). The UI (app/setup) drives these steps in the flows' order:
//
//   S1a name → S2 createPasskey(label)   passkey named after the device, created before
//                                         anything else; the test get() picks the tier
//   S3       → sealVault(passphrase?)     keys generated once, sealed; stage keys_created
//   (code)   → redeem(code)               signed redeem; stage redeemed + mode
//            → finish(label)              mode "first" only: MK, master doc, self-grant of
//                                         the master tag as kind `master`; stage scopes_granted
//   S4       → issueRecoveryCode()        stage recovery_pending, wrap uploaded, code shown
//                                         only after the relay acknowledged it (A-2)
//   S5       → confirmRecoveryCode(typed) last two groups re-typed; stage done
//
// The setup stage is written to the device record BEFORE each network step and holds only
// the stage, the mode and when it was written. The setup code and the recovery code are
// held in memory only and never written anywhere on the device.
//
// `mode: "recovery"` (an owner or a master tag already exists) never mints an MK: finish()
// refuses it, and the relay refuses a second master tag anyway (F1 step 6).

import {
  generateRecoveryCode,
  normalizeRecoveryCode,
  toBase64,
  type VaultTier,
  wrapRecoveryBundle,
  completeDeviceEnrollment,
  zeroize,
} from "@teacher-assistant/crypto";
import { type PersistenceAdapter, RelayClient, type Transport } from "@teacher-assistant/sync";
import { initializeMasterDoc, mintFirstDeviceGrant } from "../data/first-device.js";
import { ControlClient, type ListedDevice } from "./control-client.js";
import type { DeviceStore, SetupStage, SetupStageName } from "./device-store.js";
import { passkeyDisplayName, type PasskeyPrfPort, type TeacherDeviceLabel } from "./passkey-prf.js";
import type { PlatformEnv } from "./platform.js";
import { createDeviceVault, probeTier, type TierProbe, type UnlockedDevice } from "./vault.js";

/** How long a setup code lasts (the relay's OWNER_CODE_TTL): the A-8 resume window before redeem. */
export const SETUP_CODE_TTL_MS = 24 * 60 * 60 * 1000;

/** The recovery code is re-typed by its last two groups of four (flows S5). */
const CONFIRM_CHARS = 8;

/** Thrown when the relay definitively refuses the self-grant: retrying cannot help. */
export class SetupRefusedError extends Error {
  constructor() {
    super("Setup can't finish on this device — text Neil.");
    this.name = "SetupRefusedError";
  }
}

/** Thrown when a step needs the network and the relay gave no definite answer. */
export class SetupOfflineError extends Error {
  constructor() {
    super("Connect to the internet to finish setup.");
    this.name = "SetupOfflineError";
  }
}

/** Where the device stands when the app opens (before any unlock). */
export type DeviceStatus =
  | {
      readonly kind: "none";
      /** True when an unfinished setup was cleared just now (A-8: code expired, or an interrupted recovery). */
      readonly cleared: boolean;
    }
  | {
      readonly kind: "enrolled";
      readonly tier: VaultTier;
      /** `done` for a finished device; any other stage resumes setup after the unlock. */
      readonly stage: SetupStageName;
    };

/**
 * Read the device's state and apply the A-8 rules that need no unlock: a setup that never
 * got its code accepted is wiped once the code's 24 h have passed (no relay row exists), and
 * an interrupted recovery is wiped (F5 has no resume after redeem). A post-redeem first
 * setup is never wiped: that would leave an orphan owner on the relay.
 */
export async function readDeviceStatus(
  store: DeviceStore,
  now: number = Date.now(),
): Promise<DeviceStatus> {
  const record = await store.load();
  if (record === null) {
    return { kind: "none", cleared: false };
  }
  const stage = record.setupStage;
  const expired = stage?.stage === "keys_created" && now - stage.at > SETUP_CODE_TTL_MS;
  const interruptedRecovery = stage?.mode === "recovery" && stage.stage !== "done";
  if (expired || interruptedRecovery) {
    await store.wipe();
    return { kind: "none", cleared: true };
  }
  return { kind: "enrolled", tier: record.tier, stage: stage?.stage ?? "done" };
}

/**
 * A-1 / relay rule: the redeem landed as `first` only if no active owner other than this
 * device exists and no master tag is registered; anything else is `recovery`.
 */
export function inferRedeemMode(
  devices: readonly ListedDevice[],
  self: string,
): "first" | "recovery" {
  const otherOwner = devices.some(
    (d) => d.device !== self && d.role === "owner" && d.status === "active",
  );
  const masterTag = devices.some((d) => d.scopes.some((s) => s.kind === "master"));
  return otherOwner || masterTag ? "recovery" : "first";
}

export type RedeemStep = "first" | "recovery" | "refused" | "rate_limited" | "offline";

export interface FirstSetupDeps {
  readonly store: DeviceStore;
  readonly passkey: PasskeyPrfPort;
  /** Relay transport (fetch in the app, Fastify inject in tests). */
  readonly transport: Transport;
  readonly persistence: PersistenceAdapter;
  /** QA/synthetic build: write the synthetic caseload at F1. False on a production build. */
  readonly synthetic: boolean;
  readonly platform?: PlatformEnv;
  readonly now?: () => number;
}

/**
 * One first-setup run on this device. Holds the unlocked device and the one-time values
 * (probe, name, recovery code) in memory only. Built fresh for a new device, or around the
 * device the unlock just opened when a setup resumes (any resume needs the full unlock).
 */
export class FirstSetup {
  readonly #deps: FirstSetupDeps;
  #device: UnlockedDevice | null;
  #probe: TierProbe | null = null;
  #label: TeacherDeviceLabel | undefined;
  #recoveryCode: string | null = null;

  constructor(deps: FirstSetupDeps, device: UnlockedDevice | null = null) {
    this.#deps = deps;
    this.#device = device;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #unlocked(): UnlockedDevice {
    if (this.#device === null || this.#device.locked) {
      throw new Error("setup needs the unlocked device");
    }
    return this.#device;
  }

  #control(): ControlClient {
    return new ControlClient(
      new RelayClient({ transport: this.#deps.transport, signer: this.#unlocked() }),
    );
  }

  async #writeStage(stage: SetupStageName, mode?: "first" | "recovery"): Promise<void> {
    this.#unlocked(); // a lock ends this run: a late step never moves the stage
    const next: SetupStage =
      mode === undefined ? { stage, at: this.#now() } : { stage, mode, at: this.#now() };
    await this.#deps.store.update((record) => ({
      ...record,
      setupStage: next,
      enrolled: record.enrolled || stage !== "keys_created",
    }));
  }

  async #stage(): Promise<SetupStage | undefined> {
    return (await this.#deps.store.load())?.setupStage;
  }

  /** The device this setup unlocked (for the session once setup is done). */
  get device(): UnlockedDevice {
    return this.#unlocked();
  }

  /** The device's name, when this run knows it (chosen at S1a). */
  get label(): TeacherDeviceLabel | undefined {
    return this.#label;
  }

  /** S1a: the device's name. Also asked again on a resume that lost it. */
  setLabel(label: TeacherDeviceLabel): void {
    this.#label = label;
  }

  /**
   * S2: create the passkey under the device's name (chosen first, DN-1a) and run the test
   * get(). Returns the tier: `passphrase` means S3 comes next (C8).
   */
  async createPasskey(): Promise<VaultTier> {
    if (this.#label === undefined) {
      throw new Error("name the device before its passkey is created");
    }
    const name = passkeyDisplayName(this.#label, new Date(this.#now()));
    this.#probe = await probeTier(this.#deps.passkey, name, this.#deps.platform);
    return this.#probe.tier;
  }

  /** After S2 (Tier P) or S3 (Tier W): generate the device keys and seal the vault. */
  async sealVault(passphrase?: string): Promise<{ readonly persisted: boolean }> {
    if (this.#probe === null) {
      throw new Error("create the passkey first");
    }
    const { device, persisted } = await createDeviceVault({
      store: this.#deps.store,
      probe: this.#probe,
      role: "teacher",
      ...(passphrase === undefined ? {} : { passphrase }),
      ...(this.#deps.platform === undefined ? {} : { platform: this.#deps.platform }),
      now: () => this.#now(),
    });
    this.#probe = null; // createDeviceVault consumed (zeroized) any PRF output
    this.#device = device;
    return { persisted };
  }

  /**
   * F1 step 5 with the A-1 rules. Before any redeem, `devices/list` is probed: a 200 means an
   * earlier redeem already landed (mode from the relay rule), a 404 means it did not and the
   * code is redeemed now, with the same key. An unknowable outcome is `offline` and redeem is
   * not retried until a later probe answers 404.
   */
  async redeem(code: string): Promise<RedeemStep> {
    const known = await this.#stage();
    if (known !== undefined && known.stage !== "keys_created" && known.mode !== undefined) {
      return known.mode;
    }
    const control = this.#control();
    const self = toBase64(this.#unlocked().publicKey);
    const probe = await control.listDevices();
    if (probe.kind === "ambiguous") {
      return "offline";
    }
    if (probe.kind === "ok") {
      const mode = inferRedeemMode(probe.devices, self);
      await this.#writeStage("redeemed", mode);
      return mode;
    }
    const outcome = await control.redeem(code);
    switch (outcome.kind) {
      case "redeemed":
        await this.#writeStage("redeemed", outcome.mode);
        return outcome.mode;
      case "ambiguous":
        return "offline";
      case "rate_limited":
        return "rate_limited";
      case "refused":
        return "refused";
    }
  }

  /**
   * F1 steps 4 and 6, for `mode: "first"` only: mint the self-grant (unless the vault already
   * holds one from an interrupted run), write the master manifest, then self-grant the master
   * tag as kind `master` and the period tag. A recovery redeem is refused here: no MK is
   * ever minted for it.
   */
  async finish(): Promise<void> {
    const stage = await this.#stage();
    if (stage?.mode !== "first") {
      throw new Error("only a first-device redeem can mint the master key");
    }
    if (stage.stage !== "redeemed") {
      return; // the scopes were granted already
    }
    const device = this.#unlocked();
    const { store } = this.#deps;
    let stored = await device.readGrant(store);
    if (stored === null) {
      const grant = mintFirstDeviceGrant(device.boxKeypair(), device.publicKey);
      await device.storeGrant(store, { role: "teacher", grant });
      stored = { role: "teacher", grant };
    }
    if (stored.role !== "teacher") {
      throw new Error("a teacher setup holds a para grant");
    }
    const scopes = await initializeMasterDoc({
      boxKeypair: device.boxKeypair(),
      signer: device,
      grant: stored.grant,
      persistence: this.#deps.persistence,
      transport: this.#deps.transport,
      label: this.#label,
      now: new Date(this.#now()),
      synthetic: this.#deps.synthetic,
    });
    const granted = await this.#control().grant(toBase64(device.publicKey), scopes);
    if (granted === "refused") {
      throw new SetupRefusedError();
    }
    if (granted !== "ok") {
      throw new SetupOfflineError();
    }
    await this.#writeStage("scopes_granted", "first");
  }

  /**
   * S4 (F1 step 7, A-2): a fresh recovery code, its wrap of {MK, master tag, master doc id}
   * stored on the relay (overwriting any earlier, unconfirmed one). The code is returned
   * only after the relay acknowledged the wrap; otherwise it is dropped and the stage stays
   * `recovery_pending`, so the next try issues a new one.
   */
  async issueRecoveryCode(): Promise<string> {
    const device = this.#unlocked();
    this.discardRecoveryCode();
    await this.#writeStage("recovery_pending", "first");
    const stored = await device.readGrant(this.#deps.store);
    if (stored?.role !== "teacher") {
      throw new Error("no teacher grant to back up");
    }
    const { mk, masterScopeTag } = completeDeviceEnrollment(device.boxKeypair(), stored.grant);
    const code = generateRecoveryCode();
    let wrap: string;
    try {
      const sealed = wrapRecoveryBundle(
        { mk, masterScopeTag, masterDocId: stored.grant.masterDocId },
        code,
      );
      wrap = `${sealed.saltB64}.${sealed.blobB64}`;
    } finally {
      zeroize(mk);
    }
    if ((await this.#control().putRecoveryWrap(wrap)) !== "ok") {
      throw new SetupOfflineError();
    }
    if (device.locked) {
      throw new Error("the device locked while the wrap was stored"); // a lock drops the code
    }
    this.#recoveryCode = code;
    return code;
  }

  /** S5: the last two groups re-typed from paper. A match finishes setup. */
  async confirmRecoveryCode(typed: string): Promise<boolean> {
    const code = this.#recoveryCode;
    if (code === null) {
      return false;
    }
    const expected = normalizeRecoveryCode(code).slice(-CONFIRM_CHARS);
    if (normalizeRecoveryCode(typed) !== expected) {
      return false;
    }
    await this.#writeStage("done", "first");
    this.discardRecoveryCode();
    return true;
  }

  /** Drop the recovery code from memory (leaving S4/S5, or a lock). */
  discardRecoveryCode(): void {
    this.#recoveryCode = null;
  }
}
