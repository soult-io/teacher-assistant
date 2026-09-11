// FERPA-guard check primitives (M14).
//
// Pure, dependency-free helpers that walk the repository source tree and assert
// privacy invariants mechanically. They are deliberately simple and fast so
// they can run on every PR (ferpa-guard.yml) as a hard gate. As feature code
// lands, add invariants to the test suite in ../test — this file only provides
// the primitives.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Recursively collect files under `dir` whose name matches `exts`. */
export function collectFiles(dir: string, exts: readonly string[]): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // dir absent (a service/package not yet scaffolded) — nothing to scan
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "dev-dist") {
      continue;
    }
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectFiles(full, exts));
    } else if (exts.some((e) => name.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

export interface PatternHit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** Return every line across `files` matching `pattern`. Empty = clean. */
export function scanForPattern(files: readonly string[], pattern: RegExp): PatternHit[] {
  const hits: PatternHit[] = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? "";
      // Fresh lastIndex each test — pattern may be /g.
      pattern.lastIndex = 0;
      if (pattern.test(text)) {
        hits.push({ file, line: i + 1, text: text.trim() });
      }
    }
  }
  return hits;
}

/** True if `file` contains `needle` (substring). */
export function fileContains(file: string, needle: string): boolean {
  try {
    return readFileSync(file, "utf8").includes(needle);
  } catch {
    return false;
  }
}
