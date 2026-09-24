import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_STILL_BYTES, makeAssetResolver } from "./assets.mjs";

// Minimal leading bytes of a real JPEG / PNG — the resolver checks them.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const jpegOf = (size) => Buffer.concat([JPEG, Buffer.alloc(size - JPEG.length)]);

let root;
let artifacts;
let out;
let evidenceFile;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "assets-test-"));
  artifacts = join(root, "e2e-artifacts");
  out = join(root, "dist");
  mkdirSync(join(artifacts, "j1-chromium", "attachments"), { recursive: true });
  evidenceFile = join(artifacts, "journey-evidence.json");
  writeFileSync(evidenceFile, "{}");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// The path the evidence records is the CI container's absolute path; the resolver
// remaps it under the downloaded artifact root.
const ciPath = (rel) => `/__w/repo/repo/e2e/test-results/${rel}`;

describe("makeAssetResolver", () => {
  it("serves a video under videos/ with a sanitised name", () => {
    writeFileSync(join(artifacts, "j1-chromium", "video.webm"), "vid");
    const resolve = makeAssetResolver(evidenceFile, out);
    const rel = resolve(ciPath("j1-chromium/video.webm"), "video", "J1", "chromium");
    expect(rel).toBe("videos/J1-chromium.webm");
    expect(readFileSync(join(out, rel), "utf8")).toBe("vid");
  });

  it("serves a still under stills/, named per journey, engine and zero-padded step", () => {
    const src = join(artifacts, "j1-chromium", "attachments", "step-still-abc.jpg");
    writeFileSync(src, JPEG);
    const resolve = makeAssetResolver(evidenceFile, out);
    const rel = resolve(
      ciPath("j1-chromium/attachments/step-still-abc.jpg"),
      "still",
      "J5-draft",
      "chromium",
      3,
    );
    expect(rel).toBe("stills/J5-draft-chromium-03.jpg");
    expect(readFileSync(join(out, rel))).toEqual(JPEG);
  });

  it("keeps a png still's extension", () => {
    writeFileSync(join(artifacts, "j1-chromium", "s.png"), PNG);
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(resolve(ciPath("j1-chromium/s.png"), "still", "J1", "chromium", 0)).toBe(
      "stills/J1-chromium-00.png",
    );
  });

  it("fails loud on a still that is not a jpeg/png image", () => {
    writeFileSync(join(artifacts, "j1-chromium", "s.svg"), "<svg/>");
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(() => resolve(ciPath("j1-chromium/s.svg"), "still", "J1", "chromium", 0)).toThrow(
      /not a jpeg\/png/,
    );
  });

  it("fails loud on a .jpg whose bytes are not a JPEG", () => {
    writeFileSync(join(artifacts, "j1-chromium", "fake.jpg"), "<html>not an image</html>");
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(() => resolve(ciPath("j1-chromium/fake.jpg"), "still", "J1", "chromium", 0)).toThrow(
      /not a jpeg\/png/,
    );
  });

  it("fails loud on a still over the size cap — never serves or silently drops it", () => {
    writeFileSync(join(artifacts, "j1-chromium", "big.jpg"), jpegOf(MAX_STILL_BYTES + 1));
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(() => resolve(ciPath("j1-chromium/big.jpg"), "still", "J1", "chromium", 0)).toThrow(
      /exceeds the .* byte cap/,
    );
    expect(existsSync(join(out, "stills"))).toBe(false);
  });

  it("accepts a still exactly at the size cap", () => {
    writeFileSync(join(artifacts, "j1-chromium", "edge.jpg"), jpegOf(MAX_STILL_BYTES));
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(resolve(ciPath("j1-chromium/edge.jpg"), "still", "J1", "chromium", 1)).toBe(
      "stills/J1-chromium-01.jpg",
    );
  });

  it("returns null (explicit absent) for a still missing from the artifact", () => {
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(resolve(ciPath("j1-chromium/gone.jpg"), "still", "J1", "chromium", 0)).toBeNull();
  });

  it("refuses a source outside the artifact tree", () => {
    const outside = join(root, "secret.jpg");
    writeFileSync(outside, "x");
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(resolve(outside, "still", "J1", "chromium", 0)).toBeNull();
    expect(resolve(ciPath("../../secret.jpg"), "still", "J1", "chromium", 0)).toBeNull();
  });

  it("requires a step index for a still", () => {
    writeFileSync(join(artifacts, "j1-chromium", "s.jpg"), JPEG);
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(() => resolve(ciPath("j1-chromium/s.jpg"), "still", "J1", "chromium")).toThrow(
      /step index/,
    );
  });
});
