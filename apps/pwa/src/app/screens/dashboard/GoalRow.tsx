// A flat dashboard goal row (owes-first + by-period lenses). Status glyph +
// monogram avatar + title/meta + value, plus the score-later flag on owes rows
// and the pending-para note. All display data comes from the RowVM; no logic.

import type { DashboardState } from "@teacher-assistant/store";
import { Avatar } from "../../../design/Avatar.js";
import { chipForDashboardState } from "../../../design/glyphs.js";
import { StatusChip } from "../../../design/StatusChip.js";
import { type RowVM, rowValueText } from "./dashboard-vm.js";

const STATE_LABEL: Readonly<Record<DashboardState, string>> = {
  owes: "owes",
  documented_no_data: "no data",
  has_point: "scored",
};

function rightValue(vm: RowVM) {
  const text = rowValueText(vm);
  if (text === null) {
    return null;
  }
  const dim = vm.state === "documented_no_data";
  return <span className={`rowval${dim ? " dim" : ""}`}>{text}</span>;
}

export interface GoalRowProps {
  readonly vm: RowVM;
  readonly scoreLater: boolean;
  readonly onScoreLater: (goalId: string) => void;
}

export function GoalRow({ vm, scoreLater, onScoreLater }: GoalRowProps) {
  const chip = chipForDashboardState(vm.state);
  const isOwes = vm.state === "owes";
  const right = rightValue(vm);
  return (
    <div className={`row${isOwes ? " owes" : ""}`}>
      <StatusChip chip={chip} label={STATE_LABEL[vm.state]} />
      <Avatar initials={vm.initials} />
      <div className="rowmain">
        <span className="rowtitle">{vm.goalText}</span>
        <span className="rowmeta">
          {vm.periodLabel !== null ? <span className="period">{vm.periodLabel}</span> : null}
          {/* Owes rows carry glanceable mid-class context: the probe + criterion. */}
          {isOwes && vm.probe !== "" ? ` · ${vm.probe}` : null}
          {isOwes && vm.criterion !== "" ? ` · ${vm.criterion}` : null}
          {scoreLater ? <span className="laternote"> · ⚑ score later</span> : null}
        </span>
        {vm.pending ? <span className="pendnote">⏳ para point — awaiting your OK</span> : null}
      </div>
      {right !== null ? <div className="rowright">{right}</div> : null}
      {isOwes ? (
        <div className="rowactions">
          <button
            type="button"
            className={`minibtn book${scoreLater ? " on" : ""}`}
            title="Gave it — score later"
            aria-label="Gave it, score later"
            aria-pressed={scoreLater}
            onClick={() => onScoreLater(vm.goalId)}
          >
            ⚑
          </button>
        </div>
      ) : null}
    </div>
  );
}
