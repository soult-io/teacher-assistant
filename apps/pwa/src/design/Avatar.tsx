// Monogram avatar — the LOCKED student identity component (design §E.1). A
// filled circle in the student's fixed hue with white bold initials centred.
// Initials are the primary identifier; the hue reinforces. No names, no photos,
// ever — the disc holds initials only (privacy rule). The `sm` variant is for
// dense inline contexts (design §E.1).
//
// Every place a student appears carries this avatar (design §E.5), so U2–U6
// import it rather than re-deriving the hue.

import { hueClassForInitials } from "./hues.js";

export interface AvatarProps {
  /** 2–3 letter student initials (the human identifier; never a name). */
  readonly initials: string;
  /** Small variant for dense inline rows/strips. */
  readonly small?: boolean;
}

export function Avatar({ initials, small = false }: AvatarProps) {
  const upper = initials.toUpperCase();
  const hue = hueClassForInitials(upper);
  const cls = `av circle ${small ? "sm " : ""}${hue}`;
  return (
    <span className={cls} role="img" aria-label={`student ${upper}`}>
      {upper}
    </span>
  );
}
