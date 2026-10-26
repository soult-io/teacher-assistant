// Flow 3, laptop side — add her phone (design/flows-device-enrollment.md §5 A0–A4; spec rev
// 2.7 §4.2 F2, §13 A-4/A-5). Release 1 adds Niah's own devices only: A0 has no "para's
// phone" choice (para pairing is release 2).
//
//   A0 whose device → A1 square code (QR + typed fallback) → A2 type the matching code
//   (Approve disabled until all 16 are typed; 3 tries) → A3 confirm it's you (the full
//   unlock again) → A4 done.
//
// No key or secret is held here beyond the square code on screen while A1 shows it.

import type { VaultTier } from "@teacher-assistant/crypto";
import { type ReactNode, useState } from "react";
import type { ApprovePort } from "../../device/device-port.js";
import { PAIRING_COPY } from "../../device/pairing-copy.js";
import { Countdown } from "./Countdown.js";
import { MatchingCodeInput, matchingCodeComplete } from "./MatchingCodeInput.js";
import { QrCode } from "./QrCode.js";
import { type AddDeviceState, deviceWordOf, useAddDevice } from "./useAddDevice.js";

export interface AddDeviceFlowProps {
  readonly openApprover: () => ApprovePort;
  readonly tier: VaultTier;
  readonly online: boolean;
  /** Skip A0 and open the square code at once (S6 "Add my phone now" jumps to A1). */
  readonly autoStart?: boolean;
  /** Leave the flow (Cancel or Done). Unmounting abandons any open session. */
  readonly onClose: () => void;
}

export function AddDeviceFlow({
  openApprover,
  tier,
  online,
  autoStart = false,
  onClose,
}: AddDeviceFlowProps) {
  const flow = useAddDevice({ openApprover, tier, autoStart: autoStart && online });
  return (
    <div className="lock pairing" data-testid={`add-step-${flow.step}`}>
      <div className="lockbody">
        <AddStepView flow={flow} tier={tier} online={online} onClose={onClose} />
        <p className="err" role="alert">
          {flow.error ?? ""}
        </p>
      </div>
    </div>
  );
}

function AddStepView({
  flow,
  tier,
  online,
  onClose,
}: {
  readonly flow: AddDeviceState;
  readonly tier: VaultTier;
  readonly online: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const word = deviceWordOf(flow.label);
  switch (flow.step) {
    case "whose":
      return (
        <Whose
          busy={flow.busy}
          online={online}
          onMine={() => void flow.start()}
          onClose={onClose}
        />
      );
    case "show":
      return flow.squareCode === null ? null : (
        <ShowSquareCode code={flow.squareCode} expiresAt={flow.expiresAt} onCancel={onClose} />
      );
    case "match":
      return (
        <>
          <h2>Your {word} is showing a code</h2>
          <p className="locknote">Type it here to make sure it's your {word}.</p>
          <MatchingCodeInput parts={flow.parts} onChange={flow.setParts} />
          <button
            type="button"
            className="btn primary wide"
            disabled={!matchingCodeComplete(flow.parts)}
            onClick={flow.checkCode}
            data-testid="pair-approve"
          >
            Approve
          </button>
          <CancelLink onCancel={onClose} />
        </>
      );
    case "confirm":
      return (
        <ConfirmItsYou
          tier={tier}
          word={word}
          busy={flow.busy}
          onConfirm={(passphrase) => void flow.confirm(passphrase)}
          onCancel={onClose}
        />
      );
    case "done":
      return (
        <>
          <span className="mark" aria-hidden="true">
            ✓
          </span>
          <h2 data-testid="pair-added">
            Your {word} is added as "{flow.label ?? ""}".
          </h2>
          <button
            type="button"
            className="btn primary wide"
            onClick={onClose}
            data-testid="pair-done"
          >
            Done
          </button>
        </>
      );
    case "stopped":
      return (
        <>
          <button
            type="button"
            className="btn primary wide"
            onClick={flow.restart}
            data-testid="pair-restart"
          >
            Start again
          </button>
          <CancelLink onCancel={onClose} />
        </>
      );
  }
}

function CancelLink({ onCancel }: { readonly onCancel: () => void }) {
  return (
    <button type="button" className="backlink" onClick={onCancel} data-testid="pair-cancel">
      Cancel
    </button>
  );
}

/** [A0] Release 1: her own devices only. */
function Whose({
  busy,
  online,
  onMine,
  onClose,
}: {
  readonly busy: boolean;
  readonly online: boolean;
  readonly onMine: () => void;
  readonly onClose: () => void;
}) {
  return (
    <>
      <h2>Add a device</h2>
      <p className="locknote">Whose device is it?</p>
      <button
        type="button"
        className="btn primary wide choice"
        disabled={busy || !online}
        onClick={onMine}
        data-testid="add-mine"
      >
        📱 My phone or another computer of mine ▸
        <span className="choicenote">Sees everything you see.</span>
      </button>
      {online ? null : <p className="locknote">{PAIRING_COPY.offlineAdd}</p>}
      <CancelLink onCancel={onClose} />
    </>
  );
}

/** [A1] The square code, the collapsed typed code, and the time left. */
function ShowSquareCode({
  code,
  expiresAt,
  onCancel,
}: {
  readonly code: string;
  readonly expiresAt: number;
  readonly onCancel: () => void;
}) {
  return (
    <>
      <h2>Add your phone</h2>
      <ol className="pairsteps">
        <li>On your phone, open Teacher Assistant.</li>
        <li>Tap "Add this device to my account".</li>
        <li>Point your phone's camera at this code.</li>
      </ol>
      <QrCode code={code} />
      <details className="typedcode">
        <summary>Can't scan? Type this on your phone instead</summary>
        <p className="mono squarecode" data-testid="pair-typed-code">
          {code.replace(/-/g, " ")}
        </p>
      </details>
      <Countdown until={expiresAt} waiting="Waiting for your phone…" />
      <button type="button" className="btn wide" onClick={onCancel} data-testid="pair-cancel">
        Cancel
      </button>
    </>
  );
}

/** [A3] The full unlock again, even though this device is unlocked (spec §4.2 step 4). */
function ConfirmItsYou({
  tier,
  word,
  busy,
  onConfirm,
  onCancel,
}: {
  readonly tier: VaultTier;
  readonly word: string;
  readonly busy: boolean;
  readonly onConfirm: (passphrase?: string) => void;
  readonly onCancel: () => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const styleW = tier === "passphrase";
  return (
    <>
      <h2>Confirm it's you</h2>
      <p className="locknote">
        {styleW
          ? "Type your passphrase (Bitwarden can fill it in), then confirm with your passkey."
          : `Confirm with your passkey to add this ${word}.`}
      </p>
      {styleW ? (
        <form
          className="unlockform"
          onSubmit={(e) => {
            e.preventDefault();
            onConfirm(passphrase);
          }}
        >
          {/* Not focused on load: a password manager fills it only when she taps it (C10). */}
          <label className="setupfield">
            <span className="fieldname">Passphrase</span>
            <input
              className="setupinput"
              type="password"
              autoComplete="current-password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              data-testid="pair-passphrase"
            />
          </label>
        </form>
      ) : null}
      <button
        type="button"
        className="btn primary wide"
        disabled={busy}
        onClick={() => onConfirm(styleW ? passphrase : undefined)}
        data-testid="pair-confirm"
      >
        {busy ? "Checking…" : "Confirm"}
      </button>
      <CancelLink onCancel={onCancel} />
    </>
  );
}
