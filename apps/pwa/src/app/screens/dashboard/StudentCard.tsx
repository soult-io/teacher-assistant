// A by-student dashboard card (design §E.4): the student's monogram avatar +
// initials + period(s) + a to-do/done tally, with their goals nested under a
// matching-hue colour rail. Status still dominates each nested row — the glyph
// plus a status-coloured value (§E.3) — and owes rows carry the same score-later
// ⚑ flag as the flat row (R3-2; U2 marks local state only).

import { Avatar } from "../../../design/Avatar.js";
import { chipForDashboardState } from "../../../design/glyphs.js";
import { hueClassForInitials } from "../../../design/hues.js";
import { type RowVM, rowValueText, type StudentCardVM } from "./dashboard-vm.js";

/** Status-coloured nested value (owes=amber, ⊘=grey, %=default) — status dominates. */
function nestedValue(vm: RowVM) {
  const text = rowValueText(vm) ?? "owes";
  const tone = vm.state === "owes" ? " owes" : vm.state === "documented_no_data" ? " nodata" : "";
  return <span className={`sval${tone}`}>{text}</span>;
}

export interface StudentCardProps {
  readonly card: StudentCardVM;
  readonly scoreLater: ReadonlySet<string>;
  readonly onScoreLater: (goalId: string) => void;
}

export function StudentCard({ card, scoreLater, onScoreLater }: StudentCardProps) {
  const hue = hueClassForInitials(card.initials);
  return (
    <div className="scard">
      <div className="shead">
        <Avatar initials={card.initials} />
        <span className="name">{card.initials}</span>
        {card.periodLabels.length > 0 ? (
          <span className="period">{card.periodLabels.join(" / ")}</span>
        ) : null}
        <span className={`tally ${card.todo > 0 ? "todo" : "done"}`}>
          {card.todo > 0 ? `${card.todo} to do` : "✓ done"}
        </span>
      </div>
      {card.rows.map((vm) => (
        <div className="sgoal" key={vm.goalId}>
          <span className={`rail ${hue}`} />
          <span className={`chip ${chipForDashboardState(vm.state).className}`} aria-hidden="true">
            {chipForDashboardState(vm.state).glyph}
          </span>
          <span className="g">{vm.goalText}</span>
          {nestedValue(vm)}
          {vm.state === "owes" ? (
            <button
              type="button"
              className={`minibtn book${scoreLater.has(vm.goalId) ? " on" : ""}`}
              title="Gave it — score later"
              aria-label="Gave it, score later"
              aria-pressed={scoreLater.has(vm.goalId)}
              onClick={() => onScoreLater(vm.goalId)}
            >
              ⚑
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
