// The trusted device's side of pairing, A0–A4 (flows §5 Flow 3 laptop side; spec rev 2.7
// §4.2, §13 A-4). Every step goes through an ApprovePort; the pairing secret, the request
// and the tries counter live in the port (memory only). Leaving the flow, a lock or an
// unmount abandons the session.

import type { VaultTier } from "@teacher-assistant/crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovePort } from "../../device/device-port.js";
import type { DeviceLabel } from "../../device/passkey-prf.js";
import { PAIRING_COPY, wrongMatchingCode } from "../../device/pairing-copy.js";
import { POLL_MS } from "../../device/pairing-limits.js";
import { unlockFailureCopy } from "../../device/unlock-copy.js";
import { EMPTY_MATCHING_CODE, matchingCodeComplete } from "./MatchingCodeInput.js";

export type AddStep = "whose" | "show" | "match" | "confirm" | "done" | "stopped";

export interface AddDeviceOptions {
  /** A fresh approver for one pairing session (the App owns it, so a lock can abandon it). */
  readonly openApprover: () => ApprovePort;
  readonly tier: VaultTier;
  /** Open the session on mount, skipping A0 (S6 "Add my phone now"). */
  readonly autoStart?: boolean;
}

/** A word for the device being added, from its name ("Phone" → "phone"). */
export function deviceWordOf(label: DeviceLabel | null): string {
  return label === null ? "device" : label.toLowerCase();
}

export function useAddDevice({ openApprover, tier, autoStart = false }: AddDeviceOptions) {
  const portRef = useRef<ApprovePort | null>(null);
  const [step, setStep] = useState<AddStep>("whose");
  const [squareCode, setSquareCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [label, setLabel] = useState<DeviceLabel | null>(null);
  const [parts, setParts] = useState<readonly string[]>(EMPTY_MATCHING_CODE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Why the session ended (shown as the stopped screen's heading). */
  const [ended, setEnded] = useState<string | null>(null);

  const end = useCallback(() => {
    portRef.current?.abandon();
    portRef.current = null;
  }, []);
  useEffect(() => end, [end]); // unmount (leaving, or a lock) abandons the session

  /** The session is over: one line, then Start again (a new square code, flows Flow 3 errors). */
  const stop = useCallback(
    (message: string) => {
      end();
      setSquareCode(null);
      setParts(EMPTY_MATCHING_CODE);
      setEnded(message);
      setStep("stopped");
    },
    [end],
  );

  /** A0 → A1: open a session and show its square code. */
  const start = useCallback(async () => {
    end();
    setBusy(true);
    setError(null);
    setEnded(null);
    const port = openApprover();
    portRef.current = port;
    try {
      const opened = await port.open();
      if (portRef.current !== port) {
        return;
      }
      if (opened.kind === "open") {
        setSquareCode(opened.code);
        setExpiresAt(opened.expiresAt);
        setStep("show");
      } else {
        portRef.current = null;
        setError(opened.kind === "too_many" ? PAIRING_COPY.tooMany : PAIRING_COPY.offlineAdd);
      }
    } catch {
      portRef.current = null;
      setError(PAIRING_COPY.offlineAdd);
    } finally {
      setBusy(false);
    }
  }, [end, openApprover]);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStart && !autoStarted.current) {
      autoStarted.current = true;
      void start();
    }
  }, [autoStart, start]);

  // A1: ask every few seconds whether the new device checked in.
  useEffect(() => {
    if (step !== "show") {
      return;
    }
    let live = true;
    const tick = async () => {
      const port = portRef.current;
      if (port === null) {
        return;
      }
      const outcome = await port.poll().catch(() => ({ kind: "waiting" as const }));
      if (!live) {
        return;
      }
      switch (outcome.kind) {
        case "arrived":
          setLabel(outcome.label);
          setStep("match");
          return;
        case "expired":
          stop(PAIRING_COPY.timeUp);
          return;
        case "interrupted":
          stop(PAIRING_COPY.interrupted);
          return;
        case "waiting":
          timer = setTimeout(() => void tick(), POLL_MS);
      }
    };
    let timer = setTimeout(() => void tick(), 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [step, stop]);

  /** A2 Approve: the typed code is compared locally; the 3rd miss stops the session. */
  const checkCode = useCallback(() => {
    const port = portRef.current;
    if (port === null || !matchingCodeComplete(parts)) {
      return;
    }
    const outcome = port.checkCode(parts.join(""));
    if (outcome === "match") {
      setError(null);
      setStep("confirm");
    } else if (outcome === "mismatch") {
      setParts(EMPTY_MATCHING_CODE);
      setError(wrongMatchingCode(deviceWordOf(label)));
    } else {
      stop(PAIRING_COPY.stopped);
    }
  }, [parts, label, stop]);

  /** A3 Confirm: the full unlock again, then the grant. */
  const confirm = useCallback(
    async (passphrase?: string) => {
      const port = portRef.current;
      if (port === null) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const outcome = await port.approve(tier === "passphrase" ? passphrase : undefined);
        switch (outcome.kind) {
          case "added":
            portRef.current = null;
            setStep("done");
            return;
          case "expired":
            stop(PAIRING_COPY.timeUp);
            return;
          case "interrupted":
            stop(PAIRING_COPY.interrupted);
            return;
          case "offline":
            stop(PAIRING_COPY.needsInternet);
        }
      } catch (err) {
        if (port.over) {
          stop(PAIRING_COPY.interrupted); // the session ended after the unlock: no retry
          return;
        }
        // The unlock failed: stay on A3, the matching code is kept.
        setError(unlockFailureCopy(err, "Type your passphrase, then confirm with your passkey."));
      } finally {
        setBusy(false);
      }
    },
    [tier, stop],
  );

  return {
    step,
    squareCode,
    expiresAt,
    label,
    parts,
    setParts,
    busy,
    error,
    ended,
    start,
    checkCode,
    confirm,
    restart: () => void start(),
    end,
  };
}

export type AddDeviceState = ReturnType<typeof useAddDevice>;
