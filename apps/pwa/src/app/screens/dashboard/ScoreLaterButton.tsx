// The score-later toggle on an owes row (flat GoalRow and nested StudentCard row).
// Pressed = the goal has a queued M5 bookmark; tapping again removes it.

import { SCORE_LATER } from "../../../design/glyphs.js";
import type { RowVM } from "./dashboard-vm.js";

export function ScoreLaterButton({
  vm,
  on,
  onScoreLater,
}: {
  readonly vm: RowVM;
  readonly on: boolean;
  readonly onScoreLater: (vm: RowVM) => void;
}) {
  return (
    <button
      type="button"
      className={`minibtn book${on ? " on" : ""}`}
      title={SCORE_LATER.label}
      aria-label={SCORE_LATER.label}
      aria-pressed={on}
      onClick={() => onScoreLater(vm)}
    >
      <span aria-hidden="true">{SCORE_LATER.glyph}</span>
    </button>
  );
}
