// U5 — New-Goal flow (design §F.F5, teacher-only). Collects the 6 KY IEP-goal
// components + method/tool + frequency + denominator basis + setting + accom/mod
// (+ an already-collected baseline on the ADOPT path). The BASELINE-MANDATORY gate
// is the ENGINE's `canBeginMonitoring` (no UI-side rule): ADOPT requires it fully;
// DRAFT allows only the baseline to be missing (it is gathered later in the
// baseline track). Two paths: ADOPT → active, DRAFT → a proposed goal to baseline.

import { canBeginMonitoring } from "@teacher-assistant/domain-core";
import {
  type AccomMod,
  ACCOM_MODS,
  type DenominatorBasis,
  type Frequency,
  FREQUENCIES,
  newOpaqueId,
  type Setting,
  SETTINGS,
} from "@teacher-assistant/schema";
import { useState } from "react";
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
      : "Baseline-mandatory: a goal cannot go active without a baseline value AND a criterion with level + consistency.";
  }
  return ready
    ? "✓ Ready to baseline. Proposed goals never feed IC and carry no weekly “owes” until adopted at ARC."
    : "Fill the KY goal components + the accommodation label to start baselining.";
}

export interface NewGoalScreenProps {
  readonly onSubmit: (form: NewGoalForm) => void;
  readonly onBack: () => void;
}

export function NewGoalScreen({ onSubmit, onBack }: NewGoalScreenProps) {
  const [form, setForm] = useState<NewGoalForm>(emptyForm);
  const set = <K extends keyof NewGoalForm>(key: K, value: NewGoalForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  // Run the ENGINE gate against a preview goal (a throwaway id — the gate is
  // id-independent). ADOPT needs it fully satisfied; DRAFT tolerates a missing baseline.
  const preview = assembleGoal(form, newOpaqueId(), nowTs());
  const check = canBeginMonitoring(preview.goal);
  // Domain validity comes from the engine gate; the form additionally requires its
  // own required-marked text fields the gate doesn't cover (initials = the audience,
  // method tool) — plain presence checks, not domain rules.
  const fieldsPresent = form.initials.trim() !== "" && form.methodTool.trim() !== "";
  const gateReady = form.path === "adopt" ? check.ok : draftReady(check.missing);
  const ready = gateReady && fieldsPresent;
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
              className={form.path === "adopt" ? "on" : ""}
              onClick={() => set("path", "adopt")}
            >
              Adopt an already-baselined goal → active
            </button>
            <button
              type="button"
              className={form.path === "draft" ? "on" : ""}
              onClick={() => set("path", "draft")}
            >
              Draft a proposed goal to baseline
            </button>
          </div>
        </Group>

        <Field label="Student initials" hint="(Audience)" required>
          <input
            className="tin"
            value={form.initials}
            placeholder="e.g. AB"
            onChange={(e) => set("initials", e.target.value)}
          />
        </Field>
        <Field label="Behavior" hint="(what the student will do)" required>
          <input
            className="tin"
            value={form.behavior}
            placeholder="solve two-step equations"
            onChange={(e) => set("behavior", e.target.value)}
          />
        </Field>
        <Field label="Circumstance" hint="(given…)" required>
          <input
            className="tin"
            value={form.circumstance}
            placeholder="given a 5-item probe and a number line"
            onChange={(e) => set("circumstance", e.target.value)}
          />
        </Field>
        <Field label="Criterion" hint="level % AND consistency (n probes)" required>
          <div className="two">
            <input
              className="tin"
              inputMode="numeric"
              value={form.level}
              placeholder="level % e.g. 80"
              aria-label="criterion level"
              onChange={(e) => set("level", e.target.value)}
            />
            <input
              className="tin"
              inputMode="numeric"
              value={form.consistency}
              placeholder="consistency e.g. 4"
              aria-label="criterion consistency"
              onChange={(e) => set("consistency", e.target.value)}
            />
          </div>
        </Field>
        <Field label="Method tool" hint="e.g. enVision worksheet" required>
          <input
            className="tin"
            value={form.methodTool}
            placeholder="curriculum probe"
            onChange={(e) => set("methodTool", e.target.value)}
          />
        </Field>
        <Field label="Frequency" hint="(drives owes cadence)">
          <select
            className="tin"
            value={form.frequency}
            onChange={(e) => set("frequency", e.target.value as Frequency)}
          >
            {FREQUENCIES.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>

        <Group label="Probe total basis">
          <div className="pathseg">
            <button
              type="button"
              className={!variable ? "on" : ""}
              onClick={() => set("denominatorBasis", "fixed" as DenominatorBasis)}
            >
              Fixed total
            </button>
            <button
              type="button"
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
        <Field label="Accommodation / modification" hint="(explicit — never defaulted)" required>
          <select
            className="tin"
            value={form.accomMod}
            onChange={(e) => set("accomMod", e.target.value as AccomMod)}
          >
            {ACCOM_MODS.map((a) => (
              <option key={a} value={a}>
                {ACCOM_LABEL[a]}
              </option>
            ))}
          </select>
        </Field>

        {form.path === "adopt" ? (
          <Field label="Baseline %" hint="(already collected)" required>
            <input
              className="tin"
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
