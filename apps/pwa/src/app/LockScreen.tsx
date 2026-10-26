// The lock screen — the passkey unlock gate (M0-AUTH; flows U1/U2). The app opens locked;
// the encrypted store is unreadable until the unlock ceremony opens the device vault. The
// <h1> title is the app's first paint (and the e2e smoke anchor).
//
// Style P (U1): one button, the passkey prompt. Style W (U2, layout W-a): the passphrase box
// first, then the passkey. The box is NOT focused on load, so a password manager fills it
// only when she taps it (spec DN-1a C10); Enter starts the unlock. No student data here.

import type { VaultTier } from "@teacher-assistant/crypto";
import { useState } from "react";

export function LockScreen({
  onUnlock,
  busy,
  error,
  reason = null,
  tier = "prf",
}: {
  /** Start the unlock ceremony; Style W passes the passphrase typed (or filled) here. */
  readonly onUnlock: (passphrase?: string) => void;
  readonly busy: boolean;
  readonly error: string | null;
  /** Why the app locked (flows U3), shown only after a lock. No student data. */
  readonly reason?: string | null;
  /** This device's unlock style, fixed at setup. */
  readonly tier?: VaultTier;
}) {
  const [passphrase, setPassphrase] = useState("");
  const styleW = tier === "passphrase";
  const unlock = () => onUnlock(styleW ? passphrase : undefined);
  return (
    <div className="lock">
      {/* The lock screen renders as the plain `.phone` (no 1180 shell), so its content is
          capped here in a centered `.lockbody` column — otherwise `.btn.wide` (width:100%)
          stretches edge-to-edge on a wide monitor. The cap never binds on mobile. */}
      <div className="lockbody">
        <span className="mark" aria-hidden="true">
          🔒
        </span>
        <h1>Teacher Assistant</h1>
        <p className="locknote">
          {styleW
            ? "Type your passphrase (Bitwarden can fill it in), then unlock with your passkey."
            : "Student data is locked on this device."}
        </p>
        {styleW ? (
          <form
            className="unlockform"
            onSubmit={(e) => {
              e.preventDefault();
              unlock();
            }}
          >
            <label className="setupfield">
              <span className="fieldname">Passphrase</span>
              <input
                className="setupinput"
                type="password"
                autoComplete="current-password"
                data-testid="unlock-passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
              />
            </label>
          </form>
        ) : null}
        <button
          type="button"
          className="btn primary wide"
          onClick={unlock}
          disabled={busy}
          data-testid="unlock"
        >
          {busy ? "Unlocking…" : "Unlock with your passkey"}
        </button>
        {reason !== null ? (
          <p className="locknote" data-testid="lock-reason">
            {reason}
          </p>
        ) : null}
        <p className="err" role="alert">
          {error ?? ""}
        </p>
      </div>
    </div>
  );
}
