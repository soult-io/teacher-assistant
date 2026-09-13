// A by-student dashboard card (design §E.4): the student's monogram avatar +
// initials + period(s) + a to-do/done tally, with their goals nested under a
// matching-hue colour rail. Status still dominates each nested row (glyph +
// status-coloured value); the student hue lives only in the avatar + rail.

import { hueClassForInitials } from "../../../design/hues.js";
import { chipForDashboardState } from "../../../design/glyphs.js";
import { Avatar } from "../../../design/Avatar.js";
import { rowValueText, type StudentCardVM } from "./dashboard-vm.js";

export function StudentCard({ card }: { readonly card: StudentCardVM }) {
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
          <span>{rowValueText(vm) ?? "owes"}</span>
        </div>
      ))}
    </div>
  );
}
