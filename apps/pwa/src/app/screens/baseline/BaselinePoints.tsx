// TEACH-46 — the Baseline card's point list: audited Fix / Remove, the "Keep {M}"
// mismatch prompt, the collapsed History, and the "Fixed after ARC" note
// (ky-sped-lbd-sdi-sme ruling 2026-10-09; UI strings are the ruling's, verbatim).
// Shared by the Baseline track (proposed goals: Fix + Remove) and Goal Detail
// (adopted goals: Fix only). The UI collects + calls — every rule is domain-core's.

import {
  type BaselineFix,
  type BaselineHistoryEntry,
  type BaselineScoreProblem,
  baselineCorrectionAfterArc,
  baselineHistory,
  checkBaselineScore,
  needsTotalDecision,
  parseBaselineCount,
  percentCorrect,
} from "@teacher-assistant/domain-core";
import {
  BASELINE_REMOVE_REASONS,
  type BaselinePoint,
  type BaselineRemoveReason,
  type IEPGoal,
  type IsoDate,
} from "@teacher-assistant/schema";
import { useId, useState } from "react";
import { isoDayOfTs } from "../../../data/date.js";
import { Sheet } from "../../Sheet.js";

/** The ruling's option labels for the closed remove-reason list (C2). */
const REMOVE_REASON_LABELS: Readonly<Record<BaselineRemoveReason, string>> = {
  entered_by_mistake: "Entered by mistake",
  duplicate: "Duplicate entry",
  wrong_student_or_goal: "Wrong student or goal",
  probe_not_per_goal_condition: "Probe not given the way the goal says",
};

/** Why Save / Add is disabled (ruling D; the total line covers a variable-total goal). */
export const SCORE_PROBLEM_TEXT: Readonly<Record<BaselineScoreProblem, string>> = {
  numerator_missing: "Type the number correct first.",
  total_missing: "Type the total first.",
  over_total: "Number correct can't be more than the total.",
};

/** The typed "# correct of N" pair, parsed and checked by the domain rule. */
export function useScoreDraft(initialCorrect: string, initialTotal: string) {
  const [correctText, setCorrectText] = useState(initialCorrect);
  const [totalText, setTotalText] = useState(initialTotal);
  const numerator = parseBaselineCount(correctText);
  const total = parseBaselineCount(totalText);
  return {
    correctText,
    setCorrectText,
    totalText,
    setTotalText,
    numerator,
    total,
    problem: checkBaselineScore(numerator, total),
  };
}

function FixDialog({
  point,
  onSave,
  onClose,
}: {
  readonly point: BaselinePoint;
  readonly onSave: (fix: BaselineFix) => void;
  readonly onClose: () => void;
}) {
  const draft = useScoreDraft(String(point.numerator), String(point.denominator_used));
  const [date, setDate] = useState<string>(point.admin_date);
  const problemId = useId();
  const { numerator, total, problem } = draft;
  const blocked = problem !== null || date === "";
  return (
    <Sheet title="Fix baseline point" onClose={onClose}>
      <div className="baddrow">
        <span className="baddlabel"># correct</span>
        <input
          className="numin"
          inputMode="numeric"
          aria-label="fixed correct"
          value={draft.correctText}
          onChange={(e) => draft.setCorrectText(e.target.value)}
        />
        <span>of</span>
        <input
          className="ofin"
          inputMode="numeric"
          aria-label="fixed total"
          value={draft.totalText}
          onChange={(e) => draft.setTotalText(e.target.value)}
        />
      </div>
      {problem !== null ? (
        <div className="note warn" id={problemId} data-testid="fix-problem">
          {SCORE_PROBLEM_TEXT[problem]}
        </div>
      ) : null}
      <label className="arcedit">
        <span className="nghint">Date given</span>
        <input
          className="tin arcin"
          type="date"
          aria-label="fixed date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <div className="btnrow">
        <button type="button" className="btn wide" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary wide"
          data-testid="save-fix"
          disabled={blocked}
          aria-describedby={problem !== null ? problemId : undefined}
          onClick={() =>
            numerator !== undefined &&
            total !== undefined &&
            onSave({ numerator, denominator_used: total, admin_date: date as IsoDate })
          }
        >
          Save fix
        </button>
      </div>
    </Sheet>
  );
}

