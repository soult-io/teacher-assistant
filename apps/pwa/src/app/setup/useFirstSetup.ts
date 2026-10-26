// The F1 screens' state and actions (flows §3; spec rev 2.7 §4.1, §13 A-1/A-2/A-8). Every
// step goes through the SetupPort; the setup code and the recovery code live only in this
// state while a screen needs them.

import type { VaultTier } from "@teacher-assistant/crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SetupPort } from "../../device/device-port.js";
import type { SetupStageName } from "../../device/device-store.js";
import type { RedeemStep } from "../../device/first-setup.js";
import type { TeacherDeviceLabel } from "../../device/passkey-prf.js";

export type Step =
  | "welcome"
  | "code"
  | "name"
  | "passkey"
  | "passphrase"
  | "connect"
  | "show_code"
  | "check_code"
  | "done"
  | "recovery_mode"
  | "stopped";

/** A-3: navigator.storage.persist() refused — a one-line warning, never blocking. */
const NOT_PERSISTED = "This browser may clear this device's setup. Install the app to keep it.";

export const SETUP_ERRORS = {
  code: "That setup code didn't work. Codes work once and last 24 hours. Check it with Neil, or ask him for a new one.",
  tooMany: "Too many tries. Wait 15 minutes, then try again.",
  connect: "Connect to the internet to finish setup.",
  passkey:
    "Try your passkey again. If Bitwarden doesn't pop up, choose Bitwarden in the window that appears.",
  homeScreen: "Add to Home Screen first, then open the app from the icon.",
  noPasskey:
    "This device can't save a passkey yet. Open Bitwarden and make sure it's unlocked, or turn on a screen lock in your device's Settings. Then come back.",
} as const;

/** E-S4 (retry), E-S5 (this device cannot save a passkey at all) or the A-3 install line. */
function passkeyError(err: unknown): string {
  const name = err instanceof Error ? err.name : "";
  if (name === "SetupNeedsHomeScreenError") {
    return SETUP_ERRORS.homeScreen;
  }
  // WebAuthn missing (no navigator.credentials) or the platform refuses the ceremony.
  return name === "NotSupportedError" || name === "TypeError"
    ? SETUP_ERRORS.noPasskey
    : SETUP_ERRORS.passkey;
}

/** The step a resumed setup opens on. */
function resumeStep(stage: SetupStageName | null, labelKnown: boolean): Step {
  switch (stage) {
    case null:
      return "welcome";
    case "keys_created":
      return "code";
    case "redeemed":
      return labelKnown ? "connect" : "name";
    default:
      return "show_code"; // scopes_granted / recovery_pending: a (new) recovery code
  }
}

/** Where each code-check outcome leads (E-S1, E-S2, E-S3, E-S7). */
const REDEEM_RESULT: Readonly<
  Record<Exclude<RedeemStep, "first">, { readonly step: Step; readonly error: string | null }>
> = {
  recovery: { step: "recovery_mode", error: null },
  refused: { step: "code", error: SETUP_ERRORS.code }, // the code stays in the field
  rate_limited: { step: "code", error: SETUP_ERRORS.tooMany },
  offline: { step: "connect", error: null }, // the connect screen says it
};

export interface FirstSetupOptions {
  readonly port: SetupPort;
  readonly resumeAt: SetupStageName | null;
  readonly resumeTier: VaultTier | undefined;
  readonly deviceWord: string;
  readonly startNotice: string | null;
  /** The vault exists: the App takes the unlocked device under its auto-lock and lock. */
  readonly onVaultSealed: () => void;
}

