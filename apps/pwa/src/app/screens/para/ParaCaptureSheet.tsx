// U6 — the para capture sheet (M13, field-split §1.4). A HARD-constrained write:
// integers + closed-set chips ONLY, ZERO free-text of any kind (a single free-text
// field is a FERPA BLOCK). The para sets # correct, this probe's ACTUAL total (a
// differing total flags off-basis for the teacher — the para can't redefine the
// denominator), a BOUNDED admin date (today/recent, no future), a setting from the
// picklist, the LOCKED observation multi-select (+ accommodation subtypes when
// "Accommodation" is picked — a BLANK field, no edge from the goal's accom_mod), or a
// ⊘ with an Absent/Behavior/No-time reason. Everything lands state=pending; it is
// NOT a record until the teacher validates. The engine (buildParaPendingPoint) owns
// every rule — this sheet only collects the structured values and calls it.

import {
  buildParaPendingPoint,
  type ParaCaptureContext,
  type ParaEntryInput,
  PARA_NO_DATA_REASONS,
  type ParaNoDataReason,
} from "@teacher-assistant/domain-core";
import {
  type AccommodationSubtype,
  ACCOMMODATION_SUBTYPES,
  asTimestamp,
  type IsoDate,
  newOpaqueId,
  type ParaObservation,
  PARA_OBSERVATIONS,
  type Setting,
} from "@teacher-assistant/schema";
import { useEffect, useState } from "react";
import { Avatar } from "../../../design/Avatar.js";
import { isoDateOf } from "../../../data/date.js";
import type { DocMutator } from "../../../data/session.js";
import { paraCaptureMutator } from "../../../data/writes.js";
import { OBS_LABEL, SETTING_LABEL } from "./labels.js";

const ACCOM_LABEL: Readonly<Record<AccommodationSubtype, string>> = {
  Calculator: "Calculator",
  MultiplicationGrid: "Multiplication grid",
  WorkedExample: "Worked example",
  Manipulatives: "Manipulatives",
  KeywordList: "Keyword list",
  SymbolChart: "Symbol chart",
};
const REASON_LABEL: Readonly<Record<ParaNoDataReason, string>> = {
  absent: "Absent",
  behavior: "Behavior",
  no_time: "No time",
};

/** The para admin target the sheet opens against — all opaque/Period-DEK, no PII. */
export interface ParaCaptureTarget {
  readonly goalId: string;
  readonly studentId: string;
  readonly initials: string;
  readonly probeDefinitionId: string;
  readonly administerLabel: string;
  readonly expectedDenominator: number;
}

