// U5 — New-Goal flow (design §F.F5, teacher-only). Collects the 6 KY IEP-goal
// components + method/tool + frequency + denominator basis + setting + accom/mod
// (+ an already-collected baseline on the ADOPT path). The BASELINE-MANDATORY gate
// is the ENGINE's `canBeginMonitoring` (no UI-side rule): ADOPT requires it fully;
// DRAFT allows only the baseline to be missing (it is gathered later in the
// baseline track). Two paths: ADOPT → active, DRAFT → a proposed goal to baseline.

import {
  canBeginMonitoring,
  goalLabelConflicts,
  usableGoalLabel,
  validateGoalLabel,
} from "@teacher-assistant/domain-core";
import {
  type AccomMod,
  ACCOM_MODS,
  type DenominatorBasis,
  type Frequency,
  FREQUENCIES,
  type IEPGoal,
  type MethodGeneral,
  METHODS_GENERAL,
  newOpaqueId,
  normalizeInitials,
  type OpaqueId,
  type Setting,
  SETTINGS,
} from "@teacher-assistant/schema";
import { useState } from "react";
import { GOAL_LABEL_INVALID } from "../../GoalLabelEditor.js";
import { assembleGoal, emptyForm, type NewGoalForm, nowTs } from "./assemble.js";

const ACCOM_LABEL: Readonly<Record<AccomMod, string>> = {
  none: "None",
  accommodation: "Accommodation",
  modification: "Modification",
};
const SETTING_LABEL: Readonly<Record<Setting, string>> = {
  math_resource: "Resource",
  gen_ed: "Gen-ed",
  home_scored: "Home",
};
const FREQ_LABEL: Readonly<Record<Frequency, string>> = {
  daily: "daily",
  weekly: "weekly",
  twice_monthly: "2×/month",
  monthly: "monthly",
};
const METHOD_LABEL: Readonly<Record<MethodGeneral, string>> = {
  cbm: "CBM (curriculum-based)",
  direct: "Direct assessment",
  indirect: "Indirect",
  authentic: "Authentic",
};

/** DRAFT is ready when the ONLY thing the engine gate is missing is the baseline. */
function draftReady(missing: readonly string[]): boolean {
  return missing.every((m) => m === "baseline_value" || m === "baseline_source");
}

function LabelText({
  label,
  hint,
  required,
}: {
  readonly label: string;
  readonly hint?: string | undefined;
  readonly required?: boolean | undefined;
}) {
  return (
    <span className="nglabel">
      {label}
      {required ? <span className="reqmark"> *</span> : null}
      {hint !== undefined ? <span className="nghint"> {hint}</span> : null}
    </span>
  );
}

/** A labelled field that wraps ONE form control (input/select). */
function Field({
  label,
  hint,
  required,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as `children` and nested inside — a valid implicit association the static rule can't see through the prop.
    <label className="ngfield">
      <LabelText label={label} hint={hint} required={required} />
      {children}
    </label>
  );
}

/**
 * A labelled GROUP of controls (button segments) — a <div>, never a <label>: a
 * <label> wrapping multiple buttons corrupts each button's accessible name.
 */
function Group({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="ngfield">
      <LabelText label={label} />
      {children}
    </div>
  );
}

/** The baseline-mandatory gate copy (pure) — keeps the big form component under the complexity bar. */
function gateMessage(path: NewGoalForm["path"], ready: boolean): string {
  if (path === "adopt") {
    return ready
      ? "✓ Baseline + criterion (level & consistency) present — this goal can go active and feed IC."
      : "Baseline-mandatory: a goal cannot go active without a baseline value AND a criterion with level + consistency, and needs its IEP goal #.";
  }
  return ready
    ? "✓ Ready to baseline. Proposed goals never feed IC and carry no weekly “owes” until adopted at ARC."
    : "Fill the KY goal components + the accommodation label to start baselining.";
}

