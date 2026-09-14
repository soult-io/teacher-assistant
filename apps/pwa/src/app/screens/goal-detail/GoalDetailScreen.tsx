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
  type IndeterminateReason,
  isIcExportable,
  type MasteryCandidate,
  MIN_SCORED_POINTS,
} from "@teacher-assistant/domain-core";
import type {
  IEPGoal,
  MasteryObservation,
  ProgressDataPoint,
  Revision,
  Timestamp,
} from "@teacher-assistant/schema";
import type { ReactNode } from "react";
import { Avatar } from "../../../design/Avatar.js";
import { useIsDesktop } from "../../useIsDesktop.js";
import { TrendChart } from "./TrendChart.js";

/** Copy text to the clipboard when available — a no-op elsewhere (guarded for jsdom/older browsers). */
function copyToClipboard(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    // Clipboard unavailable (insecure context / test env) — the DRAFT label + on-screen
    // text still let the teacher copy manually; nothing to surface.
  }
}

/** A friendly, honesty-safe hint for why a statement is INDETERMINATE (surfaces the gate math). */
function indeterminateHint(statement: AutoStatement): string | null {
  const reason: IndeterminateReason | undefined = statement.indeterminateReason;
  switch (reason) {
    case "below_point_gate":
    case "insufficient_after_exclusion": {
      const need = Math.max(0, MIN_SCORED_POINTS - statement.slots.totalPoints);
      return `Needs ${need} more scored data point${need === 1 ? "" : "s"} for a defensible trend (${MIN_SCORED_POINTS} minimum).`;
    }
    case "below_week_gate":
      return "Needs more instructional weeks of monitoring before a trend can be claimed.";
    case "no_scored_data":
      return "No scored data points this period yet.";
    case "fourpoint_straddle":
    case "trend_fourpoint_disagree":
      return "The recent points are too mixed to claim a reliable trend yet.";
    default:
      return null;
  }
}

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

/** Human label for the captured setting (display-only; the point carries the enum). */
function settingLabel(setting: ProgressDataPoint["setting"]): string {
  switch (setting) {
    case "math_resource":
      return "Resource";
    case "gen_ed":
      return "Gen-ed";
    case "home_scored":
      return "Home";
    default:
      return setting;
  }
}

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

/**
 * An inline info tip (prototype ⓘ) — carries the honesty / ARC-defense copy for a
 * non-technical teacher. Native <details> so it is keyboard-accessible and the text
 * is in the DOM even when collapsed; no per-card state.
 */
