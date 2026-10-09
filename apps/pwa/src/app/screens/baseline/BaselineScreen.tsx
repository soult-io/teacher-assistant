// U5 — Baseline / proposed-goal track (design §F.F3, SEGREGATED). Proposed goals
// being baselined before each student's ARC: never on the active weekly dashboard,
// no owes, HARD NO to IC (the M6a structural guard). Reads M7: deriveBaseline (mean
// + median-of-3, always an ESTIMATE), canAdopt (the ≥3-comparable-point gate), and
// computeBaselineWindowStart (arc_date − ~6 instructional weeks). The UI collects +
// calls — no baseline / adoption / window rules live here.
//
// TEACH-46: "# correct" starts EMPTY (a typed 0 is a real score; an untouched box
// is not), "of N" is prefilled from the probe (never a hardcoded 5), and each point
// can be fixed or removed through the audited BaselinePoints panel.

import {
  type AdoptionCheck,
  type ArcDateAlert,
  type BaselineFix,
  type BaselineMethod,
  baselineTotalPrefill,
  canAdopt,
  computeBaselineWindowStart,
  deriveBaseline,
  goalLabelConflicts,
  takesBaselineScore,
} from "@teacher-assistant/domain-core";
import type {
  BaselinePoint,
  BaselineRemoveReason,
  IEPGoal,
  OpaqueId,
  ProbeDefinition,
} from "@teacher-assistant/schema";
import { useId, useState } from "react";
import { Avatar } from "../../../design/Avatar.js";
import { DuplicateLabelCue, GoalTitle } from "../../../design/GoalTitle.js";
import { GoalLabelEditor } from "../../GoalLabelEditor.js";
import type { DecryptedRecords } from "../../../data/repository.js";
import { baselinePointsOldestFirst, orderProposedGoals } from "./baseline-order.js";
import { BaselinePoints, SCORE_PROBLEM_TEXT, useScoreDraft } from "./BaselinePoints.js";

export interface BaselineScreenProps {
  readonly records: DecryptedRecords;
  readonly initialsById: ReadonlyMap<string, string>;
  /** The student's class-period label, if any (design §E.1 — the period tag on the card). */
  readonly periodLabelByStudent: (studentId: OpaqueId) => string | null;
  readonly isNonInstructional: (weekId: string) => boolean;
  readonly onBack: () => void;
  readonly onNewGoal: () => void;
  readonly onAddBaselinePoint: (goal: IEPGoal, numerator: number, denominator: number) => void;
  readonly onAdopt: (
    goal: IEPGoal,
    points: readonly BaselinePoint[],
    method: BaselineMethod,
  ) => void;
  readonly onEditArcDate: (goal: IEPGoal, newArcDate: string) => ArcDateAlert;
  /** Save a changed IEP goal label (undefined = cleared); the caller audits via setGoalLabel. */
  readonly onSetGoalLabel: (goal: IEPGoal, label: string | undefined) => void;
  /** TEACH-46 audited edits; the caller routes each through the domain-core rule. */
  readonly onFixBaselinePoint: (goal: IEPGoal, point: BaselinePoint, fix: BaselineFix) => void;
  readonly onRemoveBaselinePoint: (
    goal: IEPGoal,
    point: BaselinePoint,
    reason: BaselineRemoveReason,
  ) => void;
  readonly onKeepBaselineTotal: (goal: IEPGoal, point: BaselinePoint) => void;
}

/**
 * "# correct of N" + Add (C7, ruling D). # correct starts empty and the button
 * stays disabled, with its reason, until a whole number is typed (0 is fine).
 * N is the probe's total on a fixed-total goal, empty and required otherwise.
 */
function AddPointRow({
  goal,
  probe,
  onAdd,
}: {
  readonly goal: IEPGoal;
  readonly probe: ProbeDefinition | undefined;
  readonly onAdd: (goal: IEPGoal, numerator: number, denominator: number) => void;
}) {
  const prefill = baselineTotalPrefill(goal, probe);
  const initialTotal = prefill !== undefined ? String(prefill) : "";
  const draft = useScoreDraft("", initialTotal);
  const reasonId = useId();
  const { numerator, total, problem } = draft;
  return (
    <>
      <div className="baddrow">
        <span className="baddlabel"># correct</span>
        <input
          className="numin"
          inputMode="numeric"
          aria-label="baseline correct"
          value={draft.correctText}
          onChange={(e) => draft.setCorrectText(e.target.value)}
        />
        <span>of</span>
        <input
          className="ofin"
          inputMode="numeric"
          aria-label="baseline total"
          value={draft.totalText}
          onChange={(e) => draft.setTotalText(e.target.value)}
        />
        <button
          type="button"
          className="btn small primary"
          data-testid="add-baseline-point"
          disabled={problem !== null}
          aria-describedby={problem !== null ? reasonId : undefined}
          onClick={() => {
            if (numerator !== undefined && total !== undefined) {
              onAdd(goal, numerator, total);
              draft.setCorrectText("");
              draft.setTotalText(initialTotal);
            }
          }}
        >
          + Add baseline point
        </button>
      </div>
      {problem !== null ? (
        <div className="note" id={reasonId} data-testid="add-point-reason">
          {SCORE_PROBLEM_TEXT[problem]}
        </div>
      ) : null}
    </>
  );
}

