// @vitest-environment node
import {
  asTimestamp,
  type IsoDate,
  newOpaqueId,
  type ProgressDataPoint,
} from "@teacher-assistant/schema";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { readRecords } from "./repository.js";
import {
  bookmarkMutator,
  noDataMutator,
  scoreMutator,
  scoreQueuedMutator,
  unbookmarkMutator,
} from "./writes.js";

const ADMIN = "2026-09-14" as IsoDate;
const TS = asTimestamp(0);

function ctx() {
  return {
    goalId: newOpaqueId(),
    studentId: newOpaqueId(),
    adminDate: ADMIN,
    entryTs: TS,
    setting: "math_resource" as const,
  };
}

function applyTo(mutator: (doc: Y.Doc) => void): readonly ProgressDataPoint[] {
  const doc = new Y.Doc();
  doc.transact(() => mutator(doc));
  return readRecords(doc).points;
}

describe("write mutators (M5 capture path)", () => {
  it("scoreMutator writes a scored point with the computed value + mismatch flag", () => {
    const points = applyTo(
      scoreMutator({ ...ctx(), numerator: 3, denominatorUsed: 6, expectedDenominator: 5 }),
    );
    expect(points).toHaveLength(1);
    const p = points[0];
    expect(p?.state).toBe("scored");
    expect(p?.numerator).toBe(3);
    expect(p?.computed_value).toBe(0.5);
    // 6 ≠ expected 5 → flagged (never blocked), original retained.
    expect(p?.denominator_mismatch).toBe(true);
    expect(p?.denominator_original).toBe(5);
  });

  it("noDataMutator writes a ⊘ with the reason and NO numerator (never a zero)", () => {
    const points = applyTo(noDataMutator(ctx(), "absent"));
    const p = points[0];
    expect(p?.state).toBe("no_data");
    expect(p?.no_data_reason).toBe("absent");
    expect(p?.numerator).toBeUndefined();
    expect(p?.computed_value).toBeUndefined();
  });

  it("bookmarkMutator writes a queued placeholder; unbookmarkMutator removes it", () => {
    const doc = new Y.Doc();
    const context = ctx();
    doc.transact(() => bookmarkMutator(context)(doc));
    const queued = readRecords(doc).points[0];
    expect(queued?.state).toBe("queued");
    if (queued === undefined) {
      throw new Error("expected a queued point");
    }
    doc.transact(() => unbookmarkMutator(queued.data_point_id)(doc));
    expect(readRecords(doc).points).toHaveLength(0);
  });

  it("scoreQueuedMutator turns a queued point scored with an audit revision (same id)", () => {
    const doc = new Y.Doc();
    const context = ctx();
    doc.transact(() => bookmarkMutator(context)(doc));
    const queued = readRecords(doc).points[0];
    if (queued === undefined) {
      throw new Error("expected a queued point");
    }
    doc.transact(() =>
      scoreQueuedMutator(
        queued,
        { numerator: 4, denominatorUsed: 5, setting: "math_resource" },
        asTimestamp(1),
      )(doc),
    );
    const scored = readRecords(doc).points[0];
    expect(scored?.data_point_id).toBe(queued.data_point_id); // same id — not a new point
    expect(scored?.state).toBe("scored");
    expect(scored?.numerator).toBe(4);
    expect(scored?.revisions).toHaveLength(1); // audited, prior value retained
  });
});
