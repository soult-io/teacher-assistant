// Pre-upload gate for e2e.yml: scan a Playwright output directory before it becomes a
// PUBLIC Actions artifact (engine/artifact-scan.mjs). Exit 1 on any finding, so the
// upload step after it does not run. The log names file + pattern type + location only
// — never the matched value (the Actions log is public too).
//
// Usage: node src/scan-artifacts.mjs <dir>
// A missing directory (the run died before writing any) has nothing to upload: exit 0.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { scanArtifactDir } from "../engine/artifact-scan.mjs";
import { formatFindings } from "../engine/pii-scan.mjs";
import { evidenceBaseURL } from "../config/teacher-assistant/index.mjs";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: scan-artifacts <dir>");
  process.exit(2);
}
const dir = resolve(arg);
if (!existsSync(dir)) {
  console.log(`scan-artifacts: ${arg} does not exist — nothing to upload`);
  process.exit(0);
}

let result;
try {
  result = scanArtifactDir(dir, { baseURL: evidenceBaseURL });
} catch (err) {
  // An error message could quote file content; say only that the scan did not finish.
  console.error(
    `scan-artifacts: ${arg} could not be scanned (${err?.code ?? "error"}) — refusing the upload`,
  );
  process.exit(1);
}
const { findings, scanned, media } = result;
if (findings.length > 0) {
  // An annotation on the run page: a refused walkthrough upload fails only a non-gating
  // job, which a green run would otherwise hide.
  if (process.env.GITHUB_ACTIONS) {
    console.log(
      `::error title=Student-data scan refused an upload::${arg}: ${findings.length} finding(s) — the artifact was not uploaded`,
    );
  }
  console.error(
    `scan-artifacts: ${arg} refused — ${findings.length} finding(s) (values not logged):\n${formatFindings(findings)}`,
  );
  process.exit(1);
}
console.log(
  `scan-artifacts: ${arg} clean — ${scanned} file(s) scanned, ${media} video/still(s) not text-scanned`,
);