function RemoveDialog({
  onRemove,
  onClose,
}: {
  readonly onRemove: (reason: BaselineRemoveReason) => void;
  readonly onClose: () => void;
}) {
  const [reason, setReason] = useState<BaselineRemoveReason | null>(null);
  const promptId = useId();
  return (
    <Sheet title="Remove baseline point" onClose={onClose}>
      <div className="reasonhead" id={promptId}>
        <b>Why remove it?</b>
      </div>
      <div className="chips" role="radiogroup" aria-labelledby={promptId}>
        {BASELINE_REMOVE_REASONS.map((r) => (
          // biome-ignore lint/a11y/useSemanticElements: a chip row styled like the no-data reasons; role=radio keeps the single choice announced
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reason === r}
            className={`rchip${reason === r ? " on" : ""}`}
            data-testid="remove-reason"
            onClick={() => setReason(r)}
          >
            {REMOVE_REASON_LABELS[r]}
          </button>
        ))}
      </div>
      <div className="note">It stays in the history. It won't count toward the baseline.</div>
      <div className="btnrow">
        <button type="button" className="btn wide" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn primary wide"
          data-testid="confirm-remove"
          disabled={reason === null}
          onClick={() => reason !== null && onRemove(reason)}
        >
          Remove
        </button>
      </div>
    </Sheet>
  );
}

/** C8: "This goal's probe has {N} items. Keep {M}?" [Keep {M}] [Use {N}]. */
function TotalDecision({
  point,
  onKeep,
  onUseProbeTotal,
}: {
  readonly point: BaselinePoint;
  readonly onKeep: () => void;
  readonly onUseProbeTotal: () => void;
}) {
  const probeTotal = point.denominator_original;
  const typedTotal = point.denominator_used;
  if (probeTotal === undefined) {
    return null;
  }
  return (
    <div className="note warn bdecide" data-testid="total-mismatch">
      This goal's probe has {probeTotal} items. Keep {typedTotal}?
      <span className="bdecidebtns">
        <button type="button" className="btn small" onClick={onKeep}>
          Keep {typedTotal}
        </button>
        {/* Using N is a Fix; it is offered only when the number correct still fits. */}
        {point.numerator <= probeTotal ? (
          <button type="button" className="btn small" onClick={onUseProbeTotal}>
            Use {probeTotal}
          </button>
        ) : null}
      </span>
    </div>
  );
}

function historyText(entry: BaselineHistoryEntry): string {
  const date = isoDayOfTs(entry.when);
  const [a, b] = entry.was;
  if (entry.kind === "fixed") {
    const [c, d] = entry.now;
    return `Fixed ${date}: was ${a}/${b}, now ${c}/${d}`;
  }
  return `Removed ${date}: ${REMOVE_REASON_LABELS[entry.reason]} (was ${a}/${b})`;
}

/** C4: the collapsed History — fixes and removals (removed rows struck through). */
function BaselineHistory({ points }: { readonly points: readonly BaselinePoint[] }) {
  const rows = points
    .flatMap((p) => baselineHistory(p).map((entry) => ({ id: p.baseline_point_id, entry })))
    .sort((x, y) => x.entry.when - y.entry.when);
  if (rows.length === 0) {
    return null;
  }
  return (
    <details className="tip bhist" data-testid="baseline-history">
      <summary>History ({rows.length})</summary>
      {rows.map(({ id, entry }) => (
        <div key={`${id}-${entry.when}-${entry.kind}`} className="revrow">
          {entry.kind === "removed" ? <s>{historyText(entry)}</s> : historyText(entry)}
        </div>
      ))}
    </details>
  );
}

