// Quick-Score bottom sheet (U3) — the teacher write surface. Two modes:
//  - score: #correct (stepper + tap-to-type) + a custom total (3/5/12-item
//    probes) → live %, saved via the M5 capture path. A total ≠ the assigned
//    probe's expected total is WARNED + flagged (never blocked).
//  - no-data (⊘): a REQUIRED reason from the locked set. A ⊘ is a documented gap,
//    never a score of 0 (no numerator is written). Excused vs fidelity-accruing
//    semantics are surfaced to the teacher.
// The sheet builds a DocMutator (data/writes.ts) and hands it to onCommit; the
// parent applies it (encrypted + persisted) and closes.

import { asTimestamp, type NoDataReason, type ProgressDataPoint } from "@teacher-assistant/schema";
import { useEffect, useState } from "react";
import { Avatar } from "../design/Avatar.js";
import type { DocMutator } from "../data/session.js";
import {
  bookmarkMutator,
  type CaptureContext,
  completeQueuedMutator,
  DEFAULT_SETTING,
  editMutator,
  type MismatchElection,
  noDataMutator,
  scoreMutator,
} from "../data/writes.js";
import type { SheetTarget } from "./sheet-target.js";

const SETTING = DEFAULT_SETTING;

// Locked no-data reason set (design §A.2 + R3-1). Excused = Absent/Testing/No
// School (pause the run, no fidelity ding); No time accrues the fidelity counter.
const REASON_OPTIONS: readonly { readonly value: NoDataReason; readonly label: string }[] = [
  { value: "no_time", label: "No time" },
  { value: "absent", label: "Absent" },
  { value: "testing", label: "Testing" },
  { value: "behavior", label: "Behavior" },
  { value: "no_school", label: "No School" },
];

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function contextOf(target: SheetTarget): CaptureContext {
  return {
    goalId: target.goalId,
    studentId: target.studentId,
    adminDate: target.adminDate,
    entryTs: asTimestamp(Date.now()),
    setting: SETTING,
  };
}

function TargetHeader({ target }: { readonly target: SheetTarget }) {
  return (
    <div className="whowhat sheet-who">
      <Avatar initials={target.initials} />
      <span>
        {target.periodLabel !== null ? `${target.periodLabel} · ` : ""}
        {target.goalText}
      </span>
    </div>
  );
}

function ScoreEntry({
  target,
  onCommit,
  toNoData,
  onValidateEdit,
}: {
  readonly target: SheetTarget;
  readonly onCommit: (m: DocMutator) => void;
  readonly toNoData: () => void;
  readonly onValidateEdit?: (edit: ParaFixEdit) => void;
}) {
  const existing: ProgressDataPoint | undefined = target.existingPoint;
  const [correct, setCorrect] = useState<number>(existing?.numerator ?? 0);
  const [denom, setDenom] = useState<number>(
    existing?.denominator_used ?? target.expectedDenominator,
  );
  const pct = denom > 0 ? Math.round((correct / denom) * 100) : 0;
  // A VARIABLE-basis goal (F-2 escape valve) never warns: the entered total is
  // accepted as-is and NO expected total is passed to capture, so no off-basis flag.
  const mismatch = !target.variableBasis && denom !== target.expectedDenominator;
  // The expected total the engine checks against — undefined for a variable-basis
  // goal, so captureScoredPoint/applyEdit never flag a mismatch.
  const expectedForCapture = target.variableBasis ? undefined : target.expectedDenominator;
  const expectedParam =
    expectedForCapture !== undefined ? { expectedDenominator: expectedForCapture } : {};

  const setDenomSafe = (n: number) => {
    const d = Math.max(1, n);
    setDenom(d);
    setCorrect((c) => clamp(c, 0, d));
  };

  // On a genuine mismatch, Save is gated behind the F-2 ack: `election` carries the
  // teacher's one-tap disposition. On a matching total it is undefined (no ack).
  const save = (election?: MismatchElection) => {
    const entryTs = asTimestamp(Date.now());
    const withElection = election !== undefined ? { election } : {};
    // Para [Fix]: the corrected values are promoted to a validated master record by
    // the session (+ a para tombstone), never written as a plain master edit here.
    if (onValidateEdit !== undefined) {
      onValidateEdit({ numerator: correct, denominatorUsed: denom });
      return;
    }
    if (existing !== undefined) {
      // A queued placeholder is completed by a fresh mismatch-aware capture that
      // replaces it; an already-scored point is corrected by an audited [Fix].
      onCommit(
        existing.state === "queued"
          ? completeQueuedMutator(
              existing,
              {
                numerator: correct,
                denominatorUsed: denom,
                ...expectedParam,
                ...withElection,
              },
              entryTs,
            )
          : editMutator(existing, { numerator: correct, denominator_used: denom }, entryTs, {
              ...expectedParam,
              ...(election !== undefined ? { election } : {}),
            }),
      );
      return;
    }
    onCommit(
      scoreMutator({
        ...contextOf(target),
        numerator: correct,
        denominatorUsed: denom,
        ...expectedParam,
        ...withElection,
      }),
    );
  };

  return (
    <>
      <TargetHeader target={target} />
      <div className="ctx">
        Probe: {target.probeLabel} · Setting: Resource <span className="locked">this session</span>
      </div>
      <div className="scorewrap">
        <div className="scorelabel"># CORRECT</div>
        <div className="scoreline">
          <button
            type="button"
            className="stepbtn"
            aria-label="minus"
            onClick={() => setCorrect((c) => clamp(c - 1, 0, denom))}
          >
            −
          </button>
          <input
            className="numin"
            inputMode="numeric"
            aria-label="number correct"
            value={correct}
            onChange={(e) => setCorrect(clamp(Number.parseInt(e.target.value, 10) || 0, 0, denom))}
          />
          <button
            type="button"
            className="stepbtn"
            aria-label="plus"
            onClick={() => setCorrect((c) => clamp(c + 1, 0, denom))}
          >
            +
          </button>
        </div>
        <div className="ofwrap">
          of{" "}
          <input
            className="ofin"
            inputMode="numeric"
            aria-label="total items"
            value={denom}
            onChange={(e) => setDenomSafe(Number.parseInt(e.target.value, 10) || 1)}
          />
          {mismatch ? (
            <span className="mismatch"> ⚠ assigned {target.expectedDenominator}</span>
          ) : null}
        </div>
        <div className="pct">
          {pct}
          <small>%</small>
        </div>
      </div>
      {mismatch ? (
        // F-2 (§B): a genuine denominator mismatch REQUIRES an affirmative
        // acknowledgment before Save — one tap picks the window disposition. Both
        // choices acknowledge; the point carries the off-basis flag either way.
        <div className="ack" data-testid="mismatch-ack">
          <div className="note laternote">
            This total ({denom}) differs from the goal's basis ({target.expectedDenominator}) —
            choose how it counts. It stays flagged off-basis; the goal's denominator is unchanged.
          </div>
          <div className="btnrow">
            <button
              type="button"
              className="btn primary wide"
              onClick={() => save({ mismatchWindowDisposition: "counted" })}
            >
              Count it in the trend
            </button>
            <button
              type="button"
              className="btn wide"
              onClick={() => save({ mismatchWindowDisposition: "excluded" })}
            >
              Keep it out
            </button>
          </div>
          <div className="sheet-later">
            <button type="button" className="btn small ghost" onClick={toNoData}>
              No data instead
            </button>
          </div>
        </div>
      ) : (
        <div className="btnrow">
          <button type="button" className="btn primary wide" onClick={() => save()}>
            Save
          </button>
          <button type="button" className="btn wide" onClick={toNoData}>
            No data
          </button>
        </div>
      )}
      {existing === undefined ? (
        <div className="sheet-later">
          <button
            type="button"
            className="btn small ghost"
            onClick={() => onCommit(bookmarkMutator(contextOf(target)))}
          >
            ⚑ Collected — score later
          </button>
        </div>
      ) : null}
    </>
  );
}

