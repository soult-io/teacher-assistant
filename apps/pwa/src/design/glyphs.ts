// Status glyphs (design §E, round-3). The settled TRACK status set — kept
// visually distinct so status always dominates a row:
//   ● logged   ○ owes   ⊘ no-data   ★ mastery   ⏳ pending   ◐ incomplete   ◷ queued
// The glyph carries the state to grayscale / colour-vision-deficient readers;
// the chip colour reinforces. Ported from the prototype's glyph() map.

import type { DashboardState } from "@teacher-assistant/store";

/** A chip is a (glyph, className) pair; the className maps to a --status colour. */
export interface Chip {
  readonly glyph: string;
  readonly className: string;
}

/** The full status vocabulary (used by U2–U6; U1 renders the dashboard subset). */
export const STATUS_CHIPS = {
  logged: { glyph: "●", className: "logged" },
  owes: { glyph: "○", className: "owes" },
  nodata: { glyph: "⊘", className: "nodata" },
  mastery: { glyph: "★", className: "mastery" },
  pending: { glyph: "⏳", className: "pending" },
  incomplete: { glyph: "◐", className: "incomplete" },
  queued: { glyph: "◷", className: "queued" },
} as const satisfies Record<string, Chip>;

/** Map a weekly-dashboard row state (M3 projection) to its chip. */
export function chipForDashboardState(state: DashboardState): Chip {
  switch (state) {
    case "has_point":
      return STATUS_CHIPS.logged;
    case "documented_no_data":
      return STATUS_CHIPS.nodata;
    case "owes":
      return STATUS_CHIPS.owes;
  }
}
