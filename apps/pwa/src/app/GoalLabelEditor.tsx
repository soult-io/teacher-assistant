// TEACH-41 — the inline IEP goal # editor (product-ux-designer ruling): there is
// no Edit Goal screen, so Goal Detail and the Baseline card edit the label in
// place. Collapsed it is a small "edit" link (labelled goal) or a grey
// "+ Add IEP goal #" (unlabeled); tapped, an input opens — Enter or blur saves,
// Esc cancels. Validation is the engine's validateGoalLabel; the caller persists
// through setGoalLabel (an audited Revision). Never auto-filled.

import { validateGoalLabel } from "@teacher-assistant/domain-core";
import { useState } from "react";

export const GOAL_LABEL_INVALID = "Use up to 6 letters, numbers or dots (e.g. 2, 1a, 3.1).";

export interface GoalLabelEditorProps {
  readonly label: string | undefined;
  /** Save a changed label (undefined = cleared). Only called with a valid, changed value. */
  readonly onSave: (label: string | undefined) => void;
}

export function GoalLabelEditor({ label, onSave }: GoalLabelEditorProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  if (draft === null) {
    return (
      <button
        type="button"
        className={`linkbtn goallabel-edit${label === undefined ? " add" : ""}`}
        data-testid="goal-label-edit"
        aria-label={label === undefined ? "Add IEP goal number" : `Edit IEP goal number ${label}`}
        onClick={() => {
          setInvalid(false);
          setDraft(label ?? "");
        }}
      >
        {label === undefined ? "+ Add IEP goal #" : "edit"}
      </button>
    );
  }

  const cancel = () => {
    setDraft(null);
    setInvalid(false);
  };
  const save = () => {
    const check = validateGoalLabel(draft);
    if (!check.ok) {
      setInvalid(true);
      return;
    }
    setDraft(null);
    setInvalid(false);
    if (check.label !== label) {
      onSave(check.label);
    }
  };

  return (
    <span className="goallabel-box">
      <span className="nghint">IEP goal #</span>
      <input
        className="tin goallabel-in"
        data-testid="goal-label-input"
        aria-label="IEP goal number"
        aria-invalid={invalid}
        placeholder="e.g. 1"
        maxLength={6}
        // biome-ignore lint/a11y/noAutofocus: the box opens on an explicit tap of "edit" — focus belongs in it.
        autoFocus
        value={draft}
        onChange={(e) => {
          setInvalid(false);
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={save}
      />
      {invalid ? (
        <span className="note warn" role="alert" data-testid="goal-label-invalid">
          {GOAL_LABEL_INVALID}
        </span>
      ) : null}
    </span>
  );
}