function NoDataEntry({
  target,
  onCommit,
  toScore,
}: {
  readonly target: SheetTarget;
  readonly onCommit: (m: DocMutator) => void;
  readonly toScore: () => void;
}) {
  const [reason, setReason] = useState<NoDataReason | null>(null);
  return (
    <>
      <TargetHeader target={target} />
      <div className="ctx">No data this week — a documented gap, not a zero.</div>
      <div className="reasonhead">
        <b>Reason</b> <span className="req">required</span>
      </div>
      <div className="chips">
        {REASON_OPTIONS.map((r) => (
          <button
            key={r.value}
            type="button"
            className={`rchip${reason === r.value ? " on" : ""}`}
            aria-pressed={reason === r.value}
            onClick={() => setReason(r.value)}
          >
            {r.label}
          </button>
        ))}
      </div>
      <div className="note">
        Any no-data pauses your consistency run (never breaks it). Absent · Testing · No School are
        excused. Behavior is logged as a pattern to watch. No time also counts toward a
        delivery-fidelity flag before an ARC.
      </div>
      <div className="btnrow">
        <button type="button" className="btn wide" onClick={toScore}>
          ‹ Back
        </button>
        <button
          type="button"
          className="btn primary wide"
          disabled={reason === null}
          onClick={() => reason !== null && onCommit(noDataMutator(contextOf(target), reason))}
        >
          Record no data
        </button>
      </div>
    </>
  );
}

/** A teacher [Fix] of a para pending point: correct the values, promoting it → validated (D3). */
export interface ParaFixEdit {
  readonly numerator: number;
  readonly denominatorUsed: number;
}

export function QuickScoreSheet({
  target,
  onCommit,
  onClose,
  onValidateEdit,
}: {
  readonly target: SheetTarget;
  readonly onCommit: (mutator: DocMutator) => void;
  readonly onClose: () => void;
  /**
   * Present ONLY when the sheet was opened to [Fix] a para pending point: Save routes
   * the corrected values here (the session promotes them → master + tombstones the para
   * doc) instead of a plain master edit. The No-data path is unavailable in this mode.
   */
  readonly onValidateEdit?: (edit: ParaFixEdit) => void;
}) {
  const [mode, setMode] = useState<"score" | "nodata">("score");

  // Keyboard dismissal (Escape) — the accessible way to close; the backdrop
  // click is a pointer convenience on top of it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    globalThis.addEventListener?.("keydown", onKey);
    return () => globalThis.removeEventListener?.("keydown", onKey);
  }, [onClose]);

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: decorative backdrop; Escape (above) is the keyboard control */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: decorative backdrop; Escape (above) is the keyboard control */}
      <div className="scrim open" onClick={onClose} />
      <div className="sheet open" role="dialog" aria-label="score entry">
        <div className="grip" />
        {mode === "score" ? (
          <ScoreEntry
            target={target}
            onCommit={onCommit}
            toNoData={() => setMode("nodata")}
            {...(onValidateEdit !== undefined ? { onValidateEdit } : {})}
          />
        ) : (
          <NoDataEntry target={target} onCommit={onCommit} toScore={() => setMode("score")} />
        )}
      </div>
    </>
  );
}
