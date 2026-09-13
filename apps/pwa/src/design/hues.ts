// Student identity hue map (design §E.2, LOCKED 2026-08-30). A student is the
// SAME colour on every screen — the hue is deterministic and keyed by initials,
// never random, never per-render. Known synthetic students map directly; unknown
// initials fall back to a stable hash over the same six-hue palette.
//
// The palette deliberately excludes green/amber/red — those are status hues
// (scored / owes / alert). Identity and status must never be the same colour.
// Initials are the PRIMARY identifier; the colour reinforces (design §E.1).

/** The six locked hue classes (suffix of the --s-* CSS token). */
export const HUE_CLASSES = ["ab", "cd", "ef", "gh", "jm", "rt"] as const;
export type HueClass = (typeof HUE_CLASSES)[number];

/** Known synthetic students → their fixed hue (design §E.2). */
const FIXED: Readonly<Record<string, HueClass>> = {
  AB: "ab",
  CD: "cd",
  EF: "ef",
  GH: "gh",
  JM: "jm",
  RT: "rt",
};

/**
 * Deterministic, PII-free hash over the initials — the same fold the prototype
 * uses (`s = s*31 + codeUnit`, unsigned). Stable across renders and hosts (no
 * locale, no randomness), so a given student keeps one colour everywhere.
 */
function hashToHue(upper: string): HueClass {
  let sum = 0;
  for (let i = 0; i < upper.length; i++) {
    sum = (sum * 31 + upper.charCodeAt(i)) >>> 0;
  }
  const idx = sum % HUE_CLASSES.length;
  // idx is always in-range; the fallback keeps the return type non-undefined
  // under noUncheckedIndexedAccess.
  return HUE_CLASSES[idx] ?? "ab";
}

/** The hue class for a student's initials — fixed map first, deterministic hash otherwise. */
export function hueClassForInitials(initials: string): HueClass {
  const upper = initials.toUpperCase();
  return FIXED[upper] ?? hashToHue(upper);
}
