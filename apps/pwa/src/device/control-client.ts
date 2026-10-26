// The enrollment control routes the device calls during first setup and pairing
// (device-enrollment-spec rev 2.7 §5.3, §4.1 F1 steps 5–7, §4.2 F2, §13 A-1). Every call
// is a signed POST under the reserved `control` scope; identifiers travel only in the
// strict JSON body. The bodies carry exactly the fields the relay accepts — never a device
// name, never the BE/BS flags (C4).
//
// Outcomes the relay cannot have decided are reported as `ambiguous`: a transport failure
// (no response) or a 5xx ("outcome unknown"). A redeem that ends ambiguous may still have
// committed, so first-setup probes `devices/list` before ever redeeming again (A-1).

import type { RelayClient } from "@teacher-assistant/sync";

const CONTROL_ROUTES = {
  redeem: "/sync/enroll/redeem",
  list: "/sync/devices/list",
  grant: "/sync/devices/grant",
  recoveryWrap: "/sync/devices/recovery-wrap",
  pairingOpen: "/sync/enroll/pairing/open",
  pairingRequestPut: "/sync/enroll/pairing/request-put",
  pairingRequestGet: "/sync/enroll/pairing/request-get",
  pairingGrantPut: "/sync/enroll/pairing/grant-put",
  pairingGrantGet: "/sync/enroll/pairing/grant-get",
} as const;

export type RedeemOutcome =
  | {
      readonly kind: "redeemed";
      readonly mode: "first" | "recovery";
      readonly recoveryWrap: string | null;
    }
  | { readonly kind: "refused" }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "ambiguous" };

/** A scope as the control routes carry it: an opaque tag and its kind. */
export interface ScopeGrant {
  readonly tag: string;
  readonly kind: "master" | "period";
}

/** One device as the relay lists it (opaque keys and tags only). */
export interface ListedDevice {
  readonly device: string;
  readonly role: "owner" | "member";
  readonly status: "active" | "revoked";
  readonly scopes: readonly ScopeGrant[];
}