/**
 * TEACH-41 label readiness: ADOPT requires a valid IEP goal #, DRAFT accepts a
 * blank one (the new IEP's numbers may only be final at the ARC); an invalid
 * entry blocks either path.
 */
function labelReady(path: NewGoalForm["path"], raw: string): boolean {
  return validateGoalLabel(raw).ok && (path === "draft" || usableGoalLabel(raw) !== undefined);
}

/**
 * The non-blocking duplicate line under the IEP goal # field: "AB already has Goal 2
 * — Add integers". Same student + same cohort only (ADOPT = current IEP, DRAFT = next
 * IEP). Null when there is nothing to warn about.
 */
function duplicateWarning(
  form: NewGoalForm,
  goals: readonly IEPGoal[],
  studentId: OpaqueId | undefined,
): string | null {
  const label = usableGoalLabel(form.goalLabel);
  if (studentId === undefined || label === undefined) {
    return null;
  }
  const clashes = goalLabelConflicts(goals, {
    student_id: studentId,
    status: form.path === "adopt" ? "active" : "proposed",
    goal_label: label,
  });
  if (clashes.length === 0) {
    return null;
  }
  // A resolved student implies valid initials; show them in canonical form (TEACH-40).
  const initials = normalizeInitials(form.initials) ?? form.initials.trim();
  const texts = clashes.map((g) => g.goal_text).join(" / ");
  return `${initials} already has Goal ${label} — ${texts}`;
}

export interface NewGoalScreenProps {
  /** Every goal on record — the IEP goal # duplicate warning reads the student's goals. */
  readonly goals: readonly IEPGoal[];
  /** The existing student these initials resolve to (the same match the submit uses), if any. */
  readonly studentIdForInitials: (initials: string) => OpaqueId | undefined;
  readonly onSubmit: (form: NewGoalForm) => void;
  readonly onBack: () => void;
}

/**
 * Student initials (TEACH-40). One form cell (desktop grid) for the field + its error;
 * the error sits outside the <label>, so it is the input's description, not part of
 * its name. It waits for the first blur, so typing "JAS" never flashes it at "J", and
 * flags only a non-empty bad entry (an empty field is just "not filled yet").
 */
function InitialsField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [touched, setTouched] = useState(false);
  const error = touched && value.trim() !== "" && normalizeInitials(value) === undefined;
  return (
    <div className="ngfieldwrap">
      <Field label="Student initials" hint="(Audience)" required>
        <input
          className="tin"
          data-testid="ng-initials"
          value={value}
          placeholder="e.g. AB or JAS"
          // Room for "J.A.S."; normalizeInitials enforces the real 2–3 letter rule.
          maxLength={6}
          autoComplete="off"
          aria-invalid={error}
          aria-describedby={error ? "ng-initials-error" : undefined}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => setTouched(true)}
        />
      </Field>
      {error ? (
        <span className="ngerror" id="ng-initials-error" role="alert">
          Use 2 or 3 letters (initials only)
        </span>
      ) : null}
    </div>
  );
}

