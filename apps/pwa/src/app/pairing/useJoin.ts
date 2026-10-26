// The new device's side of pairing, B1–B4 (flows §5 Flow 3 phone side; spec rev 2.7 §4.2
// steps 2 and 5). Every step goes through a JoinPort. The matching code is shown BEFORE the
// request is posted: the post runs from an effect, after the code screen has rendered.

import type { VaultTier } from "@teacher-assistant/crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceHandle, JoinPort } from "../../device/device-port.js";
import { type DeviceLabel, defaultDeviceLabel } from "../../device/passkey-prf.js";
import { PAIRING_COPY } from "../../device/pairing-copy.js";
import { passkeyErrorCopy } from "../../device/setup-copy.js";
import { PAIRING_TTL_MS, POLL_MS } from "../../device/pairing-limits.js";

export type JoinStep =
  | "scan"
  | "name"
  | "passkey"
  | "passphrase"
  | "code"
  | "done"
  | "interrupted"
  | "busy";

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
  const [label, setLabel] = useState<DeviceLabel>(defaultDeviceLabel(deviceWord));
  const [tier, setTier] = useState<VaultTier | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Why the pairing ended (interrupted, or another window is setting this device up). */
  const [ended, setEnded] = useState<string | null>(null);
  // The App may pass a new callback on each render; the post must still run exactly once.
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  const interrupt = useCallback((message: string) => {
    setCode(null);
    setEnded(message);
    setStep("interrupted");
  }, []);

  /**
   * B1: a scanned or typed square code. Returns false for one that does not decode, so the
   * scanner keeps the camera running after a stray QR.
   */
  const entered = useCallback(
    (text: string, how: "scan" | "typed"): boolean => {
      setError(null);
      if (!port.begin(text)) {
        setError(how === "scan" ? PAIRING_COPY.badScan : PAIRING_COPY.badSquareCode);
        return false;
      }
      setExpiresAt(Date.now() + PAIRING_TTL_MS);
      setStep("name");
      return true;
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
        setEnded(PAIRING_COPY.busy);
        setStep("busy");
        return;
      }
      setError(passkeyErrorCopy(err, PAIRING_COPY.passkeyNew));
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
        setError(weak ? err.message : passkeyErrorCopy(err, PAIRING_COPY.passkeyNew));
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
      const posted = await port.postRequest().catch(() => "interrupted" as const);
      if (!live) {
        return;
      }
      if (posted === "waiting") {
        void wait();
      } else {
        interrupt(PAIRING_COPY.interruptedNew);
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
    ended,
    entered,
    savePasskey,
    savePassphrase,
  };
}

export type JoinState = ReturnType<typeof useJoin>;
