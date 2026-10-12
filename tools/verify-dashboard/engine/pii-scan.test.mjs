import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatFindings,
  localRequestCount,
  scanBuild,
  scanText,
  scanTraceZip,
} from "./pii-scan.mjs";
import { makeZip } from "./test-zip.mjs";
import { readZipEntries } from "./zip.mjs";

// Planted values. Each must be caught — and must never appear in a finding or its log.
const EMAIL = "jane.doe@gmail.com";
const SSN = "219-09-9999";
const PHONE = "(859) 555-0142";

const kinds = (findings) => findings.map((f) => f.kind);

const request = (url) =>
  JSON.stringify({ type: "resource-snapshot", snapshot: { request: { url } } });

describe("scanText", () => {
  it("catches a planted email", () => {
    expect(kinds(scanText(`{"note":"write to ${EMAIL}"}`, "f.json"))).toEqual(["email"]);
  });
  it("catches a planted SSN", () => {
    expect(kinds(scanText(`{"t":"id ${SSN}"}`, "f.json"))).toEqual(["ssn"]);
  });
  it("catches a US phone number", () => {
    expect(kinds(scanText(`call ${PHONE}`, "f.txt"))).toEqual(["phone"]);
  });
  it("catches long initials in JSON", () => {
    expect(kinds(scanText(`{"initials":"ABCD"}`, "f.json"))).toEqual(["initials"]);
  });
  it("catches a full name in the initials field", () => {
    expect(kinds(scanText(`{"initials":"Jane Doe"}`, "f.json"))).toEqual(["initials"]);
  });
  it("catches bad initials in JSON escaped inside a JSON string (a trace body)", () => {
    const body = JSON.stringify({ postData: JSON.stringify({ initials: "Jd" }) });
    expect(kinds(scanText(body, "t"))).toEqual(["initials"]);
  });
  it("catches bad initials in a JS object literal", () => {
    expect(kinds(scanText(`{initials:"abc",color:"--s-ab"}`, "b.js"))).toEqual(["initials"]);
  });
  it("catches a non-string initials value in JSON", () => {
    expect(kinds(scanText(`{"initials": 42}`, "f.json"))).toEqual(["initials"]);
  });
  it("passes 2- and 3-letter initials in every form, and a blank form default", () => {
    const text = [
      `{"initials":"AB"}`,
      JSON.stringify({ body: JSON.stringify({ initials: "XYZ" }) }),
      `{initials:"CD",x:1}`,
      `{initials:""}`,
      "initials: t.initials.trim()",
    ].join("\n");
    expect(scanText(text, "f")).toEqual([]);
  });
  it("passes RFC 2606 reserved addresses and file names that look like addresses", () => {
    const text = [
      "para@example.com",
      "a@school.test",
      "b@x.example.org",
      "screencast/page@b9245b18bb327ea038927027a227c63b-1790364739096.jpeg",
      "icon@2x.png",
    ].join("\n");
    expect(scanText(text, "f")).toEqual([]);
  });
  it("catches an address on .zip, a real TLD that is also a file extension", () => {
    expect(kinds(scanText("kid@school.zip", "f"))).toEqual(["email"]);
  });
  it("catches an initials key nested deeper than it reads", () => {
    expect(kinds(scanText(`${"\\".repeat(31)}"initials${"\\".repeat(31)}"`, "f"))).toEqual([
      "initials",
    ]);
  });
  it("stays linear on a long backslash run before an initials key", () => {
    const text = `${"\\".repeat(50_000)}"initials"`;
    const start = Date.now();
    scanText(text, "f");
    expect(Date.now() - start).toBeLessThan(1000);
  });
  it("passes timestamps, durations and ISO dates", () => {
    const text = `{"startTime":"2026-09-25T19:30:43.933Z","durationMs":1790364655841,"n":8595550142}`;
    expect(scanText(text, "f")).toEqual([]);
  });
  it("reports line:col, never the value", () => {
    const findings = scanText(`line one\nmail ${EMAIL}`, "f.txt");
    expect(findings).toEqual([{ file: "f.txt", kind: "email", location: "2:6" }]);
  });
});