/** Recent bounded admin dates (today + prior days) — no future date is offered. */
function recentDates(now: Date, days: number): IsoDate[] {
  const out: IsoDate[] = [];
  for (let i = 0; i < days; i++) {
    out.push(isoDateOf(new Date(now.getTime() - i * 86_400_000)));
  }
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function ChipRow<T extends string>({
  values,
  label,
  selected,
  onToggle,
}: {
  readonly values: readonly T[];
  readonly label: (v: T) => string;
  readonly selected: readonly T[];
  readonly onToggle: (v: T) => void;
}) {
  return (
    <div className="chips">
      {values.map((v) => (
        <button
          key={v}
          type="button"
          className={`dchip${selected.includes(v) ? " on" : ""}`}
          aria-pressed={selected.includes(v)}
          onClick={() => onToggle(v)}
        >
          {label(v)}
        </button>
      ))}
    </div>
  );
}

export function ParaCaptureSheet({
  target,
  settingPicklist,
  now,
  onCommit,
  onClose,
}: {
  readonly target: ParaCaptureTarget;
  readonly settingPicklist: readonly Setting[];
  readonly now: Date;
  readonly onCommit: (mutator: DocMutator) => void;
  readonly onClose: () => void;
}) {
  const dates = recentDates(now, 5);
  const [mode, setMode] = useState<"score" | "nodata">("score");
  const [correct, setCorrect] = useState(0);
  const [total, setTotal] = useState(target.expectedDenominator);
  const [adminDate, setAdminDate] = useState<IsoDate>(dates[0] as IsoDate);
  const [setting, setSetting] = useState<Setting>(settingPicklist[0] ?? "math_resource");
  const [observations, setObservations] = useState<readonly ParaObservation[]>([]);
  const [accoms, setAccoms] = useState<readonly AccommodationSubtype[]>([]);
  const [reason, setReason] = useState<ParaNoDataReason | null>(null);
  const mismatch = total !== target.expectedDenominator;

  // Escape closes (design §3.3 — desktop modal parity); the backdrop click is the pointer path.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    globalThis.addEventListener?.("keydown", onKey);
    return () => globalThis.removeEventListener?.("keydown", onKey);
  }, [onClose]);

  const toggleObs = (o: ParaObservation) => {
    setObservations((prev) => {
      const next = prev.includes(o) ? prev.filter((x) => x !== o) : [...prev, o];
      if (o === "Accommodation" && prev.includes(o)) {
        setAccoms([]); // deselecting Accommodation clears its subtypes
      }
      return next;
    });
  };
  const toggleAccom = (a: AccommodationSubtype) =>
    setAccoms((prev) => (prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]));

  const ctx = (): ParaCaptureContext => ({
    dataPointId: newOpaqueId(),
    goalId: target.goalId as ParaCaptureContext["goalId"],
    studentId: target.studentId as ParaCaptureContext["studentId"],
    probeConditionId: target.probeDefinitionId as ParaCaptureContext["probeConditionId"],
    expectedDenominator: target.expectedDenominator,
    adminDate,
    setting,
    entryTs: asTimestamp(Date.now()),
    // Bounded: latest = today (no future), earliest = a recent window (the offered dates).
    adminDateBounds: { earliest: dates[dates.length - 1] as IsoDate, latest: dates[0] as IsoDate },
  });

  const commit = (input: ParaEntryInput) => {
    const result = buildParaPendingPoint(ctx(), input);
    if (result.ok) {
      onCommit(paraCaptureMutator(result.point));
    }
    // A reject can only arise from a programming error here (inputs are clamped +
    // enum-bound); nothing to surface to the aide.
  };

  const saveScore = () =>
    commit({
      kind: "scored",
      numerator: correct,
      denominatorUsed: total,
      ...(observations.length > 0 ? { paraObservations: observations } : {}),
      ...(accoms.length > 0 ? { accommodationSubtypes: accoms } : {}),
    });
  const saveNoData = () =>
    reason !== null &&
    commit({
      kind: "no_data",
      noDataReason: reason,
      ...(observations.length > 0 ? { paraObservations: observations } : {}),
    });

  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: decorative backdrop; the Cancel button is the control */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: decorative backdrop; the Cancel button is the control */}
      <div className="scrim open" onClick={onClose} />
      <div className="sheet open" role="dialog" aria-label="para score entry">
        <div className="grip" />
        <button type="button" className="modal-close" aria-label="close" onClick={onClose}>
          ✕
        </button>
        <div className="whowhat sheet-who">
          <Avatar initials={target.initials} />
          <span>{target.administerLabel}</span>
        </div>

        {mode === "score" ? (
          <>
            <div className="scorewrap">
              <div className="scorelabel"># CORRECT</div>
              <div className="scoreline">
                <button
                  type="button"
                  className="stepbtn"
                  aria-label="minus"
                  onClick={() => setCorrect((c) => clamp(c - 1, 0, total))}
                >
                  −
                </button>
                <input
                  className="numin"
                  inputMode="numeric"
                  aria-label="number correct"
                  value={correct}
                  onChange={(e) =>
                    setCorrect(clamp(Number.parseInt(e.target.value, 10) || 0, 0, total))
                  }
                />
                <button
                  type="button"
                  className="stepbtn"
                  aria-label="plus"
                  onClick={() => setCorrect((c) => clamp(c + 1, 0, total))}
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
                  value={total}
                  onChange={(e) => {
                    const t = Math.max(1, Number.parseInt(e.target.value, 10) || 1);
                    setTotal(t);
                    setCorrect((c) => clamp(c, 0, t));
                  }}
                />
                {mismatch ? (
                  <span className="mismatch"> ⚠ assigned {target.expectedDenominator}</span>
                ) : null}
              </div>
              <div className="pct">
                {total > 0 ? Math.round((correct / total) * 100) : 0}
                <small>%</small>
              </div>
            </div>

            <div className="nglabel">Date administered · today or recent, no future</div>
            <ChipRow
              values={dates}
              label={(d) => d}
              selected={[adminDate]}
              onToggle={(d) => setAdminDate(d)}
            />
            <div className="nglabel">Setting</div>
            <ChipRow
              values={settingPicklist}
              label={(s) => SETTING_LABEL[s]}
              selected={[setting]}
              onToggle={(s) => setSetting(s)}
            />
            <div className="nglabel">Observations · select all that apply</div>
            <ChipRow
              values={PARA_OBSERVATIONS}
              label={(o) => OBS_LABEL[o]}
              selected={observations}
              onToggle={toggleObs}
            />
            {observations.includes("Accommodation") ? (
              <>
                <div className="nglabel">Which accommodation(s)?</div>
                <ChipRow
                  values={ACCOMMODATION_SUBTYPES}
                  label={(a) => ACCOM_LABEL[a]}
                  selected={accoms}
                  onToggle={toggleAccom}
                />
              </>
            ) : null}

            <div className="note">Tap-select only — no free typing, by design.</div>
            {mismatch ? (
              <div className="note warn" data-testid="para-mismatch-note">
                Total differs from the assigned probe ({target.expectedDenominator}). It lands
                flagged for the teacher to resolve; the goal's denominator is not changed here.
              </div>
            ) : null}
            <div className="field">
              <span className="lab">Student notes</span>
              <span className="val dim">teacher-only — not on this device</span>
            </div>
            <div className="field">
              <span className="lab">Lands as</span>
              <span className="val pendingtxt">⏳ pending — teacher confirms</span>
            </div>

            <div className="btnrow">
              <button type="button" className="btn primary wide" onClick={saveScore}>
                Save (pending)
              </button>
              <button type="button" className="btn wide" onClick={() => setMode("nodata")}>
                No data
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="ctx">No data — a documented gap, not a zero.</div>
            <div className="nglabel">
              Reason <span className="req">required</span>
            </div>
            <div className="chips">
              {PARA_NO_DATA_REASONS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`rchip${reason === r ? " on" : ""}`}
                  aria-pressed={reason === r}
                  onClick={() => setReason(r)}
                >
                  {REASON_LABEL[r]}
                </button>
              ))}
            </div>
            <div className="note">
              Absent · Behavior · No time only — Testing and No-school are the teacher's call.
            </div>
            <div className="btnrow">
              <button type="button" className="btn wide" onClick={() => setMode("score")}>
                ‹ Back
              </button>
              <button
                type="button"
                className="btn primary wide"
                disabled={reason === null}
                onClick={saveNoData}
              >
                Record no data (pending)
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
