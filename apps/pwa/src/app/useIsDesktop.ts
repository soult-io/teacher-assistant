// A single responsive boolean: is the viewport at/above the desktop breakpoint
// (design/desktop-design-spec.md §1, 900px)? U7 is ONE codebase driven by CSS
// media queries for pure layout — but two behaviors genuinely DIVERGE by width and
// cannot be expressed in CSS (design §4 interaction table): a dashboard row CLICK
// selects into the master-detail pane on desktop vs navigates to full Goal Detail on
// mobile, and Goal Detail reflows to two columns. This hook is that one boolean, not
// a second layout tree; every other desktop difference stays in the stylesheet.
//
// jsdom has no `matchMedia`, so the guarded reader returns `false` under test — the
// validated MOBILE layout is the default and its tests exercise it unchanged.

import { useEffect, useState } from "react";

/** The desktop breakpoint — kept in lockstep with the `@media (min-width: 900px)` in app.css. */
export const DESKTOP_QUERY = "(min-width: 900px)";

/**
 * A one-shot read of whether the viewport is at/above the desktop breakpoint. The single
 * definition of the jsdom-safe matchMedia guard — the hook's initializer and any
 * imperative desktop check (e.g. the Quick-Score focus-on-open) both use it.
 */
export function matchesDesktop(): boolean {
  try {
    return globalThis.matchMedia?.(DESKTOP_QUERY).matches ?? false;
  } catch {
    // matchMedia can throw in constrained/legacy environments — treat as mobile.
    return false;
  }
}

export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(matchesDesktop);

  useEffect(() => {
    const mql = globalThis.matchMedia?.(DESKTOP_QUERY);
    if (mql === undefined) {
      return;
    }
    const onChange = () => setIsDesktop(mql.matches);
    onChange(); // reconcile any change between first render and effect
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  return isDesktop;
}
