// Period DEK rotation = para revocation (architecture §1.4). Revoking a para's
// access is not a server ACL flip (the server cannot read to enforce one); it is
// a key rotation. A new DEK under a NEW scope tag encrypts all future writes for
// the period, and the new key is re-wrapped only to still-authorized devices. The
// revoked device holds the old DEK only, so it cannot read post-rotation writes —
// enforced by cryptography, not policy.
//
// Records written before rotation keep their old scope tag; a teacher keeps both
// keys to read history. A re-authorized para is re-enrolled against the new scope
// tag (enrollment.ts). The revoked para receives neither.

import type { ScopeTag } from "@teacher-assistant/schema";
import { generatePeriodKey, type PeriodKey } from "./keys.js";

/**
 * Mint the replacement Period DEK for a rotation. Returns a fresh key under a new
 * opaque scope tag; the caller re-wraps it to the devices that remain authorized
 * and starts encrypting new writes under it.
 */
export function rotatePeriodKey(newScopeTag: ScopeTag): PeriodKey {
  return generatePeriodKey(newScopeTag);
}