/** The window/deadline line — the DEADLINE (ARC date) drives urgency (pure). */
function windowText(goal: IEPGoal, windowStart: string | undefined): string {
  if (goal.arc_date === undefined) {
    return " · set an ARC date to open the baseline window";
  }
  const open = windowStart !== undefined ? ` · window ${windowStart} →` : "";
  return `${open} closes ARC ${goal.arc_date}`;
}

/** The baseline estimate (usable) or the "needs more / not comparable" note — split out for complexity. */
function EstimateBlock({
  estimate,
  useMedian,
}: {
  readonly estimate: ReturnType<typeof deriveBaseline>;
  readonly useMedian: boolean;
}) {
  if (estimate.usable && estimate.value !== null) {
    return (
      <>
        <div className="estline" data-testid="baseline-estimate">
          <span className="est">{Math.round(estimate.value)}%</span>
          <span className="estlab">baseline estimate ({useMedian ? "median" : "average"})</span>
        </div>
        <div className="note">
          An ESTIMATE, not a trend (n = {estimate.n}). Locks into the goal only on ARC adoption,
          when the criterion is finalized.
        </div>
      </>
    );
  }
  return (
    <div className="note owestext" data-testid="baseline-not-usable">
      {estimate.comparable
        ? `Need 3 points to estimate a baseline (you have ${estimate.n}).`
        : "Points span more than one probe condition — not comparable. Re-collect on one probe."}
    </div>
  );
}

function ArcAlertNote({ alert }: { readonly alert: ArcDateAlert }) {
  if (alert === null) {
    return null;
  }
  return (
    <div className="note warn" data-testid="arc-alert">
      {alert === "compressed"
        ? "⚠ Earlier ARC date — the baseline window is now shorter. Collected points are kept; plan the remaining probes sooner."
        : "The ARC date moved later — the baseline window is longer. Collected points are kept."}
    </div>
  );
}

/**
 * TEACH-41 adopt-time warning (warn, never block): once a proposed goal is
 * adoptable, an ACTIVE/mastered goal already numbered the same would become a
 * duplicate on adoption. Nothing is retired automatically; the teacher decides.
 */
function AdoptLabelWarning({
  goal,
  allGoals,
  initials,
  adoptable,
}: {
  readonly goal: IEPGoal;
  readonly allGoals: readonly IEPGoal[];
  readonly initials: string;
  readonly adoptable: boolean;
}) {
  const adoptClash = adoptable ? goalLabelConflicts(allGoals, { ...goal, status: "active" }) : [];
  const [clash] = adoptClash;
  return clash !== undefined ? (
    <div className="note warn" data-testid="adopt-label-warning">
      {initials} already has an active Goal {goal.goal_label} — {clash.goal_text}. Adopting this
      makes two Goal {goal.goal_label}: retire the old Goal {goal.goal_label}?
    </div>
  ) : null;
}

/** The plain reason a ready-but-unnumbered goal cannot be adopted yet (TEACH-41). */
export const ADOPT_NEEDS_LABEL =
  "Add the IEP goal # first — use “+ Add IEP goal #” beside the ARC date.";
/** The same block when a stored label fails validation (old/synced data): the box shows “edit”. */
export const ADOPT_FIX_LABEL = "Fix the IEP goal # first — use “edit” beside the ARC date.";

/**
 * The Adopt-at-ARC action. Shown once the baseline is usable; while the goal has no
 * IEP goal # (canAdopt → "missing_label", the New-Goal ADOPT rule) it stays visible
 * but disabled, with the reason as its description.
 */
