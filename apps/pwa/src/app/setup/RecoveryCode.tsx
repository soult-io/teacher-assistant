// [S4] Show the recovery code and [S5] check it (flows §3; spec §4.1 step 7, D-ARCH-1, C6,
// §13 A-2). The code is on paper only: no copy button, no print button, and the screen says
// never to save it in Bitwarden or any password manager (C6). S5 asks for the last two
// groups; the first six are masked once S4 is left. Unlimited retries.

import { useState } from "react";

function groups(code: string): string[] {
  return code.split(/[\s-]+/).filter((g) => g.length > 0);
}

export function RecoveryShow({
  code,
  reissued,
  onWrote,
}: {
  readonly code: string;
  /** A-2 / E-S6: an earlier code was never confirmed, so this is a new one. */
  readonly reissued: boolean;
  readonly onWrote: () => void;
}) {
  const all = groups(code);
  return (
    <>
      {reissued ? (
        <p className="locknote" data-testid="recovery-reissued">
          For safety, here is a new recovery code. Throw away the old one.
        </p>
      ) : null}
      <h2>Write down your recovery code</h2>
      <p className="locknote">
        If you ever lose all your devices, this code is the only way to get your student data back.
      </p>
      <div className="recoverycode mono" data-testid="recovery-code">
        <span>{all.slice(0, 4).join("  ")}</span>
        <span>{all.slice(4).join("  ")}</span>
      </div>
      <ul className="recoveryrules">
        <li>
          ✎ Write it on paper. Keep the paper at home, somewhere safe — not in your school bag.
        </li>
        <li>✕ Don't save it in Bitwarden or any password manager.</li>
        <li>✕ Don't take a photo or screenshot.</li>
      </ul>
      <button
        type="button"
        className="btn primary wide"
        onClick={onWrote}
        data-testid="wrote-it-down"
      >
        I wrote it down
      </button>
    </>
  );
}

export function RecoveryCheck({
  code,
  busy,
  onCheck,
  onShowAgain,
}: {
  readonly code: string;
  readonly busy: boolean;
  readonly onCheck: (typed: string) => Promise<boolean>;
  readonly onShowAgain: () => void;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [wrong, setWrong] = useState(false);
  const masked = groups(code)
    .slice(0, -2)
    .map(() => "••••")
    .join(" ");
  const check = async () => {
    setWrong(!(await onCheck(`${a}${b}`)));
  };
  return (
    <>
      <h2>Check your paper</h2>
      <p className="locknote">Type the last two groups from your paper.</p>
      <div className="recoverycheck mono">
        <span aria-hidden="true">{masked}</span>
        <input
          className="setupinput mono group"
          aria-label="Second to last group"
          data-testid="check-group-1"
          autoComplete="off"
          maxLength={4}
          value={a}
          onChange={(e) => setA(e.target.value)}
        />
        <input
          className="setupinput mono group"
          aria-label="Last group"
          data-testid="check-group-2"
          autoComplete="off"
          maxLength={4}
          value={b}
          onChange={(e) => setB(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="btn primary wide"
        disabled={busy}
        onClick={() => void check()}
        data-testid="check-recovery"
      >
        Check
      </button>
      <button type="button" className="backlink" onClick={onShowAgain}>
        ‹ Show the code again
      </button>
      {wrong ? (
        <p className="err" data-testid="check-wrong">
          That doesn't match. Look at your paper again — the last two groups.
        </p>
      ) : null}
    </>
  );
}
