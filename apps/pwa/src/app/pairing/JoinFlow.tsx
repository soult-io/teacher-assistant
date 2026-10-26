// Flow 3, phone side — add this device to her account (design/flows-device-enrollment.md §5
// B1–B4; spec rev 2.7 §4.2 F2, §13 A-3/A-5).
//
//   B1 scan the square code (or type it) → B1a name this device (one combined list,
//   generic provider copy: the device does not know yet whose it is, A-13) → B2 save a
//   passkey (+ S3 passphrase on Style W) → B3 the matching code, shown BEFORE anything is
//   posted → B4 done, then the first download.
//
// A slot that is taken or expired, a grant that never comes, or no internet ends with
// "Pairing interrupted" and the device throws its new keys away.

import { type ReactNode, useState } from "react";
import type { DeviceHandle, JoinPort } from "../../device/device-port.js";
import { DEVICE_LABELS } from "../../device/passkey-prf.js";
import { PAIRING_COPY } from "../../device/pairing-copy.js";
import { STYLE_W_LINE } from "../../device/setup-copy.js";
import { NameStep } from "../setup/NameStep.js";
import { PassphraseStep } from "../setup/PassphraseStep.js";
import { Countdown } from "./Countdown.js";
import { QrScanner } from "./QrScanner.js";
import { type JoinState, useJoin } from "./useJoin.js";

export interface JoinFlowProps {
  readonly port: JoinPort;
  /** "laptop" or "phone" (flows §0: from screen size). */
  readonly deviceWord: string;
  readonly onVaultSealed: (device: DeviceHandle) => void;
  readonly onDone: (device: DeviceHandle) => void;
  /** Back to the welcome screen (before any key exists, or after an interruption). */
  readonly onLeave: () => void;
  /** Test seam for the scanner's camera. */
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia">;
}

export function JoinFlow(props: JoinFlowProps) {
  const flow = useJoin(props);
  return (
    <div className="lock pairing" data-testid={`join-step-${flow.step}`}>
      <div className="lockbody">
        <JoinStepView flow={flow} {...props} />
        <p className="err" role="alert">
          {flow.error ?? ""}
        </p>
      </div>
    </div>
  );
}

function JoinStepView({
  flow,
  deviceWord,
  onLeave,
  mediaDevices,
}: JoinFlowProps & { readonly flow: JoinState }): ReactNode {
  switch (flow.step) {
    case "scan":
      return <Scan flow={flow} onLeave={onLeave} mediaDevices={mediaDevices} />;
    case "name":
      return (
        <NameStep
          options={DEVICE_LABELS}
          label={flow.label}
          note="Your passkey will carry this name, so you can find it in your password manager later."
          busy={false}
          onLabel={flow.setLabel}
          onContinue={() => flow.setStep("passkey")}
          testId="join-name-continue"
        />
      );
    case "passkey":
      return (
        <>
          <h2>Set up unlock</h2>
          <p className="locknote">
            Save a passkey (your password manager, phone or computer will ask how).
          </p>
          <p className="locknote">
            You'll be asked twice — once to save the passkey, once to test it. That's normal.
          </p>
          <button
            type="button"
            className="btn primary wide"
            disabled={flow.busy}
            onClick={() => void flow.savePasskey()}
            data-testid="join-save-passkey"
          >
            Save a passkey
          </button>
        </>
      );
    case "passphrase":
      return (
        <PassphraseStep
          styleLine={STYLE_W_LINE}
          deviceWord={deviceWord}
          busy={flow.busy}
          onSave={(passphrase) => void flow.savePassphrase(passphrase)}
        />
      );
    case "code":
      return flow.code === null ? null : (
        <>
          <h2>Type this code on your other device</h2>
          <p className="matchshow mono" data-testid="join-matching-code">
            {flow.code.split("-").join(" - ")}
          </p>
          <Countdown until={flow.expiresAt} waiting="Waiting for your other device…" />
        </>
      );
    case "done":
      return (
        <>
          <span className="mark" aria-hidden="true">
            ✓
          </span>
          <h2 data-testid="join-done">
            {flow.tier === "prf"
              ? `This ${deviceWord} is set up. It unlocks with your passkey.`
              : `This ${deviceWord} is set up. It unlocks with your passkey and your passphrase.`}
          </h2>
          <p className="locknote" role="status">
            Getting your data… 1 moment
          </p>
        </>
      );
    case "interrupted":
    case "busy":
      // The reason is the screen's heading, above its one button.
      return (
        <>
          <h2 data-testid="join-ended">{flow.ended}</h2>
          <button
            type="button"
            className="btn primary wide"
            onClick={onLeave}
            data-testid="join-leave"
          >
            {flow.step === "busy" ? "OK" : "Start again"}
          </button>
        </>
      );
  }
}

/** [B1] The camera, or the typed square code. */
function Scan({
  flow,
  onLeave,
  mediaDevices,
}: {
  readonly flow: JoinState;
  readonly onLeave: () => void;
  readonly mediaDevices: Pick<MediaDevices, "getUserMedia"> | undefined;
}) {
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState("");
  return (
    <>
      <h2>Scan the code on your other device</h2>
      <p className="locknote" data-testid="join-home-screen">
        {PAIRING_COPY.homeScreen}
      </p>
      {typing ? null : (
        <QrScanner
          onResult={(text) => flow.entered(text, "scan")}
          onBlocked={() => {
            flow.setError(PAIRING_COPY.camera);
            setTyping(true);
          }}
          mediaDevices={mediaDevices}
        />
      )}
      {typing ? (
        <form
          className="unlockform"
          onSubmit={(e) => {
            e.preventDefault();
            flow.entered(typed, "typed");
          }}
        >
          <label className="setupfield">
            <span className="fieldname">Code</span>
            <textarea
              className="setupinput mono codeinput"
              rows={3}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="join-typed-code"
            />
          </label>
          <button type="submit" className="btn primary wide" data-testid="join-typed-continue">
            Continue
          </button>
        </form>
      ) : (
        <button
          type="button"
          className="backlink"
          onClick={() => setTyping(true)}
          data-testid="join-type-instead"
        >
          Type the code instead
        </button>
      )}
      <button type="button" className="backlink" onClick={onLeave} data-testid="join-back">
        ‹ Back
      </button>
    </>
  );
}