function AdoptAction({
  goal,
  check,
  onAdopt,
}: {
  readonly goal: IEPGoal;
  readonly check: AdoptionCheck;
  readonly onAdopt: () => void;
}) {
  const needsLabel = check.reason === "missing_label";
  if (!check.ok && !needsLabel) {
    return null;
  }
  const reasonId = `adopt-reason-${goal.goal_id}`;
  // GoalLabelEditor shows "+ Add IEP goal #" only when no label is stored at all.
  const reason = goal.goal_label === undefined ? ADOPT_NEEDS_LABEL : ADOPT_FIX_LABEL;
  return (
    <>
      {needsLabel ? (
        <div className="note warn" id={reasonId} data-testid="adopt-needs-label">
          {reason}
        </div>
      ) : null}
      <button
        type="button"
        className="btn primary small wide adoptbtn"
        data-testid="adopt-button"
        disabled={needsLabel}
        aria-describedby={needsLabel ? reasonId : undefined}
        onClick={onAdopt}
      >
        Adopt at ARC → activate goal
      </button>
    </>
  );
}

function ProposedCard({
  goal,
  allGoals,
  points,
  probe,
  initials,
  periodLabel,
  useMedian,
  isNonInstructional,
  onAddBaselinePoint,
  onAdopt,
  onEditArcDate,
  onSetGoalLabel,
  onFixBaselinePoint,
  onRemoveBaselinePoint,
  onKeepBaselineTotal,
}: {
  readonly goal: IEPGoal;
  /** Every goal on record — the duplicate-label checks read the student's other goals. */
  readonly allGoals: readonly IEPGoal[];
  readonly points: readonly BaselinePoint[];
  readonly probe: ProbeDefinition | undefined;
  readonly initials: string;
  readonly periodLabel: string | null;
  readonly useMedian: boolean;
  readonly isNonInstructional: (weekId: string) => boolean;
  readonly onAddBaselinePoint: (goal: IEPGoal, numerator: number, denominator: number) => void;
  readonly onAdopt: (
    goal: IEPGoal,
    points: readonly BaselinePoint[],
    method: BaselineMethod,
  ) => void;
  readonly onEditArcDate: (goal: IEPGoal, newArcDate: string) => ArcDateAlert;
  readonly onSetGoalLabel: (goal: IEPGoal, label: string | undefined) => void;
  readonly onFixBaselinePoint: BaselineScreenProps["onFixBaselinePoint"];
  readonly onRemoveBaselinePoint: BaselineScreenProps["onRemoveBaselinePoint"];
  readonly onKeepBaselineTotal: BaselineScreenProps["onKeepBaselineTotal"];
}) {
  const [alert, setAlert] = useState<ArcDateAlert>(null);
  const estimate = deriveBaseline(goal, points, useMedian ? "median" : "mean");
  const adoptCheck = canAdopt(goal, points);
  const windowStart = computeBaselineWindowStart(goal, isNonInstructional);

  return (
    <div className="bcard" data-testid="proposed-card">
      <div className="bhd">
        <Avatar initials={initials} />
        <div className="btitle">
          <div className="rowtitle">
            <GoalTitle label={goal.goal_label} text={goal.goal_text} />
            {goalLabelConflicts(allGoals, goal).length > 0 ? (
              <DuplicateLabelCue label={goal.goal_label} />
            ) : null}
          </div>
          <div className="rowmeta">
            {periodLabel !== null ? `${periodLabel} · ` : ""}
            {goal.behavior}
          </div>
        </div>
      </div>

      <div className="note bwindow">
        <b>{estimate.n} of ≥3 collected</b>
        {windowText(goal, windowStart)}
      </div>

      {/* DD-1: the ARC-date input renders even when unset, so a just-drafted proposed
          goal can get its arc_date and open its window (routed through the engine). */}
      <div className="arcrow">
        <label className="arcedit">
          <span className="nghint">ARC date</span>
          <input
            className="tin arcin"
            type="date"
            value={goal.arc_date ?? ""}
            aria-label="arc date"
            onChange={(e) => e.target.value !== "" && setAlert(onEditArcDate(goal, e.target.value))}
          />
        </label>
        {/* TEACH-41: the IEP goal # box sits beside the ARC date (optional on a draft).
            Outside the <label>: one label wrapping two controls corrupts their names. */}
        <span className="goallabel-row">
          {goal.goal_label !== undefined ? (
            <span className="goalnum">Goal {goal.goal_label}</span>
          ) : null}
          <GoalLabelEditor
            label={goal.goal_label}
            onSave={(label) => onSetGoalLabel(goal, label)}
          />
        </span>
      </div>
      <ArcAlertNote alert={alert} />

      <BaselinePoints
        goal={goal}
        points={points}
        allowRemove={true}
        onFix={(point, fix) => onFixBaselinePoint(goal, point, fix)}
        onRemove={(point, reason) => onRemoveBaselinePoint(goal, point, reason)}
        onKeep={(point) => onKeepBaselineTotal(goal, point)}
      />

      <EstimateBlock estimate={estimate} useMedian={useMedian} />

      {/* C7: the "# correct of N" row serves %-scored goals only. Keyed by the
          prefill so a probe-total change resets the empty draft. */}
      {takesBaselineScore(goal) ? (
        <AddPointRow
          key={baselineTotalPrefill(goal, probe) ?? "none"}
          goal={goal}
          probe={probe}
          onAdd={onAddBaselinePoint}
        />
      ) : null}

      <AdoptLabelWarning
        goal={goal}
        allGoals={allGoals}
        initials={initials}
        // ok also requires a label; a clash needs one, so missing_label correctly shows nothing.
        adoptable={adoptCheck.ok}
      />
      <AdoptAction
        goal={goal}
        check={adoptCheck}
        onAdopt={() => onAdopt(goal, points, useMedian ? "median" : "mean")}
      />
    </div>
  );
}

