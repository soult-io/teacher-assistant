// The copy for a failed unlock ceremony, on the lock screen and on A3 (approving a new
// device runs the same ceremony). One source, so the two never drift (flows §4 unlock
// errors, §5 Flow 3 errors).

import { SETUP_ERRORS } from "./setup-copy.js";
import {
  DeviceCannotUnlockError,
  PassphraseRequiredError,
  UnlockBackoffError,
  WrongPassphraseError,
} from "./vault.js";

/**
 * What to tell her after the ceremony failed. `passphraseRequired` is the screen's own
 * "type your passphrase, then …" line. Never echoes an error message that is not the app's
 * own fixed copy.
 */
export function unlockFailureCopy(err: unknown, passphraseRequired: string): string {
  if (err instanceof UnlockBackoffError) {
    return `Too many tries. Try again in ${Math.ceil(err.retryAfterMs / 1000)} seconds.`;
  }
  if (err instanceof WrongPassphraseError || err instanceof DeviceCannotUnlockError) {
    return err.message;
  }
  if (err instanceof PassphraseRequiredError) {
    return passphraseRequired;
  }
  return SETUP_ERRORS.passkey;
}