describe("scanTraceZip", () => {
  it("round-trips the zip fixture through readZipEntries (deflate and stored)", () => {
    for (const store of [false, true]) {
      const entries = readZipEntries(makeZip({ "a.txt": "hello" }, { store }));
      expect(entries.map((e) => [e.name, e.data.toString()])).toEqual([["a.txt", "hello"]]);
    }
  });
  it("passes a trace of the local build", () => {
    const zip = makeZip({
      "0-trace.network": [
        request("http://127.0.0.1:4173/"),
        request("http://127.0.0.1:4173/assets/index.js"),
        request("data:image/png;base64,iVBORw0KGgoA"),
        request("blob:http://127.0.0.1:4173/5d1c"),
        request("http://overlay.test/a"),
      ].join("\n"),
      "resources/abc.js": `const s=[{initials:"AB"}];`,
    });
    expect(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173")).toEqual([]);
  });
  it("refuses a request to any other host", () => {
    const zip = makeZip({
      "0-trace.network": [
        request("http://127.0.0.1:4173/"),
        request("https://qa.stabpablo.com/"),
      ].join("\n"),
    });
    expect(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173")).toEqual([
      { file: "trace.zip", kind: "network-host", location: "0-trace.network:2" },
    ]);
  });
  it("refuses localhost and .localhost names (not the pinned host)", () => {
    const zip = makeZip({
      "0-trace.network": [request("http://localhost:4173/"), request("http://app.localhost/")].join(
        "\n",
      ),
    });
    expect(kinds(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173"))).toEqual([
      "network-host",
      "network-host",
    ]);
  });
  it("refuses a blob or websocket URL on another origin, and an opaque blob", () => {
    const zip = makeZip({
      "0-trace.network": [
        request("blob:https://evil.example.com/x"),
        request("ws://127.0.0.1:4173/hmr"),
        request("wss://relay.stabpablo.com/"),
        request("blob:null/5d1c"),
      ].join("\n"),
    });
    expect(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173")).toEqual([
      { file: "trace.zip", kind: "network-host", location: "0-trace.network:1" },
      { file: "trace.zip", kind: "network-host", location: "0-trace.network:3" },
      { file: "trace.zip", kind: "network-host", location: "0-trace.network:4" },
    ]);
  });
  it("refuses the right host on another port, and a protocol it does not know", () => {
    const zip = makeZip({
      "0-trace.network": [request("http://127.0.0.1:8080/"), request("file:///etc/passwd")].join(
        "\n",
      ),
    });
    expect(kinds(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173"))).toEqual([
      "network-host",
      "network-host",
    ]);
  });
  it("refuses a network line it cannot read, and a trace log holding a NUL byte", () => {
    const zip = makeZip({
      "0-trace.network": "{not json",
      "1-trace.network": "a\0b",
      "test.trace": "x\0y",
    });
    expect(kinds(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173"))).toEqual([
      "unreadable",
      "unreadable",
      "unreadable",
    ]);
  });
  it("refuses an archive with an unsupported method, an encrypted entry, or a bomb", () => {
    const withHeader = (zip, offset, write) => {
      const copy = Buffer.from(zip);
      write(copy, copy.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + offset);
      return copy;
    };
    const base = makeZip({ "test.trace": "{}" });
    const method = withHeader(base, 10, (b, at) => b.writeUInt16LE(12, at));
    const encrypted = withHeader(base, 8, (b, at) => b.writeUInt16LE(1, at));
    const bomb = withHeader(base, 24, (b, at) => b.writeUInt32LE(0xfffffff0, at));
    for (const zip of [method, encrypted, bomb]) {
      expect(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173")).toEqual([
        { file: "trace.zip", kind: "unreadable", location: "archive" },
      ]);
    }
  });
  it("refuses an entry that is neither UTF-8 text nor a known image or font", () => {
    const zip = makeZip({
      "resources/a.bin": Buffer.from([0x78, 0xff, 0xfe, 0x80]),
      "resources/b.woff2": Buffer.from([...Buffer.from("wOF2"), 0x00, 0x01]),
      "resources/c.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]),
    });
    expect(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173")).toEqual([
      { file: "trace.zip", kind: "unreadable", location: "resources/a.bin" },
    ]);
  });
  it("refuses an archive it cannot read", () => {
    expect(scanTraceZip(Buffer.from("not a zip"), "trace.zip", "127.0.0.1:4173")).toEqual([
      { file: "trace.zip", kind: "unreadable", location: "archive" },
    ]);
  });
  it("catches planted values in any text entry, with the entry as the location", () => {
    const zip = makeZip({
      "resources/snap.html": `<p>${EMAIL}</p>`,
      "test.trace": `{"x":"${SSN}"}\n{"initials":"ABCD"}`,
      "screencast/a.jpeg": Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x40]),
    });
    expect(scanTraceZip(zip, "trace.zip", "127.0.0.1:4173")).toEqual([
      { file: "trace.zip", kind: "email", location: "resources/snap.html:1:4" },
      { file: "trace.zip", kind: "ssn", location: "test.trace:1:7" },
      { file: "trace.zip", kind: "initials", location: "test.trace:2:2" },
    ]);
  });
});

