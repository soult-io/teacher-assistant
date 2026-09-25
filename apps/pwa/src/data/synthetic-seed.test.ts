// TEACH-23: the synthetic seed's audit timestamps. Goal Detail's ARC history renders
// entry_ts as the "Entered" day, and TEACH-25 orders same-day points by it — so every
// seeded *_ts must be a real, plausible time derived from `now` alone.
import { asTimestamp, type IsoDate, newOpaqueId } from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import { buildSyntheticSeed, stampEntryTimes } from "./synthetic-seed.js";

const Y2K = Date.UTC(2000, 0, 1);

// Midday (the e2e FIXED_NOW), just past midnight (today's afternoon slot is still in
// the future, so the clamp bites), and late evening (no clamp).
const NOWS = [
  new Date("2026-05-13T12:00:00.000Z"),
  new Date("2026-09-14T00:00:00.005Z"),
  new Date("2026-09-25T23:59:59.999Z"),
];

/** Every numeric `*_ts` field anywhere in the seed, with its path. */
function allTimestamps(value: unknown, path = "seed"): { path: string; ts: number }[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => allTimestamps(v, `${path}[${i}]`));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([k, v]) =>
    k.endsWith("_ts") && typeof v === "number"
      ? [{ path: `${path}.${k}`, ts: v }]
      : allTimestamps(v, `${path}.${k}`),
  );
}

/** Strip the freshly minted ids so two seeds compare on their timestamps. */
function timestampsOnly(seed: ReturnType<typeof buildSyntheticSeed>): number[] {
  return allTimestamps(seed).map((t) => t.ts);
}

describe.each(NOWS)("buildSyntheticSeed(%s) timestamps", (now) => {
  const seed = buildSyntheticSeed(now);
  const entered = [...seed.master.points, ...seed.paraPending, ...seed.master.baselinePoints];

  it("stamps no *_ts before 2000-01-01 (no epoch-0 placeholder)", () => {
    const stamps = allTimestamps(seed);
    // points + para + baselines + goals at least — the walk actually found them.
    expect(stamps.length).toBeGreaterThanOrEqual(entered.length + seed.master.goals.length);
    for (const { path, ts } of stamps) {
      expect(ts, path).toBeGreaterThanOrEqual(Y2K);
    }
  });

  it("enters every point on or after its admin date (UTC) and never after now", () => {
    for (const p of entered) {
      expect(p.entry_ts).toBeGreaterThanOrEqual(Date.parse(p.admin_date));
      expect(p.entry_ts).toBeLessThanOrEqual(now.getTime());
    }
  });

  it("creates every goal before its first point", () => {
    for (const g of seed.master.goals) {
      const first = Math.min(
        ...entered.filter((p) => p.goal_id === g.goal_id).map((p) => p.entry_ts),
      );
      expect(g.created_ts).toBeLessThan(first);
      expect(g.created_ts).toBeLessThanOrEqual(now.getTime());
    }
  });

  it("orders a goal's same-day points by strictly increasing entry_ts", () => {
    const byDay = new Map<string, number[]>();
    for (const p of entered) {
      const key = `${p.goal_id}|${p.admin_date}`;
      byDay.set(key, [...(byDay.get(key) ?? []), p.entry_ts]);
    }
    for (const stamps of byDay.values()) {
      for (let i = 1; i < stamps.length; i++) {
        expect(stamps[i]).toBeGreaterThan(stamps[i - 1] ?? Number.NaN);
      }
    }
  });

  it("is deterministic for a given now", () => {
    expect(timestampsOnly(buildSyntheticSeed(now))).toEqual(timestampsOnly(seed));
  });
});

describe("stampEntryTimes", () => {
  const goal = newOpaqueId();
  const other = newOpaqueId();
  const rec = (goal_id: typeof goal, admin_date: string) => ({
    goal_id,
    admin_date: admin_date as IsoDate,
  });

  it("stamps a past day at the afternoon slot, a few minutes apart per goal", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const out = stampEntryTimes(
      [rec(goal, "2026-09-18"), rec(other, "2026-09-18"), rec(goal, "2026-09-18")],
      now,
    ).map((r) => new Date(r.entry_ts).toISOString());
    expect(out).toEqual([
      "2026-09-18T15:00:00.000Z",
      "2026-09-18T15:00:00.000Z", // another goal starts its own sequence
      "2026-09-18T15:07:00.000Z",
    ]);
  });

  it("clamps today's points to at most now, keeping them strictly increasing", () => {
    const now = new Date("2026-09-25T12:00:00Z");
    const out = stampEntryTimes(
      [rec(goal, "2026-09-25"), rec(goal, "2026-09-25"), rec(goal, "2026-09-25")],
      now,
    ).map((r) => r.entry_ts);
    expect(out).toEqual([
      asTimestamp(now.getTime() - 2),
      asTimestamp(now.getTime() - 1),
      asTimestamp(now.getTime()),
    ]);
  });

  it("only clamps the slots that would land after now", () => {
    const now = new Date("2026-09-25T15:10:00Z");
    const out = stampEntryTimes(
      [rec(goal, "2026-09-25"), rec(goal, "2026-09-25"), rec(goal, "2026-09-25")],
      now,
    ).map((r) => new Date(r.entry_ts).toISOString());
    expect(out).toEqual([
      "2026-09-25T15:00:00.000Z",
      "2026-09-25T15:07:00.000Z",
      "2026-09-25T15:10:00.000Z", // 15:14 planned → clamped to now
    ]);
  });
});
