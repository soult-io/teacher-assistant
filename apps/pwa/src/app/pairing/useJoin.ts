// The new device's side of pairing, B1–B4 (flows §5 Flow 3 phone side; spec rev 2.7 §4.2
// steps 2 and 5). Every step goes through a JoinPort. The matching code is shown BEFORE the
// request is posted: the post runs from an effect, after the code screen has rendered.

import type { VaultTier } from "@teacher-assistant/crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceHandle, JoinPort } from "../../device/device-port.js";
import type { DeviceLabel } from "../../device/passkey-prf.js";
import { PAIRING_COPY } from "../../device/pairing-copy.js";
import { SETUP_ERRORS } from "../../device/setup-copy.js";
import { POLL_MS } from "./useAddDevice.js";

/** The relay's pairing lifetime, counted on this device from the scan. */
const PAIRING_TTL_MS = 10 * 60 * 1000;

export type JoinStep =
  | "scan"
  | "name"
  | "passkey"
  | "passphrase"
  | "code"
  | "done"
  | "interrupted"
  | "busy";

/** B2 errors (the passkey), mirroring first setup's E-S4/E-S5 with the generic provider copy. */
function passkeyError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "SetupNeedsHomeScreenError") {
    return SETUP_ERRORS.homeScreen;
  }
  return name === "NotSupportedError" || name === "TypeError"
    ? SETUP_ERRORS.noPasskey
    : PAIRING_COPY.passkeyNew;
}

export interface JoinOptions {
  readonly port: JoinPort;
  readonly deviceWord: string;
  /** The vault exists: the App takes the unlocked device under its auto-lock and lock. */
  readonly onVaultSealed: (device: DeviceHandle) => void;
  /** The grant is stored (stage done): the App opens the session. */
  readonly onDone: (device: DeviceHandle) => void;
}

export function useJoin({ port, deviceWord, onVaultSealed, onDone }: JoinOptions) {
  const [step, setStep] = useState<JoinStep>("scan");
  const [label, setLabel] = useState<DeviceLabel>(
    deviceWord === "phone" ? "Phone" : "School computer",
  );
  const [tier, setTier] = useState<VaultTier | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The App may pass a new callback on each render; the post must still run exactly once.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const interrupt = useCallback((message: string) => {
    setCode(null);
    setError(message);
    setStep("interrupted");
  }, []);

  /** B1: a scanned or typed square code. */
  const scanned = useCallback(
    (text: string) => {
      setError(null);
      if (!port.begin(text)) {
        setError(PAIRING_COPY.badSquareCode);
        return;
      }
      setExpiresAt(Date.now() + PAIRING_TTL_MS);
      setStep("name");
    },
    [port],
  );

  /** The vault is sealed: hand the device to the App, then show the code (no network yet). */
  const sealed = useCallback(
    (matching: string) => {
      onVaultSealed(port.device);
      setCode(matching);
      setStep("code");
    },
    [port, onVaultSealed],
  );

  /** B2: the passkey under the chosen name; Style P seals at once, Style W asks a passphrase. */
  const savePasskey = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      port.setLabel(label);
      const chosen = await port.createPasskey();
      setTier(chosen);
      if (chosen === "passphrase") {
        setStep("passphrase");
        return;
      }
      sealed((await port.sealVault()).code);
    } catch (err) {
      if (err instanceof Error && err.name === "SetupBusyError") {
        setError(PAIRING_COPY.busy);
        setStep("busy");
        return;
      }
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  }, [port, label, sealed]);

  /** S3 on the new device: seal the vault under the passphrase. */
  const savePassphrase = useCallback(
    async (passphrase: string) => {
      setBusy(true);
      setError(null);
      try {
        sealed((await port.sealVault(passphrase)).code);
      } catch (err) {
        const weak = err instanceof Error && err.name === "WeakPassphraseError";
        setError(weak ? err.message : passkeyError(err));
      } finally {
        setBusy(false);
      }
    },
    [port, sealed],
  );

  // B3: the code is on screen; now post the request, then wait for the grant.
  useEffect(() => {
    if (step !== "code") {
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait = async () => {
      const outcome = await port.poll().catch(() => "waiting" as const);
      if (!live) {
        return;
      }
      if (outcome === "done") {
        setCode(null);
        setStep("done");
        doneRef.current(port.device);
      } else if (outcome === "interrupted") {
        interrupt(PAIRING_COPY.interruptedNew);
      } else {
        timer = setTimeout(() => void wait(), POLL_MS);
      }
    };
    void (async () => {
      const posted = await port.postRequest().catch(() => "offline" as const);
      if (!live) {
        return;
      }
      if (posted === "waiting") {
        void wait();
      } else {
        interrupt(posted === "offline" ? PAIRING_COPY.needsInternet : PAIRING_COPY.interruptedNew);
      }
    })();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [step, port, interrupt]);

  return {
    step,
    setStep,
    label,
    setLabel,
    tier,
    code,
    expiresAt,
    busy,
    error,
    setError,
    scanned,
    savePasskey,
    savePassphrase,
  };
}

export type JoinState = ReturnType<typeof useJoin>;
