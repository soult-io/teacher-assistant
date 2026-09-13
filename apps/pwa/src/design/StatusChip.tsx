// Status chip — the settled TRACK glyph with its status colour (design §E). The
// glyph is what carries the state to grayscale / colour-vision readers; the
// colour reinforces. Shared across every screen that shows a monitoring state.

import type { Chip } from "./glyphs.js";

export interface StatusChipProps {
  readonly chip: Chip;
  /** Accessible name for the state (e.g. "owes", "scored"). */
  readonly label: string;
}

export function StatusChip({ chip, label }: StatusChipProps) {
  return (
    <span className={`chip ${chip.className}`} role="img" aria-label={label}>
      {chip.glyph}
    </span>
  );
}
