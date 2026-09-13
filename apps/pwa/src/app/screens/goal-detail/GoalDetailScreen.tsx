// U4 — Goal Detail (design R3 D2/D3, prototype renderGoalDetail). Reachable from
// every goal (dashboard row ↗). It READS the M5/M6a/M8 read models and renders
// them faithfully — it holds NO domain logic (every rule is routed back to the
// engine: buildGoalDetail / computeAutoStatement). The screen assembles:
//   (a) the trend chart (TrendChart),
//   (b) the F4 quarterly progress summary — incl. the no-data-weeks-spanned label,
//   (c) the M8 DRAFT auto-statement — three variants, INDETERMINATE under the gate,
//   (d) the consistency-window tracker + teacher-only mastery acknowledge,
//   (e) the ARC-audit history table (every point, incl. off-basis + ⊘ + edits).

import {
  type AutoStatement,
  buildGoalDetail,
  compareCodePoints,
  computeAutoStatement,
  type GoalDetail,
  type MasteryCandidate,
} from "@teacher-assistant/domain-core";
import type {
  IEPGoal,
  MasteryObservation,
  ProgressDataPoint,
  Revision,
  Timestamp,
} from "@teacher-assistant/schema";
import { Avatar } from "../../../design/Avatar.js";
import { TrendChart } from "./TrendChart.js";

/** ISO day for a millisecond audit timestamp (entry / edit time). */
function isoDay(ts: Timestamp): string {
  return new Date(Number(ts)).toISOString().slice(0, 10);
}

/** Compact who/when/old→new summary for an audited edit (§B audit trail). */
function describeRevision(rev: Revision): string {
  const keysOf = (o: unknown): string[] =>
    typeof o === "object" && o !== null ? Object.keys(o) : [];
  const keys = [...new Set([...keysOf(rev.old), ...keysOf(rev.new)])];
  const asRec = (o: unknown): Record<string, unknown> =>
    typeof o === "object" && o !== null ? (o as Record<string, unknown>) : {};
  const oldR = asRec(rev.old);
  const newR = asRec(rev.new);
  const diff = keys
    .map((k) => `${k}: ${String(oldR[k] ?? "—")}→${String(newR[k] ?? "—")}`)
    .join(", ");
  return `${rev.who} · ${isoDay(rev.when)} — ${diff}`;
}

const VARIANT_BADGE: Readonly<Record<AutoStatement["variant"], string>> = {
  on_track: "On track",
  not_on_track: "Not yet on track",
  indeterminate: "Indeterminate",
};

function pctOf(p: ProgressDataPoint): string {
  if (p.state === "no_data") {
    return `⊘ ${p.no_data_reason ?? "no data"}`;
  }
  if (p.computed_value === undefined) {
    return "—";
  }
  return `${Math.round(p.computed_value * 100)}%`;
}

/** "s" for a plural count, "" for one — keeps the note copy out of the branch count. */
function plural(n: number): string {
  return n === 1 ? "" : "s";
}

/** The F4 context notes (each shown only when it applies) — split out to keep the card simple. */
function QuarterlyNotes({ q }: { readonly q: GoalDetail["quarterlySummary"] }) {
  return (
    <>
      {/* Honesty nuance #1 (F4): the no-data weeks the window spans are shown so the
          gap is explained (excluded from the average, never zero-filled). */}
      {q.noDataCountSpanned > 0 ? (
        <div className="note" data-testid="nodata-spanned">
          Spans {q.noDataCountSpanned} no-data week{plural(q.noDataCountSpanned)} (excluded from the
          average, shown for context).
        </div>
      ) : null}
      {q.n < 5 ? (
        <div className="note">
          Only {q.n} scored point{plural(q.n)} available — averaged as-is, never padded with zeros.
        </div>
      ) : null}
      {q.countedOffBasis > 0 ? (
        <div className="note warn">
          ⚠ Includes {q.countedOffBasis} off-basis point{plural(q.countedOffBasis)} (counted at your
          election) — check comparability before reporting.
        </div>
      ) : null}
      {q.excludedMismatches > 0 ? (
        <div className="note warn">
          {q.excludedMismatches} off-basis point{plural(q.excludedMismatches)} kept out of the
          average (shown in history).
        </div>
      ) : null}
    </>
  );
}

