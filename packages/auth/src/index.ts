// @teacher-assistant/auth — M0-AUTH (H-PUB-1). Passkeys/WebAuthn as the primary
// and only authentication factor; rate-limiting + lockout (H-PUB-5); and the
// binding that a verified passkey auth unlocks the device-held wrapped keys.
// There is NO password path anywhere in this package.

export { type RpConfig, PROD_RP, QA_RP, rpConfigForHost } from "./config.js";
export {
  type AuthUser,
  beginRegistration,
  finishRegistration,
  beginAuthentication,
  finishAuthentication,
} from "./webauthn.js";
export {
  type ThrottlePolicy,
  type ThrottleDecision,
  DEFAULT_THROTTLE,
  AuthThrottle,
} from "./throttle.js";
export {
  AuthRequiredError,
  type TeacherUnlockInput,
  type ParaUnlockInput,
  unlockTeacherKeyring,
  unlockParaKeyring,
} from "./unlock.js";
