// U6 — shared para display labels. The para observation chips are a LOCKED closed
// enum (schema PARA_OBSERVATIONS); their human labels are rendered in two places (the
// capture sheet and the teacher validation queue), so the map lives here once. Keyed
// by the enum so adding an observation is a compile error until it is labeled.

import type { ParaObservation } from "@teacher-assistant/schema";

export const OBS_LABEL: Readonly<Record<ParaObservation, string>> = {
  Independent: "Independent",
  Accommodation: "Accommodation",
  Within2Prompts: "Within 2 prompts",
  ThreePlusPrompts: "3+ prompts",
  Frustrated: "Frustrated",
  OffTask: "Off-task",
  TaskRefusal: "Task-refusal",
  OnTaskNeededMoreTime: "On-task, needed more time",
  UsedLearnedStrategy: "Used learned strategy",
  SelfCorrected: "Self-corrected",
};