function QuarterlyCard({ detail }: { readonly detail: GoalDetail }) {
  const q = detail.quarterlySummary;
  return (
    <div className="card qsummary" data-testid="quarterly">
      <div className="qhead">
        <span className="qlab">Quarterly progress summary</span>
      </div>
      {q.average === null ? (
        <div className="note">No scored points yet — nothing to average.</div>
      ) : (
        <>
          <div className="qbigline">
            <span className="big">{Math.round(q.average)}%</span>
            <span className="qsub">
              average of last {q.n} scored point{plural(q.n)}
              {q.dateRange !== null ? ` · ${q.dateRange.start}–${q.dateRange.end}` : ""}
            </span>
          </div>
          <QuarterlyNotes q={q} />
        </>
      )}
    </div>
  );
}

function StatementCard({ statement }: { readonly statement: AutoStatement }) {
  return (
    <div className="card draftstmt" data-testid="auto-statement">
      <div className="draftbanner">{statement.label}</div>
      <div className={`vbadge ${statement.variant}`} data-testid="statement-variant">
        {VARIANT_BADGE[statement.variant]}
      </div>
      <p className="stmttext">{statement.text}</p>
      {statement.excludedMismatches > 0 ? (
        <div className="note">
          {statement.excludedMismatches} off-basis/condition-mismatched point
          {statement.excludedMismatches === 1 ? " is" : "s are"} excluded from this statement.
        </div>
      ) : null}
      {statement.clampedAtChange ? (
        <div className="note">
          Figures are limited to the current goal (a criterion / model change was not averaged
          across).
        </div>
      ) : null}
    </div>
  );
}

function ConsistencyCard({
  detail,
  goal,
  observation,
  onAckMastery,
}: {
  readonly detail: GoalDetail;
  readonly goal: IEPGoal;
  readonly observation: MasteryObservation | undefined;
  readonly onAckMastery: (candidate: MasteryCandidate) => void;
}) {
  const c = detail.consistency;
  const candidate = detail.masteryCandidate;
  // The recent probes glance: the last `required` plotted values vs criterion. The
  // authoritative run count is the engine's `c.run` (⊘ pauses; off-basis per election).
  const recent = detail.trend.slice(-c.required);
  return (
    <div className="card">
      <div className="cardhead">
        <b>Consistency window</b>
      </div>
      <div className="window" data-testid="consistency-window">
        {recent.map((t) => (
          <span
            key={t.adminDate}
            className={t.value >= goal.criterion_level ? "win-yes" : "win-no"}
          >
            {t.value >= goal.criterion_level ? "●" : "○"}
          </span>
        ))}
        <span className="wl">
          {c.run} of {c.required} consecutive ≥{goal.criterion_level}%
        </span>
      </div>
      {c.unresolvedMismatches > 0 ? (
        <div className="note warn">
          {c.unresolvedMismatches} off-basis point{plural(c.unresolvedMismatches)} awaiting your
          disposition (out of the window until resolved).
        </div>
      ) : null}
      {observation !== undefined ? (
        <div className="banner ok" data-testid="mastery-acknowledged">
          ★ Window met — acknowledged {observation.window_met_date}, flagged for ARC. Goal stays
          open.
        </div>
      ) : candidate !== null ? (
        <div className="metbox" data-testid="mastery-candidate">
          <div>
            <span className="star">★</span> <b>Criterion window met.</b>
          </div>
          <div className="note mastery-note">
            The app only observes this — it never closes the goal. Retiring a goal is your call at
            ARC.
          </div>
          <button
            type="button"
            className="btn small primary ackbtn"
            onClick={() => onAckMastery(candidate)}
          >
            Acknowledge for ARC
          </button>
        </div>
      ) : (
        <div className="notyet">
          ↳ Not yet: needs {c.required} consecutive ≥{goal.criterion_level}%.
        </div>
      )}
    </div>
  );
}