export function NewGoalScreen({
  goals,
  studentIdForInitials,
  onSubmit,
  onBack,
}: NewGoalScreenProps) {
  const [form, setForm] = useState<NewGoalForm>(emptyForm);
  const set = <K extends keyof NewGoalForm>(key: K, value: NewGoalForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Run the ENGINE gate against a preview goal (a throwaway id — the gate is
  // id-independent). ADOPT needs it fully satisfied; DRAFT tolerates a missing baseline.
  const preview = assembleGoal(form, newOpaqueId(), nowTs());
  const check = canBeginMonitoring(preview.goal);
  // Domain validity comes from the engine gate; the form additionally requires its
  // own required-marked text fields the gate doesn't cover: initials = the audience
  // (2–3 letters via the schema rule, TEACH-40) and the method tool (presence).
  const initialsValid = normalizeInitials(form.initials) !== undefined;
  const fieldsPresent = initialsValid && form.methodTool.trim() !== "";
  const gateReady = form.path === "adopt" ? check.ok : draftReady(check.missing);
  const labelOk = labelReady(form.path, form.goalLabel);
  const labelInvalid = !validateGoalLabel(form.goalLabel).ok;
  const dupLine = duplicateWarning(form, goals, studentIdForInitials(form.initials));
  const ready = gateReady && fieldsPresent && labelOk;
  const variable = form.denominatorBasis === "variable";

  return (
    <div className="new-goal">
      <div className="backrow">
        <button type="button" className="back" onClick={onBack}>
          ‹ Dashboard
        </button>
      </div>
      <h1>New goal</h1>
      <div className="sub">
        Teacher only. Initials only — no names; the goal text must pass the stranger test.
      </div>

      <div className="form card">
        <Group label="Path">
          <div className="pathseg">
            <button
              type="button"
              data-testid="ng-path-adopt"
              className={form.path === "adopt" ? "on" : ""}
              onClick={() => set("path", "adopt")}
            >
              Adopt an already-baselined goal → active
            </button>
            <button
              type="button"
              data-testid="ng-path-draft"
              className={form.path === "draft" ? "on" : ""}
              onClick={() => set("path", "draft")}
            >
              Draft a proposed goal to baseline
            </button>
          </div>
        </Group>

        <div className="two">
          <InitialsField value={form.initials} onChange={(v) => set("initials", v)} />
          {/* TEACH-41: the IEP's own goal number — required to ADOPT, optional on a DRAFT
              (final at the ARC). Typed from the IEP, never auto-filled. */}
          <Field label="IEP goal #" hint="(from the IEP)" required={form.path === "adopt"}>
            <input
              className="tin"
              data-testid="ng-goal-label"
              value={form.goalLabel}
              placeholder="e.g. 1"
              maxLength={6}
              aria-invalid={labelInvalid}
              onChange={(e) => set("goalLabel", e.target.value)}
            />
          </Field>
        </div>
        {labelInvalid ? (
          <div className="note warn" role="alert" data-testid="ng-goal-label-invalid">
            {GOAL_LABEL_INVALID}
          </div>
        ) : null}
        {dupLine !== null ? (
          <div className="note warn" data-testid="ng-goal-label-dup">
            {dupLine}
          </div>
        ) : null}
        <Field label="Behavior" hint="(what the student will do)" required>
          <input
            className="tin"
            data-testid="ng-behavior"
            value={form.behavior}
            placeholder="solve two-step equations"
            onChange={(e) => set("behavior", e.target.value)}
          />
        </Field>
        <Field label="Circumstance" hint="(given…)" required>
          <input
            className="tin"
            data-testid="ng-circumstance"
            value={form.circumstance}
            placeholder="given a 5-item probe and a number line"
            onChange={(e) => set("circumstance", e.target.value)}
          />
        </Field>
        <Field label="Criterion" hint="level % AND consistency (n probes)" required>
          <div className="two">
            <input
              className="tin"
              data-testid="ng-level"
              inputMode="numeric"
              value={form.level}
              placeholder="level % e.g. 80"
              aria-label="criterion level"
              onChange={(e) => set("level", e.target.value)}
            />
            <input
              className="tin"
              data-testid="ng-consistency"
              inputMode="numeric"
              value={form.consistency}
              placeholder="consistency e.g. 4"
              aria-label="criterion consistency"
              onChange={(e) => set("consistency", e.target.value)}
            />
          </div>
        </Field>
        <Field label="Method" hint="general class + the concrete tool" required>
          <div className="two">
            <select
              className="tin"
              data-testid="ng-method-general"
              value={form.methodGeneral}
              aria-label="method general"
              onChange={(e) => set("methodGeneral", e.target.value as MethodGeneral)}
            >
              {METHODS_GENERAL.map((m) => (
                <option key={m} value={m}>
                  {METHOD_LABEL[m]}
                </option>
              ))}
            </select>
            <input
              className="tin"
              data-testid="ng-method-tool"
              value={form.methodTool}
              placeholder="tool e.g. enVision worksheet"
              aria-label="method tool"
              onChange={(e) => set("methodTool", e.target.value)}
            />
          </div>
        </Field>
        <Field label="Frequency" hint="(drives owes cadence)">
          <select
            className="tin"
            value={form.frequency}
            onChange={(e) => set("frequency", e.target.value as Frequency)}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {FREQ_LABEL[f]}
              </option>
            ))}
          </select>
        </Field>

        <Group label="Probe total basis">
          <div className="pathseg">
            <button
              type="button"
              data-testid="ng-basis-fixed"
              className={!variable ? "on" : ""}
              onClick={() => set("denominatorBasis", "fixed" as DenominatorBasis)}
            >
              Fixed total
            </button>
            <button
              type="button"
              data-testid="ng-basis-variable"
              className={variable ? "on" : ""}
              onClick={() => set("denominatorBasis", "variable" as DenominatorBasis)}
            >
              Variable / custom
            </button>
          </div>
        </Group>
        {variable ? (
          <div className="note warn" data-testid="variable-basis-note">
            Variable basis turns OFF the off-basis check for this goal: every total you enter is
            accepted as-is, with no “differs from the assigned probe” prompt. Choose this only when
            your probes really do vary (e.g. 3, 5, 12 items) — a fixed goal keeps that safety check.
          </div>
        ) : (
          <Field label="Total items per probe" hint="(the fixed basis)" required>
            <input
              className="tin"
              data-testid="ng-total"
              inputMode="numeric"
              value={form.total}
              placeholder="e.g. 5"
              aria-label="total items per probe"
              onChange={(e) => set("total", e.target.value)}
            />
          </Field>
        )}

        <Field label="Setting">
          <select
            className="tin"
            value={form.setting}
            onChange={(e) => set("setting", e.target.value as Setting)}
          >
            {SETTINGS.map((s) => (
              <option key={s} value={s}>
                {SETTING_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Accommodation / modification"
          hint="category (explicit — never defaulted)"
          required
        >
          <select
            className="tin"
            data-testid="ng-accom"
            value={form.accomMod}
            aria-label="accommodation category"
            onChange={(e) => set("accomMod", e.target.value as AccomMod)}
          >
            {ACCOM_MODS.map((a) => (
              <option key={a} value={a}>
                {ACCOM_LABEL[a]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Accom / mod detail" hint="teacher reference only — not in the IC statement">
          <input
            className="tin"
            data-testid="ng-accom-detail"
            value={form.accomDetail}
            placeholder="e.g. read-aloud + extended time"
            aria-label="accommodation detail"
            onChange={(e) => set("accomDetail", e.target.value)}
          />
        </Field>

        {form.path === "adopt" ? (
          <Field label="Baseline %" hint="(already collected)" required>
            <input
              className="tin"
              data-testid="ng-baseline"
              inputMode="numeric"
              value={form.baseline}
              placeholder="e.g. 20"
              aria-label="baseline percent"
              onChange={(e) => set("baseline", e.target.value)}
            />
          </Field>
        ) : (
          <div className="note">
            Baseline is gathered in the Baseline / proposed track (≥3 comparable probes, then
            averaged into an estimate). Not entered here.
          </div>
        )}

        <div className={`gate ${ready ? "ok" : "bad"}`} data-testid="ng-gate">
          {gateMessage(form.path, ready)}
        </div>
        <button
          type="button"
          data-testid="ng-submit"
          className="btn primary wide ngsubmit"
          disabled={!ready}
          onClick={() => onSubmit(form)}
        >
          {form.path === "adopt" ? "Activate goal · begin monitoring" : "Start baselining →"}
        </button>
      </div>
    </div>
  );
}
