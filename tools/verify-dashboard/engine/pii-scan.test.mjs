import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { formatFindings, scanBuild, scanText, scanTraceZip } from "./pii-scan.mjs";
import { readZipEntries } from "./zip.mjs";

// Planted values. Each must be caught — and must never appear in a finding or its log.
const EMAIL = "jane.doe@gmail.com";
const SSN = "219-09-9999";
const PHONE = "(859) 555-0142";

const kinds = (findings) => findings.map((f) => f.kind);

// A zip writer for fixtures (deflate, or stored with `store`): just enough of the
// format for readZipEntries.
function makeZip(files, { store = false } = {}) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const body = store ? data : deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(store ? 0 : 8, 8);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(store ? 0 : 8, 10);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    locals.push(lfh, nameBuf, body);
    central.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

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
        request("data:image/png;base64,AAAA"),
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
  it("refuses an archive it cannot read", () => {
    expect(scanTraceZip(Buffer.from("not a zip"), "trace.zip", "127.0.0.1:4173")).toEqual([
      { file: "trace.zip", kind: "unreadable", location: "archive" },
    ]);
  });
  it("catches planted values in any text entry, with the entry as the location", () => {
    const zip = makeZip({
      "resources/snap.html": `<p>${EMAIL}</p>`,
      "test.trace": `{"x":"${SSN}"}\n{"initials":"ABCD"}`,
      "screencast/a.jpeg": Buffer.from([0xff, 0xd8, 0x00, 0x40]),
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
