// Pre-upload check: the output scan (pii-scan.mjs) over a Playwright output directory,
// run BEFORE e2e.yml uploads it as a PUBLIC Actions artifact. The dashboard build scans
// the same files again, but by then the artifact is already public.
//
// Fail-closed over the whole tree, not a list of known names: whatever Playwright writes
// (evidence, results.json, error-context.md page snapshots, stdout attachments) is read.
// - every *.zip: scanTraceZip (the text scan over its entries + the network-host check)
// - a video or still: skipped, pixels (their guard is the evidence origin stamp)
// - every other file: the text scan; a file with a NUL byte cannot be read as text, so it
//   is a finding, not skipped
// - an evidence file (*-evidence.json): its origin stamp must be the local build
// - a symlink: a finding (upload-artifact would follow it out of the directory)

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { checkRunOrigin } from "./ingest.mjs";
import { scanBuild } from "./pii-scan.mjs";

/** Pixels: no text scan can read them. */
const MEDIA = /\.(?:webm|mp4|png|jpe?g|webp|gif)$/i;
const EVIDENCE = /-evidence\.json$/;

/** @typedef {import("./pii-scan.mjs").Finding} Finding */

/**
 * The evidence file's origin stamp, as findings (none when it is the local build or the
 * file predates the stamp). The stamped value is never logged.
 */
function originFindings(text, file, expectedBaseURL) {
  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch {
    return [{ file, kind: "unreadable", location: "json" }];
  }
  try {
    checkRunOrigin(evidence, expectedBaseURL);
    return [];
  } catch {
    return [{ file, kind: "origin", location: "baseURL" }];
  }
}

/**
 * Scan every file under `dir`. File names in findings are relative to `dir`.
 * @param {string} dir
 * @param {{baseURL: string}} opts the only origin the run may have tested
 * @returns {{findings: Finding[], scanned: number, media: number}}
 */
export function scanArtifactDir(dir, { baseURL }) {
  const findings = [];
  const files = [];
  const traceZips = [];
  let media = 0;
  for (const rel of readdirSync(dir, { recursive: true })) {
    const path = join(dir, rel);
    const stat = lstatSync(path);
    if (stat.isDirectory()) continue;
    if (!stat.isFile()) {
      findings.push({ file: rel, kind: "unreadable", location: "not a regular file" });
      continue;
    }
    if (MEDIA.test(rel)) {
      media++;
      continue;
    }
    if (rel.endsWith(".zip")) {
      traceZips.push(path);
      continue;
    }
    const buf = readFileSync(path);
    if (buf.includes(0)) {
      findings.push({ file: rel, kind: "unreadable", location: "binary" });
      continue;
    }
    files.push(path);
    if (EVIDENCE.test(basename(rel))) {
      findings.push(...originFindings(buf.toString("utf8"), rel, baseURL));
    }
  }
  const scanned = scanBuild({ files, traceZips, allowedHost: new URL(baseURL).host }).map((f) => ({
    ...f,
    file: relative(dir, f.file),
  }));
  findings.push(...scanned);
  return { findings, scanned: files.length + traceZips.length, media };
}
