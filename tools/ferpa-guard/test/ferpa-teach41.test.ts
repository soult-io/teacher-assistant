// FERPA-guard — TEACH-41 IEP goal label. The label ("Goal 2") is teacher-only goal
// content: it lives INSIDE the encrypted goal payload, never in the cleartext
// RecordEnvelope / sync protocol / server, never on the para path, and is never
// logged. Behavioural (the sealed blob) + static (source scans).

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMasterKey, sodiumReady, TeacherKeyring, utf8 } from "@teacher-assistant/crypto";
import {
  asTimestamp,
  newOpaqueId,
  newScopeTag,
  type RecordEnvelope,
} from "@teacher-assistant/schema";
import { beforeAll, describe, expect, it } from "vitest";
import { collectFiles, scanCodeForPattern } from "../src/checks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LABEL_FIELD = /\bgoal_label\b|\bgoalLabel\b/;

/** True if `needle`'s bytes appear as a contiguous run inside `haystack`. */
function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return true;
  }
  return false;
}

beforeAll(async () => {
  await sodiumReady();
});

describe("TEACH-41 — the IEP goal label is encrypted goal content", () => {
  it("a sealed goal carrying a label never contains the label in its bytes or envelope", () => {
    const scope = newScopeTag();
    const teacher = new TeacherKeyring(scope, generateMasterKey());
    const envelope: RecordEnvelope = {
      record_id: newOpaqueId(),
      record_type: "goal",
      scope_tag: scope,
      crdt_version: {},
      created_ts: asTimestamp(0),
      updated_ts: asTimestamp(0),
      size: 0,
      deleted: false,
    };
    // A distinctive synthetic label so a chance byte match is negligible.
    const payload = utf8(JSON.stringify({ goal_text: "synthetic", goal_label: "q7.Zx" }));
    const blob = teacher.encryptRecord(envelope, payload);
    expect(containsBytes(blob, utf8('"goal_label":"q7.Zx"'))).toBe(false);
    expect(containsBytes(blob, utf8("q7.Zx"))).toBe(false);
    expect(JSON.stringify(envelope)).not.toMatch(LABEL_FIELD);
  });

  it("no cleartext surface names the label: envelope/sync protocol, sync, crypto, server", () => {
    const files = [
      join(repoRoot, "packages", "schema", "src", "classification.ts"),
      join(repoRoot, "packages", "schema", "src", "sync-protocol.ts"),
      ...collectFiles(join(repoRoot, "packages", "sync", "src"), [".ts"]),
      ...collectFiles(join(repoRoot, "packages", "crypto", "src"), [".ts"]),
      ...collectFiles(join(repoRoot, "services"), [".ts"]),
    ].filter((f) => !f.endsWith(".test.ts"));
    const hits = scanCodeForPattern(files, LABEL_FIELD);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it("the para path never reads the label (projection, publish, para order, para screens)", () => {
    const files = [
      join(repoRoot, "packages", "store", "src", "para-projection.ts"),
      join(repoRoot, "apps", "pwa", "src", "data", "para-publish.ts"),
      join(repoRoot, "apps", "pwa", "src", "app", "screens", "para", "para-order.ts"),
      join(repoRoot, "apps", "pwa", "src", "app", "screens", "para", "ParaScreen.tsx"),
      join(repoRoot, "apps", "pwa", "src", "app", "screens", "para", "ParaCaptureSheet.tsx"),
      join(repoRoot, "packages", "domain-core", "src", "para-capture.ts"),
      join(repoRoot, "packages", "domain-core", "src", "para-administer-label.ts"),
    ];
    const hits = scanCodeForPattern(files, LABEL_FIELD);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  it("no file that handles the label logs anything", () => {
    const sources = [
      ...collectFiles(join(repoRoot, "apps", "pwa", "src"), [".ts", ".tsx"]),
      ...collectFiles(join(repoRoot, "packages", "domain-core", "src"), [".ts"]),
    ].filter((f) => !/\.test\.tsx?$/.test(f));
    const labelFiles = scanCodeForPattern(sources, LABEL_FIELD).map((h) => h.file);
    expect(labelFiles.length).toBeGreaterThan(0); // sanity: the scan sees the label code
    const logs = scanCodeForPattern([...new Set(labelFiles)], /\bconsole\.\w+\(/);
    expect(logs, JSON.stringify(logs, null, 2)).toEqual([]);
  });

  it("never on MYP / Toddle (Engine B): no MYP record or Toddle surface names the label", () => {
    // Engine B is physically separate (data-model §8). The MYP record shapes must not
    // carry the IEP goal #, and any MYP/Toddle module (none exist yet) must not read it.
    const entities = readFileSync(
      join(repoRoot, "packages", "schema", "src", "entities.ts"),
      "utf8",
    );
    const mypBlocks = entities.match(/export interface MYP\w+ \{[\s\S]*?\n\}/g) ?? [];
    expect(mypBlocks.length).toBeGreaterThan(0); // sanity: the MYP shapes were found
    for (const block of mypBlocks) {
      expect(block).not.toMatch(LABEL_FIELD);
    }
    const engineB = [
      ...collectFiles(join(repoRoot, "apps"), [".ts", ".tsx"]),
      ...collectFiles(join(repoRoot, "packages"), [".ts"]),
      ...collectFiles(join(repoRoot, "services"), [".ts"]),
    ].filter((f) => /myp|toddle/i.test(f.slice(repoRoot.length)));
    const hits = scanCodeForPattern(engineB, LABEL_FIELD);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });
});
