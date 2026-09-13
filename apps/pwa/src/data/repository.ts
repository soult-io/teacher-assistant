// Local doc repository — the (de)serialisation seam between the encrypted CRDT
// stream (@teacher-assistant/sync) and the typed domain entities the M3
// projections consume (@teacher-assistant/store). It holds NO domain rules: it
// only reads records out of / writes records into the Yjs doc. All monitoring
// math lives in the engine; the UI reads these records and calls the engine.
//
// Convention (inherited by U2–U6): each entity kind is a top-level Y.Map keyed
// by its opaque id → the whole entity object. Whole-entity values match the M1
// stream granularity (one Period-DEK doc per period); per-field CRDT merge is a
// later refinement, not needed for the single-writer synthetic seed.
//
// FERPA: the entities are plaintext IN MEMORY only. They reach disk exclusively
// as the stream's ciphertext snapshot/updates via the PersistenceAdapter
// (hard-stop #10/#11). This module never touches storage.

import type {
  ClassPeriod,
  IEPGoal,
  OpaqueId,
  ProbeDefinition,
  ProgressDataPoint,
  Student,
} from "@teacher-assistant/schema";
import type { Doc as YDoc } from "yjs";

const STUDENTS = "students";
const GOALS = "goals";
const POINTS = "points";
const PERIODS = "periods";
const PROBES = "probes";

/** The decrypted, in-memory record set read out of one stream's doc. */
export interface DecryptedRecords {
  readonly students: readonly Student[];
  readonly goals: readonly IEPGoal[];
  readonly points: readonly ProgressDataPoint[];
  /** ClassPeriod is a cleartext structural container (design §1.3); carried for the by-period lens. */
  readonly periods: readonly ClassPeriod[];
  /** The assigned probe per goal — expected denominator + condition (M5 mismatch/construct guard). */
  readonly probes: readonly ProbeDefinition[];
}

/** Read every record out of the doc as typed arrays (order is the doc's insertion order). */
export function readRecords(doc: YDoc): DecryptedRecords {
  return {
    students: [...doc.getMap<Student>(STUDENTS).values()],
    goals: [...doc.getMap<IEPGoal>(GOALS).values()],
    points: [...doc.getMap<ProgressDataPoint>(POINTS).values()],
    periods: [...doc.getMap<ClassPeriod>(PERIODS).values()],
    probes: [...doc.getMap<ProbeDefinition>(PROBES).values()],
  };
}

/** Upsert one monitoring point (M5 capture path). Keyed by opaque data_point_id. */
export function upsertPoint(doc: YDoc, point: ProgressDataPoint): void {
  doc.getMap<ProgressDataPoint>(POINTS).set(point.data_point_id, point);
}

/** Remove a monitoring point by id (e.g. un-bookmarking a score-later placeholder). */
export function deletePoint(doc: YDoc, dataPointId: OpaqueId): void {
  doc.getMap<ProgressDataPoint>(POINTS).delete(dataPointId);
}

/**
 * Write a record set into the doc, keyed by opaque id. Intended as the mutator
 * body of `SyncEngine.capture()` so the change is encrypted + persisted as
 * ciphertext; it must run inside a stream transaction, never against disk.
 */
export function writeRecords(doc: YDoc, records: DecryptedRecords): void {
  const students = doc.getMap<Student>(STUDENTS);
  for (const student of records.students) {
    students.set(student.student_id, student);
  }
  const goals = doc.getMap<IEPGoal>(GOALS);
  for (const goal of records.goals) {
    goals.set(goal.goal_id, goal);
  }
  const points = doc.getMap<ProgressDataPoint>(POINTS);
  for (const point of records.points) {
    points.set(point.data_point_id, point);
  }
  const periods = doc.getMap<ClassPeriod>(PERIODS);
  for (const period of records.periods) {
    periods.set(period.period_id, period);
  }
  const probes = doc.getMap<ProbeDefinition>(PROBES);
  for (const probe of records.probes) {
    probes.set(probe.probe_definition_id, probe);
  }
}

/** True when the doc holds no records yet (first run, before the synthetic seed). */
export function isEmpty(doc: YDoc): boolean {
  return (
    doc.getMap(STUDENTS).size === 0 && doc.getMap(GOALS).size === 0 && doc.getMap(POINTS).size === 0
  );
}
