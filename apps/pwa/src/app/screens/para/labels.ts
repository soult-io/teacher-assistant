// U6 — shared para display labels. The para observation chips are a LOCKED closed
// enum (schema PARA_OBSERVATIONS); their human labels are rendered in two places (the
// capture sheet and the teacher validation queue), so the map lives here once. Keyed
// by the enum so adding an observation is a compile error until it is labeled.

import type { ParaObservation, ProgressDataPoint, Setting } from "@teacher-assistant/schema";

export const OBS_LABEL: Readonly<Record<ParaObservation, string>> = {
  Independent: "Independent",
  Accommodation: "Accommodation",
  Within2Prompts: "Within 2 prompts",
  ThreePlusPrompts: "3+ prompts",
  Frustrated: "Frustrated",
  OffTask: "Off-task",
  TaskRefusal: "Task-refusal",
  OnTaskNeededMoreTime: "On-task but needed more time",
  UsedLearnedStrategy: "Used learned strategy",
  SelfCorrected: "Self-corrected",
};

/** The instructional-setting label — shared by the capture sheet chips and the validation queue. */
export const SETTING_LABEL: Readonly<Record<Setting, string>> = {
  math_resource: "Resource",
  gen_ed: "Gen-ed",
  home_scored: "Home",
};

/**
 * The captured value of a pending point, for display: a ⊘ documented gap or a
 * numerator/denominator with its %. Shared by every teacher-side view of a para point
 * (the mobile validation queue + the desktop validation strip) so the formatting — a
 * ⊘ never a zero, the % rounding — can only change in one place.
 */
export function pointValueLabel(p: ProgressDataPoint): string {
  if (p.state === "no_data") {
    return `⊘ ${p.no_data_reason ?? "no data"}`;
  }
  if (p.numerator !== undefined && p.denominator_used !== undefined) {
    const pct = Math.round((p.numerator / p.denominator_used) * 100);
    return `${p.numerator}/${p.denominator_used} = ${pct}%`;
  }
  return "—";
}
