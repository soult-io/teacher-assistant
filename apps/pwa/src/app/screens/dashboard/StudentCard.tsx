// A by-student dashboard card (design §E.4): the student's monogram avatar +
// initials + period(s) + a to-do/done tally, with their goals nested under a
// matching-hue colour rail. Status dominates each nested row (glyph + a
// status-coloured value, §E.3); owes/scored rows are tappable to score/[Fix], and
// owes rows carry the score-later ⚑ flag — same behavior as the flat row.

import { Avatar } from "../../../design/Avatar.js";
import { chipForDashboardState } from "../../../design/glyphs.js";
import { hueClassForInitials } from "../../../design/hues.js";
import { type RowVM, rowValueText, type StudentCardVM } from "./dashboard-vm.js";

function nestedValue(vm: RowVM) {
  const text = rowValueText(vm) ?? "owes";
  const tone = vm.state === "owes" ? " owes" : vm.state === "documented_no_data" ? " nodata" : "";
  return <span className={`sval${tone}`}>{text}</span>;
}

export interface StudentCardProps {
  readonly card: StudentCardVM;
  readonly queuedGoalIds: ReadonlySet<string>;
  readonly onScoreLater: (vm: RowVM) => void;
  readonly onOpenScore: (vm: RowVM) => void;
}

function NestedGoal({
  vm,
  hue,
  scoreLater,
  onScoreLater,
  onOpenScore,
}: {
  readonly vm: RowVM;
  readonly hue: string;
  readonly scoreLater: boolean;
  readonly onScoreLater: (vm: RowVM) => void;
  readonly onOpenScore: (vm: RowVM) => void;
}) {
  const tappable = vm.state === "owes" || vm.state === "has_point";
  return (
    <div className="sgoal">
      <span className={`rail ${hue}`} />
      <span className={`chip ${chipForDashboardState(vm.state).className}`} aria-hidden="true">
        {chipForDashboardState(vm.state).glyph}
      </span>
      {tappable ? (
        <button
          type="button"
          className="g tap gbtn"
          aria-label={`score ${vm.goalText}`}
          onClick={() => onOpenScore(vm)}
        >
          {vm.goalText}
        </button>
      ) : (
        <span className="g">{vm.goalText}</span>
      )}
      {nestedValue(vm)}
      {vm.state === "owes" ? (
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
    </div>
  );
}

export function StudentCard({ card, queuedGoalIds, onScoreLater, onOpenScore }: StudentCardProps) {
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
        <NestedGoal
          key={vm.goalId}
          vm={vm}
          hue={hue}
          scoreLater={queuedGoalIds.has(vm.goalId)}
          onScoreLater={onScoreLater}
          onOpenScore={onOpenScore}
        />
      ))}
    </div>
  );
}
