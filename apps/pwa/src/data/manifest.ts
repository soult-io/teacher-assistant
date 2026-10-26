// The master-doc maps (device-enrollment-spec rev 2.5 §3.3; co-owned with
// data-model-integration). They live in the MASTER doc, so they are encrypted under MK
// like every other master record and reach the relay only as master ciphertext:
//
//   - streams:     { [periodScopeTag]: { paraDocId, periodId, retired } } — the manifest a
//                  teacher device reads to find the para docs;
//   - period_keys: { [periodScopeTag]: AEAD_MK(dek, aad = scopeTag) } — period DEKs wrapped
//                  under MK, so a teacher device rebuilds its full keyring from master;
//   - devices:     { [signPk]: { label, role, enrolledAt } } — the device names. A label
//                  lives ONLY here (never in a relay body, never in the DeviceRecord).
//
// Same convention as repository.ts: one top-level Y.Map per kind, keyed by its id, the
// whole entry as the value. This module holds no key: it stores the wrapped DEK bytes the
// keyring produced (base64) and hands them back.

import type { OpaqueId, ScopeTag, Timestamp } from "@teacher-assistant/schema";
import type { Doc as YDoc } from "yjs";

const STREAMS = "streams";
const PERIOD_KEYS = "period_keys";
const DEVICES = "devices";

/** One para stream: its doc, the period it serves (null until the caseload has one), and whether it is retired. */
export interface StreamEntry {
  readonly paraDocId: OpaqueId;
  readonly periodId: OpaqueId | null;
  readonly retired: boolean;
}

/** A device the teacher enrolled, by its name from the fixed list. */
export interface DeviceEntry {
  readonly label: string;
  readonly role: "teacher" | "para";
  readonly enrolledAt: Timestamp;
}

export interface Manifest {
  readonly streams: ReadonlyMap<ScopeTag, StreamEntry>;
  /** Base64 of `TeacherKeyring.wrapScopeKeyUnderMaster(tag)`. */
  readonly periodKeys: ReadonlyMap<ScopeTag, string>;
  /** Keyed by the device's signing public key (base64url). */
  readonly devices: ReadonlyMap<string, DeviceEntry>;
}

function entries<T>(doc: YDoc, name: string): Map<string, T> {
  return new Map(doc.getMap<T>(name).entries());
}

export function readManifest(doc: YDoc): Manifest {
  return {
    streams: entries<StreamEntry>(doc, STREAMS) as Map<ScopeTag, StreamEntry>,
    periodKeys: entries<string>(doc, PERIOD_KEYS) as Map<ScopeTag, string>,
    devices: entries<DeviceEntry>(doc, DEVICES),
  };
}

/** The para stream the session opens: the first one not retired (one period has a para today). */
export function activeStream(
  manifest: Manifest,
): { readonly scopeTag: ScopeTag; readonly entry: StreamEntry } | null {
  for (const [scopeTag, entry] of manifest.streams) {
    if (!entry.retired) {
      return { scopeTag, entry };
    }
  }
  return null;
}

/** Register a para stream and its MK-wrapped DEK. */
export function addStream(
  doc: YDoc,
  scopeTag: ScopeTag,
  entry: StreamEntry,
  wrappedDekB64: string,
): void {
  doc.getMap<string>(PERIOD_KEYS).set(scopeTag, wrappedDekB64);
  doc.getMap<StreamEntry>(STREAMS).set(scopeTag, entry);
}

/** Record a device by its signing key. */
export function addDevice(doc: YDoc, signPkB64: string, entry: DeviceEntry): void {
  doc.getMap<DeviceEntry>(DEVICES).set(signPkB64, entry);
}
