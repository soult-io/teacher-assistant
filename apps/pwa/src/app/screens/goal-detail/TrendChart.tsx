// U4 trend chart (design §F / prototype trendSVG). Plots the scored %-by-admin-date
// from the M5 read model. Pure/presentational: it renders exactly what the engine
// classified — it makes no domain decision.
//
// Honesty rules encoded here:
//   - A ⊘ (no-data) probe is a GAP, never a plotted 0: it draws a ⊘ glyph + a faint
//     marker at its date and BREAKS the connecting line; it is never a y=0 point.
//   - A teacher-COUNTED off-basis point plots WITH a non-strippable off-basis ring.
//     (Excluded/pending mismatched points are already absent from `trend`.)
//   - The baseline→criterion AIM line and the connect-the-dots line are NEVER drawn
//     ACROSS a criterion / denominator-model change (SME advisory): both segment at
//     `clampAfter`. We deliberately fit NO regression/trend line — the trend claim
//     lives in the M8 draft statement, gated; the chart only shows the actuals.

import type { NoDataMarker, TrendPoint } from "@teacher-assistant/domain-core";

export interface TrendChartProps {
  readonly trend: readonly TrendPoint[];
  readonly noDataMarkers: readonly NoDataMarker[];
  /** Criterion/denominator-model change date; the aim + line never span it. Null = no change. */
  readonly clampAfter: string | null;
  /** Aim-line start value (baseline). Null → no aim ramp (fall back to a flat criterion line). */
  readonly baselineValue: number | null;
  readonly criterionLevel: number;
  /** Aim-line horizon; the ramp reaches criterion here. Null → flat criterion line. */
  readonly iepEndDate: string | null;
}

const W = 520;
const H = 180;
const PAD_L = 34;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 26;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
const GRID = [0, 20, 40, 60, 80, 100] as const;

/** Days since epoch (UTC) for an ISO date — the x axis is real admin-date spacing. */
function dayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
}

/**
 * Split the plotted points into connect-the-dots segments, breaking the line
 * whenever a ⊘ falls between two points (a gap) or a pair straddles the clamp
 * boundary (never a line across a criterion / denominator-model change). No
 * regression fit — the trend claim lives in the gated M8 statement, not the chart.
 */
