// First-device key material and master doc (device-enrollment-spec rev 2.5 §4.1 F1 steps
// 4 and 6, §3.3). Runs only after the relay answered the setup code with `mode: "first"`:
// a recovery redeem never reaches here, so it never mints an MK (§4.5, EU-7 HARD).
//
//   mintFirstDeviceGrant  — MK, the master scope tag and the master doc id, as a self-grant
//                           (MK sealed to this device's own box key).
//   initializeMasterDoc   — the period DEK, scope tag and para doc id, written into the
//                           master manifest (streams, period_keys under MK, devices with
//                           this device's name). On a QA/synthetic build ONLY, the synthetic
//                           caseload is written here too — never on a production build, and
//                           never anywhere else. Idempotent: a resumed setup reuses what the
//                           master doc already holds.
// Returns the scopes the device must self-grant, the master tag with kind `master`.

import {
  approveDeviceEnrollment,
  createEnrollmentRequest,
  type DeviceEnrollmentGrant,
  type DeviceKeypair,
  fromBase64,
  generateMasterKey,
  generatePeriodKey,
  TeacherKeyring,
  toBase64,
} from "@teacher-assistant/crypto";
import { asTimestamp, newOpaqueId, newScopeTag, type ScopeTag } from "@teacher-assistant/schema";
import { type PersistenceAdapter, RelayClient, type Transport } from "@teacher-assistant/sync";
import { activeStream, addDevice, addStream, readManifest } from "./manifest.js";
import { paraPeriodId } from "./para-publish.js";
import {
  isEmpty,
  readParaVisible,
  readRecords,
  upsertParaPending,
  writeRecords,
} from "./repository.js";
import { openStream, teacherKeyringFromGrant } from "./session.js";
import type { RequestSigner } from "@teacher-assistant/sync";
import { buildSyntheticSeed } from "./synthetic-seed.js";

/** A scope to self-grant at F1 step 6. */
export interface ScopeGrantRequest {
  readonly tag: ScopeTag;
  readonly kind: "master" | "period";
}

/** Thrown when the master doc has no entry for this device and no name was given (resume). */
export class DeviceNameRequiredError extends Error {
  constructor() {
    super("this device needs a name before setup can finish");
    this.name = "DeviceNameRequiredError";
  }
}

/**
 * F1 step 4 (keys): mint MK, the master scope tag and the master doc id, and seal MK to
 * this device's own box key — the self-grant the vault keeps. MK exists afterwards only
 * inside the sealed grant; the minting keyring is destroyed.
 */
export function mintFirstDeviceGrant(
  boxKeypair: DeviceKeypair,
  signingPublicKey: Uint8Array,
): DeviceEnrollmentGrant {
  const keyring = new TeacherKeyring(newScopeTag(), generateMasterKey());
  try {
    const { request, verificationCode } = createEnrollmentRequest({
      boxPublicKey: boxKeypair.publicKey,
      signingPublicKey,
    });
    return approveDeviceEnrollment(keyring, request, verificationCode, newOpaqueId());
  } finally {
    keyring.destroy();
  }
}

export interface InitializeMasterInput {
  readonly boxKeypair: DeviceKeypair;
  readonly signer: RequestSigner;
  readonly grant: DeviceEnrollmentGrant;
  readonly persistence: PersistenceAdapter;
  /** Transport for the engines (setup does not sync; nothing is sent from here). */
  readonly transport: Transport;
  /** This device's name from the fixed list; needed only when the manifest lacks it. */
  readonly label: string | undefined;
  readonly now: Date;
  /** QA/synthetic build: write the synthetic caseload. Never true on a production build. */
  readonly synthetic: boolean;
}

/**
 * F1 step 4 (master doc): ensure the master manifest has a para stream (period DEK wrapped
 * under MK) and this device's entry, then return the scopes to self-grant: the master tag
 * (kind `master`) and the active period tag (kind `period`). Writes are local ciphertext;
 * the first sync pushes them.
 */
export async function initializeMasterDoc(
  input: InitializeMasterInput,
): Promise<readonly ScopeGrantRequest[]> {
  const keyring = teacherKeyringFromGrant(input.boxKeypair, input.grant);
  try {
    const relay = new RelayClient({ transport: input.transport, signer: input.signer });
    const master = await openStream(
      input.grant.masterDocId,
      keyring.masterScopeTag,
      keyring,
      relay,
      input.persistence,
    );
    const seed = input.synthetic ? buildSyntheticSeed(input.now) : null;
    if (seed !== null && isEmpty(master.stream.doc)) {
      await master.engine.capture((doc) => writeRecords(doc, seed.master));
    }
    const manifest = readManifest(master.stream.doc);
    for (const [scopeTag, wrapped] of manifest.periodKeys) {
      keyring.addWrappedPeriodKey(scopeTag, fromBase64(wrapped));
    }
    let active = activeStream(manifest);
    if (active === null) {
      const periodKey = generatePeriodKey(newScopeTag());
      keyring.addPeriodKey(periodKey);
      const entry = {
        paraDocId: newOpaqueId(),
        periodId: paraPeriodId(readRecords(master.stream.doc)),
        retired: false,
      };
      const wrapped = toBase64(keyring.wrapScopeKeyUnderMaster(periodKey.scopeTag));
      await master.engine.capture((doc) => addStream(doc, periodKey.scopeTag, entry, wrapped));
      active = { scopeTag: periodKey.scopeTag, entry };
    }
    const self = toBase64(input.signer.publicKey);
    if (!manifest.devices.has(self)) {
      const label = input.label;
      if (label === undefined) {
        throw new DeviceNameRequiredError();
      }
      const entry = {
        label,
        role: "teacher" as const,
        enrolledAt: asTimestamp(input.now.getTime()),
      };
      await master.engine.capture((doc) => addDevice(doc, self, entry));
    }
    if (seed !== null) {
      const para = await openStream(
        active.entry.paraDocId,
        active.scopeTag,
        keyring,
        relay,
        input.persistence,
      );
      if (readParaVisible(para.stream.doc).pending.length === 0) {
        for (const pending of seed.paraPending) {
          await para.engine.capture((doc) => upsertParaPending(doc, pending));
        }
      }
    }
    return [
      { tag: keyring.masterScopeTag, kind: "master" },
      { tag: active.scopeTag, kind: "period" },
    ];
  } finally {
    keyring.destroy();
  }
}
