// @teacher-assistant/crypto — M0 crypto / identity / keyring core.
//
// Client-side only. The server (sync-relay) never imports this package and never
// receives an unwrapped key (asserted by the FERPA-guard suite). Call
// `sodiumReady()` once before using any operation.
//
// Invariants this module enforces (architecture §1.4, D-ARCH-1, D-ARCH-FERPA):
//   - Two key tiers: master key (teacher-only) + per-period DEK (para-scoped).
//   - A para keyring cannot decrypt goal definitions or other periods.
//   - Keys never leave a device unwrapped; only sealed/recovery-wrapped blobs do.
//   - Paper recovery code wraps the recovery bundle (MK + master ids); no share
//     ever lands on the server.
//   - Enrollment binds BOTH device keys (box + signing) into the typed code; a para
//     grant can never carry MK; Keyring.destroy() zeroizes keys and ends the keyring.
//   - Rotating a Period DEK revokes a para's post-rotation read access.

export { sodiumReady, bytesEqual, zeroize, toBase64, fromBase64, utf8 } from "./sodium.js";
export {
  generateMasterKey,
  generatePeriodKey,
  generateDeviceKeypair,
  type MasterKey,
  type PeriodDek,
  type PeriodKey,
  type DeviceKeypair,
} from "./keys.js";
export { recordAad, encryptWithKey, decryptWithKey } from "./records.js";
export { generateSigningKeypair, sign, type DeviceSigningKeypair } from "./signing.js";
export {
  Keyring,
  TeacherKeyring,
  ParaKeyring,
  NoKeyForScopeError,
  KeyringDestroyedError,
  ScopeConflictError,
} from "./keyring.js";
export {
  generateRecoveryCode,
  normalizeRecoveryCode,
  wrapRecoveryBundle,
  unwrapRecoveryBundle,
  type RecoveryBundle,
  type RecoveryWrap,
} from "./recovery.js";
export {
  deviceVerificationCode,
  createEnrollmentRequest,
  encodeEnrollmentRequest,
  decodeEnrollmentRequest,
  approveDeviceEnrollment,
  completeDeviceEnrollment,
  approveParaEnrollment,
  completeParaEnrollment,
  EnrollmentConfirmationError,
  type EnrollmentRequest,
  type EnrollingDeviceKeys,
  type DeviceEnrollmentGrant,
  type ParaEnrollmentGrant,
} from "./enrollment.js";
export {
  newPairingSecret,
  pairingSid,
  pairingKey,
  sealPairing,
  openPairing,
  sealEnrollmentRequest,
  openEnrollmentRequest,
  encodePairingSecret,
  decodePairingSecret,
  PairingError,
  type PairingPurpose,
} from "./pairing.js";
export { rotatePeriodKey } from "./rotation.js";
