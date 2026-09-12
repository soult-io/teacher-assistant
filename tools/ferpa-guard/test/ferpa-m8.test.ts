// FERPA-guard — HARD STOP #8 (M8 auto progress-statement, data-model §6.2, design
// §G R3-3, FERPA Item-3a/§10). The draft progress statement is a defensible
// PROJECTION, which makes its FERPA posture the nuanced one. Two invariants are
// enforced here:
//
//   (a) NO proposed-goal statement — a proposed/baseline or non-% goal is
//       structurally incapable of a statement (reuse of the M6a export guard).
//       Proven behaviourally against the real M8 engine.
//   (b) NO narrative ingestion — the engine assembles from STRUCTURED slots only
//       and must never read a free-text / clinical / para-chip field. Proven by a
//       static scan of the M8 source (comment-stripped, so the privacy prose that
//       NAMES these fields does not trip the check).

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeAutoStatement } from "@teacher-assistant/domain-core";
import {
  asTimestamp,
  type DenominatorModel,
  type GoalStatus,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { scanCodeForPattern } from "../src/checks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const m8Files = [
  join(repoRoot, "packages", "domain-core", "src", "auto-statement.ts"),
  join(repoRoot, "packages", "domain-core", "src", "trend.ts"),
];

function goal(over?: Partial<{ status: GoalStatus; denominatorModel: DenominatorModel }>): IEPGoal {
  return {
    goal_id: newOpaqueId(),
    student_id: newOpaqueId(),
    goal_text: "synthetic",
    behavior: "b",
    circumstance: "c",
    criterion_level: 80,
    criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
    method_general: "cbm",
    method_tool: "probe",
    frequency: "weekly",
    denominator_model: over?.denominatorModel ?? "percent_correct_over_total",
    baseline_value: 50,
    baseline_source: "computed_from_baseline_points",
    accom_mod: "none",
    setting_default: "math_resource",
    valid_settings: ["math_resource"],
    status: over?.status ?? "active",
    created_ts: asTimestamp(0),
    iep_end_date: "2027-05-29" as IsoDate,
    revisions: [],
  };
}

const WEEKLY = [
  "2026-09-07",
  "2026-09-14",
  "2026-09-21",
  "2026-09-28",
  "2026-10-05",
  "2026-10-12",
  "2026-10-19",
  "2026-10-26",
];
function points(g: IEPGoal): ProgressDataPoint[] {
  return WEEKLY.map((d, i) => ({
    data_point_id: newOpaqueId(),
    goal_id: g.goal_id,
    student_id: g.student_id,
    admin_date: d as IsoDate,
    entry_ts: asTimestamp(0),
    state: "scored" as const,
    numerator: 52 + i * 4,
    denominator_used: 100,
    setting: "math_resource" as const,
    scorer: "teacher" as const,
    revisions: [],
  }));
}

describe("HARD STOP #8a — no statement for a proposed/baseline or non-% goal", () => {
  it("a proposed goal produces NO statement (null), even with a full scored series", () => {
    const proposed = goal({ status: "proposed" });
    expect(
      computeAutoStatement(proposed, "AB", points(proposed), { isNonInstructional: () => false }),
    ).toBeNull();
  });

  it("a non-% goal produces NO statement (no %↔rubric coercion into a projection)", () => {
    const rubric = goal({ denominatorModel: "rubric_score" });
    expect(
      computeAutoStatement(rubric, "AB", points(rubric), { isNonInstructional: () => false }),
    ).toBeNull();
  });

  it("an active, baselined % goal DOES produce a statement — the guard is structural, not blanket", () => {
    const active = goal();
    expect(
      computeAutoStatement(active, "AB", points(active), { isNonInstructional: () => false }),
    ).not.toBeNull();
  });
});

describe("HARD STOP #8b — the M8 engine never ingests a narrative / clinical / para-chip field", () => {
  // These schema fields carry (or could carry) un-reviewed student narrative or
  // para-entered observation; the statement must be built from STRUCTURED slots
  // only, so none may appear anywhere in the M8 code (comments excepted).
  const forbiddenFields: readonly RegExp[] = [
    /\bpara_observations\b/,
    /\baccommodation_subtypes\b/,
    /\bno_data_reason\b/,
    /\bclinical/i,
    /\bnotes?\b/i,
  ];

  it("no forbidden narrative field is referenced in the M8 source", () => {
    for (const pattern of forbiddenFields) {
      const hits = scanCodeForPattern(m8Files, pattern);
      expect(hits, `${pattern} → ${JSON.stringify(hits, null, 2)}`).toEqual([]);
    }
  });
});