export type ListOutcome =
  | { readonly kind: "ok"; readonly devices: readonly ListedDevice[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "ambiguous" };

/** `refused`: a definitive 4xx (404 not an owner, 409 conflict, 400/413). */
export type WriteOutcome = "ok" | "refused" | "ambiguous";

/**
 * A pairing mailbox read (spec §4.2, §5.3): the blob, `empty` for the relay's one 404 (not
 * there yet, already taken, expired or unknown: the relay does not say which), or
 * `ambiguous` when there was no definite answer (offline, 5xx, a rate limit).
 */
export type MailboxRead =
  | { readonly kind: "blob"; readonly blob: string }
  | { readonly kind: "empty" }
  | { readonly kind: "ambiguous" };

function mailboxRead(res: { readonly status: number; readonly body: unknown } | null): MailboxRead {
  if (res?.status === 404) {
    return { kind: "empty" };
  }
  const blob = (res?.body as { blob?: unknown } | undefined)?.blob;
  return res?.status === 200 && typeof blob === "string"
    ? { kind: "blob", blob }
    : { kind: "ambiguous" };
}

/** Statuses that settle a write. 401 (signature, clock) and 429 (rate limit) settle nothing. */
const DEFINITE_REFUSALS: ReadonlySet<number> = new Set([400, 404, 409, 413]);

function writeOutcome(res: { readonly status: number } | null): WriteOutcome {
  if (res?.status === 200) {
    return "ok";
  }
  return res !== null && DEFINITE_REFUSALS.has(res.status) ? "refused" : "ambiguous";
}

function json(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/** The relay's answer, or null when there was none (transport failure). */
async function call(
  relay: RelayClient,
  path: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<{ readonly status: number; readonly body: unknown } | null> {
  try {
    const res = await relay.control(path, payload);
    return { status: res.status, body: json(res.body) };
  } catch {
    return null;
  }
}

function parseRedeem(body: unknown): RedeemOutcome {
  const value = body as { mode?: unknown; recovery_wrap?: unknown } | undefined;
  const mode = value?.mode;
  if (mode !== "first" && mode !== "recovery") {
    return { kind: "ambiguous" };
  }
  const wrap = value?.recovery_wrap;
  return { kind: "redeemed", mode, recoveryWrap: typeof wrap === "string" ? wrap : null };
}

/** The control-plane calls first setup needs, over the device-signed RelayClient. */
export class ControlClient {
  readonly #relay: RelayClient;

  constructor(relay: RelayClient) {
    this.#relay = relay;
  }

  /** F1 step 5. 401 is the relay's one answer for wrong, used, expired or revoked. */
  async redeem(code: string): Promise<RedeemOutcome> {
    const res = await call(this.#relay, CONTROL_ROUTES.redeem, { code });
    if (res === null || res.status >= 500) {
      return { kind: "ambiguous" };
    }
    if (res.status === 429) {
      return { kind: "rate_limited" };
    }
    if (res.status !== 200) {
      return { kind: "refused" };
    }
    return parseRedeem(res.body);
  }

  /** The A-1 probe: 200 means this key is an active owner; 404 means it is not. */
  async listDevices(): Promise<ListOutcome> {
    const res = await call(this.#relay, CONTROL_ROUTES.list, {});
    // Only a definitive 404 means "not an owner" (A-1). A 401, 429 or any other answer
    // decides nothing, so the caller keeps probing and never redeems blindly.
    if (res?.status === 404) {
      return { kind: "not_found" };
    }
    if (res === null || res.status !== 200) {
      return { kind: "ambiguous" };
    }
    const devices = (res.body as { devices?: unknown } | undefined)?.devices;
    return Array.isArray(devices)
      ? { kind: "ok", devices: devices as ListedDevice[] }
      : { kind: "ambiguous" };
  }

  /** F1 step 6: self-grant the master (kind `master`) and period scopes. */
  async grant(device: string, scopes: readonly ScopeGrant[]): Promise<WriteOutcome> {
    const res = await call(this.#relay, CONTROL_ROUTES.grant, {
      device,
      scopes: scopes.map(({ tag, kind }) => ({ tag, kind })),
    });
    return writeOutcome(res);
  }

  /** F1 step 7: store (or overwrite, A-2) the recovery wrap. */
  async putRecoveryWrap(blob: string): Promise<WriteOutcome> {
    const res = await call(this.#relay, CONTROL_ROUTES.recoveryWrap, { blob });
    return writeOutcome(res);
  }

  // ── The pairing mailbox (F2 / EU-8). The sid travels only in these signed bodies. ──

  /** A, F2 step 1: open a session. `refused` (404): not an owner, or 3 sessions already waiting. */
  async openPairing(sid: string): Promise<WriteOutcome> {
    return writeOutcome(await call(this.#relay, CONTROL_ROUTES.pairingOpen, { sid }));
  }

  /** B, F2 step 2: post the sealed request. `refused` (404): taken, expired or unknown. */
  async putPairingRequest(sid: string, blob: string): Promise<WriteOutcome> {
    return writeOutcome(await call(this.#relay, CONTROL_ROUTES.pairingRequestPut, { sid, blob }));
  }

  /** A, F2 step 3: fetch B's sealed request. */
  async getPairingRequest(sid: string): Promise<MailboxRead> {
    return mailboxRead(await call(this.#relay, CONTROL_ROUTES.pairingRequestGet, { sid }));
  }

  /** A, F2 step 4: enroll the request signer and post the sealed grant, in one relay step. */
  async putPairingGrant(grant: {
    readonly sid: string;
    readonly device: string;
    readonly role: "teacher" | "para";
    readonly scopes: readonly ScopeGrant[];
    readonly blob: string;
  }): Promise<WriteOutcome> {
    const res = await call(this.#relay, CONTROL_ROUTES.pairingGrantPut, {
      sid: grant.sid,
      device: grant.device,
      role: grant.role,
      scopes: grant.scopes.map(({ tag, kind }) => ({ tag, kind })),
      blob: grant.blob,
    });
    return writeOutcome(res);
  }

  /** B, F2 step 5: collect the sealed grant (once; the relay then deletes the session). */
  async takePairingGrant(sid: string): Promise<MailboxRead> {
    return mailboxRead(await call(this.#relay, CONTROL_ROUTES.pairingGrantGet, { sid }));
  }
}