export function useFirstSetup(options: FirstSetupOptions) {
  const { port, resumeAt, deviceWord } = options;
  const [step, setStep] = useState<Step>(() => resumeStep(resumeAt, port.label !== undefined));
  const [code, setCode] = useState("");
  const [label, setLabel] = useState<TeacherDeviceLabel>(
    deviceWord === "phone" ? "Phone" : "School computer",
  );
  const [tier, setTier] = useState<VaultTier | null>(options.resumeTier ?? null);
  const [vaultSealed, setVaultSealed] = useState(resumeAt !== null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [reissued, setReissued] = useState(resumeAt === "recovery_pending");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(options.startNotice);
  const [notice, setNotice] = useState<string | null>(null);

  /** Run a port step with one busy flag and one error line. */
  const run = useCallback(async (task: () => Promise<void>, onError: (err: unknown) => void) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }, []);

  /** S4: a fresh recovery code, shown only after the relay stored its wrap (A-2). */
  const showRecoveryCode = useCallback(
    () =>
      run(
        async () => {
          setRecoveryCode(await port.issueRecoveryCode());
          setStep("show_code");
        },
        () => setRecoveryCode(null), // the connect screen says it
      ),
    [port, run],
  );

  /** After redeem `first`: F1 steps 4 and 6, then the recovery code. */
  const finishSetup = useCallback(
    () =>
      run(
        async () => {
          await port.finish();
          setRecoveryCode(await port.issueRecoveryCode());
          setStep("show_code");
        },
        (err) =>
          // A definite refusal cannot be retried; anything else waits for the network.
          setStep(err instanceof Error && err.name === "SetupRefusedError" ? "stopped" : "connect"),
      ),
    [port, run],
  );

  /** The code is checked after the unlock setup (spec §4.1 steps 3→5). */
  const submitCode = useCallback(async () => {
    setBusy(true);
    setError(null);
    const outcome = await port.redeem(code).catch((): RedeemStep => "offline");
    setBusy(false);
    if (outcome !== "first") {
      setStep(REDEEM_RESULT[outcome].step);
      setError(REDEEM_RESULT[outcome].error);
      return;
    }
    setCode(""); // spent: the relay accepted it, and a resume never needs it again
    if (port.label === undefined) {
      setStep("name"); // a resumed setup lost the name: ask again, no new passkey
      return;
    }
    await finishSetup();
  }, [port, code, finishSetup]);

  /** S1 Continue: a new device names itself next; a resumed one checks the code. */
  const continueFromCode = useCallback(() => {
    setError(null);
    if (vaultSealed && port.label !== undefined) {
      void submitCode();
      return;
    }
    setStep("name");
  }, [vaultSealed, port, submitCode]);

  /** S1a Continue: the name is set BEFORE any passkey exists (DN-1a label). */
  const chooseName = useCallback(async () => {
    port.setLabel(label);
    if (!vaultSealed) {
      setStep("passkey");
      return;
    }
    // Resumed: the vault exists; the name only feeds the master doc's device entry.
    await (resumeAt === "redeemed" ? finishSetup() : submitCode());
  }, [port, label, vaultSealed, resumeAt, finishSetup, submitCode]);

  /** S2: create + test the passkey. Style P seals at once; Style W goes to S3. */
  const savePasskey = useCallback(
    () =>
      run(
        async () => {
          const chosen = await port.createPasskey();
          setTier(chosen);
          if (chosen === "passphrase") {
            setStep("passphrase");
            return;
          }
          const { persisted } = await port.sealVault();
          options.onVaultSealed();
          const done = `Passkey saved. This ${deviceWord} unlocks with it.`;
          setNotice(persisted ? done : `${done} ${NOT_PERSISTED}`);
          setVaultSealed(true);
          await submitCode();
        },
        (err) => setError(passkeyError(err)),
      ),
    [port, run, submitCode, deviceWord, options.onVaultSealed],
  );

  /** S3: seal the vault under the passphrase, then check the code. */
  const savePassphrase = useCallback(
    (passphrase: string) =>
      run(
        async () => {
          const { persisted } = await port.sealVault(passphrase);
          options.onVaultSealed();
          if (!persisted) {
            setNotice(NOT_PERSISTED);
          }
          setVaultSealed(true);
          await submitCode();
        },
        (err) => setError(passkeyError(err)),
      ),
    [port, run, submitCode, options.onVaultSealed],
  );

  const retryConnect = useCallback(
    () =>
      resumeAt === "scopes_granted" || resumeAt === "recovery_pending"
        ? showRecoveryCode()
        : submitCode(),
    [resumeAt, showRecoveryCode, submitCode],
  );

  /** S5: a match finishes setup and drops the code from memory. */
  const checkRecoveryCode = useCallback(
    async (typed: string) => {
      const ok = await port.confirmRecoveryCode(typed);
      if (ok) {
        setRecoveryCode(null);
        setStep("done");
      }
      return ok;
    },
    [port],
  );

  // A resume at scopes_granted / recovery_pending issues the (new) recovery code at once.
  const autoIssued = useRef(false);
  useEffect(() => {
    if (step === "show_code" && recoveryCode === null && !autoIssued.current) {
      autoIssued.current = true;
      void showRecoveryCode();
    }
  }, [step, recoveryCode, showRecoveryCode]);

  return {
    step,
    setStep,
    code,
    setCode,
    label,
    setLabel,
    tier,
    recoveryCode,
    reissued,
    wroteItDown: () => {
      setReissued(false);
      setStep("check_code");
    },
    busy,
    error,
    notice,
    continueFromCode,
    chooseName,
    savePasskey,
    savePassphrase,
    retryConnect,
    showRecoveryCode,
    checkRecoveryCode,
  };
}

export type FirstSetupFlow = ReturnType<typeof useFirstSetup>;
