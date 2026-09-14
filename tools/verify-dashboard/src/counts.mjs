// Live test counts. Runs each tested workspace's vitest with the JSON reporter
// and reduces the report through lib.parseVitestReport. Assumes `pnpm -r run
// build` has already run (cross-package imports resolve to dist), which the
// workflow does before invoking the generator.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseVitestReport } from "./lib.mjs";

// The nine tested packages, in the display order used as a stable fallback (the
// bars are re-sorted by pass count at render time). content-api and
// diff-orchestrator are scaffolds with no tests and are intentionally absent.
export const PACKAGES = [
  {
    name: "@teacher-assistant/domain-core",
    label: "domain-core",
    sub: "the honesty engine",
    barClass: "eng",
  },
  { name: "@teacher-assistant/pwa", label: "apps/pwa", sub: "the UI, U1–U7", barClass: "ui" },
  {
    name: "@teacher-assistant/ferpa-guard",
    label: "ferpa-guard",
    sub: "privacy CI",
    barClass: "guard",
  },
  { name: "@teacher-assistant/store", label: "store", sub: "projections" },
  { name: "@teacher-assistant/crypto", label: "crypto", sub: "keyring / DEK" },
  { name: "@teacher-assistant/auth", label: "auth", sub: "passkey unlock" },
  { name: "@teacher-assistant/schema", label: "schema", sub: "entities" },
  { name: "@teacher-assistant/sync", label: "sync", sub: "relay client" },
  { name: "@teacher-assistant/sync-relay", label: "sync-relay", sub: "service" },
];

// ferpa-guard's pass count is surfaced on its own tile.
export const FERPA_PACKAGE = "@teacher-assistant/ferpa-guard";

function runVitest(repoRoot, pkgName, outFile) {
  rmSync(outFile, { force: true });
  try {
    execFileSync(
      "pnpm",
      ["--filter", pkgName, "exec", "vitest", "run", "--reporter=json", `--outputFile=${outFile}`],
      { cwd: repoRoot, stdio: "ignore" },
    );
  } catch {
    // vitest exits non-zero when tests fail; it still writes the JSON, and the
    // failing count is the truth the board should show. Read the file regardless.
  }
  // Every package in PACKAGES has tests, so a missing or unparseable report is a
  // broken run, not a zero-test package — fail loud rather than silently drop it
  // from the total (the generator's whole ethos is loud failure over silent zeros).
  if (!existsSync(outFile)) {
    throw new Error(`vitest wrote no JSON report for ${pkgName} (${outFile})`);
  }
  try {
    return parseVitestReport(JSON.parse(readFileSync(outFile, "utf8")));
  } catch (err) {
    throw new Error(`could not parse vitest report for ${pkgName}: ${err.message}`);
  }
}

/** Run every tested package and return its config plus live pass/file counts. */
export function collectPackageCounts(repoRoot, tmpDir) {
  mkdirSync(tmpDir, { recursive: true });
  return PACKAGES.map((pkg) => {
    const outFile = join(tmpDir, `${pkg.label.replace(/\W/g, "-")}.json`);
    const { pass, files } = runVitest(repoRoot, pkg.name, outFile);
    return { ...pkg, pass, files };
  });
}

/** Count Playwright tests via `playwright test --list` (no browser launched). */
export function collectE2eCount(repoRoot) {
  try {
    const out = execFileSync(
      "pnpm",
      ["--filter", "@teacher-assistant/e2e", "exec", "playwright", "test", "--list"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const match = out.match(/Total:\s+(\d+)\s+test/);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}
