// Placeholder for a surface built in a later unit (Plan = Phase 2; New-goal =
// U5; the Para surface = U6). Keeps the chrome navigable without implying
// unbuilt behavior. An optional Back returns to the previous screen.

export function StubScreen({
  title,
  note,
  onBack,
}: {
  readonly title: string;
  readonly note: string;
  readonly onBack?: () => void;
}) {
  return (
    <div className="stub">
      <h1>{title}</h1>
      <span className="comingsoon">{note}</span>
      {onBack !== undefined ? (
        <button type="button" className="btn small ghost" onClick={onBack}>
          ‹ Back
        </button>
      ) : null}
    </div>
  );
}