function InfoTip({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <details className="tip">
      <summary aria-label={label}>ⓘ</summary>
      <span className="tiptext">{children}</span>
    </details>
  );
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
        <>
          <div className="note warn">
            ⚠ Includes {q.countedOffBasis} off-basis point{plural(q.countedOffBasis)} (counted at
            your election) — check comparability before reporting.
          </div>
          {/* Clarifier: the IC progress statement HARD-excludes off-basis points, so its
              average can differ from this F4 report-card number. Say so, so the two are not
              read as a contradiction. */}
          <div className="note" data-testid="two-average-clarifier">
            The draft IC progress statement excludes off-basis points, so its average may differ
            from this number.
          </div>
        </>
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

function QuarterlyCard({
  detail,
  exportable,
}: {
  readonly detail: GoalDetail;
  readonly exportable: boolean;
}) {
  const q = detail.quarterlySummary;
  return (
    <div className="card qsummary" data-testid="quarterly">
      <div className="qhead">
        <span className="qlab">Quarterly progress summary</span>
        <InfoTip label="What the quarterly summary is">
          A report-card figure: the average of the last {q.n} scored points, not the last {q.n}{" "}
          calendar weeks. Separate from the weekly monitoring feed, and copied to the progress
          report (IC), not the weekly value.
        </InfoTip>
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
          {/* IC copy path — ONLY for an IC-exportable goal (same structural guard the
              statement card uses); a proposed/baseline/non-% goal has no copy path (DF-1). */}
          {exportable ? (
            <button
              type="button"
              className="btn small primary copybtn"
              data-testid="copy-quarterly"
              onClick={() => copyToClipboard(`${Math.round(q.average ?? 0)}%`)}
            >
              Copy for IC progress report
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function StatementCard({ statement }: { readonly statement: AutoStatement }) {
  // The card only renders for an IC-exportable goal (computeAutoStatement returns
  // null otherwise), so the copy path is inherently guarded (DF-7). Copy is the ONLY
  // action — the statement stays slot-assembled; the teacher reviews/edits in IC
  // after paste (FERPA: no in-app free-text statement channel).
  const hint = statement.variant === "indeterminate" ? indeterminateHint(statement) : null;
  return (
    <div className="card draftstmt" data-testid="auto-statement">
      <div className="draftbanner">{statement.label}</div>
      <div className={`vbadge ${statement.variant}`} data-testid="statement-variant">
        {VARIANT_BADGE[statement.variant]}
      </div>
      <p className="stmttext">{statement.text}</p>
      {hint !== null ? (
        <div className="note" data-testid="indeterminate-hint">
          {hint}
        </div>
      ) : null}
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
      <button
        type="button"
        className="btn small primary copybtn"
        onClick={() => copyToClipboard(statement.text)}
      >
        Copy to IC
      </button>
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
  // The glance is painted from the ENGINE's clamped, disposition-aware glyphs
  // (c.recentGlyphs) — the UI re-derives nothing, so it can never blend pre/post-clamp
  // probes or re-classify the criterion (R3 DM-1). The authoritative run is c.run.
  return (
    <div className="card">
      <div className="cardhead">
        <b>Consistency window</b>
        <InfoTip label="How the consistency window works">
          Consecutive means consecutive probes in admin-date order — never cherry-picked weeks. A ⊘
          pauses the run, it never breaks or resets it.
        </InfoTip>
      </div>
      <div className="window" data-testid="consistency-window">
        {c.recentGlyphs.map((g) => (
          <span
            key={g.dataPointId}
            className={`${g.meets ? "win-yes" : "win-no"}${g.offBasis ? " win-off" : ""}`}
            title={g.offBasis ? "off-basis (counted at your election)" : undefined}
          >
            {g.meets ? "●" : "○"}
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
            <InfoTip label="What acknowledging does">
              Acknowledging flags the goal for ARC / progress review. Retiring a goal is always your
              call at ARC, never automatic.
            </InfoTip>
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
              <th>Setting</th>
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
                  <td>{settingLabel(p.setting)}</td>
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
  /**
   * The M4 instructional-weeks calendar predicate — feeds the R3-3 ≥4-instructional-
   * week half of the auto-statement gate. REQUIRED (no default): a default of
   * `() => false` would count every calendar week as instructional and INFLATE the
   * week count, silently LOOSENING the gate (R3 DM-2). A missing calendar must fail
   * at the wiring site, not widen the honesty gate here.
   */
  readonly isNonInstructional: (weekId: string) => boolean;
  readonly onBack: () => void;
  readonly onAddPoint: () => void;
  readonly onEditPoint: (point: ProgressDataPoint) => void;
  readonly onAckMastery: (candidate: MasteryCandidate) => void;
}

/** The trend card (chart + the ⊘-as-gap note) — shared by every layout. */
function ChartCard({ detail, goal }: { readonly detail: GoalDetail; readonly goal: IEPGoal }) {
  return (
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
  );
}

/** The goal header (avatar + name + criterion/baseline). Desktop lays "+ Add a point" inline. */
function DetailHeader({
  goal,
  initials,
  periodLabel,
  onAddPoint,
  inlineAdd,
}: {
  readonly goal: IEPGoal;
  readonly initials: string;
  readonly periodLabel: string | null;
  readonly onAddPoint: () => void;
  readonly inlineAdd: boolean;
}) {
  return (
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
      {inlineAdd ? (
        <span className="detailadd">
          <button type="button" className="btn primary small" onClick={onAddPoint}>
            + Add a point
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** Which arrangement to render the Goal Detail cards in (design §3.1/§3.2). */
export type GoalDetailLayout = "mobile" | "pane" | "full";

export interface GoalDetailBodyProps extends Omit<GoalDetailScreenProps, "onBack"> {
  /** mobile = validated single column; full = two columns (deep-link); pane = stacked (dashboard). */
  readonly layout: GoalDetailLayout;
}

/**
 * The Goal Detail cards, arranged for one of three layouts. The SAME card components
 * render everywhere — only their arrangement changes (design §5: desktop reflows the
 * honesty surfaces, never their meaning or copy):
 *   - mobile: the validated single column (chart · quarterly · statement · consistency · ARC).
 *   - full  : two columns — data left (chart · consistency · ARC), report-bound honesty
 *             surfaces right (draft statement · quarterly) — the deep-linked Goal Detail.
 *   - pane  : one stacked column inside the dashboard master-detail (chart · statement ·
 *             consistency · quarterly · ARC), with "+ Add a point" inline in the header.
 * The caller wraps this in `.goal-detail`.
 */
export function GoalDetailBody(props: GoalDetailBodyProps) {
  const {
    goal,
    points,
    observations,
    initials,
    periodLabel,
    probeLabel,
    isNonInstructional,
    onAddPoint,
    onEditPoint,
    onAckMastery,
    layout,
  } = props;

  const detail = buildGoalDetail(goal, points);
  const statement = computeAutoStatement(goal, initials, points, { isNonInstructional });
  const observation = observations.find((o) => o.goal_id === goal.goal_id);
  const exportable = isIcExportable(goal);

  const header = (
    <DetailHeader
      goal={goal}
      initials={initials}
      periodLabel={periodLabel}
      onAddPoint={onAddPoint}
      inlineAdd={layout !== "mobile"}
    />
  );
  const chart = <ChartCard detail={detail} goal={goal} />;
  const quarterly = <QuarterlyCard detail={detail} exportable={exportable} />;
  const stmt = statement !== null ? <StatementCard statement={statement} /> : null;
  const consistency = (
    <ConsistencyCard
      detail={detail}
      goal={goal}
      observation={observation}
      onAckMastery={onAckMastery}
    />
  );
  const history = (
    <HistoryTable goal={goal} points={points} probeLabel={probeLabel} onEditPoint={onEditPoint} />
  );

  if (layout === "full") {
    return (
      <>
        {header}
        <div className="twocol">
          <div className="gdcol">
            {chart}
            {consistency}
            {history}
          </div>
          <div className="gdcol">
            {stmt}
            {quarterly}
          </div>
        </div>
      </>
    );
  }

  if (layout === "pane") {
    return (
      <>
        {header}
        {chart}
        {stmt}
        {consistency}
        {quarterly}
        {history}
      </>
    );
  }

  // mobile — the validated single column (unchanged order + the full-width add button).
  return (
    <>
      {header}
      <div className="btnrow addrow">
        <button type="button" className="btn primary wide" onClick={onAddPoint}>
          + Add a point
        </button>
      </div>
      {chart}
      {quarterly}
      {stmt}
      {consistency}
      {history}
    </>
  );
}

export function GoalDetailScreen(props: GoalDetailScreenProps) {
  const { onBack, ...body } = props;
  const isDesktop = useIsDesktop();
  return (
    <div className="goal-detail">
      <div className="backrow">
        <button type="button" className="back" onClick={onBack}>
          ‹ Dashboard
        </button>
      </div>
      <GoalDetailBody {...body} layout={isDesktop ? "full" : "mobile"} />
    </div>
  );
}
