// Node-realm test helper: the material an unlocked, set-up first teacher device hands the
// session (device-enrollment-spec §3.1, §4.1) — without WebAuthn or IndexedDB vault code.
// It runs the same F1 steps the app does (mintFirstDeviceGrant, initializeMasterDoc) on
// in-memory keys, so a session test opens exactly what first setup wrote.

import {
  generateDeviceKeypair,
  generateSigningKeypair,
  sodiumReady,
} from "@teacher-assistant/crypto";
import {
  keypairSigner,
  type PersistenceAdapter,
  type RelayHttpResponse,
  type Transport,
} from "@teacher-assistant/sync";
import { initializeMasterDoc, mintFirstDeviceGrant } from "../data/first-device.js";
import type { TeacherVault } from "../data/session.js";

/** A transport that answers nothing: setup never syncs, so it must never be called. */
const NO_RELAY: Transport = (): Promise<RelayHttpResponse> =>
  Promise.reject(new Error("no relay in this test"));

/** A first teacher device after F1: its vault material, with the master doc written. */
export async function firstTeacherVault(
  persistence: PersistenceAdapter,
  options: { readonly now: Date; readonly synthetic?: boolean },
): Promise<TeacherVault> {
  await sodiumReady();
  const boxKeypair = generateDeviceKeypair();
  const signing = generateSigningKeypair();
  const signer = keypairSigner(signing);
  const grant = mintFirstDeviceGrant(boxKeypair, signing.publicKey);
  await initializeMasterDoc({
    boxKeypair,
    signer,
    grant,
    persistence,
    transport: NO_RELAY,
    label: "Phone",
    now: options.now,
    synthetic: options.synthetic ?? true,
  });
  return { signer, boxKeypair, grant };
}
