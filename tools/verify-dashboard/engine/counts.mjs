// Live test counts (engine mechanics). Runs each configured workspace's vitest with
// the JSON reporter and reduces the report to pass/file figures. Product-agnostic:
// the package LIST comes from config; this only knows how to run vitest and read its
// report. Assumes `pnpm -r run build` has run (cross-package imports resolve to dist),
// which the workflow does before invoking the generator.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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
 * Count e2e tests via `playwright test --list` (no browser launched).
 * @param {string} repoRoot
 * @param {string} e2ePackage workspace name, from config
 */
export function collectE2eCount(repoRoot, e2ePackage) {
  try {
    const out = execFileSync(
      "pnpm",
      ["--filter", e2ePackage, "exec", "playwright", "test", "--list"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    const match = out.match(/Total:\s+(\d+)\s+test/);
    // A regex miss means the CLI output format changed — warn rather than silently
    // zero the e2e tile (a CI-only degrade, so 0 not a throw, but never silent).
    if (!match) console.warn("  counts: could not parse `playwright test --list` total; using 0");
    return match ? Number(match[1]) : 0;
  } catch (err) {
    console.warn(`  counts: e2e count unavailable (${err.message}); using 0`);
    return 0;
  }
}
