// Adding a teacher device by pairing — F2, E1 direction (device-enrollment-spec rev 2.7
// DN-2, §4.2, §7 and §11 EU-8, §13 A-4/A-5). Release 1 pairs Niah's own devices only; the
// para path (F3) is release 2, so the approver here only ever adds a `teacher` device.
//
//   A (trusted, unlocked)                         B (new device)
//   open()     S → sid, K; POST pairing/open      begin(code)  S → sid, K (S dropped)
//              shows S as a QR / typed code       setLabel     name, before the passkey
//                                                 createPasskey, sealVault → the matching
//                                                              code, shown BEFORE posting
//   poll()     request-get, fetched ONCE,     ◀── postRequest  AEAD_K({keys, nonce, label})
//              opened with K; the label is
//              checked HERE, before anything
//   checkCode  3 tries (A-4), compared locally
//   approve    FRESH unlock; grant from the
//              freshly opened vault; grant-put ──▶ poll()      grant-get, opened with K;
//              then the name into the master                   grant + stage done stored
//              `devices` map                                   in one record write
//
// S, K, the sid, the fetched request and the tries counter live in memory only: a reload,
// a lock, a cancel, the 3rd miss or the end of the run zeroizes them and abandons the
// session (§13 rev 2.4 EU-8). grant-put is never called for a request whose name is not in
// the fixed list or not a teacher name, nor after the 3rd miss. The device name reaches
// the relay only inside the AEAD_K request blob, and the stored name only inside the MK
// master doc (§3.3).

import {
  approveDeviceEnrollment,
  createEnrollmentRequest,
  decodePairingSecret,
  encodePairingSecret,
  type EnrollmentRequest,
  fromBase64,
  newPairingSecret,
  openLabelledEnrollmentRequest,
  openTeacherGrant,
  pairingKey,
  PairingError,
  pairingSid,
  sealLabelledEnrollmentRequest,
  sealTeacherGrant,
  toBase64,
  type VaultTier,
  verificationCodeMatches,
  zeroize,
} from "@teacher-assistant/crypto";
import { asTimestamp } from "@teacher-assistant/schema";
import { RelayClient, type RequestSigner, type Transport } from "@teacher-assistant/sync";
import type { DeviceEntry } from "../data/manifest.js";
import { teacherKeyringFromGrant } from "../data/session.js";
import { ControlClient, type ScopeGrant } from "./control-client.js";
import type { DeviceStore } from "./device-store.js";
import {
  type DeviceLabel,
  isDeviceLabel,
  labelRole,
  passkeyDisplayName,
  type PasskeyPrfPort,
} from "./passkey-prf.js";
import type { PlatformEnv } from "./platform.js";
import { PAIRING_TTL_MS } from "./pairing-limits.js";
import { type ReleaseSetupLock, SetupBusyError, type SetupLockPort } from "./setup-lock.js";
import {
  createDeviceVault,
  probeTier,
  type TierProbe,
  unlockDevice,
  type UnlockedDevice,
} from "./vault.js";

export { PAIRING_TTL_MS };
/** Wrong matching codes allowed per session; the 3rd abandons it (spec §13 A-4). */
export const MATCH_TRIES = 3;

function control(transport: Transport, signer: RequestSigner): ControlClient {
  return new ControlClient(new RelayClient({ transport, signer }));
}

// ── A: the trusted device ───────────────────────────────────────────────────────────

/** What the approver needs from the open teacher session (the master doc). */
export interface PairingSession {
  /** Every active scope this device holds, with its kind: the master tag and live periods. */
  pairingScopes(): readonly ScopeGrant[];
  /** Write a device's name into the master `devices` map (MK-encrypted) and sync it. */
  addDevice(signPkB64: string, entry: DeviceEntry): Promise<void>;
}

export interface ApproverDeps {
  readonly store: DeviceStore;
  readonly passkey: PasskeyPrfPort;
  readonly transport: Transport;
  /** The unlocked device: signs open and request-get. */
  readonly device: RequestSigner;
  readonly session: PairingSession;
  readonly now?: () => number;
}

