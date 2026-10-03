// The IEP goal label display (TEACH-41, product-ux-designer ruling): "Goal 2 ·
// Two-step equations", the "Goal 2 ·" part grey and lighter; screen readers hear
// "Goal 2, Two-step equations". No label → the text alone, never "Goal ?". The
// label is teacher-only — this is never used on the para path.

/** The plain-text title: "Goal 2 · Two-step equations", or the text alone. */
export function goalLabel(label: string | null | undefined, text: string): string {
  return label != null ? `Goal ${label} · ${text}` : text;
}

/** The spoken title for aria-labels: "Goal 2, Two-step equations", or the text alone. */
export function goalLabelSpoken(label: string | null | undefined, text: string): string {
  return label != null ? `Goal ${label}, ${text}` : text;
}

/** The goal title as rendered: a grey "Goal 2 ·" prefix (".goalnum") + the text. */
export function GoalTitle({
  label,
  text,
}: {
  readonly label: string | null | undefined;
  readonly text: string;
}) {
  if (label == null) {
    return <>{text}</>;
  }
  return (
    <>
      <span className="goalnum">
        Goal {label}
        <span aria-hidden="true"> · </span>
        <span className="sr-only">, </span>
      </span>
      {text}
    </>
  );
}

/**
 * The LASTING duplicate-label cue (ky-sped-lbd-sdi-sme binding condition): shown on
 * every goal that shares its label with another goal of the same student and
 * cohort, until one label is changed — a save-time warning never reaches the device
 * that synced the other copy.
 */
export function DuplicateLabelCue({ label }: { readonly label: string | null | undefined }) {
  if (label == null) {
    return null;
  }
  return (
    <span
      className="dupcue"
      data-testid="dup-label-cue"
      title={`Two goals are numbered Goal ${label} — change one label`}
    >
      ⚠ two Goal {label}
    </span>
  );
}
