import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collectFiles, fileContains, scanCodeForPattern, scanForPattern } from "../src/checks.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// All TypeScript source that could conceivably reach a runtime log, URL, or the
// client bundle. As new apps/services/packages are added, they are picked up
// automatically (collectFiles tolerates absent dirs).
const sourceDirs = [join(repoRoot, "services"), join(repoRoot, "apps"), join(repoRoot, "packages")];
const sourceFiles = sourceDirs.flatMap((d) => collectFiles(d, [".ts", ".tsx"]));

describe("FERPA-guard (M14) — enforced from day one", () => {
  it("finds source to scan (sanity: the scaffold is present)", () => {
    expect(sourceFiles.length).toBeGreaterThan(0);
  });

  // Item-2d defense in depth: localeCompare is banned fleet-wide by the biome
  // GritQL plugin; assert it here too so a privacy-relevant ordering never
  // silently varies by host locale.
  it("Item-2d: no String.prototype.localeCompare in source", () => {
    const hits = scanForPattern(sourceFiles, /\.localeCompare\s*\(/);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  // FERPA egress (M10/M11): the ONLY external-egress component must not log
  // prompt/response bodies. Guard the structural setting that enforces it.
  it("de-id egress: diff-orchestrator disables request-body logging", () => {
    const f = join(repoRoot, "services", "diff-orchestrator", "src", "index.ts");
    expect(existsSync(f)).toBe(true);
    expect(fileContains(f, "disableRequestLogging: true")).toBe(true);
  });

  // Architecture §1.3/§1.5: the sync-relay never decrypts. It must not depend on
  // the crypto package at all — decryption is exclusively client-side.
  it("no-decrypt: sync-relay does not import @teacher-assistant/crypto", () => {
    const relayFiles = collectFiles(join(repoRoot, "services", "sync-relay"), [".ts"]);
    // Comment-stripped: a comment that merely explains the rule must not trip it.
    const hits = scanCodeForPattern(relayFiles, /@teacher-assistant\/crypto/);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  // H-PUB-2 + FERPA cache boundary (D1 / Item-2a). The PWA service worker is the
  // one place an HTTP response could be cached, so the privacy invariant is
  // enforced right here: the SW caches ONLY the shell + build assets, and the app
  // -shell update path (a deploy must reach a returning online visitor) is present.
  const swFile = join(repoRoot, "apps", "pwa", "src", "sw.ts");

  it("H-PUB-2: the PWA service worker ships the app-shell update path", () => {
    expect(existsSync(swFile), "apps/pwa/src/sw.ts must exist").toBe(true);
    // NetworkFirst navigations (fresh shell online) + prompt takeover so a deploy
    // reaches a returning visitor on a normal reload, not only after unregister.
    for (const token of [
      "NavigationRoute",
      "NetworkFirst",
      "skipWaiting",
      "clientsClaim",
      "cleanupOutdatedCaches",
    ]) {
      expect(fileContains(swFile, token), `sw.ts must use ${token}`).toBe(true);
    }
  });

  it("Item-2a: the service worker HTTP-caches no data endpoint", () => {
    // No runtime cache in the SW code can ever match a data endpoint, so
    // student-linked data stays server-uncached, served only from the local
    // encrypted store. API fetches are not navigations, so the shell route misses
    // them and they always reach the network uncached. Comment-stripped: a comment
    // that merely explains which endpoints are excluded must not trip the rule.
    const hits = scanCodeForPattern([swFile], /\/(sync|reference|differentiate)\b/);
    expect(hits, JSON.stringify(hits, null, 2)).toEqual([]);
  });

  // Extensible slot — banned identity tokens that must never appear in source.
  // The concrete list grows with the data-model (real student initials/goal
  // fixtures live only in gitignored test data, never in source).
  it("Item-2d: no banned identity tokens in source", () => {
    const bannedTokens: RegExp[] = [
      // e.g. /studentName/ , /\bSSN\b/ — added as the schema lands.
    ];
    for (const pattern of bannedTokens) {
      expect(scanForPattern(sourceFiles, pattern)).toEqual([]);
    }
  });
});
