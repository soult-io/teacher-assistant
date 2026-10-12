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
    put("j1-chromium/video.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0]));
    put("j1-chromium/still.jpeg", Buffer.from([0xff, 0xd8, 0xff, 0]));
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

  it("refuses a file of invalid UTF-8 with no NUL byte (e.g. compressed text)", () => {
    put("j4-chromium/blob.gz", Buffer.from([0x78, 0xff, 0xfe, 0x80, 0x67]));
    expect(summary(scan().findings)).toEqual(["j4-chromium/blob.gz unreadable"]);
  });

  it("text-scans nothing named as media unless its bytes say it is media", () => {
    put("j4-chromium/fake.png", `note ${EMAIL}`);
    expect(summary(scan().findings)).toEqual(["j4-chromium/fake.png unreadable"]);
  });

  it("accepts no font or icon signature under a media name, and WEBP needs RIFF", () => {
    put("a.png", Buffer.from([0x00, 0x00, 0x01, 0x00, 0x41]));
    put("b.webp", Buffer.from([...Buffer.from("XXXXxxxxWEBP")]));
    put("c.webp", Buffer.from([...Buffer.from("RIFFxxxxWEBP")]));
    expect(summary(scan().findings).sort()).toEqual(["a.png unreadable", "b.webp unreadable"]);
  });

  it("logs a data-derived JSON key as ? and strips control characters", () => {
    const body = Buffer.from(EMAIL).toString("base64");
    put("x.json", JSON.stringify({ "Janet\n::stop-commands::x": { buffer: body } }));
    const log = formatFindings(scan().findings);
    expect(log).toContain("$.?.buffer");
    expect(log).not.toContain("Janet");
    expect(log).not.toContain("\n::");
  });

  it("scans base64 attachment bodies and stdout buffers inside results.json", () => {
    const b64 = (text) => Buffer.from(text).toString("base64");
    put(
      "results.json",
      JSON.stringify({
        suites: [
          {
            attachments: [{ name: "note", contentType: "text/plain", body: b64(EMAIL) }],
            stdout: [{ text: "ok" }, { buffer: b64(`{"initials":"${NAME}"}`) }],
          },
        ],
      }),
    );
    expect(scan().findings.map((f) => `${f.kind} ${f.location.split(":")[0]}`)).toEqual([
      "email $.suites[0].attachments[0].body",
      "initials $.suites[0].stdout[1].buffer",
    ]);
  });

  it("passes a base64 image body, refuses an unreadable one", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    put(
      "results.json",
      JSON.stringify({
        attachments: [
          { contentType: "image/png", body: png.toString("base64") },
          {
            contentType: "application/gzip",
            body: Buffer.from([0x1f, 0x8b, 0]).toString("base64"),
          },
        ],
      }),
    );
    expect(scan().findings.map((f) => `${f.kind} ${f.location}`)).toEqual([
      "unreadable $.attachments[1].body",
    ]);
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

  it("refuses evidence with no origin stamp (this run wrote it, so it must be v4)", () => {
    put("journey-evidence.json", JSON.stringify({ schema: "ta/journey-evidence/3", tests: [] }));
    expect(summary(scan().findings)).toEqual(["journey-evidence.json origin"]);
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
