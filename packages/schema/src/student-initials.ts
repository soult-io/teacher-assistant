// Student initials rule (TEACH-40, data-model §1.2: "string(2–3), letters only").
// The ONE place the rule lives — the create form, the App's student match and the
// roster mint all call it, so a full name can never reach a stored Student.

/** Exactly 2 or 3 ASCII letters. Checked BEFORE upper-casing: "ß".toUpperCase() is "SS". */
const INITIALS = /^[A-Za-z]{2,3}$/;

/**
 * Normalize typed initials: drop "." and whitespace, upper-case, then require 2–3
 * letters. Returns the canonical form ("j.a.s." → "JAS"), or `undefined` when the
 * entry is not initials (a full name, 1 letter, 4+ letters, digits, other symbols).
 */
export function normalizeInitials(raw: string): string | undefined {
  const candidate = raw.replace(/[.\s]/g, "");
  return INITIALS.test(candidate) ? candidate.toUpperCase() : undefined;
}
