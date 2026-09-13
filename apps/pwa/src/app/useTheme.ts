// Theme control (light / dark / system) using the prototype's token approach:
// `data-theme` on the root element drives an explicit choice; its ABSENCE lets
// `prefers-color-scheme` decide (system). The choice persists in localStorage —
// a per-viewer UI convenience with NO student data, so it is FERPA-safe there
// (the hard-stop is on student data at rest, not a theme flag). Reads/writes are
// guarded: storage can throw or be empty (private mode), and the app must render
// regardless.

import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const STORAGE_KEY = "ta-theme";
const ORDER: readonly ThemeChoice[] = ["system", "light", "dark"];

function readStored(): ThemeChoice {
  try {
    const v = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") {
      return v;
    }
  } catch {
    // storage unavailable — fall through to the default
  }
  return "system";
}

function applyChoice(choice: ThemeChoice): void {
  const root = globalThis.document?.documentElement;
  if (root === undefined) {
    return;
  }
  if (choice === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", choice);
  }
}

/** The label/icon for the current choice (shown on the toggle). */
export function themeIcon(choice: ThemeChoice): string {
  switch (choice) {
    case "light":
      return "☀";
    case "dark":
      return "☽";
    case "system":
      return "◐";
  }
}

export interface ThemeControl {
  readonly choice: ThemeChoice;
  /** Advance system → light → dark → system. */
  cycle(): void;
}

export function useTheme(): ThemeControl {
  const [choice, setChoice] = useState<ThemeChoice>(readStored);

  useEffect(() => {
    applyChoice(choice);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, choice);
    } catch {
      // best-effort persistence; ignore
    }
  }, [choice]);

  const cycle = useCallback(() => {
    setChoice((cur) => {
      const next = ORDER[(ORDER.indexOf(cur) + 1) % ORDER.length];
      return next ?? "system";
    });
  }, []);

  return { choice, cycle };
}
