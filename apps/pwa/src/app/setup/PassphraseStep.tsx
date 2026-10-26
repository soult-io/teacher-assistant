// [S3] Passphrase — Style W only (flows §3; spec DN-1 passphrase rule, DN-1a C9–C13).
// The one-line reason comes first (no PRF from the passkey). The box is NOT focused on
// load: a password manager fills it only when she taps it (C10). The app never sends the
// passphrase anywhere; Bitwarden may save it (ruling A-12), so the copy does not call it
// "local only" (C12).

import { isAcceptablePassphrase } from "@teacher-assistant/crypto";
import { useState } from "react";

const RULE_ERROR = "Use at least 8 characters with letters and numbers, or at least 10 numbers.";
const MISMATCH = "The two passphrases don't match.";

export function PassphraseStep({
  styleLine,
  deviceWord,
  busy,
  onSave,
}: {
  readonly styleLine: string;
  readonly deviceWord: string;
  readonly busy: boolean;
  readonly onSave: (passphrase: string) => void;
}) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chars = [...first.normalize("NFC")];
  const longEnough = chars.length >= 8;
  const lettersAndNumbers = /\p{L}/u.test(first) && /\d/.test(first);
  const tenNumbers = /^\d{10,}$/.test(first);

  const save = () => {
    if (!isAcceptablePassphrase(first)) {
      setError(RULE_ERROR);
      return;
    }
    if (first !== second) {
      setError(MISMATCH);
      return;
    }
    setError(null);
    onSave(first);
  };

  return (
    <>
      <p className="locknote" data-testid="style-w-line">
        {styleLine}
      </p>
      <h2>Choose a passphrase</h2>
      <p className="locknote">
        You'll use it with your passkey each time you unlock this {deviceWord}. Bitwarden can save
        it and fill it in for you. The app never sends it anywhere. Nobody can reset it — not Neil,
        not the school.
      </p>
      <label className="setupfield">
        <span className="fieldname">Passphrase</span>
        <input
          className="setupinput"
          type={shown ? "text" : "password"}
          autoComplete="new-password"
          data-testid="passphrase"
          value={first}
          onChange={(e) => setFirst(e.target.value)}
        />
        <button
          type="button"
          className="btn small ghost"
          aria-label={shown ? "Hide passphrase" : "Show passphrase"}
          onClick={() => setShown((s) => !s)}
        >
          👁
        </button>
      </label>
      <ul className="checklist">
        <li className={longEnough ? "ok" : ""}>{longEnough ? "✓" : "·"} 8 or more characters</li>
        <li className={lettersAndNumbers ? "ok" : ""}>
          {lettersAndNumbers ? "✓" : "·"} has letters and numbers
        </li>
        <li className={tenNumbers ? "ok" : ""}>— or 10 or more numbers</li>
      </ul>
      <label className="setupfield">
        <span className="fieldname">Type it again</span>
        <input
          className="setupinput"
          type={shown ? "text" : "password"}
          autoComplete="new-password"
          data-testid="passphrase-again"
          value={second}
          onChange={(e) => setSecond(e.target.value)}
        />
      </label>
      <p className="locknote">Tip: a short phrase is easiest, like "blue7kites".</p>
      <button
        type="button"
        className="btn primary wide"
        disabled={busy}
        onClick={save}
        data-testid="save-passphrase"
      >
        Save passphrase
      </button>
      {error !== null ? (
        <p className="err" data-testid="passphrase-error">
          {error}
        </p>
      ) : null}
    </>
  );
}