function HistoryTable({
  goal,
  points,
  probeLabel,
  onEditPoint,
}: {
  readonly goal: IEPGoal;
  readonly points: readonly ProgressDataPoint[];
  readonly probeLabel: string;
  readonly onEditPoint: (point: ProgressDataPoint) => void;
}) {
  // Newest-first, like the prototype; a stable id tiebreak for same-date points.
  const rows = points
    .filter((p) => p.goal_id === goal.goal_id)
    .slice()
    .sort(
      (a, b) =>
        compareCodePoints(b.admin_date, a.admin_date) ||
        compareCodePoints(b.data_point_id, a.data_point_id),
    );
  return (
    <div className="card">
      <div className="cardhead">
        <b>ARC history (audit)</b>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Admin date</th>
              <th>Entered</th>
              <th>Correct/total</th>
              <th>%</th>
              <th>Probe</th>
              <th>Scorer</th>
              <th>Validated by</th>
              <th> </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const ct =
                p.state === "scored" && p.numerator !== undefined
                  ? `${p.numerator}/${p.denominator_used ?? "?"}`
                  : "—";
              return (
                <tr key={p.data_point_id}>
                  <td>
                    {p.admin_date}
                    {p.denominator_mismatch ? (
                      <span className="mismatch" title="off-basis (total ≠ assigned probe)">
                        {" "}
                        ⚠
                      </span>
                    ) : null}
                  </td>
                  <td>{isoDay(p.entry_ts)}</td>
                  <td>
                    {ct}
                    {p.denominator_original !== undefined && p.denominator_mismatch === true ? (
                      <span className="waswas"> (assigned {p.denominator_original})</span>
                    ) : null}
                  </td>
                  <td>{pctOf(p)}</td>
                  <td>{probeLabel}</td>
                  <td>{p.scorer}</td>
                  <td>{p.validated_by ?? (p.scorer === "para" ? "—" : "teacher")}</td>
                  <td>
                    {p.state === "scored" ? (
                      <button
                        type="button"
                        className="editpt"
                        onClick={() => onEditPoint(p)}
                        aria-label={`fix ${p.admin_date}`}
                      >
                        Fix
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.some((p) => p.revisions.length > 0) ? (
        <div className="revlist" data-testid="revisions">
          <div className="revhead">Edit history (prior values retained)</div>
          {rows.flatMap((p) =>
            p.revisions.map((rev) => (
              <div key={`${p.data_point_id}-${rev.when}`} className="revrow">
                {p.admin_date}: {describeRevision(rev)}
              </div>
            )),
          )}
        </div>
      ) : null}
      <div className="note">
        Stores numerator/denominator, both dates, and validator — not just the %. Edits keep the
        prior value (who/when/old→new).
      </div>
    </div>
  );
}

export interface GoalDetailScreenProps {
  readonly goal: IEPGoal;
  readonly points: readonly ProgressDataPoint[];
  readonly observations: readonly MasteryObservation[];
  readonly initials: string;
  readonly periodLabel: string | null;
  readonly probeLabel: string;
  /** Calendar break flag (M4) — the ≥4-instructional-week gate; synthetic = none. */
  readonly isNonInstructional?: (weekId: string) => boolean;
  readonly onBack: () => void;
  readonly onAddPoint: () => void;
  readonly onEditPoint: (point: ProgressDataPoint) => void;
  readonly onAckMastery: (candidate: MasteryCandidate) => void;
}

export function GoalDetailScreen(props: GoalDetailScreenProps) {
  const {
    goal,
    points,
    observations,
    initials,
    periodLabel,
    probeLabel,
    isNonInstructional = () => false,
    onBack,
    onAddPoint,
    onEditPoint,
    onAckMastery,
  } = props;

  const detail = buildGoalDetail(goal, points);
  const statement = computeAutoStatement(goal, initials, points, { isNonInstructional });
  const observation = observations.find((o) => o.goal_id === goal.goal_id);

  return (
    <div className="goal-detail">
      <div className="backrow">
        <button type="button" className="back" onClick={onBack}>
          ‹ Dashboard
        </button>
      </div>

      <div className="detailhead">
        <Avatar initials={initials} />
        <div className="detailtitle">
          <h1>{goal.goal_text}</h1>
          <div className="sub">
            {periodLabel !== null ? `${periodLabel} · ` : ""}Criterion: {goal.criterion_level}% ×{" "}
            {goal.criterion_consistency.phrase}
            {goal.baseline_value !== undefined ? ` · Baseline ${goal.baseline_value}%` : ""}
          </div>
        </div>
      </div>

      <div className="btnrow addrow">
        <button type="button" className="btn primary wide" onClick={onAddPoint}>
          + Add a point
        </button>
      </div>

      <div className="card">
        <div className="chartwrap">
          <TrendChart
            trend={detail.trend}
            noDataMarkers={detail.noDataMarkers}
            clampAfter={detail.clampAfter}
            baselineValue={goal.baseline_value ?? null}
            criterionLevel={goal.criterion_level}
            iepEndDate={goal.iep_end_date ?? null}
          />
        </div>
        <div className="note">⊘ no-data probe is shown as a gap, never plotted as a zero.</div>
      </div>

      <QuarterlyCard detail={detail} />

      {statement !== null ? <StatementCard statement={statement} /> : null}

      <ConsistencyCard
        detail={detail}
        goal={goal}
        observation={observation}
        onAckMastery={onAckMastery}
      />

      <HistoryTable goal={goal} points={points} probeLabel={probeLabel} onEditPoint={onEditPoint} />
    </div>
  );
}
