// @teacher-assistant/crypto — M0 crypto / identity / keyring core (SCAFFOLD).
//
// The real implementation lands with the Phase-0 M0 spec (libsodium.js:
// XChaCha20-Poly1305 AEAD, X25519 crypto_box key wrapping, Argon2id). It is
// NOT written here — this task is foundation scaffolding only.
//
// Locked invariants the M0 module must enforce (architecture §1.4, D-ARCH-1):
//   - Two key tiers: teacher master key (MK) + one Data-Encryption-Key per
//     class period (Period DEK). The para device holds ONLY its period's DEK
//     and is cryptographically incapable of decrypting goal definitions or any
//     other period. Least-privilege lives in the key hierarchy, not a UI toggle
//     or a server check.
//   - Keys never leave a device unwrapped; the server never receives MK or any
//     DEK unwrapped. Multi-device enrollment wraps MK to a new device's public
//     key after an out-of-band QR confirmation.
//   - Recovery = a printed paper recovery code that wraps MK (D-ARCH-1). No
//     escrow share ever lands on the server / PALLAS.
//   - Rotating a Period DEK renders a revoked para device unable to read
//     post-rotation writes.

export const CRYPTO_SCAFFOLD =
  "M0 crypto core not yet implemented — see the Phase-0 M0 spec." as const;