export type OpenOutcome =
  | {
      readonly kind: "open";
      /** The typed fallback (52 Crockford characters in groups); the QR carries the same text. */
      readonly code: string;
      readonly expiresAt: number;
    }
  | { readonly kind: "too_many" }
  | { readonly kind: "offline" };

export type PollOutcome =
  | { readonly kind: "waiting" }
  | { readonly kind: "arrived"; readonly label: DeviceLabel }
  | { readonly kind: "expired" }
  | { readonly kind: "interrupted" };

export type CodeOutcome = "match" | "mismatch" | "stopped";

export type ApproveOutcome =
  | { readonly kind: "added"; readonly label: DeviceLabel }
  | { readonly kind: "expired" }
  | { readonly kind: "interrupted" }
  | { readonly kind: "offline" };

interface ArrivedRequest {
  readonly request: EnrollmentRequest;
  readonly label: DeviceLabel;
}

/**
 * One pairing session on the trusted device. Single use: after approve(), the 3rd wrong
 * code, an expiry, a bad request or abandon(), every call reports the session as over.
 */
export class PairingApprover {
  readonly #deps: ApproverDeps;
  /** The role this session adds. Release 1: teacher only. */
  readonly #role = "teacher" as const;
  #secret: Uint8Array | null = null;
  #key: Uint8Array | null = null;
  #sid: string | null = null;
  #openedAt = 0;
  #arrived: ArrivedRequest | null = null;
  #matched: string | null = null;
  #misses = 0;
  #approving = false;
  #over = false;

  constructor(deps: ApproverDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #expired(): boolean {
    return this.#now() - this.#openedAt >= PAIRING_TTL_MS;
  }

  /** True once the session can do nothing more. */
  get over(): boolean {
    return this.#over;
  }

