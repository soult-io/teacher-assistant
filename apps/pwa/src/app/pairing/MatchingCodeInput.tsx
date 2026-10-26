// [A2] The matching code typed on the trusted device (flows Flow 3 A2; spec §13 A-4, A-9):
// 16 characters in four boxes of four, digits and letters a–f, upper or lower case. The
// cursor moves on by itself and a paste of the whole code fills every box. Never shows
// or hints at the expected code.

import { useRef } from "react";

const GROUPS = 4;
const GROUP_LENGTH = 4;
/** Stable React keys for the four boxes (their order never changes). */
const BOX_KEYS = ["box-1", "box-2", "box-3", "box-4"] as const;

/** The four empty boxes. */
export const EMPTY_MATCHING_CODE: readonly string[] = ["", "", "", ""];

/** True once all 16 characters are typed. */
export function matchingCodeComplete(parts: readonly string[]): boolean {
  return parts.every((part) => part.length === GROUP_LENGTH);
}

/** Keep only hex characters (case kept for the boxes; the check ignores case). */
function hexOnly(text: string): string {
  return text.replace(/[^0-9a-fA-F]/g, "");
}

export function MatchingCodeInput({
  parts,
  onChange,
  disabled = false,
}: {
  /** The four boxes, each up to four characters. */
  readonly parts: readonly string[];
  readonly onChange: (parts: readonly string[]) => void;
  readonly disabled?: boolean;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const change = (index: number, typed: string) => {
    const clean = hexOnly(typed);
    const next = [...parts];
    if (clean.length > GROUP_LENGTH) {
      // A paste: fill this box and the ones after it, four characters each.
      for (let i = index; i < GROUPS; i += 1) {
        const offset = (i - index) * GROUP_LENGTH;
        next[i] = clean.slice(offset, offset + GROUP_LENGTH);
      }
    } else {
      next[index] = clean;
    }
    onChange(next);
    const firstOpen = next.findIndex((part) => part.length < GROUP_LENGTH);
    if (clean.length >= GROUP_LENGTH && firstOpen > index) {
      boxes.current[firstOpen]?.focus();
    }
  };
  return (
    <div className="matchcode" data-testid="matching-code">
      {parts.map((part, index) => (
        <span key={BOX_KEYS[index]} className="matchgroup">
          {index > 0 ? (
            <span className="matchdash" aria-hidden="true">
              -
            </span>
          ) : null}
          <input
            ref={(el) => {
              boxes.current[index] = el;
            }}
            className="setupinput mono group"
            aria-label={`Matching code, part ${index + 1} of ${GROUPS}`}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
            value={part}
            onChange={(e) => change(index, e.target.value)}
            data-testid={`matching-code-${index + 1}`}
          />
        </span>
      ))}
    </div>
  );
}
