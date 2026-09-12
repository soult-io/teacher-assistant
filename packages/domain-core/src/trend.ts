// M8 — trend engine (design §G R3-3). Ordinary-least-squares line over
// %-by-admin-date, plus the aim line (baseline → criterion by iep_end) and the
// four-point noise cross-check. Pure numeric helpers; no student payload.

export interface TrendLine {
  readonly slope: number;
  readonly intercept: number;
}

export interface XY {
  readonly x: number;
  readonly y: number;
}

/** OLS fit over (x, y). Returns null when it is undefined (fewer than 2 distinct x). */
export function olsTrend(points: readonly XY[]): TrendLine | null {
  const n = points.length;
  if (n < 2) {
    return null;
  }
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    num += dx * (p.y - meanY);
    den += dx * dx;
  }
  if (den === 0) {
    return null; // all points on the same date — no defined slope
  }
  const slope = num / den;
  return { slope, intercept: meanY - slope * meanX };
}

/** Evaluate a line at x. */
export function valueAt(line: TrendLine, x: number): number {
  return line.slope * x + line.intercept;
}

/** The aim line value at x: baseline at x=0 rising to criterion at x=xEnd. */
export function aimValueAt(baseline: number, criterion: number, xEnd: number, x: number): number {
  if (xEnd <= 0) {
    return criterion;
  }
  return baseline + ((criterion - baseline) * x) / xEnd;
}

/** Four-point verdict: are the last four actuals all above / all below / straddling the aim line? */
export type FourPointVerdict = "above" | "below" | "straddle";

export function fourPointVerdict(
  lastFour: readonly XY[],
  baseline: number,
  criterion: number,
  xEnd: number,
): FourPointVerdict {
  let above = 0;
  let below = 0;
  for (const p of lastFour) {
    const aim = aimValueAt(baseline, criterion, xEnd, p.x);
    if (p.y >= aim) {
      above += 1;
    } else {
      below += 1;
    }
  }
  if (above > 0 && below > 0) {
    return "straddle";
  }
  return below === 0 ? "above" : "below";
}