  /** F2 step 1: a fresh S, its mailbox opened on the relay. */
  async open(): Promise<OpenOutcome> {
    if (this.#over || this.#secret !== null) {
      throw new Error("a pairing session opens once");
    }
    const secret = newPairingSecret();
    const sid = pairingSid(secret);
    const outcome = await control(this.#deps.transport, this.#deps.device).openPairingSession(sid);
    if (outcome !== "ok" || this.#over) {
      // Refused, no answer, or abandoned (a lock, Cancel) while the relay answered: S never
      // lands on this object. An opened mailbox simply expires on the relay.
      zeroize(secret);
      this.#over = true;
      return { kind: outcome === "refused" ? "too_many" : "offline" };
    }
    this.#secret = secret;
    this.#key = pairingKey(secret);
    this.#sid = sid;
    this.#openedAt = this.#now();
    return {
      kind: "open",
      code: encodePairingSecret(secret),
      expiresAt: this.#openedAt + PAIRING_TTL_MS,
    };
  }

  /**
   * F2 step 3: B's request, fetched once. A blob that fails AEAD, or a name that is not in
   * the fixed list or not a teacher name, ends the session here: nothing is granted.
   */
  async poll(): Promise<PollOutcome> {
    if (this.#arrived !== null && !this.#over) {
      return { kind: "arrived", label: this.#arrived.label };
    }
    const session = this.#live();
    if (session === null) {
      return { kind: "interrupted" };
    }
    if (this.#expired()) {
      this.abandon();
      return { kind: "expired" };
    }
    const read = await control(this.#deps.transport, this.#deps.device).getPairingRequest(
      session.sid,
    );
    if (read.kind !== "blob") {
      return { kind: "waiting" }; // not posted yet, or no answer: the TTL decides
    }
    const live = this.#live();
    if (live === null) {
      return { kind: "interrupted" }; // abandoned while the read was in flight
    }
    let opened: { readonly request: EnrollmentRequest; readonly label: string };
    try {
      opened = openLabelledEnrollmentRequest(live.key, live.sid, fromBase64(read.blob));
    } catch {
      this.abandon();
      return { kind: "interrupted" };
    }
    const { label } = opened;
    if (!isDeviceLabel(label) || labelRole(label) !== this.#role) {
      this.abandon(); // spec §4.2 step 3: before any grant-put, never after
      return { kind: "interrupted" };
    }
    this.#arrived = { request: opened.request, label };
    return { kind: "arrived", label };
  }

  /**
   * A-4: compare a typed matching code with the one request fetched. The 3rd miss
   * abandons the session. Never says which characters were wrong.
   */
  checkCode(typed: string): CodeOutcome {
    if (this.#over || this.#arrived === null) {
      return "stopped";
    }
    if (verificationCodeMatches(this.#arrived.request, typed)) {
      this.#matched = typed;
      return "match";
    }
    this.#misses += 1;
    if (this.#misses >= MATCH_TRIES) {
      this.abandon();
      return "stopped";
    }
    return "mismatch";
  }

  /**
   * F2 step 4, after a matching code: the full unlock ceremony again (passkey with UV and,
   * on Tier W, the passphrase), even though the device is unlocked. The grant is built from
   * the vault this fresh unlock opened, posted with grant-put, and the new device's name is
   * written into the master `devices` map. An unlock that fails (cancelled, wrong
   * passphrase, backoff) throws and leaves the session as it was, so she can retry.
   */
  async approve(passphrase?: string): Promise<ApproveOutcome> {
    const arrived = this.#arrived;
    const matched = this.#matched;
    if (this.#over || arrived === null || matched === null) {
      throw new Error("type the matching code first");
    }
    if (this.#approving) {
      throw new Error("an approval is already running"); // one approve per session
    }
    if (this.#expired()) {
      this.abandon();
      return { kind: "expired" };
    }
    this.#approving = true;
    let fresh: UnlockedDevice;
    try {
      fresh = await unlockDevice({
        store: this.#deps.store,
        passkey: this.#deps.passkey,
        ...(passphrase === undefined ? {} : { passphrase }),
        now: () => this.#now(),
      });
    } catch (err) {
      this.#approving = false; // a failed unlock leaves the session as it was: retry on A3
      throw err;
    }
    try {
      return await this.#grant(fresh, arrived, matched);
    } finally {
      fresh.lock();
      this.abandon();
    }
  }

  /**
   * The session's key and sid while it is live, else null. Checked after every wait in
   * #grant: abandon() zeroizes K in place, so a lock that lands during a wait must stop
   * the grant before anything is sealed or sent.
   */
  #live(): { readonly key: Uint8Array; readonly sid: string } | null {
    return this.#over || this.#key === null || this.#sid === null
      ? null
      : { key: this.#key, sid: this.#sid };
  }

  async #grant(
    fresh: UnlockedDevice,
    arrived: ArrivedRequest,
    matched: string,
  ): Promise<ApproveOutcome> {
    if (this.#live() === null) {
      return { kind: "interrupted" }; // abandoned (a lock) during the unlock ceremony
    }
    const stored = await fresh.readGrant(this.#deps.store);
    if (stored?.role !== "teacher") {
      throw new Error("only a teacher device can add a device");
    }
    // The name goes into the master `devices` map BEFORE grant-put, so a device the relay
    // enrolls is always named, even if a lock lands while grant-put is out. If grant-put is
    // then refused, the entry names a key the relay never enrolled; the Devices screen
    // lists relay keys only (EU-9), so it never shows.
    const device = arrived.request.signingPublicKeyB64;
    await this.#deps.session.addDevice(device, {
      label: arrived.label,
      role: this.#role,
      enrolledAt: asTimestamp(this.#now()),
    });
    const live = this.#live();
    if (live === null) {
      return { kind: "interrupted" }; // a lock during the reads: K is zeroized, send nothing
    }
    const keyring = teacherKeyringFromGrant(fresh.boxKeypair(), stored.grant);
    let blob: string;
    try {
      const grant = approveDeviceEnrollment(
        keyring,
        arrived.request,
        matched,
        stored.grant.masterDocId,
      );
      blob = toBase64(sealTeacherGrant(live.key, live.sid, grant));
    } finally {
      keyring.destroy();
    }
    // No wait between the check above and this send: nothing can zeroize K in between.
    const outcome = await control(this.#deps.transport, fresh).putPairingGrant({
      sid: live.sid,
      device,
      role: this.#role,
      scopes: this.#deps.session.pairingScopes(),
      blob,
    });
    switch (outcome) {
      case "ok":
        return { kind: "added", label: arrived.label };
      case "refused":
        return { kind: "interrupted" };
      case "ambiguous":
        return { kind: "offline" };
    }
  }

  /** End the session: zeroize S and K, drop the request and the counter. Idempotent. */
  abandon(): void {
    this.#over = true;
    if (this.#secret !== null) {
      zeroize(this.#secret);
    }
    if (this.#key !== null) {
      zeroize(this.#key);
    }
    this.#secret = null;
    this.#key = null;
    this.#sid = null;
    this.#arrived = null;
    this.#matched = null;
  }
}

// ── B: the new device ───────────────────────────────────────────────────────────────

export interface JoinDeps {
  readonly store: DeviceStore;
  readonly passkey: PasskeyPrfPort;
  readonly transport: Transport;
  readonly setupLock: SetupLockPort;
  readonly platform?: PlatformEnv;
  readonly now?: () => number;
}

export type PostOutcome = "waiting" | "interrupted";
export type JoinPollOutcome = "waiting" | "done" | "interrupted";

/**
 * The new device's side of one pairing. Keys, vault and record are made here exactly as in
 * first setup, but the record's stage is `pairing` until the grant arrives; any failure
 * discards them (the record is wiped and the device locked), so nothing half-made stays.
 */
export class PairingJoin {
  readonly #deps: JoinDeps;
  #key: Uint8Array | null = null;
  #sid: string | null = null;
  #startedAt = 0;
  #label: DeviceLabel | undefined;
  #probe: TierProbe | null = null;
  #device: UnlockedDevice | null = null;
  #request: EnrollmentRequest | null = null;
  #release: ReleaseSetupLock | null = null;
  #posted: Promise<PostOutcome> | null = null;
  #over = false;

  constructor(deps: JoinDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** The device this pairing made, once its vault is sealed. */
  get device(): UnlockedDevice {
    if (this.#device === null || this.#device.locked) {
      throw new Error("pairing needs the unlocked device");
    }
    return this.#device;
  }

  get label(): DeviceLabel | undefined {
    return this.#label;
  }

  /**
   * B1: the scanned (or typed) square code. Returns false for a code that does not decode.
   * Only sid and K are kept; S itself is zeroized at once.
   */
  begin(code: string): boolean {
    if (this.#over || this.#key !== null) {
      throw new Error("a pairing starts once");
    }
    let secret: Uint8Array;
    try {
      secret = decodePairingSecret(code);
    } catch (err) {
      if (err instanceof PairingError) {
        return false;
      }
      throw err;
    }
    this.#sid = pairingSid(secret);
    this.#key = pairingKey(secret);
    zeroize(secret);
    this.#startedAt = this.#now();
    return true;
  }

  /** B1a: the device's name from the combined list, before any passkey exists. */
  setLabel(label: DeviceLabel): void {
    this.#label = label;
  }

  /** B2: the passkey under the device's name, and the test get() that picks the tier. */
  async createPasskey(): Promise<VaultTier> {
    if (this.#label === undefined || this.#key === null) {
      throw new Error("scan the code and name the device first");
    }
    if (this.#release === null) {
      this.#release = await this.#deps.setupLock.tryAcquire();
      if (this.#release === null) {
        throw new SetupBusyError();
      }
    }
    const name = passkeyDisplayName(this.#label, new Date(this.#now()));
    this.#probe = await probeTier(this.#deps.passkey, name, this.#deps.platform);
    return this.#probe.tier;
  }

  /**
   * After B2 (Tier P) or S3 (Tier W): the keys, the vault and the record (stage
   * `pairing`), then the matching code. No network call: the screen shows the code
   * BEFORE postRequest() sends anything (spec §4.2 step 2).
   */
  async sealVault(
    passphrase?: string,
  ): Promise<{ readonly persisted: boolean; readonly code: string }> {
    const label = this.#label;
    if (this.#probe === null || label === undefined) {
      throw new Error("create the passkey first");
    }
    const { device, persisted } = await createDeviceVault({
      store: this.#deps.store,
      probe: this.#probe,
      role: labelRole(label),
      ...(passphrase === undefined ? {} : { passphrase }),
      ...(this.#deps.platform === undefined ? {} : { platform: this.#deps.platform }),
      now: () => this.#now(),
      stage: "pairing",
    });
    this.#probe = null; // createDeviceVault consumed (zeroized) any PRF output
    this.#device = device;
    const { request, verificationCode } = createEnrollmentRequest({
      boxPublicKey: device.boxKeypair().publicKey,
      signingPublicKey: device.publicKey,
    });
    this.#request = request;
    return { persisted, code: verificationCode };
  }

  /** F2 step 2: post the sealed, labelled request. A refusal or no answer discards the device. */
  postRequest(): Promise<PostOutcome> {
    // Once per pairing: the relay refuses a second put for a slot (first write wins), and a
    // screen effect that runs twice must not turn that refusal into a discard.
    this.#posted ??= this.#post();
    return this.#posted;
  }

  async #post(): Promise<PostOutcome> {
    const key = this.#key;
    const sid = this.#sid;
    const request = this.#request;
    const label = this.#label;
    if (this.#over || key === null || sid === null || request === null || label === undefined) {
      return "interrupted";
    }
    const blob = toBase64(sealLabelledEnrollmentRequest(key, sid, request, label));
    const outcome = await control(this.#deps.transport, this.device).putPairingRequest(sid, blob);
    if (outcome === "refused") {
      await this.discard(); // taken, expired or unknown
      return "interrupted";
    }
    // `ambiguous` (no answer) may still have landed, and her matching code is already on
    // screen: keep waiting for the grant. If it never comes, the 10 minutes end it.
    return "waiting";
  }

  /**
   * F2 step 5: the grant, once A approved. Stored with stage `done` in one record write.
   * Past the session's 10 minutes, or for a grant that does not verify, the device is
   * discarded.
   */
  async poll(): Promise<JoinPollOutcome> {
    const key = this.#key;
    const sid = this.#sid;
    if (this.#over || key === null || sid === null || this.#device === null) {
      return "interrupted";
    }
    if (this.#now() - this.#startedAt >= PAIRING_TTL_MS) {
      await this.discard();
      return "interrupted";
    }
    const read = await control(this.#deps.transport, this.device).takePairingGrant(sid);
    if (read.kind !== "blob") {
      return "waiting";
    }
    if (this.#over || this.#device.role !== "teacher") {
      await this.discard(); // release 1 pairs teacher devices only
      return "interrupted";
    }
    try {
      const grant = openTeacherGrant(key, sid, fromBase64(read.blob));
      await this.#device.storePairedGrant(
        this.#deps.store,
        { role: "teacher", grant },
        this.#now(),
      );
    } catch {
      await this.discard();
      return "interrupted";
    }
    this.#finish();
    return "done";
  }

  #finish(): void {
    this.#over = true;
    if (this.#key !== null) {
      zeroize(this.#key);
    }
    this.#key = null;
    this.#sid = null;
    this.#request = null;
    this.#release?.();
    this.#release = null;
  }

  /**
   * Stop and throw away what this pairing made: K, the device keys, the record. Used on
   * every failure and on a lock or cancel before the grant arrived. Idempotent, and a
   * no-op once the grant is stored.
   */
  async discard(): Promise<void> {
    if (this.#over) {
      return; // already discarded, or done: a finished device is never wiped here
    }
    const device = this.#device;
    this.#device = null;
    if (this.#probe?.prf != null) {
      zeroize(this.#probe.prf);
    }
    this.#probe = null;
    device?.lock();
    const madeRecord = device !== null;
    const release = this.#release;
    this.#release = null; // #finish must not release a lock the wipe still needs
    this.#finish();
    try {
      if (madeRecord) {
        await this.#deps.store.wipe();
      }
    } finally {
      release?.();
    }
  }
}
