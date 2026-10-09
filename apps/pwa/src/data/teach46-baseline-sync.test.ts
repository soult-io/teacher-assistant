// @vitest-environment node
// TEACH-46 — baseline Fix / Remove through the CRDT doc (ruling E6, E13).
// Two devices edit offline, then exchange updates: edits merge by point id with
// no overwrite of another point's edit and no duplicate. SYNTHETIC data only.

import { createBaselinePoint } from "@teacher-assistant/domain-core";
import {
  asTimestamp,
  type BaselinePoint,
  type IEPGoal,
  type IsoDate,
  newOpaqueId,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as repository from "./repository.js";
import { normalizeBaselinePoint, readRecords, upsertBaselinePoint } from "./repository.js";
import * as writes from "./writes.js";
import {
  addBaselinePointMutator,
  fixBaselinePointMutator,
  removeBaselinePointMutator,
} from "./writes.js";

const goal: IEPGoal = {
  goal_id: newOpaqueId(),
  student_id: newOpaqueId(),
  goal_text: "synthetic",
  behavior: "b",
  circumstance: "c",
  criterion_level: 80,
  criterion_consistency: { n_probes: 4, phrase: "4 consecutive probes" },
  method_general: "cbm",
  method_tool: "probe",
  frequency: "weekly",
  denominator_model: "percent_correct_over_total",
  accom_mod: "none",
  setting_default: "math_resource",
  valid_settings: ["math_resource"],
  status: "proposed",
  created_ts: asTimestamp(0),
  revisions: [],
};

function point(numerator: number): BaselinePoint {
  return createBaselinePoint({
    goal,
    probe: undefined,
    adminDate: "2026-09-14" as IsoDate,
    numerator,
    denominator: 10,
    who: "teacher",
    entryTs: asTimestamp(0),
  });
}

/** Push every update one doc has that the other lacks, both ways. */
function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

function byId(doc: Y.Doc): Map<string, BaselinePoint> {
  return new Map(readRecords(doc).baselinePoints.map((p) => [p.baseline_point_id, p]));
}

describe("E13 — offline Fix and Remove sync without overwriting or duplicating", () => {
  it("two devices editing different points offline converge on both edits", () => {
    const [p1, p2, p3] = [point(2), point(4), point(6)];
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.transact(() => {
      for (const p of [p1, p2, p3]) addBaselinePointMutator(p)(a);
    });
    sync(a, b);

    // Offline: device A fixes p1, device B removes p2.
    a.transact(() => fixBaselinePointMutator(p1, goal, { numerator: 3 }, asTimestamp(10))(a));
    b.transact(() =>
      removeBaselinePointMutator(p2, goal, "entered_by_mistake", asTimestamp(11))(b),
    );
    sync(a, b);

    for (const doc of [a, b]) {
      const pts = byId(doc);
      expect(pts.size).toBe(3);
      expect(pts.get(p1.baseline_point_id)?.numerator).toBe(3);
      expect(pts.get(p1.baseline_point_id)?.revisions).toHaveLength(1);
      expect(pts.get(p2.baseline_point_id)?.status).toBe("removed");
      expect(pts.get(p2.baseline_point_id)?.numerator).toBe(4);
      expect(pts.get(p3.baseline_point_id)).toEqual(p3);
    }
  });

  it("a fix then a remove on one offline device arrive as one point with both revisions", () => {
    const p = point(2);
    const a = new Y.Doc();
    const b = new Y.Doc();
    a.transact(() => addBaselinePointMutator(p)(a));
    sync(a, b);

    a.transact(() => fixBaselinePointMutator(p, goal, { numerator: 3 }, asTimestamp(10))(a));
    const fixed = byId(a).get(p.baseline_point_id);
    if (fixed === undefined) throw new Error("expected the fixed point");
    a.transact(() => removeBaselinePointMutator(fixed, goal, "duplicate", asTimestamp(11))(a));
    sync(a, b);

    const pts = byId(b);
    expect(pts.size).toBe(1);
    const synced = pts.get(p.baseline_point_id);
    expect(synced?.status).toBe("removed");
    expect(synced?.revisions.map((r) => r.when)).toEqual([10, 11]);
  });

  it("replaying the same update twice does not duplicate a point", () => {
    const p = point(5);
    const a = new Y.Doc();
    a.transact(() => addBaselinePointMutator(p)(a));
    a.transact(() => fixBaselinePointMutator(p, goal, { numerator: 1 }, asTimestamp(10))(a));
    const update = Y.encodeStateAsUpdate(a);
    const b = new Y.Doc();
    Y.applyUpdate(b, update);
    Y.applyUpdate(b, update);
    expect(readRecords(b).baselinePoints).toHaveLength(1);
    expect(readRecords(b).baselinePoints[0]?.revisions).toHaveLength(1);
  });
});

describe("E6 — no baseline delete path in the data layer", () => {
  it("repository and writes export no delete for baseline points", () => {
    const names = [...Object.keys(repository), ...Object.keys(writes)];
    expect(names.filter((n) => /baseline/i.test(n) && /delete|purge|drop|erase/i.test(n))).toEqual(
      [],
    );
  });

  it("a removed point stays in the doc", () => {
    const p = point(2);
    const doc = new Y.Doc();
    doc.transact(() => addBaselinePointMutator(p)(doc));
    doc.transact(() => removeBaselinePointMutator(p, goal, "duplicate", asTimestamp(10))(doc));
    expect(readRecords(doc).baselinePoints).toHaveLength(1);
    expect(readRecords(doc).baselinePoints[0]?.status).toBe("removed");
  });
});

describe("legacy baseline points (stored before TEACH-46)", () => {
  it("read back as recorded with an empty revision list", () => {
    const { status: _s, revisions: _r, ...legacy } = point(3);
    expect(normalizeBaselinePoint(legacy)).toMatchObject({ status: "recorded", revisions: [] });
    const doc = new Y.Doc();
    doc.transact(() => upsertBaselinePoint(doc, legacy as BaselinePoint));
    expect(readRecords(doc).baselinePoints[0]).toMatchObject({
      status: "recorded",
      revisions: [],
    });
  });
});
