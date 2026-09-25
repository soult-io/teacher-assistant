// Output check: the last gate before the dashboard is written. The image it lands in
// (ghcr.io/soult-io/teacher-assistant-verify) and the Actions artifacts are PUBLIC, so
// everything the page is built from is scanned for student-data shapes, and every
// trace.zip's network log must show only the local synthetic build.
//
// The inputs are synthetic by construction (the PWA's synthetic seed, run against the
// local vite preview). This is defence in depth for the accidental case — a real value
// in a test, a run pointed at a live URL. A hit refuses the whole build.
//
// The logs of a public Actions run are public too: a finding records the file, the
// pattern type and the location — NEVER the matched value.
//
// Not covered here: videos and stills (pixels). Their guard is the origin stamp
// (checkRunOrigin in ingest.mjs); the gating run's own traces back it at network level.
// The walkthrough records no trace, so its videos rest on the stamp and on the gating
// run tracing the same journeys.
//
// Deliberately NOT scanned: a name blocklist (student initials are the only identity
// the app holds) and bare digit runs as student IDs (they collide with timestamps,
// durations and sizes).

import { readFileSync } from "node:fs";
import { readZipEntries } from "./zip.mjs";

/** RFC 2606 / RFC 6761 names that can never resolve to a real server. */
const UNRESOLVABLE_TLDS = [".test", ".example", ".invalid"];
/** Reserved names never counted as a real address (`.localhost` resolves, locally). */
const RESERVED_TLDS = [...UNRESOLVABLE_TLDS, ".localhost"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
// A match whose "TLD" is a file extension is a file name, not an address — Playwright
// names every screencast frame `page@<id>-<time>.jpeg`, and assets go `icon@2x.png`.
// Never a real TLD (`.zip` is one, so it is not listed).
const FILE_EXTENSIONS = new Set(
  "jpeg jpg png webp gif svg ico webm mp4 js mjs cjs ts tsx css map json html woff woff2 ttf".split(
    " ",
  ),
);

// Bounded, unambiguous (a dot only as a label separator) so matching stays linear on
// untrusted input. Group 1 is the domain.
const EMAIL_RE = /[a-z0-9._%+-]{1,64}@([a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63}){0,9}\.[a-z]{2,24})\b/gi;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

