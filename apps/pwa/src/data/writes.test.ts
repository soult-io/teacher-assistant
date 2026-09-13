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
  completeQueuedMutator,
  editMutator,
  noDataMutator,
  scoreMutator,
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

  it("completeQueuedMutator replaces the placeholder with ONE scored point (no duplicate)", () => {
    const doc = new Y.Doc();
    doc.transact(() => bookmarkMutator(ctx())(doc));
    const queued = readRecords(doc).points[0];
    if (queued === undefined) {
      throw new Error("expected a queued point");
    }
    doc.transact(() =>
      completeQueuedMutator(
        queued,
        { numerator: 4, denominatorUsed: 5, expectedDenominator: 5 },
        asTimestamp(1),
      )(doc),
    );
    const points = readRecords(doc).points;
    expect(points).toHaveLength(1); // placeholder deleted → exactly one point
    expect(points[0]?.state).toBe("scored");
    expect(points[0]?.numerator).toBe(4);
    expect(points[0]?.admin_date).toBe(queued.admin_date); // keeps the collected date
  });

  it("completeQueuedMutator flags a denominator mismatch on the queued→scored point", () => {
    const doc = new Y.Doc();
    doc.transact(() => bookmarkMutator(ctx())(doc));
    const queued = readRecords(doc).points[0];
    if (queued === undefined) {
      throw new Error("expected a queued point");
    }
    doc.transact(() =>
      completeQueuedMutator(
        queued,
        { numerator: 3, denominatorUsed: 6, expectedDenominator: 5 },
        asTimestamp(1),
      )(doc),
    );
    const scored = readRecords(doc).points[0];
    expect(scored?.denominator_mismatch).toBe(true); // 6 ≠ 5 → flagged like the direct path
    expect(scored?.denominator_original).toBe(5);
  });

  it("editMutator [Fix] on a scored point retains the prior value as a revision (same id)", () => {
    const points = applyTo(
      scoreMutator({ ...ctx(), numerator: 3, denominatorUsed: 5, expectedDenominator: 5 }),
    );
    const original = points[0];
    if (original === undefined) {
      throw new Error("expected a scored point");
    }
    const doc = new Y.Doc();
    doc.transact(() => editMutator(original, { numerator: 5 }, asTimestamp(2))(doc));
    const fixed = readRecords(doc).points[0];
    expect(fixed?.data_point_id).toBe(original.data_point_id); // same id
    expect(fixed?.numerator).toBe(5);
    expect(fixed?.computed_value).toBe(1); // re-derived
    expect(fixed?.revisions).toHaveLength(1); // prior value retained
    expect(fixed?.revisions[0]?.old).toMatchObject({ numerator: 3 });
  });
});