/** Ruling B: the IEP baseline stays; show what the estimate would now be. */
function FixedAfterArcNote({
  goal,
  points,
}: {
  readonly goal: IEPGoal;
  readonly points: readonly BaselinePoint[];
}) {
  const c = baselineCorrectionAfterArc(goal, points);
  if (c === null) {
    return null;
  }
  return (
    <div className="note warn" data-testid="fixed-after-arc">
      Fixed after ARC. The IEP baseline stays {Math.round(c.iepValue)}%. With this fix the estimate
      would be {Math.round(c.estimate)}%. If the IEP baseline is wrong, bring it to the ARC.
    </div>
  );
}

interface BaselinePointsProps {
  readonly goal: IEPGoal;
  /** This goal's baseline points, oldest first (removed ones included — they go to History). */
  readonly points: readonly BaselinePoint[];
  readonly onFix: (point: BaselinePoint, fix: BaselineFix) => void;
  /** Proposed goals only: after adoption a point may be fixed, never removed (no Remove button). */
  readonly onRemove?: (point: BaselinePoint, reason: BaselineRemoveReason) => void;
  /** Proposed goals only: C8 counting matters only before adoption (no Keep prompt). */
  readonly onKeep?: (point: BaselinePoint) => void;
}

type OpenDialog = { readonly kind: "fix" | "remove"; readonly point: BaselinePoint } | null;

/** The point list with per-point [Fix] / [Remove], the C8 prompt, History and dialogs. */
export function BaselinePoints(props: BaselinePointsProps) {
  const { goal, points, onFix, onRemove, onKeep } = props;
  const [open, setOpen] = useState<OpenDialog>(null);
  const live = points.filter((p) => p.status !== "removed");
  const close = () => setOpen(null);

  return (
    <>
      {live.length > 0 ? (
        <ul className="bpoints" data-testid="baseline-points">
          {live.map((p) => {
            const label = `${p.admin_date} ${p.numerator}/${p.denominator_used}`;
            return (
              <li
                key={p.baseline_point_id}
                // A total awaiting Keep / Use is not counted yet (C8): shown dimmed until decided.
                className={`bpoint${needsTotalDecision(p) ? " pending" : ""}`}
                data-testid="baseline-point"
              >
                <span className="bpointval">
                  <span className="dchip static">
                    {Math.round(percentCorrect(p.numerator, p.denominator_used))}%
                  </span>
                  <span className="bpointraw">
                    {p.numerator}/{p.denominator_used} · {p.admin_date}
                  </span>
                </span>
                <span className="bpointacts">
                  <button
                    type="button"
                    className="editpt"
                    aria-label={`fix baseline point ${label}`}
                    onClick={() => setOpen({ kind: "fix", point: p })}
                  >
                    Fix
                  </button>
                  {onRemove !== undefined ? (
                    <button
                      type="button"
                      className="editpt"
                      aria-label={`remove baseline point ${label}`}
                      onClick={() => setOpen({ kind: "remove", point: p })}
                    >
                      Remove
                    </button>
                  ) : null}
                </span>
                {/* C8 counting only matters before adoption; an adopted goal's value is locked. */}
                {onKeep !== undefined && goal.status === "proposed" && needsTotalDecision(p) ? (
                  <TotalDecision
                    point={p}
                    onKeep={() => onKeep(p)}
                    onUseProbeTotal={() =>
                      p.denominator_original !== undefined &&
                      onFix(p, { denominator_used: p.denominator_original })
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="note bchips">no points yet</div>
      )}

      <FixedAfterArcNote goal={goal} points={points} />
      <BaselineHistory points={points} />

      {open?.kind === "fix" ? (
        <FixDialog
          point={open.point}
          onClose={close}
          onSave={(fix) => {
            onFix(open.point, fix);
            close();
          }}
        />
      ) : null}
      {open?.kind === "remove" && onRemove !== undefined ? (
        <RemoveDialog
          onClose={close}
          onRemove={(reason) => {
            onRemove(open.point, reason);
            close();
          }}
        />
      ) : null}
    </>
  );
}
