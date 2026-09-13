// A flat dashboard goal row (owes-first + by-period lenses). Status glyph +
// monogram avatar + title/meta + value. Owes and scored rows are tappable — owes
// opens the Quick-Score sheet, scored opens it for an audited [Fix]. Owes rows
// also carry the score-later ⚑ flag (writes an M5 bookmark). All data is on the
// RowVM; the handlers are wired by DashboardScreen.

import type { DashboardState } from "@teacher-assistant/store";
import { Avatar } from "../../../design/Avatar.js";
import { chipForDashboardState } from "../../../design/glyphs.js";
import { StatusChip } from "../../../design/StatusChip.js";
import { type RowVM, rowValueText } from "./dashboard-vm.js";
import { TrendHistoryButton } from "./TrendHistoryButton.js";

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

function RowMain({ vm, scoreLater }: { readonly vm: RowVM; readonly scoreLater: boolean }) {
  const isOwes = vm.state === "owes";
  return (
    <>
      <span className="rowtitle">{vm.goalText}</span>
      <span className="rowmeta">
        {vm.periodLabel !== null ? <span className="period">{vm.periodLabel}</span> : null}
        {/* Owes rows carry glanceable mid-class context: the probe + criterion. */}
        {isOwes && vm.probe !== "" ? ` · ${vm.probe}` : null}
        {isOwes && vm.criterion !== "" ? ` · ${vm.criterion}` : null}
        {scoreLater ? <span className="laternote"> · ⚑ score later</span> : null}
      </span>
      {vm.pending ? <span className="pendnote">⏳ para point — awaiting your OK</span> : null}
    </>
  );
}

export interface GoalRowProps {
  readonly vm: RowVM;
  readonly scoreLater: boolean;
  readonly onScoreLater: (vm: RowVM) => void;
  readonly onOpenScore: (vm: RowVM) => void;
  /** Open Goal Detail (trend + history) — reachable from EVERY goal (design R3 D2). */
  readonly onOpenDetail: (vm: RowVM) => void;
}

export function GoalRow({ vm, scoreLater, onScoreLater, onOpenScore, onOpenDetail }: GoalRowProps) {
  const chip = chipForDashboardState(vm.state);
  const isOwes = vm.state === "owes";
  const tappable = vm.state === "owes" || vm.state === "has_point";
  const right = rightValue(vm);
  return (
    <div className={`row${isOwes ? " owes" : ""}`}>
      <StatusChip chip={chip} label={STATE_LABEL[vm.state]} />
      <Avatar initials={vm.initials} />
      {tappable ? (
        <button
          type="button"
          className="rowmain tap"
          aria-label={`score ${vm.goalText}`}
          onClick={() => onOpenScore(vm)}
        >
          <RowMain vm={vm} scoreLater={scoreLater} />
        </button>
      ) : (
        <div className="rowmain">
          <RowMain vm={vm} scoreLater={scoreLater} />
        </div>
      )}
      {right !== null ? <div className="rowright">{right}</div> : null}
      <div className="rowactions">
        {isOwes ? (
          <button
            type="button"
            className={`minibtn book${scoreLater ? " on" : ""}`}
            title="Gave it — score later"
            aria-label="Gave it, score later"
            aria-pressed={scoreLater}
            onClick={() => onScoreLater(vm)}
          >
            ⚑
          </button>
        ) : null}
        {/* ↗ trend/history is on EVERY row — the always-available path to Goal Detail. */}
        <TrendHistoryButton vm={vm} onOpenDetail={onOpenDetail} />
      </div>
    </div>
  );
}
