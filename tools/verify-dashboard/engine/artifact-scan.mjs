// Pre-upload check: the output scan (pii-scan.mjs) over a Playwright output directory,
// run BEFORE e2e.yml uploads it as a PUBLIC Actions artifact. The dashboard build scans
// the same files again, but by then the artifact is already public.
//
// Fail-closed over the whole tree, not a list of known names: whatever Playwright writes
// (evidence, results.json, error-context.md page snapshots, stdout attachments) is read.
// - every *.zip: scanTraceZip (the text scan over its entries + the network-host check)
// - a video or still: skipped as pixels, but only when its leading bytes say it is one
//   (a text file named x.png is a finding); their guard is the origin stamp + the trace
//   network check (pii-scan.mjs header)
// - every other file: the text scan; a file that is not UTF-8 text is a finding
// - every *.json: base64 bodies inside it (the JSON reporter's inline attachments and
//   non-text stdout) are decoded and scanned too. (This is deliberately wider than the
//   dashboard build's scan: results.json is never copied into the page, and these same
//   bytes were scanned here before they were uploaded.) Not decoded: base64 inside
//   data: URLs in trace snapshots or page text.
// - an evidence file (*-evidence.json): must carry the local origin stamp. This run wrote
//   it, so an unstamped (pre-v4) file is a finding too
// - a symlink or special file: a finding (upload-artifact would follow a link out)

import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { checkRunOrigin } from "./ingest.mjs";
import { decodeText, isKnownMedia, scanText, scanTraceZip } from "./pii-scan.mjs";

const MEDIA = /\.(?:webm|mp4|png|jpe?g|webp|gif)$/i;
const EVIDENCE = /-evidence\.json$/;
/** Enough leading bytes for every signature isKnownMedia checks. */
const MAGIC_BYTES = 16;

/** @typedef {import("./pii-scan.mjs").Finding} Finding */

function leadingBytes(path) {
  const buf = Buffer.alloc(MAGIC_BYTES);
  const fd = openSync(path, "r");
  try {
    return buf.subarray(0, readSync(fd, buf, 0, MAGIC_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/** The evidence file's origin stamp, as findings. The stamped value is never logged. */
function originFindings(json, file, expectedBaseURL) {
  try {
    if (checkRunOrigin(json, expectedBaseURL)) return [];
  } catch {
    // Stamped with another origin: fall through.
  }
  return [{ file, kind: "origin", location: "baseURL" }];
}

/** Is `node[key]` a base64 body: an attachment `body` beside its `contentType`, or a
 * stdout/stderr `buffer`? */
function isBase64Field(node, key) {
  if (typeof node[key] !== "string") return false;
  return (key === "body" && "contentType" in node) || key === "buffer";
}

/** Decoded text is scanned; decoded binary must be an image. */
function decodedFindings(value, file, at) {
  const data = Buffer.from(value, "base64");
  const text = decodeText(data);
  if (text !== null) return scanText(text, file, `${at}:`);
  return isKnownMedia(data) ? [] : [{ file, kind: "unreadable", location: at }];
}

/** The JSON reporter's own keys. Any other key on a path may come from data, so the
 * logged location shows `?` in its place. */
const SCHEMA_KEYS = new Set(
  "suites specs tests results attachments stdout stderr errors steps body buffer".split(" "),
);
const pathKey = (key) => (SCHEMA_KEYS.has(key) ? key : "?");

/**
 * Findings in the base64 bodies of a JSON document (the JSON reporter's inline
 * attachments and non-text stdout), at their JSON path.
 */
function base64Findings(node, file, path = "$") {
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => base64Findings(v, file, `${path}[${i}]`));
  }
  if (node === null || typeof node !== "object") return [];
  return Object.keys(node).flatMap((key) =>
    isBase64Field(node, key)
      ? decodedFindings(node[key], file, `${path}.${pathKey(key)}`)
      : base64Findings(node[key], file, `${path}.${pathKey(key)}`),
  );
}

/** Findings for one text file: the text scan, plus the JSON checks for a *.json. */
function textFileFindings(text, rel, baseURL) {
  const findings = scanText(text, rel);
  if (!rel.endsWith(".json")) return findings;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // An evidence file must be read to check its stamp; any other .json was text-scanned.
    if (EVIDENCE.test(rel)) findings.push({ file: rel, kind: "unreadable", location: "json" });
    return findings;
  }
  findings.push(...base64Findings(json, rel));
  if (EVIDENCE.test(rel)) findings.push(...originFindings(json, rel, baseURL));
  return findings;
}

/**
 * Scan every file under `dir`. File names in findings are relative to `dir`.
 * @param {string} dir
 * @param {{baseURL: string}} opts the only origin the run may have tested
 * @returns {{findings: Finding[], scanned: number, media: number}}
 */
export function scanArtifactDir(dir, { baseURL }) {
  const allowedHost = new URL(baseURL).host;
  const findings = [];
  let scanned = 0;
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
      if (isKnownMedia(leadingBytes(path))) media++;
      else findings.push({ file: rel, kind: "unreadable", location: "not the media it is named" });
      continue;
    }
    scanned++;
    const buf = readFileSync(path);
    if (rel.endsWith(".zip")) {
      findings.push(...scanTraceZip(buf, rel, allowedHost));
      continue;
    }
    const text = decodeText(buf);
    if (text === null) findings.push({ file: rel, kind: "unreadable", location: "not UTF-8 text" });
    else findings.push(...textFileFindings(text, rel, baseURL));
  }
  return { findings, scanned, media };
}
