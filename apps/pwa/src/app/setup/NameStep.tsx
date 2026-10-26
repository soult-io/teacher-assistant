// [S1a] / [B1a] Name this device (flows §3 S1a, §5 B1a; spec DN-1a passkey label). The name
// is chosen BEFORE the passkey exists, because the passkey carries it. A fixed list, no free
// text, no student data. First setup lists the teacher names and names Bitwarden; a device
// being added lists all six and stays generic, because it does not know yet whose it is
// (A-13).

export function NameStep<Label extends string>({
  options,
  label,
  note,
  busy,
  onLabel,
  onContinue,
  testId,
}: {
  readonly options: readonly Label[];
  readonly label: Label;
  /** The line under the heading: where she will find the passkey later. */
  readonly note: string;
  readonly busy: boolean;
  readonly onLabel: (label: Label) => void;
  readonly onContinue: () => void;
  readonly testId: string;
}) {
  return (
    <>
      <h2>Name this device</h2>
      <p className="locknote">{note}</p>
      <fieldset className="namechoice">
        <legend className="sr-only">Device name</legend>
        {options.map((option) => (
          <label key={option} className={option === label ? "on" : ""}>
            <input
              type="radio"
              name="device-name"
              value={option}
              checked={option === label}
              onChange={() => onLabel(option)}
            />
            {option}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        className="btn primary wide"
        disabled={busy}
        onClick={onContinue}
        data-testid={testId}
      >
        Continue
      </button>
    </>
  );
}
