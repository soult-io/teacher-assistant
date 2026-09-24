import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createByteBudget,
  MAX_STILL_BYTES,
  MAX_VIDEO_BYTES,
  makeAssetResolver,
} from "./assets.mjs";

// Minimal leading bytes of a real JPEG / PNG — the resolver checks them.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const jpegOf = (size) => Buffer.concat([JPEG, Buffer.alloc(size - JPEG.length)]);
// The EBML magic every WebM starts with.
const WEBM = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
const webmOf = (size) => Buffer.concat([WEBM, Buffer.alloc(size - WEBM.length)]);

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
    writeFileSync(join(artifacts, "j1-chromium", "video.webm"), webmOf(64));
    const resolve = makeAssetResolver(evidenceFile, out);
    const rel = resolve(ciPath("j1-chromium/video.webm"), "video", "J1", "chromium");
    expect(rel).toBe("videos/J1-chromium.webm");
    expect(readFileSync(join(out, rel))).toEqual(webmOf(64));
  });

  it("serves a walkthrough recording beside the gating one, named by its project", () => {
    writeFileSync(join(artifacts, "j1-chromium", "video.webm"), webmOf(64));
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(resolve(ciPath("j1-chromium/video.webm"), "video", "J1", "walkthrough")).toBe(
      "videos/J1-walkthrough.webm",
    );
  });

  it("fails loud on a .webm whose bytes are not a WebM", () => {
    writeFileSync(join(artifacts, "j1-chromium", "video.webm"), "<html>not a video</html>");
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(() => resolve(ciPath("j1-chromium/video.webm"), "video", "J1", "walkthrough")).toThrow(
      /not a webm/,
    );
  });

  it("fails loud on a video over the size cap; accepts one exactly at it", () => {
    writeFileSync(join(artifacts, "j1-chromium", "big.webm"), webmOf(MAX_VIDEO_BYTES + 1));
    writeFileSync(join(artifacts, "j1-chromium", "edge.webm"), webmOf(MAX_VIDEO_BYTES));
    const resolve = makeAssetResolver(evidenceFile, out);
    expect(() => resolve(ciPath("j1-chromium/big.webm"), "video", "J1", "walkthrough")).toThrow(
      /exceeds the .* byte cap/,
    );
    expect(resolve(ciPath("j1-chromium/edge.webm"), "video", "J2", "walkthrough")).toBe(
      "videos/J2-walkthrough.webm",
    );
  });

  it("remaps a walkthrough run's CI path under its own artifact root", () => {
    // The walkthrough writes under e2e/test-results-walkthrough/, which does NOT contain
    // "test-results/" — the gating marker alone would reject every walkthrough video.
    const wtRoot = join(root, "walkthrough-artifacts");
    mkdirSync(join(wtRoot, "j1-walkthrough"), { recursive: true });
    const wtEvidence = join(wtRoot, "walkthrough-evidence.json");
    writeFileSync(wtEvidence, "{}");
    writeFileSync(join(wtRoot, "j1-walkthrough", "video.webm"), webmOf(64));
    const raw = "/__w/r/r/e2e/test-results-walkthrough/j1-walkthrough/video.webm";
    const walk = makeAssetResolver(wtEvidence, out, { outputDir: "test-results-walkthrough" });
    expect(walk(raw, "video", "J1", "walkthrough")).toBe("videos/J1-walkthrough.webm");
    // the default (gating) marker cannot remap it — it stays out of tree and is refused
    expect(makeAssetResolver(wtEvidence, out)(raw, "video", "J1", "walkthrough")).toBeNull();
  });

  it("counts every served asset from every resolver against one published-bytes bound", () => {
    const wtRoot = join(root, "walkthrough-artifacts");
    mkdirSync(join(wtRoot, "j1"), { recursive: true });
    const wtEvidence = join(wtRoot, "walkthrough-evidence.json");
    writeFileSync(wtEvidence, "{}");
    writeFileSync(join(artifacts, "j1-chromium", "video.webm"), webmOf(60));
    writeFileSync(join(wtRoot, "j1", "video.webm"), webmOf(60));
    const budget = createByteBudget(100);
    const gating = makeAssetResolver(evidenceFile, out, { budget });
    const walk = makeAssetResolver(wtEvidence, out, { budget });
    expect(gating(join(artifacts, "j1-chromium", "video.webm"), "video", "J1", "chromium")).toBe(
      "videos/J1-chromium.webm",
    );
    expect(budget.used).toBe(60);
    // the walkthrough's 60 bytes would take the total to 120 > 100 → loud, not served
    expect(() => walk(join(wtRoot, "j1", "video.webm"), "video", "J1", "walkthrough")).toThrow(
      /exceeds the 100 byte bound/,
    );
    expect(existsSync(join(out, "videos", "J1-walkthrough.webm"))).toBe(false);
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