export function BaselineScreen(props: BaselineScreenProps) {
  const { records, initialsById, periodLabelByStudent, isNonInstructional, onBack, onNewGoal } =
    props;
  const [useMedian, setUseMedian] = useState(false);

  // Display order (TEACH-25): record order is not stable across reseeds.
  const proposed = orderProposedGoals(
    records.goals.filter((g) => g.status === "proposed"),
    {
      initialsOf: (sid) => initialsById.get(sid) ?? "??",
      periodLabelOf: periodLabelByStudent,
    },
  );
  const probeByGoal = new Map(records.probes.map((p) => [p.goal_id, p]));
  const pointsByGoal = new Map<string, BaselinePoint[]>();
  for (const p of baselinePointsOldestFirst(records.baselinePoints)) {
    const bucket = pointsByGoal.get(p.goal_id) ?? [];
    bucket.push(p);
    pointsByGoal.set(p.goal_id, bucket);
  }
  // DF-5: the mean/median toggle only makes sense once a usable estimate exists —
  // show it only when at least one card has a usable (≥3 comparable) baseline.
  const anyUsable = proposed.some(
    (g) => deriveBaseline(g, pointsByGoal.get(g.goal_id) ?? []).usable,
  );

  return (
    <div className="baseline-track">
      <div className="backrow">
        <button type="button" className="back" onClick={onBack}>
          ‹ Dashboard
        </button>
      </div>
      <h1>Baseline / proposed goals</h1>
      <div className="sub">
        New IEP goals being baselined before each student's ARC. Separate from weekly monitoring.
      </div>
      <div className="banner info">
        These never feed Infinite Campus and have no weekly “owes”. On adoption at ARC they lock a
        baseline and become active goals.
      </div>

      {anyUsable ? (
        <div className="chips" style={{ margin: "0.4rem 0" }} data-testid="estimate-method">
          <button
            type="button"
            className={`dchip${!useMedian ? " on" : ""}`}
            onClick={() => setUseMedian(false)}
          >
            Average
          </button>
          <button
            type="button"
            className={`dchip${useMedian ? " on" : ""}`}
            data-testid="median-toggle"
            onClick={() => setUseMedian(true)}
          >
            Median
          </button>
        </div>
      ) : null}

      {proposed.length === 0 ? (
        <div className="card">No proposed goals. Draft one to start baselining.</div>
      ) : (
        <div className="bcardgrid">
          {proposed.map((goal) => (
            <ProposedCard
              key={goal.goal_id}
              goal={goal}
              allGoals={records.goals}
              points={pointsByGoal.get(goal.goal_id) ?? []}
              probe={probeByGoal.get(goal.goal_id)}
              initials={initialsById.get(goal.student_id) ?? "??"}
              periodLabel={periodLabelByStudent(goal.student_id)}
              useMedian={useMedian}
              isNonInstructional={isNonInstructional}
              onAddBaselinePoint={props.onAddBaselinePoint}
              onAdopt={props.onAdopt}
              onEditArcDate={props.onEditArcDate}
              onSetGoalLabel={props.onSetGoalLabel}
              onFixBaselinePoint={props.onFixBaselinePoint}
              onRemoveBaselinePoint={props.onRemoveBaselinePoint}
              onKeepBaselineTotal={props.onKeepBaselineTotal}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        className="btn primary wide"
        style={{ marginTop: "0.4rem" }}
        onClick={onNewGoal}
      >
        + Draft a proposed goal
      </button>
    </div>
  );
}
