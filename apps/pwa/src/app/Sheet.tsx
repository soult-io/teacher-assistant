// The shared bottom sheet / modal shell (scrim + role="dialog") and its Escape
// dismissal. Sheet adds the focus handling a modal needs: focus moves to the first
// field on open, Tab stays inside, and focus returns to the opener on close.

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";

/** Escape closes the sheet — the keyboard path; the backdrop click is the pointer one. */
export function useEscapeToClose(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    globalThis.addEventListener?.("keydown", onKey);
    return () => globalThis.removeEventListener?.("keydown", onKey);
  }, [onClose]);
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * A bottom sheet / modal with Escape + backdrop dismissal (the QuickScoreSheet
 * pattern). Focus moves to the first field on open, Tab stays inside the sheet,
 * and focus returns to the button that opened it on close.
 */
export function Sheet({
  title,
  onClose,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(onClose);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fields = sheetRef.current?.querySelectorAll<HTMLElement>("input, [role='radio']");
    fields?.[0]?.focus();
    return () => opener?.focus();
  }, []);
  const trapTab = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || sheetRef.current === null) {
      return;
    }
    const items = [...sheetRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
  };
  return (
    <>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: decorative backdrop; Escape (above) is the keyboard control */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: decorative backdrop; Escape (above) is the keyboard control */}
      <div className="scrim open" onClick={onClose} />
      <div
        ref={sheetRef}
        className="sheet open"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={trapTab}
      >
        <div className="grip" />
        <button type="button" className="modal-close" aria-label="close" onClick={onClose}>
          ✕
        </button>
        <h2 className="sheettitle" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
    </>
  );
}
