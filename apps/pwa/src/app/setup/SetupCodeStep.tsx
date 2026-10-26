// [S1] Setup code (flows §3). One field; paste is fine; it groups itself as she types
// (six groups of four, then two); capitals, dashes and spaces are optional, and O/0 and
// I/1/L read the same. Continue is enabled at 26 characters. The code stays in memory only.

const SETUP_CODE_LENGTH = 26;

/** Canonical Crockford characters of a typed setup code (what the relay hashes). */
export function setupCodeChars(typed: string): string {
  return typed.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Display grouping: XXXX-XXXX-…-XX (6×4 + 2). */
export function groupSetupCode(typed: string): string {
  const chars = setupCodeChars(typed).slice(0, SETUP_CODE_LENGTH);
  return (chars.match(/.{1,4}/g) ?? []).join("-");
}

export function SetupCodeStep({
  code,
  online,
  busy,
  onChange,
  onBack,
  onContinue,
}: {
  readonly code: string;
  readonly online: boolean;
  readonly busy: boolean;
  readonly onChange: (code: string) => void;
  readonly onBack: (() => void) | undefined;
  readonly onContinue: () => void;
}) {
  const complete = setupCodeChars(code).length === SETUP_CODE_LENGTH;
  return (
    <>
      {onBack !== undefined ? (
        <button type="button" className="backlink" onClick={onBack}>
          ‹ Back
        </button>
      ) : null}
      <h2>Enter your setup code</h2>
      <p className="locknote">Neil sent you this code. It works once and lasts 24 hours.</p>
      <input
        className="setupinput mono codeinput"
        aria-label="Setup code"
        data-testid="setup-code"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        value={code}
        onChange={(e) => onChange(groupSetupCode(e.target.value))}
      />
      <button
        type="button"
        className="btn primary wide"
        disabled={!complete || !online || busy}
        onClick={onContinue}
        data-testid="code-continue"
      >
        {online ? "Continue" : "Connect to the internet to continue"}
      </button>
    </>
  );
}
