// Orchestrator: assemble the live TRACK Verification dashboard.
//
//   counts (vitest --reporter=json)  +  e2e count (playwright --list)
//   + CI status (GitHub Actions API) + fresh screenshots (vite preview + Playwright)
//   -> fill template.html -> <outDir>/index.html + <outDir>/images/*.png
//
// Assumes `pnpm -r run build` has already run (the workflow does this first) so
// vitest cross-package imports and the PWA `vite preview` both resolve to dist.
// Usage: node src/generate.mjs [outDir]

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureScreens } from "./capture.mjs";
import { collectCiPills } from "./ci-status.mjs";
import { collectE2eCount, collectPackageCounts, FERPA_PACKAGE, PACKAGES } from "./counts.mjs";
import { aggregate, fillTemplate, renderBars, renderCiPills } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_DIR = resolve(HERE, "..");
const REPO_ROOT = resolve(TOOL_DIR, "..", "..");
const PREVIEW_PORT = 4173;
const PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const passOf = (pkgs, name) => pkgs.find((p) => p.name === name)?.pass ?? 0;

function shortSha() {
  const sha = process.env.GITHUB_SHA;
  if (sha) return sha.slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO_ROOT })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function startPreview() {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@teacher-assistant/pwa",
      "exec",
      "vite",
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(PREVIEW_PORT),
      "--strictPort",
    ],
    { cwd: REPO_ROOT, detached: true, stdio: "ignore" },
  );
  // Without a listener a spawn failure (e.g. pnpm missing) is thrown as an
  // uncaught exception; waitForServer will time out loudly instead.
  child.on("error", () => {});
  return child;
}

function stopPreview(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // already gone
  }
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error(`preview did not become ready at ${url}`);
}

async function captureWithPreview(imagesDir) {
  const preview = startPreview();
  try {
    await waitForServer(PREVIEW_URL);
    await captureScreens(PREVIEW_URL, imagesDir);
  } finally {
    stopPreview(preview);
  }
}

function buildTokens(pkgs, e2eCount, pillsHtml) {
  const sorted = [...pkgs].sort((a, b) => b.pass - a.pass);
  const { unitTotal, fileTotal, pkgCount } = aggregate(pkgs);
  return {
    COMMIT: shortSha(),
    GENERATED_DATE: new Date().toISOString().slice(0, 10),
    CI_PILLS: pillsHtml,
    UNIT_TOTAL: unitTotal,
    FILE_TOTAL: fileTotal,
    PKG_COUNT: pkgCount,
    FERPA_COUNT: passOf(pkgs, FERPA_PACKAGE),
    E2E_COUNT: e2eCount,
    E2E_PLURAL: e2eCount === 1 ? "" : "s",
    BARS: renderBars(sorted),
    ENGINE_COUNT: passOf(pkgs, "@teacher-assistant/domain-core"),
    PWA_COUNT: passOf(pkgs, "@teacher-assistant/pwa"),
  };
}

async function main() {
  const outDir = resolve(process.argv[2] ?? join(REPO_ROOT, "dist-dashboard"));
  const imagesDir = join(outDir, "images");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(imagesDir, { recursive: true });

  console.log(`verify-dashboard: running ${PACKAGES.length} test suites for live counts`);
  const tmpDir = mkdtempSync(join(tmpdir(), "verify-dashboard-"));
  const pkgs = collectPackageCounts(REPO_ROOT, tmpDir);
  const e2eCount = collectE2eCount(REPO_ROOT);
  for (const p of pkgs) console.log(`  ${p.label}: ${p.pass} pass / ${p.files} files`);
  console.log(`  e2e: ${e2eCount}`);

  console.log("verify-dashboard: reading CI status from GitHub Actions");
  const pills = await collectCiPills(process.env.GITHUB_REPOSITORY, process.env.GITHUB_TOKEN, {
    e2eIsSmoke: e2eCount <= 1,
  });

  console.log("verify-dashboard: capturing screenshots (vite preview + Playwright)");
  await captureWithPreview(imagesDir);

  const template = readFileSync(join(TOOL_DIR, "template.html"), "utf8");
  const html = fillTemplate(template, buildTokens(pkgs, e2eCount, renderCiPills(pills)));
  writeFileSync(join(outDir, "index.html"), html);
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`verify-dashboard: wrote ${join(outDir, "index.html")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
