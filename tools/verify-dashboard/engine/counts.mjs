// Live test counts (engine mechanics). Runs each configured workspace's vitest with
// the JSON reporter and reduces the report to pass/file figures. Product-agnostic:
// the package LIST comes from config; this only knows how to run vitest and read its
// report. Assumes `pnpm -r run build` has run (cross-package imports resolve to dist),
// which the workflow does before invoking the generator.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { JOURNEY_STATUS } from "./model.mjs";

/**
 * Reduce one package's vitest JSON report to the two figures the board shows.
 * `numPassedTests` is the pass count; `testResults.length` is the number of test
 * FILES (jest-compatible `numTotalTestSuites` counts describe blocks, not files).
 */
export function parseVitestReport(report) {
  const pass = Number.isFinite(report?.numPassedTests) ? report.numPassedTests : 0;
  const files = Array.isArray(report?.testResults) ? report.testResults.length : 0;
  return { pass, files };
}

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
  // Every configured package has tests, so a missing/unparseable report is a broken
  // run, not a zero-test package — fail loud rather than silently drop it from the
  // total (the generator's ethos is loud failure over silent zeros).
  if (!existsSync(outFile)) {
    throw new Error(`vitest wrote no JSON report for ${pkgName} (${outFile})`);
  }
  try {
    return parseVitestReport(JSON.parse(readFileSync(outFile, "utf8")));
  } catch (err) {
    throw new Error(`could not parse vitest report for ${pkgName}: ${err.message}`);
  }
}

/**
 * Run every configured package and return its config plus live pass/file counts.
 * @param {string} repoRoot
 * @param {string} tmpDir
 * @param {{name: string, label: string}[]} packages
 */
export function collectPackageCounts(repoRoot, tmpDir, packages) {
  mkdirSync(tmpDir, { recursive: true });
  return packages.map((pkg) => {
    const outFile = join(tmpDir, `${pkg.label.replace(/\W/g, "-")}.json`);
    const { pass, files } = runVitest(repoRoot, pkg.name, outFile);
    return { ...pkg, pass, files };
  });
}

/**
 * Derive the e2e tile figure from the ingested journeys — the SAME source the journey
 * cards render from, so the tile can never contradict the cards, and the generator
 * needs no browser or Playwright CLI at generate time.
 *
 * A journey with any non-UNVERIFIED status (passed/failed/flaky/skipped) is bound to a
 * real run and is counted — it is a check the run produced. UNVERIFIED journeys have no
 * run and are not counted.
 *
 * Returns null when NO journey is verified (no evidence / no run bound → every card
 * UNVERIFIED). The tile then degrades honestly to a dash, matching the cards, rather
 * than asserting a real "0 checks ran" — loud/honest failure over a silent zero.
 * @param {{status: string}[]} journeys
 * @returns {number|null}
 */
export function deriveE2eCount(journeys) {
  if (!Array.isArray(journeys)) return null;
  const verified = journeys.filter(
    (j) => j?.status && j.status !== JOURNEY_STATUS.UNVERIFIED,
  ).length;
  return verified > 0 ? verified : null;
}