describe("scanBuild", () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function fixture(files) {
    dir = mkdtempSync(join(tmpdir(), "pii-scan-"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
    return (name) => join(dir, name);
  }

  const clean = { schema: "ta/journey-evidence/4", tests: [{ title: "AB owes a probe" }] };

  it("passes a clean build", () => {
    const at = fixture({
      "journey-evidence.json": JSON.stringify(clean),
      "trace.zip": makeZip({ "0-trace.network": request("http://127.0.0.1:4173/") }),
    });
    const findings = scanBuild({
      files: [at("journey-evidence.json")],
      traceZips: [at("trace.zip")],
      html: { file: "index.html", text: "<h1>TRACK</h1>" },
      allowedHost: "127.0.0.1:4173",
    });
    expect(findings).toEqual([]);
  });

  it("throws on a listed file that is absent (the caller decides what may be absent)", () => {
    const at = fixture({});
    const scan = () =>
      scanBuild({
        files: [at("results.json")],
        traceZips: [],
        html: { file: "index.html", text: "" },
        allowedHost: "127.0.0.1:4173",
      });
    expect(scan).toThrow(/ENOENT/);
  });

  it("finds a planted email, SSN and long initials across files, and logs none of them", () => {
    const at = fixture({
      "journey-evidence.json": JSON.stringify({ ...clean, note: EMAIL }),
      "results.json": JSON.stringify({ title: `ssn ${SSN}` }),
      "trace.zip": makeZip({ "test.trace": `{"initials":"ABCD"}` }),
    });
    const findings = scanBuild({
      files: [at("journey-evidence.json"), at("results.json")],
      traceZips: [at("trace.zip")],
      html: { file: "index.html", text: `<td>${PHONE}</td>` },
      allowedHost: "127.0.0.1:4173",
    });
    expect(kinds(findings)).toEqual(["email", "ssn", "initials", "phone"]);
    const log = `${formatFindings(findings)}\n${JSON.stringify(findings)}`;
    for (const value of [EMAIL, SSN, "ABCD", PHONE, "jane.doe"]) {
      expect(log).not.toContain(value);
    }
  });
});

describe("scanText — base64 data: URLs", () => {
  const b64 = (v) => Buffer.from(v).toString("base64");
  it("finds a value inside a base64 data: URL, at the URL", () => {
    const text = `<img src="data:text/plain;base64,${b64(`mail ${EMAIL}`)}">`;
    expect(scanText(text, "snap.html")).toEqual([
      { file: "snap.html", kind: "email", location: "1:11" },
    ]);
  });
  it("finds a value in a data: URL nested inside one", () => {
    const inner = `data:text/plain;charset=utf-8;base64,${b64(SSN)}`;
    expect(kinds(scanText(`url(data:text/css;base64,${b64(inner)})`, "a.css"))).toEqual(["ssn"]);
  });
  it("passes an inline image or (in a trace) font, refuses binary it cannot identify", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    const woff2 = Buffer.from([...Buffer.from("wOF2"), 0]);
    const text = [
      `data:image/png;base64,${png.toString("base64")}`,
      `data:font/woff2;base64,${woff2.toString("base64")}`,
      `data:application/octet-stream;base64,${Buffer.from([0x1f, 0x8b, 0]).toString("base64")}`,
    ].join("\n");
    expect(scanText(text, "t", "", { glyphs: true })).toEqual([
      { file: "t", kind: "unreadable", location: "3:1" },
    ]);
  });
  it("matches in linear time on a hostile near-miss (no catastrophic backtracking)", () => {
    const hostile = `data:${"a".repeat(100)}${`;${"b".repeat(64)}`.repeat(5)};x`.repeat(200);
    const start = performance.now();
    expect(scanText(hostile, "t")).toEqual([]);
    expect(performance.now() - start).toBeLessThan(500);
  });
  it("reads a payload cut mid-character (a shortened trace value) as text", () => {
    const cut = Buffer.from(`${EMAIL} é`).subarray(0, -1).toString("base64");
    expect(kinds(scanText(`data:text/plain;base64,${cut}`, "t"))).toEqual(["email"]);
  });
  it("accepts an inline font or icon only inside a trace entry", () => {
    const ico = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0xff]).toString("base64");
    const text = `url(data:image/x-icon;base64,${ico})`;
    expect(kinds(scanText(text, "a.md"))).toEqual(["unreadable"]);
    expect(scanText(text, "t", "", { glyphs: true })).toEqual([]);
  });
  it("never logs the decoded value", () => {
    const log = formatFindings(scanText(`data:text/plain;base64,${b64(EMAIL)}`, "t"));
    expect(log).not.toContain(EMAIL);
  });
});

describe("localRequestCount (positive network proof of the local build)", () => {
  const HOST = "127.0.0.1:4173";
  it("counts only requests to the allowed host itself", () => {
    const zip = makeZip({
      "0-trace.network": "",
      "1-trace.network": [
        request("http://127.0.0.1:4173/"),
        request("http://127.0.0.1:4173/assets/index.js"),
        request("data:image/png;base64,iVBORw0KGgoA"),
        request("http://overlay.test/a"),
        request("http://127.0.0.1:8080/"),
      ].join("\n"),
    });
    expect(localRequestCount(zip, HOST)).toBe(2);
  });
  it("is 0 for empty logs (a trace recorded without snapshots) and unreadable input", () => {
    expect(localRequestCount(makeZip({ "0-trace.network": "" }), HOST)).toBe(0);
    expect(localRequestCount(makeZip({ "0-trace.network": "{not json" }), HOST)).toBe(0);
    expect(localRequestCount(Buffer.from("not a zip"), HOST)).toBe(0);
  });
});
