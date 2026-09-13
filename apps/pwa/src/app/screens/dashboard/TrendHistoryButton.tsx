// The ↗ trend/history button — the always-available path to Goal Detail from a
// dashboard row (design R3 D2: reachable from EVERY goal). Shared by the flat
// GoalRow and the nested StudentCard so the label/a11y/icon stay in one place.

import type { RowVM } from "./dashboard-vm.js";

export function TrendHistoryButton({
  vm,
  onOpenDetail,
}: {
  readonly vm: RowVM;
  readonly onOpenDetail: (vm: RowVM) => void;
}) {
  return (
    <button
      type="button"
      className="minibtn"
      title="Trend & history"
      aria-label={`trend and history ${vm.goalText}`}
      onClick={() => onOpenDetail(vm)}
    >
      ↗
    </button>
  );
}
