import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanArtifactDir } from "./artifact-scan.mjs";
import { formatFindings } from "./pii-scan.mjs";
import { makeZip } from "./test-zip.mjs";

const BASE_URL = "http://127.0.0.1:4173";
// Planted values. Each must be caught — and must never appear in a finding or its log.
const EMAIL = "jane.doe@gmail.com";
const NAME = "Janet";

const request = (url) =>
  JSON.stringify({ type: "resource-snapshot", snapshot: { request: { url } } });
const evidence = (baseURL) =>
  JSON.stringify({ schema: "ta/journey-evidence/4", mode: "gating", baseURL, tests: [] });

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifact-scan-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(rel, content) {
  mkdirSync(join(dir, rel, ".."), { recursive: true });
  writeFileSync(join(dir, rel), content);
}
const scan = () => scanArtifactDir(dir, { baseURL: BASE_URL });
const summary = (findings) => findings.map((f) => `${f.file} ${f.kind}`);

describe("scanArtifactDir", () => {
  it("passes a clean run: evidence, results, a local trace, media", () => {
    put("journey-evidence.json", evidence(BASE_URL));
    put("results.json", '{"stats":{"expected":1}}');
    put("j1-chromium/trace.zip", makeZip({ "0.network": request(`${BASE_URL}/index.html`) }));
    put("j1-chromium/video.webm", Buffer.from([0, 1, 2]));
    put("j1-chromium/still.jpeg", Buffer.from([0xff, 0xd8, 0]));
    const { findings, scanned, media } = scan();
    expect(findings).toEqual([]);
    expect(scanned).toBe(3);
    expect(media).toBe(2);
  });

  it("catches a planted email in a failure page snapshot (error-context.md)", () => {
    put("j2-firefox/error-context.md", `- text: contact ${EMAIL}`);
    expect(summary(scan().findings)).toEqual(["j2-firefox/error-context.md email"]);
  });

  it("catches a bad initials value in a text attachment", () => {
    put("j3-chromium/stdout.txt", `{"initials":"${NAME}"}`);
    expect(summary(scan().findings)).toEqual(["j3-chromium/stdout.txt initials"]);
  });

  it("text-scans a file of an unknown extension instead of skipping it", () => {
    put("j4-chromium/attachment.bin", `note ${EMAIL}`);
    expect(summary(scan().findings)).toEqual(["j4-chromium/attachment.bin email"]);
  });

  it("refuses a file it cannot read as text", () => {
    put("j4-chromium/blob.dat", Buffer.from([0x41, 0, 0x42]));
    expect(summary(scan().findings)).toEqual(["j4-chromium/blob.dat unreadable"]);
  });

  it("refuses a trace that reached a non-local host", () => {
    put("j5-chromium/trace.zip", makeZip({ "0.network": request("https://ic.fcps.net/x") }));
    expect(summary(scan().findings)).toEqual(["j5-chromium/trace.zip network-host"]);
  });

  it("scans every zip, not only trace.zip", () => {
    put("j5-chromium/attachment.zip", makeZip({ "notes.txt": EMAIL }));
    expect(summary(scan().findings)).toEqual(["j5-chromium/attachment.zip email"]);
  });

  it("refuses evidence stamped with another origin", () => {
    put("walkthrough-evidence.json", evidence("https://ta.example.org"));
    expect(summary(scan().findings)).toEqual(["walkthrough-evidence.json origin"]);
  });

  it("refuses evidence that is not JSON", () => {
    put("journey-evidence.json", "{not json");
    expect(summary(scan().findings)).toEqual(["journey-evidence.json unreadable"]);
  });

  it("refuses a symlink (the upload would follow it out of the directory)", () => {
    put("real.txt", "fine");
    symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    expect(summary(scan().findings)).toEqual(["link.txt unreadable"]);
  });

  it("never logs the matched value or the stamped origin", () => {
    put("error-context.md", EMAIL);
    put("journey-evidence.json", evidence("https://ta.example.org"));
    const log = formatFindings(scan().findings);
    expect(log).not.toContain(EMAIL);
    expect(log).not.toContain("ta.example.org");
  });
});