function segmentTrend(
  trend: readonly TrendPoint[],
  gapDays: readonly number[],
  clampX: number | null,
): TrendPoint[][] {
  const segments: TrendPoint[][] = [];
  let current: TrendPoint[] = [];
  for (const p of trend) {
    const prev = current[current.length - 1];
    if (prev !== undefined) {
      const da = dayNumber(prev.adminDate);
      const db = dayNumber(p.adminDate);
      const gapBetween = gapDays.some((g) => g > da && g < db);
      const straddlesClamp = clampX !== null && da < clampX && db >= clampX;
      if (gapBetween || straddlesClamp) {
        segments.push(current);
        current = [];
      }
    }
    current.push(p);
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

export function TrendChart(props: TrendChartProps) {
  const { trend, noDataMarkers, clampAfter, baselineValue, criterionLevel, iepEndDate } = props;

  // x domain spans every dated mark (scored points + ⊘ gaps) so a trailing ⊘ still shows.
  const dates = [...trend.map((t) => t.adminDate), ...noDataMarkers.map((m) => m.adminDate)];
  const xs = dates.map(dayNumber);
  const xMin = xs.length > 0 ? Math.min(...xs) : 0;
  const xMax = xs.length > 0 ? Math.max(...xs) : 1;
  const span = xMax - xMin || 1; // avoid /0 when a single date

  const X = (iso: string): number => PAD_L + ((dayNumber(iso) - xMin) / span) * PLOT_W;
  const Y = (v: number): number => PAD_T + (1 - v / 100) * PLOT_H;

  const clampX = clampAfter !== null ? dayNumber(clampAfter) : null;

  // Aim line value at a given x-day: baseline at the first date rising to criterion
  // at the IEP end. Without a baseline or horizon we cannot ramp — return the flat
  // criterion (a defensible target reference, never a fabricated slope).
  const aimAt = (day: number): number => {
    if (baselineValue === null || iepEndDate === null) {
      return criterionLevel;
    }
    const x0 = xMin;
    const xEnd = dayNumber(iepEndDate) - x0;
    if (xEnd <= 0) {
      return criterionLevel;
    }
    return baselineValue + ((criterionLevel - baselineValue) * (day - x0)) / xEnd;
  };

  // Aim line drawn only over the CURRENT-model region [max(xMin, clampAfter), xMax]
  // so it never spans a criterion/denominator change. Suppressed entirely when a
  // clamp post-dates every plotted point (nothing on the current-model side to aim
  // over) — otherwise the segment would draw off-plot to the right.
  const aimStartDay = clampX !== null ? Math.max(xMin, clampX) : xMin;
  const showAim = aimStartDay < xMax;
  const aimStartIso = new Date(aimStartDay * 86_400_000).toISOString().slice(0, 10);
  const aimEndIso = new Date(xMax * 86_400_000).toISOString().slice(0, 10);

  const gapDays = noDataMarkers.map((m) => dayNumber(m.adminDate));
  const segments = segmentTrend(trend, gapDays, clampX);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label="progress trend"
      className="trendsvg"
    >
      <title>Progress trend — scored percent by administration date</title>
      {GRID.map((v) => (
        <g key={v}>
          <line
            x1={PAD_L}
            y1={Y(v)}
            x2={W - PAD_R}
            y2={Y(v)}
            stroke="var(--border)"
            strokeWidth={1}
          />
          <text x={PAD_L - 6} y={Y(v) + 4} fontSize={10} fill="var(--text-dim)" textAnchor="end">
            {v}
          </text>
        </g>
      ))}

      {/* Baseline→criterion aim line (dashed), segmented to the current-model region. */}
      {showAim ? (
        <line
          x1={X(aimStartIso)}
          y1={Y(aimAt(aimStartDay))}
          x2={X(aimEndIso)}
          y2={Y(aimAt(xMax))}
          stroke="var(--owes-line)"
          strokeWidth={2}
          strokeDasharray="6 5"
        />
      ) : null}
      <text
        x={W - PAD_R}
        y={Y(criterionLevel) - 5}
        fontSize={10}
        fill="var(--owes)"
        textAnchor="end"
      >
        aim {criterionLevel}%
      </text>

      {/* Clamp boundary — a labelled break so the reader sees the model changed here. */}
      {clampAfter !== null ? (
        <line
          x1={X(clampAfter)}
          y1={PAD_T}
          x2={X(clampAfter)}
          y2={H - PAD_B}
          stroke="var(--mastery)"
          strokeWidth={1.5}
          strokeDasharray="1 3"
        />
      ) : null}

      {/* ⊘ gap markers — a glyph + faint rule at the date; NEVER a y=0 point. */}
      {noDataMarkers.map((m) => (
        <g key={`nd-${m.adminDate}-${m.reason}`}>
          <line
            x1={X(m.adminDate)}
            y1={PAD_T}
            x2={X(m.adminDate)}
            y2={H - PAD_B}
            stroke="var(--nodata)"
            strokeWidth={1}
            strokeDasharray="2 4"
            opacity={0.6}
          />
          <text
            x={X(m.adminDate)}
            y={H - PAD_B + 18}
            fontSize={15}
            fill="var(--nodata)"
            textAnchor="middle"
          >
            ⊘
          </text>
        </g>
      ))}

      {/* Connect-the-dots segments (no regression fit; broken at gaps + the clamp). */}
      {segments.map((seg) =>
        seg.length >= 2 ? (
          <path
            key={`seg-${seg[0]?.dataPointId}`}
            d={seg.map((p, i) => `${i === 0 ? "M" : "L"}${X(p.adminDate)} ${Y(p.value)}`).join(" ")}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2.5}
          />
        ) : null,
      )}

      {/* Scored points. An off-basis (teacher-counted) point carries a visible ring. */}
      {trend.map((p) => (
        <g key={`pt-${p.dataPointId}`}>
          <circle
            cx={X(p.adminDate)}
            cy={Y(p.value)}
            r={5.5}
            fill={p.value >= criterionLevel ? "var(--logged)" : "var(--accent)"}
          />
          {p.offBasis ? (
            <circle
              cx={X(p.adminDate)}
              cy={Y(p.value)}
              r={9}
              fill="none"
              stroke="var(--owes)"
              strokeWidth={1.5}
              strokeDasharray="2 2"
            />
          ) : null}
        </g>
      ))}
    </svg>
  );
}
