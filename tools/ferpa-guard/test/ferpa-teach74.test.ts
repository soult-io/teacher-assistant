// FERPA-guard — TEACH-74 HARD conditions: the synthetic caseload reaches the ta-qa image
// only, never a prod image.
//   1. The pwa Dockerfile builds production by default (VITE_TA_SYNTHETIC empty).
//   2. Every non-synthetic vite build replaces the seed module with a stub.
//   3. CI checks the built images: prod pwa `absent`, pwa-qa `present` (release: `absent`).
//   4. pwa-qa is published as qa-sha-<commit> only — never `latest`, never a plain sha- tag.
// Static checks on the build files; the bundle itself is checked in CI by
// tools/synthetic-seed-check.sh against the image each leg built.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function file(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), "utf8");
}

/** Code only: drop # and // line comments, so a check never matches the explaining prose. */
function code(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join("\n");
}

describe("TEACH-74 HARD — the synthetic seed never reaches a prod image", () => {
  it("the pwa Dockerfile defaults VITE_TA_SYNTHETIC to empty (a production build)", () => {
    const dockerfile = code(file("apps", "pwa", "Dockerfile"));
    expect(dockerfile.match(/^ARG VITE_TA_SYNTHETIC.*$/gm)).toEqual(['ARG VITE_TA_SYNTHETIC=""']);
    expect(dockerfile).not.toMatch(/ENV VITE_TA_SYNTHETIC/);
  });

  it("a vite build without VITE_TA_SYNTHETIC=1 stubs the seed module", () => {
    const config = code(file("apps", "pwa", "vite.config.ts"));
    expect(config).toMatch(/new URL\(\s*"\.\/src\/data\/synthetic-seed\.ts"/);
    expect(config).toMatch(/\.VITE_TA_SYNTHETIC\s*===\s*"1"/);
    expect(config).toMatch(/synthetic\s*\?\s*\[\]\s*:\s*\[stubSyntheticSeed\(\)\]/);
    expect(config).toContain('apply: "build"');
    // The stub exports buildSyntheticSeed only, so that must stay the one runtime import.
    const firstDevice = code(file("apps", "pwa", "src", "data", "first-device.ts"));
    expect(firstDevice).toContain('import { buildSyntheticSeed } from "./synthetic-seed.js";');
  });

  it("ci.yml checks the prod pwa for absence and pwa-qa for presence, and only pwa-qa is synthetic", () => {
    const ci = code(file(".github", "workflows", "ci.yml"));
    expect(ci).toMatch(/- name: pwa\n\s+dockerfile: apps\/pwa\/Dockerfile\n\s+seed: absent\n/);
    expect(ci).toMatch(
      /- name: pwa-qa\n\s+dockerfile: apps\/pwa\/Dockerfile\n\s+build-args: VITE_TA_SYNTHETIC=1\n\s+seed: present\n/,
    );
    expect(ci.match(/VITE_TA_SYNTHETIC=1/g)).toHaveLength(1);
    expect(ci).toContain('tools/synthetic-seed-check.sh "$RUNNER_TEMP/html" "$SEED"');
  });

  it("pwa-qa publishes qa-sha-<commit> only, never latest", () => {
    const ci = code(file(".github", "workflows", "ci.yml"));
    expect(ci).toContain("- { name: pwa-qa, image: pwa, tag-prefix: qa-sha-, latest: false }");
    expect(ci).toContain('if [ "$LATEST" = "true" ]; then tags+=(latest); fi');
  });

  it("release.yml checks the released pwa for absence and builds no synthetic image", () => {
    const release = code(file(".github", "workflows", "release.yml"));
    expect(release).toMatch(/- name: pwa\n\s+dockerfile: apps\/pwa\/Dockerfile\n\s+seed: absent\n/);
    expect(release).toContain('tools/synthetic-seed-check.sh "$RUNNER_TEMP/html" "$SEED"');
    expect(release).not.toContain("VITE_TA_SYNTHETIC");
  });
});