// A student's initials: two or three capital letters, nothing else. An empty string
// (a blank form's default) holds no student data.
const INITIALS_OK = /^(?:[A-Z]{2,3})?$/;
// A quoted `initials` key (JSON, or JSON escaped inside a JSON string: group 1 is the
// escape run, bounded so a long backslash run stays linear). Its value must be a string
// of the same escape level, or it is a finding.
const INITIALS_JSON_KEY = /(\\{0,15})"initials\1"\s*:\s*/g;
// Deeper than that bound (5+ levels of JSON-in-JSON) the key is not read: a finding.
const INITIALS_TOO_DEEP = /\\{16}"initials/g;
// A bare key with a string literal (a JS bundle or test source): `initials: "AB"`.
const INITIALS_JS_KEY = /(?<![\w$"'\\])initials\s*:\s*(["'`])(.*?)\1/g;

// Trace entries that are always text: a NUL byte in one makes it unreadable, not binary.
const TEXT_ENTRY = /(?:\.(?:trace|network|stacks)$|^src\/)/;

/** @typedef {"email"|"ssn"|"phone"|"initials"|"network-host"|"unreadable"} FindingKind */
/** @typedef {{file: string, kind: FindingKind, location: string}} Finding */

function isUnresolvableHost(hostname) {
  const h = hostname.toLowerCase();
  return UNRESOLVABLE_TLDS.some((tld) => h.endsWith(tld));
}

function isReservedDomain(domain) {
  const d = domain.toLowerCase();
  return (
    FILE_EXTENSIONS.has(d.slice(d.lastIndexOf(".") + 1)) ||
    RESERVED_DOMAINS.includes(d) ||
    RESERVED_DOMAINS.some((r) => d.endsWith(`.${r}`)) ||
    RESERVED_TLDS.some((tld) => d.endsWith(tld))
  );
}

/** The string value after a quoted `initials` key, or null when it is not a string. */
function jsonStringAt(text, at, esc) {
  const quote = `${esc}"`;
  if (!text.startsWith(quote, at)) return null;
  const end = text.indexOf(quote, at + quote.length);
  return end < 0 ? null : text.slice(at + quote.length, end);
}

/** Offsets of every PII-shaped value in the text, by kind. */
function matchOffsets(text) {
  const hits = [];
  for (const m of text.matchAll(EMAIL_RE)) {
    if (!isReservedDomain(m[1])) hits.push({ kind: "email", index: m.index });
  }
  for (const m of text.matchAll(SSN_RE)) hits.push({ kind: "ssn", index: m.index });
  for (const m of text.matchAll(PHONE_RE)) hits.push({ kind: "phone", index: m.index });
  for (const m of text.matchAll(INITIALS_JSON_KEY)) {
    const value = jsonStringAt(text, m.index + m[0].length, m[1]);
    if (value === null || !INITIALS_OK.test(value)) hits.push({ kind: "initials", index: m.index });
  }
  for (const m of text.matchAll(INITIALS_TOO_DEEP)) hits.push({ kind: "initials", index: m.index });
  for (const m of text.matchAll(INITIALS_JS_KEY)) {
    if (!INITIALS_OK.test(m[2])) hits.push({ kind: "initials", index: m.index });
  }
  return hits.sort((a, b) => a.index - b.index);
}

/** 1-based line:col of an offset. */
function lineCol(text, index) {
  let line = 1;
  let lineStart = 0;
  for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return `${line}:${index - lineStart + 1}`;
}

/**
 * Findings for one text. `where` prefixes the location (a zip entry name).
 * @returns {Finding[]}
 */
export function scanText(text, file, where = "") {
  return matchOffsets(text).map((h) => ({
    file,
    kind: h.kind,
    location: `${where}${lineCol(text, h.index)}`,
  }));
}

/**
 * The entry as text, or null for a binary entry (an image, a font: any NUL byte, which
 * also rules out UTF-16 text). Decoded lossily, so a Latin-1 resource is still scanned.
 */
function asText(data) {
  return data.includes(0) ? null : data.toString("utf8");
}

/** Does a network-log URL stay local: the allowed host:port, an unresolvable name, or
 * no host at all (data:, about:)? A protocol it does not know is not local. */
function isLocalRequest(raw, allowedHost) {
  const url = new URL(raw);
  if (url.protocol === "blob:") return isLocalRequest(url.pathname, allowedHost);
  if (url.protocol === "data:" || url.protocol === "about:") return true;
  if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
  return url.host === allowedHost || isUnresolvableHost(url.hostname);
}

/**
 * Every request in a `*.network` entry must go to the allowed host — or to a reserved
 * name that cannot resolve (a test fulfils synthetic pages on `http://overlay.test`
 * through a route, so nothing leaves the runner).
 */
function scanNetwork(text, file, entry, allowedHost) {
  const findings = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const location = `${entry}:${i + 1}`;
    let url;
    try {
      url = JSON.parse(line)?.snapshot?.request?.url;
      if (typeof url !== "string") throw new Error("no request url");
      new URL(url);
    } catch {
      // A line we cannot read cannot be shown to be local.
      findings.push({ file, kind: "unreadable", location });
      return;
    }
    let local;
    try {
      local = isLocalRequest(url, allowedHost);
    } catch {
      // e.g. `blob:null/<id>`: no origin to check. Caught so the URL never reaches a log.
      local = false;
    }
    if (!local) findings.push({ file, kind: "network-host", location });
  });
  return findings;
}

/**
 * Findings for one trace.zip: the text scan over every text entry, and the host check
 * over every `*.network` entry.
 * @param {Buffer} buf
 * @param {string} file
 * @param {string} allowedHost the only host:port the run may have reached
 * @returns {Finding[]}
 */
export function scanTraceZip(buf, file, allowedHost) {
  let entries;
  try {
    entries = readZipEntries(buf);
  } catch {
    return [{ file, kind: "unreadable", location: "archive" }];
  }
  const findings = [];
  for (const { name, data } of entries) {
    const text = asText(data);
    if (text === null) {
      // A trace's own logs are never skipped as binary: unreadable, not clean.
      if (TEXT_ENTRY.test(name)) findings.push({ file, kind: "unreadable", location: name });
      continue;
    }
    if (name.endsWith(".network")) findings.push(...scanNetwork(text, file, name, allowedHost));
    findings.push(...scanText(text, file, `${name}:`));
  }
  return findings;
}

/**
 * Scan everything the dashboard is built from and the page itself.
 * @param {{files: string[], traceZips: string[], html: {file: string, text: string},
 *   allowedHost: string}} args every listed file must exist (the caller drops absent ones)
 * @returns {Finding[]}
 */
export function scanBuild({ files, traceZips, html, allowedHost }) {
  const findings = [];
  for (const file of files) findings.push(...scanText(readFileSync(file, "utf8"), file));
  for (const file of traceZips) {
    findings.push(...scanTraceZip(readFileSync(file), file, allowedHost));
  }
  findings.push(...scanText(html.text, html.file));
  return findings;
}

/** A log line per finding: file, pattern type, location — never the matched value. */
export function formatFindings(findings) {
  return findings.map((f) => `  ${f.file} [${f.kind}] at ${f.location}`).join("\n");
}
