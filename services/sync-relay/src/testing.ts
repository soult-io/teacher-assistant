// Test-only seeding (device-enrollment spec §5.1). Production code adds ACL
// rows only through grantScopes and completePairing; `authorize` no longer
// exists. Tests that need "this device may use this scope" call seedAcl, which
// gets there through the same public RelayStore API production uses: a
// throwaway owner code enrolls the device as an owner, then a period-scope
// grant. Nothing in the relay's runtime imports this module.

import { randomBytes } from "node:crypto";
import type { RelayStore } from "./store.js";

/** Far past any test clock, so the throwaway code never reads as expired. */
const NEVER = new Date("9999-12-31T00:00:00Z");

/** Enroll `devicePublicKeyB64` (as an owner, if new) and grant it period scope `scopeTag`. */
export async function seedAcl(
  store: RelayStore,
  devicePublicKeyB64: string,
  scopeTag: string,
): Promise<void> {
  if ((await store.deviceRole(devicePublicKeyB64)) === undefined) {
    const code = randomBytes(32).toString("hex");
    await store.issueOwnerCode(code, NEVER);
    if ((await store.redeemOwnerCode(code, devicePublicKeyB64)) === "refused") {
      throw new Error("seedAcl: device refused (revoked?)");
    }
  }
  const result = await store.grantScopes(devicePublicKeyB64, [{ tag: scopeTag, kind: "period" }]);
  if (result !== "ok") {
    throw new Error(`seedAcl: grant refused (${result})`);
  }
}
