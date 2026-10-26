// Flow 1 — first-time setup on her first device (design/flows-device-enrollment.md §3,
// screens S0–S6 and errors E-S1..E-S7; device-enrollment-spec rev 2.7 §4.1 F1).
//
// Order: S0 welcome → S1 setup code → S1a name (before the passkey exists: the passkey
// carries this name, DN-1a) → S2 save a passkey (create + test, which decides the style)
// → S3 passphrase (Style W only) → the code is checked with the server → S4 recovery code
// (paper only, never Bitwarden: C6) → S5 re-type the last two groups → S6 done.
//
// Nothing here touches a key: every step goes through the SetupPort (useFirstSetup). The
// recovery code is dropped on leaving S5 (and with the whole tree on a lock).
// No student data exists or is entered before setup is done.

import type { VaultTier } from "@teacher-assistant/crypto";
import type { ReactNode } from "react";
import type { DeviceHandle, SetupPort } from "../../device/device-port.js";
import type { SetupStageName } from "../../device/device-store.js";
import { TEACHER_DEVICE_LABELS } from "../../device/passkey-prf.js";
import { NameStep } from "./NameStep.js";
import { PassphraseStep } from "./PassphraseStep.js";
import { RecoveryCheck, RecoveryShow } from "./RecoveryCode.js";
import { SetupCodeStep } from "./SetupCodeStep.js";
import { STYLE_W_LINE } from "../../device/setup-copy.js";
import { type FirstSetupFlow, SETUP_ERRORS, type Step, useFirstSetup } from "./useFirstSetup.js";

export interface SetupFlowProps {
  readonly port: SetupPort;
  /** Resume an unfinished setup at its stored stage (after the full unlock); null = new device. */
  readonly resumeAt: SetupStageName | null;
  /** The style the vault was sealed with, when resuming. */
  readonly resumeTier?: VaultTier;
  readonly online: boolean;
  /** "laptop" or "phone" (flows §0: from screen size). */
  readonly deviceWord: string;
  /**
   * Setup finished (stage `done`); the unlocked device opens the app — then, when she chose
   * "Add my phone now" on S6, pairing on this device (flows §5 A1).
   */
  readonly onDone: (device: DeviceHandle, addPhone: boolean) => void;
  /** S0 "Add this device to my account": pairing on this new device (flows §5 B1). */
  readonly onPair?: () => void;
  /** A line to show on the first screen (an unfinished setup was cleared, A-8). */
  readonly startNotice?: string | null;
  /** The vault was just sealed: the App takes the unlocked device under auto-lock and Lock. */
  readonly onVaultSealed?: (device: DeviceHandle) => void;
  /** iOS outside the Home Screen app (A-3): S0 shows only the install line. */
  readonly homeScreenOnly?: boolean;
}

/** Where the S2 result line and the storage warning belong: the steps right after S2. */
const NOTICE_STEPS: ReadonlySet<Step> = new Set<Step>(["passphrase", "show_code", "check_code"]);

export function SetupFlow(props: SetupFlowProps) {
  const flow = useFirstSetup({
    port: props.port,
    resumeAt: props.resumeAt,
    resumeTier: props.resumeTier,
    deviceWord: props.deviceWord,
    startNotice: props.startNotice ?? null,
    onVaultSealed: () => props.onVaultSealed?.(props.port.device),
  });
  const { step, notice, error } = flow;
  return (
    <div className="lock setup" data-testid={`setup-step-${step}`}>
      <div className="lockbody">
        {step === "show_code" || step === "check_code" ? (
          <p className="setupbanner" role="status" data-testid="recovery-banner">
            Recovery code not saved yet — finish setup.
          </p>
        ) : null}
        {notice !== null && NOTICE_STEPS.has(step) ? <p className="locknote">{notice}</p> : null}
        <StepView flow={flow} {...props} />
        <p className="err" role="alert">
          {error ?? ""}
        </p>
      </div>
    </div>
  );
}

