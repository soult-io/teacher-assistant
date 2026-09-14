// U5 — Baseline / proposed-goal track (design §F.F3, SEGREGATED). Proposed goals
// being baselined before each student's ARC: never on the active weekly dashboard,
// no owes, HARD NO to IC (the M6a structural guard). Reads M7: deriveBaseline (mean
// + median-of-3, always an ESTIMATE), canAdopt (the ≥3-comparable-point gate), and
// computeBaselineWindowStart (arc_date − ~6 instructional weeks). The UI collects +
// calls — no baseline / adoption / window rules live here.

import {
  type ArcDateAlert,
  type BaselineMethod,
  canAdopt,
  computeBaselineWindowStart,
  deriveBaseline,
} from "@teacher-assistant/domain-core";
import type { BaselinePoint, IEPGoal, OpaqueId } from "@teacher-assistant/schema";
import { useState } from "react";
import { Avatar } from "../../../design/Avatar.js";
import type { DecryptedRecords } from "../../../data/repository.js";

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
}

function AddPointRow({
  goal,
  onAdd,
}: {
  readonly goal: IEPGoal;
  readonly onAdd: (goal: IEPGoal, numerator: number, denominator: number) => void;
}) {
  const [correct, setCorrect] = useState(0);
  const [total, setTotal] = useState(5);
  return (
    <div className="baddrow">
      <span className="baddlabel"># correct</span>
      <input
        className="numin"
        inputMode="numeric"
        aria-label="baseline correct"
        value={correct}
        onChange={(e) => setCorrect(Math.max(0, Number.parseInt(e.target.value, 10) || 0))}
      />
      <span>of</span>
      <input
        className="ofin"
        inputMode="numeric"
        aria-label="baseline total"
        value={total}
        onChange={(e) => setTotal(Math.max(1, Number.parseInt(e.target.value, 10) || 1))}
      />
      <button
        type="button"
        className="btn small primary"
        onClick={() => onAdd(goal, Math.min(correct, total), total)}
      >
        + Add baseline point
      </button>
    </div>
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
  const need = Math.max(0, 3 - estimate.n);
  return (
    <div className="note owestext" data-testid="baseline-not-usable">
      {estimate.comparable
        ? `Needs ${need} more comparable probe${need === 1 ? "" : "s"} before a usable baseline.`
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

function ProposedCard({
  goal,
  points,
  initials,
  periodLabel,
  useMedian,
  isNonInstructional,
  onAddBaselinePoint,
  onAdopt,
  onEditArcDate,
}: {
  readonly goal: IEPGoal;
  readonly points: readonly BaselinePoint[];
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
          <div className="rowtitle">{goal.goal_text}</div>
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
      <ArcAlertNote alert={alert} />

      <div className="chips bchips">
        {points.length > 0 ? (
          points.map((p) => (
            <span key={p.baseline_point_id} className="dchip static">
              {Math.round((p.numerator / p.denominator_used) * 100)}%
            </span>
          ))
        ) : (
          <span className="note">no points yet</span>
        )}
      </div>

      <EstimateBlock estimate={estimate} useMedian={useMedian} />

      <AddPointRow goal={goal} onAdd={onAddBaselinePoint} />

      {adoptCheck.ok ? (
        <button
          type="button"
          className="btn primary small wide adoptbtn"
          data-testid="adopt-button"
          onClick={() => onAdopt(goal, points, useMedian ? "median" : "mean")}
        >
          Adopt at ARC → activate goal
        </button>
      ) : null}
    </div>
  );
}

export function BaselineScreen(props: BaselineScreenProps) {
  const { records, initialsById, periodLabelByStudent, isNonInstructional, onBack, onNewGoal } =
    props;
  const [useMedian, setUseMedian] = useState(false);

  const proposed = records.goals.filter((g) => g.status === "proposed");
  const pointsByGoal = new Map<string, BaselinePoint[]>();
  for (const p of records.baselinePoints) {
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
              points={pointsByGoal.get(goal.goal_id) ?? []}
              initials={initialsById.get(goal.student_id) ?? "??"}
              periodLabel={periodLabelByStudent(goal.student_id)}
              useMedian={useMedian}
              isNonInstructional={isNonInstructional}
              onAddBaselinePoint={props.onAddBaselinePoint}
              onAdopt={props.onAdopt}
              onEditArcDate={props.onEditArcDate}
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