/** The one screen for the current step. */
function StepView({
  flow,
  port,
  resumeAt,
  online,
  deviceWord,
  onDone,
  onPair,
  homeScreenOnly = false,
}: SetupFlowProps & { readonly flow: FirstSetupFlow }): ReactNode {
  const { busy, recoveryCode } = flow;
  switch (flow.step) {
    case "welcome":
      return homeScreenOnly ? (
        <HomeScreenFirst />
      ) : (
        <Welcome deviceWord={deviceWord} onCode={() => flow.setStep("code")} onPair={onPair} />
      );
    case "code":
      return (
        <SetupCodeStep
          code={flow.code}
          online={online}
          busy={busy}
          onChange={flow.setCode}
          onBack={resumeAt === null ? () => flow.setStep("welcome") : undefined}
          onContinue={flow.continueFromCode}
        />
      );
    case "name":
      return (
        <NameStep
          options={TEACHER_DEVICE_LABELS}
          label={flow.label}
          note="Your passkey will carry this name, so you can find it in Bitwarden later."
          busy={busy}
          onLabel={flow.setLabel}
          onContinue={() => void flow.chooseName()}
          testId="name-continue"
        />
      );
    case "passkey":
      return <PasskeyStep busy={busy} onSave={() => void flow.savePasskey()} />;
    case "passphrase":
      return (
        <PassphraseStep
          styleLine={STYLE_W_LINE}
          deviceWord={deviceWord}
          busy={busy}
          onSave={(passphrase) => void flow.savePassphrase(passphrase)}
        />
      );
    case "connect":
      return <ConnectStep busy={busy} online={online} onRetry={() => void flow.retryConnect()} />;
    case "show_code":
      return recoveryCode === null ? (
        <ConnectStep busy={busy} online={online} onRetry={() => void flow.showRecoveryCode()} />
      ) : (
        <RecoveryShow code={recoveryCode} reissued={flow.reissued} onWrote={flow.wroteItDown} />
      );
    case "check_code":
      return recoveryCode === null ? null : (
        <RecoveryCheck
          code={recoveryCode}
          busy={busy}
          onCheck={flow.checkRecoveryCode}
          onShowAgain={() => flow.setStep("show_code")}
        />
      );
    case "done":
      return (
        <Done
          deviceWord={deviceWord}
          tier={flow.tier}
          onContinue={(addPhone) => onDone(port.device, addPhone)}
        />
      );
    case "recovery_mode":
      return <RecoveryMode />;
    case "stopped":
      return (
        <>
          <span className="mark" aria-hidden="true">
            🔒
          </span>
          <p className="locknote" data-testid="setup-stopped">
            {SETUP_ERRORS.stopped}
          </p>
        </>
      );
  }
}

/** A-3: on iOS outside the Home Screen app, S0 has no setup controls at all. */
function HomeScreenFirst() {
  return (
    <>
      <span className="mark" aria-hidden="true">
        🔒
      </span>
      <h1>Teacher Assistant</h1>
      <p className="locknote" data-testid="home-screen-first">
        {SETUP_ERRORS.homeScreen}
      </p>
    </>
  );
}

function Welcome({
  deviceWord,
  onCode,
  onPair,
}: {
  readonly deviceWord: string;
  readonly onCode: () => void;
  readonly onPair: (() => void) | undefined;
}) {
  return (
    <>
      <span className="mark" aria-hidden="true">
        🔒
      </span>
      <h1>Teacher Assistant</h1>
      <p className="locknote">
        Let's set up this {deviceWord}. Student data stays locked on your own devices. Only you can
        open it.
      </p>
      {/* Spec §13 A-3 (rev 2.7): install first on every platform; if policy blocks it, she
          continues in the tab. */}
      <p className="locknote" data-testid="install-first">
        First, install the app: tap Install in your browser's menu. Then come back here.
      </p>
      <button type="button" className="btn primary wide" onClick={onCode} data-testid="setup-start">
        I have a setup code from Neil ▸
      </button>
      {onPair === undefined ? null : (
        <button type="button" className="btn wide choice" onClick={onPair} data-testid="pair-start">
          Add this {deviceWord} to my account ▸
          <span className="choicenote">I already use the app on another device</span>
        </button>
      )}
    </>
  );
}

function PasskeyStep({ busy, onSave }: { readonly busy: boolean; readonly onSave: () => void }) {
  return (
    <>
      <h2>Set up unlock</h2>
      <p className="locknote">You'll open the app with a passkey.</p>
      <p className="locknote">
        Bitwarden will ask twice — once to save the passkey, once to test it. That's normal.
      </p>
      <button
        type="button"
        className="btn primary wide"
        disabled={busy}
        onClick={onSave}
        data-testid="save-passkey"
      >
        Save a passkey
      </button>
      <p className="locknote">Bitwarden, your phone, or your computer will ask how.</p>
    </>
  );
}

function ConnectStep({
  busy,
  online,
  onRetry,
}: {
  readonly busy: boolean;
  readonly online: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <>
      <h2>Finish setup</h2>
      <p className="locknote">{SETUP_ERRORS.connect}</p>
      <button
        type="button"
        className="btn primary wide"
        disabled={busy || !online}
        onClick={onRetry}
        data-testid="setup-retry"
      >
        Try again
      </button>
    </>
  );
}

function Done({
  deviceWord,
  tier,
  onContinue,
}: {
  readonly deviceWord: string;
  readonly tier: VaultTier | null;
  /** True: "Add my phone now" (pairing next); false: "Later". */
  readonly onContinue: (addPhone: boolean) => void;
}) {
  const other = deviceWord === "phone" ? "another device" : "your phone";
  return (
    <>
      <span className="mark" aria-hidden="true">
        ✓
      </span>
      <h2>This {deviceWord} is set up</h2>
      <p className="locknote">
        {tier === "prf"
          ? "Next time, open the app and unlock with your passkey."
          : "Next time, open the app and unlock with your passkey and passphrase."}
      </p>
      <p className="locknote">Want the app on {other} too?</p>
      <button
        type="button"
        className="btn primary wide"
        onClick={() => onContinue(true)}
        data-testid="setup-add-phone"
      >
        {deviceWord === "phone" ? "Add another device now" : "Add my phone now"}
      </button>
      <button
        type="button"
        className="btn wide"
        onClick={() => onContinue(false)}
        data-testid="setup-done"
      >
        Later
      </button>
    </>
  );
}

function RecoveryMode() {
  return (
    <p className="locknote" data-testid="recovery-mode">
      You already have an account. Let's get your data back.
    </p>
  );
}
